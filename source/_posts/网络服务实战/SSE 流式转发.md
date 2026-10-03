---
title: "为什么模型在逐字生成，浏览器却最后一次性显示？从 SSE 到断线续传"
date: 2026-07-13 17:46:10
updated: 2026-07-13 17:46:10
categories:
  - "学习"
  - "网络服务实战"
permalink: /notes/网络服务实战/sse-流式转发/
series: "网络服务实战"
---

上游模型每隔几十毫秒就产生一段文本，日志里也能看到 token 持续到达，但浏览器等了十秒，最后突然显示完整答案。最常见的“代理”写法大致是这样：

```python
# 存在隐患的写法：先读取完整响应，再返回给客户端。
async def buffered_proxy(client, upstream_url):
    upstream = await client.get(upstream_url)
    return Response(
        content=upstream.content,
        media_type="text/event-stream",
    )
```

响应头虽然写着 `text/event-stream`，数据流却在 `client.get()` 读取完整 body 时被缓冲了。它已经不再是流式转发，只是把普通响应换了一个 Content-Type。

即使把代码改成边读边写，新的问题也会很快出现：用户刷新页面后，已经生成的内容去哪了？浏览器断线是否应该取消模型？两个客户端同时查看一条回答时，谁消费事件？慢客户端会不会让内存队列无限增长？

本文沿着这条故障链展开：先讲清 Server-Sent Events（SSE）的消息边界，再实现一个可运行、可断线续传的单进程版本，最后说明它怎样演进到 Redis Streams 和 Drogon Gateway。读完后，应当能够区分三个经常被混为一谈的对象：

```text
生成任务：负责产生结果
事件日志：负责暂存和回放结果
SSE 连接：负责把结果送到当前客户端
```

它们可以协作，但不应该被当成同一个生命周期。

## 1. 为什么普通 HTTP 代理会吞掉“流式”效果？

普通 JSON 接口通常要等完整响应到齐再解析：

```text
upstream headers -> upstream full body -> Gateway -> client
```

SSE 是一个长期保持的 HTTP 响应。服务端先发送响应头，之后不断追加 UTF-8 文本事件：

```text
upstream headers -> event 1 -> event 2 -> heartbeat -> event 3 -> done
                         |          |                       |
                         +----------+-----------------------+--> 立即转发
```

因此，代理 SSE 至少要满足两件事：

1. 上游客户端必须使用 streaming API，不能预先读取完整 body；
2. 下游响应必须在每个字节块到达时继续写出，不能被 Gateway、压缩中间件或反向代理重新缓冲。

这里的“字节块”不等于“SSE 事件”。一次 socket read 可能只读到半个事件，也可能同时读到多个事件。如果 Gateway 不需要检查或改写业务事件，最稳妥的方式通常是把上游 body 当作不透明字节流转发，而不是按每次 read 尝试解析。

## 2. SSE 的消息边界究竟在哪里？

一个 SSE 事件由若干文本字段组成，并以空行结束：

```text
id: 42
event: token
data: {"delta":"你好"}

```

上面的最后一个空行不是排版装饰，而是事件的提交边界。没有它，浏览器会继续等待后续字段，不会触发事件监听器。

常用字段如下：

| 字段 | 含义 | 工程用途 |
| --- | --- | --- |
| `id` | 当前事件的标识 | 重连时通过 `Last-Event-ID` 从下一条继续 |
| `event` | 事件类型 | 区分 `token`、`done`、`cancelled` 等业务事件 |
| `data` | 事件负载 | 同一事件可有多行，每行都必须以 `data:` 开头 |
| `retry` | 建议的重连等待时间 | 单位为毫秒，由浏览器作为重连提示使用 |
| `: comment` | 注释行 | 可作为不改变业务游标的心跳 |

浏览器会把同一事件的多行 `data` 用换行连接。事件流使用 UTF-8；`id` 值不能包含空字符、回车或换行。一个常见的业务协议可以这样设计：

```text
id: 1
event: token
data: {"delta":"网络"}

id: 2
event: token
data: {"delta":"断开"}

id: 3
event: done
data: {"message_id":"m-1","text":"网络断开后仍可恢复"}

```

`done` 是业务终止事件，不是 SSE 规范强制规定的字段。项目也可以使用别的名称，但必须让客户端明确知道“任务已经正常结束，不需要再次重连”。同理，本文使用 `app_error` 表示服务端业务错误，避免与浏览器 EventSource 自身的网络 `error` 事件混淆。

## 3. 为什么连接断开后，不能继续向“原连接”补发数据？

TCP/HTTP 连接一旦关闭，服务端就无法再向它写入任何字节。所谓“断线后继续返回完整内容”，真正能保证的是：

```text
旧连接断开
    |
    +--> 生成任务继续运行
    +--> 新事件继续进入可回放日志
    +--> 最终结果保存为权威快照

新连接建立 + Last-Event-ID
    |
    +--> 回放遗漏事件，再继续等待实时事件
```

如果生成循环直接写在响应生成器里，连接取消通常也会取消响应生成器，上游生成便跟着结束。这适合“断开即停止、优先节省算力”的产品，但无法满足“用户刷新页面后仍能拿到完整答案”。

更稳定的接口模型会把四件事拆开：

```text
POST /v1/chat/jobs
    创建任务，返回 message_id

GET /v1/chat/jobs/{message_id}/events
    建立 SSE，回放历史并等待新事件

GET /v1/chat/jobs/{message_id}
    查询状态和最终快照

POST /v1/chat/jobs/{message_id}/cancel
    请求真正取消生成
```

“关闭 SSE”和“取消生成”于是有了不同语义。前者只停止当前页面接收，后者才会让 worker 在安全点停止模型并保存部分结果。

## 4. 最小可运行版本：让任务脱离 SSE 连接

下面的单文件示例使用 Python 3.10+、FastAPI 和 Uvicorn。为了让示例离线可运行，`fake_model_stream()` 用定时输出模拟模型；替换成真实 SDK 时，必须继续使用异步流式接口，不能在事件循环里执行长时间同步阻塞调用。

它演示以下行为：

- 创建独立后台任务；
- 在内存中保存带递增 ID 的事件；
- SSE 断开时只移除订阅，不取消任务；
- 使用 `Last-Event-ID` 回放遗漏事件；
- 以 `done`、`cancelled` 或 `app_error` 明确结束；
- 单独提供最终结果查询接口。

```python
from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass, field
from typing import AsyncIterator, Literal

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

TerminalStatus = Literal["completed", "cancelled", "failed"]
TERMINAL_STATUSES = {"completed", "cancelled", "failed"}
TERMINAL_EVENTS = {"done", "cancelled", "app_error"}

class CreateJob(BaseModel):
    prompt: str

@dataclass(frozen=True)
class StoredEvent:
    id: int
    event: str
    data: dict[str, object]

@dataclass
class Job:
    status: str = "generating"
    events: list[StoredEvent] = field(default_factory=list)
    final_text: str = ""
    cancel_requested: bool = False
    condition: asyncio.Condition = field(default_factory=asyncio.Condition)

    async def append(self, event: str, data: dict[str, object]) -> None:
        async with self.condition:
            self.events.append(
                StoredEvent(len(self.events) + 1, event, data)
            )
            self.condition.notify_all()

    async def finish(
        self,
        status: TerminalStatus,
        event: str,
        data: dict[str, object],
        final_text: str = "",
    ) -> None:
        async with self.condition:
            # 终止操作幂等，避免取消和正常完成同时写入两个终止事件。
            if self.status in TERMINAL_STATUSES:
                return
            self.status = status
            self.final_text = final_text
            self.events.append(
                StoredEvent(len(self.events) + 1, event, data)
            )
            self.condition.notify_all()

app = FastAPI()
jobs: dict[str, Job] = {}
running_tasks: set[asyncio.Task[None]] = set()

def encode_sse(
    event: str,
    data: dict[str, object],
    *,
    event_id: int,
) -> str:
    if "\r" in event or "\n" in event:
        raise ValueError("event name must not contain CR or LF")

    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    lines = [f"id: {event_id}", f"event: {event}"]
    lines.extend(f"data: {line}" for line in payload.splitlines() or [""])
    return "\n".join(lines) + "\n\n"

async def fake_model_stream(prompt: str) -> AsyncIterator[str]:
    for part in ["正在", "回答：", prompt, "。", "生成完成。"]:
        await asyncio.sleep(0.4)
        yield part

async def run_generation(message_id: str, job: Job, prompt: str) -> None:
    parts: list[str] = []
    try:
        async for token in fake_model_stream(prompt):
            if job.cancel_requested:
                partial = "".join(parts)
                await job.finish(
                    "cancelled",
                    "cancelled",
                    {"message_id": message_id, "partial_text": partial},
                    partial,
                )
                return

            parts.append(token)
            await job.append("token", {"delta": token})

        final_text = "".join(parts)
        await job.finish(
            "completed",
            "done",
            {"message_id": message_id, "text": final_text},
            final_text,
        )
    except asyncio.CancelledError:
        # 这里只会在应用关闭等任务级取消时发生，不能吞掉取消。
        raise
    except Exception:
        # 生产代码应记录带 request_id 的完整异常，不能向客户端泄露堆栈。
        await job.finish(
            "failed",
            "app_error",
            {"code": "generation_failed", "message": "生成失败"},
        )

@app.post("/v1/chat/jobs", status_code=202)
async def create_job(body: CreateJob) -> dict[str, str]:
    prompt = body.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=422, detail="prompt must not be empty")

    message_id = uuid.uuid4().hex
    job = Job()
    jobs[message_id] = job

    # 必须保存强引用；任务完成后再从集合移除。
    task = asyncio.create_task(run_generation(message_id, job, prompt))
    running_tasks.add(task)
    task.add_done_callback(running_tasks.discard)
    return {"message_id": message_id}

def parse_last_event_id(raw: str | None) -> int:
    if raw is None or raw == "":
        return 0
    try:
        value = int(raw)
    except ValueError as exc:
        raise HTTPException(400, "invalid Last-Event-ID") from exc
    if value < 0:
        raise HTTPException(400, "invalid Last-Event-ID")
    return value

@app.get("/v1/chat/jobs/{message_id}/events")
async def stream_events(
    message_id: str,
    request: Request,
    last_event_id: str | None = Header(default=None),
) -> StreamingResponse:
    job = jobs.get(message_id)
    if job is None:
        raise HTTPException(404, "job not found")

    start_cursor = parse_last_event_id(last_event_id)
    if start_cursor > len(job.events):
        raise HTTPException(409, "Last-Event-ID is ahead of this job")

    async def generate() -> AsyncIterator[str]:
        cursor = start_cursor
        while True:
            if await request.is_disconnected():
                return

            heartbeat = False
            async with job.condition:
                while len(job.events) <= cursor and job.status not in TERMINAL_STATUSES:
                    try:
                        await asyncio.wait_for(job.condition.wait(), timeout=10)
                    except TimeoutError:
                        heartbeat = True
                        break

                pending = job.events[cursor:]
                terminal = job.status in TERMINAL_STATUSES

            # yield 时绝不能持有 condition，否则生产者无法 append。
            if heartbeat and not pending:
                yield ": ping\n\n"
                continue

            for item in pending:
                yield encode_sse(item.event, item.data, event_id=item.id)
                cursor = item.id
                if item.event in TERMINAL_EVENTS:
                    return

            if terminal and not pending:
                return

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )

@app.get("/v1/chat/jobs/{message_id}")
async def get_job(message_id: str) -> dict[str, str]:
    job = jobs.get(message_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return {
        "message_id": message_id,
        "status": job.status,
        "text": job.final_text,
    }

@app.post("/v1/chat/jobs/{message_id}/cancel", status_code=202)
async def cancel_job(message_id: str) -> dict[str, str]:
    job = jobs.get(message_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if job.status in TERMINAL_STATUSES:
        return {"status": job.status}
    job.cancel_requested = True
    return {"status": "cancel_requested"}
```

将代码保存为 `app.py`。项目需要已经安装与其锁定版本匹配的 FastAPI、Pydantic 和 Uvicorn，然后运行：

```bash
python3 -m uvicorn app:app --host 127.0.0.1 --port 8000
```

另开终端创建任务：

```bash
curl -sS -X POST http://127.0.0.1:8000/v1/chat/jobs \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"SSE 为什么要保存事件 ID？"}'
```

把返回的 `message_id` 粘贴到变量中；`-N` 会关闭 curl 自身的输出缓冲：

```bash
MESSAGE_ID='粘贴上一步返回的 message_id'
curl -N "http://127.0.0.1:8000/v1/chat/jobs/${MESSAGE_ID}/events"
```

预期会逐段看到 `token`，最后收到带完整文本的 `done`。如果第一次连接在 `id: 2` 后断开，可这样模拟续传：

```bash
curl -N "http://127.0.0.1:8000/v1/chat/jobs/${MESSAGE_ID}/events" \
  -H 'Last-Event-ID: 2'
```

服务端只会发送 ID 大于 2 的事件。最后还可以查询权威快照：

```bash
curl -sS "http://127.0.0.1:8000/v1/chat/jobs/${MESSAGE_ID}"
```

这个示例用于解释并发关系，不是生产存储方案。它没有实现鉴权、容量上限和 TTL；进程重启会丢失所有任务，多 worker 部署也会让重连请求落到没有该任务的进程。

## 5. 这段代码怎样避免“断线即取消”？

关键不在 `StreamingResponse` 本身，而在数据所有权。

`run_generation()` 由 `asyncio.create_task()` 启动，并由 `running_tasks` 保存强引用。任务把事件写入 `Job.events`，从不直接持有某个 HTTP 响应。SSE 生成器只是一个读者：连接断开后它返回，`Job` 和生成任务仍然存在。

`asyncio.Condition` 同时解决“事件列表由谁保护”和“消费者如何等待”两个问题：

```text
producer                       SSE consumer
   |                                |
   | acquire condition              | wait condition
   | append event                   |
   | notify_all -------------------> | wake up
   | release                        | copy pending events
                                    | release
                                    | yield to socket
```

消费者只在锁内复制待发送事件，然后释放锁再 `yield`。如果拿着 condition 跨越网络写入，慢客户端就会阻止生产者追加新事件。

`cursor` 保存最后成功交给响应生成器的事件 ID。因为演示中的 ID 从 1 连续递增，`job.events[cursor:]` 正好表示 ID 大于 cursor 的事件。真实系统若允许裁剪、分片或非连续 ID，就不能依靠列表下标，必须按显式 ID 查询。

终止状态与终止事件在同一个 condition 临界区写入，避免消费者先看到 `completed` 却找不到 `done`。`finish()` 还会拒绝第二次终止，防止“取消请求”和“模型正常结束”竞争后同时出现 `cancelled` 与 `done`。

## 6. EventSource 如何续传，又有哪些限制？

浏览器原生 EventSource 会解析 SSE，并在重连同一事件源时携带最近接收的事件 ID。前端可以按事件类型处理：

```js
const source = new EventSource(
  `/v1/chat/jobs/${messageId}/events`
);

source.addEventListener("token", (event) => {
  const { delta } = JSON.parse(event.data);
  appendText(delta);
});

source.addEventListener("done", (event) => {
  const { text } = JSON.parse(event.data);
  replaceWithAuthoritativeText(text);
  source.close();
});

source.addEventListener("cancelled", (event) => {
  const { partial_text } = JSON.parse(event.data);
  replaceWithAuthoritativeText(partial_text);
  source.close();
});

source.addEventListener("app_error", (event) => {
  console.error(JSON.parse(event.data));
  source.close();
});
```

收到终止事件后必须主动 `close()`。否则服务端正常关闭连接时，EventSource 仍可能把它理解为一次需要恢复的断线并再次连接。服务端也可以用 HTTP 204 告诉 EventSource 停止重连，但业务终止事件通常更容易携带最终状态。

EventSource 只发起 GET，并且不能像 `fetch` 一样任意配置请求头。它适合 Cookie 鉴权或经过严格设计的短期订阅地址。不要把长期访问令牌直接放入 URL：URL 可能进入浏览器历史、访问日志和监控系统。

需要 Bearer token、POST body 或完全控制重试时，可以使用 `fetch` 读取响应流：

```js
const response = await fetch(
  `/v1/chat/jobs/${messageId}/events`,
  {
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${token}`,
      "Last-Event-ID": savedEventId,
    },
    signal: abortController.signal,
  }
);
```

此时浏览器不会替应用解析 SSE。代码必须自行处理 UTF-8 增量解码、半个事件跨 chunk、多事件共用一个 chunk、ID 持久化、去重、退避重连和终止事件。不能用一次 `reader.read()` 的结果当作一个完整事件。

## 7. 为什么只有事件回放还不够？

断线续传通常只能按“至少一次”交付设计：

```text
客户端收到 id: 9
    -> 还没来得及持久化游标，网络断开
    -> 使用 id: 8 重连
    -> id: 9 再次到达
```

因此事件 ID 必须稳定，客户端处理必须幂等。对 token 流，仅凭“收到一个重复 token 就忽略”也不总是容易，因为页面刷新后本地状态可能已经丢失。

更可靠的做法是同时保存最终快照：

```text
token 事件：提供低延迟的打字效果
done.text：校正这一次连接拼接出的结果
GET job：事件过期或页面重启后仍可获取权威结果
```

如果历史被裁剪，服务端可以返回 `reset` 事件及当前快照，或者让客户端改查最终结果。不要声称这套链路是 exactly-once（恰好一次）：稳定 ID、幂等消费和权威快照，才是现实中更可验证的组合。

保存完成状态时还要注意顺序。如果数据库是最终消息的权威来源，应先提交最终文本与 `completed` 状态，再发布 `done`。数据库与 Redis 之间没有自动的跨系统事务；Redis pipeline 的事务能力只覆盖 Redis 内部命令。对一致性要求更高的系统可以采用事务性 outbox，并让补偿任务幂等地重发缺失的终止事件。

## 8. 单进程方案何时需要演进到 Redis Streams？

内存事件日志只有在以下条件同时成立时才有效：

```text
原进程仍然存活
+ 重连仍落到原实例
+ Job 尚未被 TTL 或容量策略清理
```

Sticky session 只能提高“回到原实例”的概率，无法抵抗进程崩溃。多实例共享、进程重启恢复或较长重连窗口，需要外部事件日志。Redis Streams 可以充当短期、带 ID、可阻塞读取的事件日志：

```text
LLM worker -- XADD --> chat:{id}:events
     |                       |
     +-- HSET final ------> chat:{id}:meta
                             |
SSE endpoint <-- XREAD ------+
```

一个事件可这样写入：

```python
import json

async def append_event(redis, message_id: str, event: str, data: dict) -> str:
    return await redis.xadd(
        f"chat:{message_id}:events",
        {
            "event": event,
            "data": json.dumps(data, ensure_ascii=False),
        },
    )
```

消费者保存 Redis 返回的 Stream ID，并直接把它用作 SSE `id`：

```python
async def read_after(redis, stream_key: str, last_id: str):
    rows = await redis.xread(
        {stream_key: last_id},
        count=100,
        block=15_000,
    )
    return rows
```

`XREAD` 返回 ID 大于给定游标的 entry。首次订阅若要回放当前保留的全部历史，通常从 `0-0` 开始；`$` 表示只等待调用时刻之后的新事件，任务已经生成的内容会被跳过。使用 `$` 后，下一次读取必须改用上次实际收到的 ID，不能每轮都继续传 `$`。

普通 SSE 广播通常不使用同一个 `XREADGROUP` Consumer Group。Consumer Group 的目标是把消息分配给组内消费者共同处理，适合 worker 分摊任务；多个查看者各自需要完整事件序列时，应各自使用 `XREAD` 和自己的游标。

Redis 方案仍有几条边界：

- 一个阻塞中的 `XREAD` 通常占用一个 Redis 连接，连接池必须按并发 SSE 量规划；
- 不能在 Drogon/FastAPI 的 I/O 线程里调用同步阻塞客户端；
- `Last-Event-ID` 必须先验证为合法 Stream ID，不能把任意输入直接交给 Redis；
- Stream 需要 TTL 或裁剪策略，否则会无限增长；
- 裁剪窗口必须覆盖产品承诺的重连窗口，最终快照应比事件保留更久；
- Redis Streams 保存事件，不会自动解决下游 socket 背压。

逐字符执行一次 `XADD` 会放大命令数、网络往返、内存和前端渲染次数。实际项目通常按很短的时间窗口或一定大小聚合 token；具体阈值应通过首字延迟、吞吐和内存测量确定，不能照抄固定数字。

## 9. 取消为何需要两阶段，而不是立即删掉任务？

用户点击“停止”可能表示两件完全不同的事：

| 操作 | 后台生成 | 最终能得到什么 |
| --- | --- | --- |
| 关闭当前显示 | 继续 | 稍后重连或查询完整答案 |
| 取消模型生成 | 在安全点停止 | 只可能得到已经生成的部分 |

如果模型已经真正停止，系统不可能凭空补出“尚未生成的完整答案”。取消接口更适合表达请求，而不是立即宣告终止：

```text
generating
    |
    | POST /cancel
    v
cancel_requested
    |
    | worker 停止上游、排空本地 token buffer、保存 partial_text
    v
cancelled + terminal event
```

终止事件必须在部分结果和最终状态保存成功之后发布。重复取消应保持幂等；任务已经 `completed` 时，迟到的取消请求不能把它改回 `cancelled`。如果 SSE 已断开，`cancelled` 仍要写入事件日志，供下一条连接读取。

最小示例为了保持简洁，每产生一个模拟 token 才检查一次布尔标记。真实 SDK 若提供取消句柄，应在 worker 中安全调用，并明确上游已经产生但尚未 flush 的数据由谁持有。

## 10. Drogon Gateway 怎样转发上游 SSE？

如果架构是 Drogon Gateway 到 FastAPI 或模型服务，普通 `sendRequest` 风格的“完整响应回调”不能直接承担 SSE 代理。正确模型是：尽快建立下游 streaming response，异步读取上游字节，并在下游可写时继续发送。

```text
downstream client
       ^
       | writable / backpressure
       |
Drogon Gateway <--- async byte chunks --- upstream SSE
       |
       +--- downstream disconnect: stop subscription or close upstream
```

下面只表达生命周期，不是可直接编译的 Drogon API。不同 Drogon 版本的流式响应、客户端分块回调和断线通知接口可能不同，必须以项目锁定版本的头文件、官方示例和最小集成测试为准：

```cpp
// 伪代码：API 名称需要结合项目使用的 Drogon 版本验证。
auto state = std::make_shared<RelayState>();
auto response = make_stream_response();
response->set_content_type("text/event-stream; charset=utf-8");
response->add_header("Cache-Control", "no-cache, no-transform");
response->add_header("X-Accel-Buffering", "no");

upstream->on_chunk([state](std::string_view bytes) {
    // chunk 只是字节片段，不要求与 SSE 事件对齐。
    state->enqueue_bounded(bytes);
    state->request_downstream_write();
});

response->on_writable([state](auto& writer) {
    while (writer.can_write() && state->has_pending_bytes()) {
        writer.write(state->take_next_chunk());
    }
});

response->on_disconnect([state] {
    state->remove_subscriber();
    // 是否取消上游生成由产品语义决定，不能由断线隐式决定。
});
```

若 Gateway 直接代理上游 SSE，下游断开后通常也会关闭这条专属上游连接；如果业务要求生成继续，就必须让上游任务本身与该 HTTP 连接解耦，或者改为由 worker 写 Redis Streams，Gateway 只订阅事件日志。

不要在 Drogon 事件循环线程中执行同步 `XREAD BLOCK`。应使用真正异步的 Redis 客户端，或把阻塞读取放入有明确并发上限的业务线程，并把结果安全地投递回 I/O 循环。

## 11. 背压、心跳和代理缓冲为什么必须一起检查？

假设模型每秒产生 100 KiB，而移动网络客户端只能消费 10 KiB：如果每个上游 chunk 都无限追加到内存队列，一分钟就可能累积约 5.4 MiB，连接越多，放大越严重。

可靠的流式链路需要有界策略：

```text
下游跟得上 -> 持续转发
下游暂时变慢 -> 暂停读取上游或聚合事件
超过每连接队列上限 -> 断开该订阅者，允许稍后按 ID 续传
禁止 -> 无限扩张内存队列
```

具体实现取决于上游 SDK 是否支持暂停读取，以及事件是否已经保存在可回放日志中。Redis Streams 让“断开慢客户端后恢复”成为可能，却不会替 socket 自动施加背压。

SSE 长时间没有业务事件时，可以发送注释心跳：

```text
: ping

```

心跳间隔应小于链路中最短的空闲超时，包括负载均衡器、Nginx、Gateway 和客户端网络。它不是业务事件，不需要事件 ID，也不应写入 Redis 或更新业务游标。

常见响应头是：

```http
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
```

`X-Accel-Buffering` 是常见的 Nginx 相关控制头，不是通用 HTTP/SSE 标准。仅设置响应头也不保证整条链路不缓冲，还应验证 Nginx `proxy_buffering`、CDN、压缩中间件和 Gateway response buffer。压缩器可能为了凑够输出块而增加延迟，SSE 路由通常需要单独关闭压缩或通过真实链路测量首事件时间。

超时也不应只剩一个笼统的 `timeout=30`：

| 超时 | 约束的问题 |
| --- | --- |
| connect timeout | 多久无法连上上游或 Redis 就失败 |
| first-event timeout | 建连后多久还没有第一个业务事件 |
| idle timeout | 相邻事件或心跳之间允许沉默多久 |
| total timeout | 一个生成任务最多运行多久 |
| reconnect window | 历史事件至少保留多久 |

心跳能避免“空闲连接被误杀”，不能代替任务总超时，也不能证明 worker 仍在正常生成。

## 12. 常见误区：看起来能流，为什么仍不可靠？

### 误区一：响应类型是 `text/event-stream`，所以一定是流式

Content-Type 只描述语义。若上游客户端、Gateway、Nginx 或浏览器前的任一环节缓冲完整 body，用户仍会最后一次性看到结果。应测量首事件延迟，并用 `curl -N` 观察真实到达节奏。

### 误区二：一次 read 就是一个 SSE 事件

HTTP/TCP 只提供字节传输，read 边界不等于空行定义的事件边界。代理若不修改事件就转发原始字节；客户端若解析事件就必须保存残余缓冲区。

### 误区三：连接断开就取消任务更“干净”

这只有在产品语义明确为“断开即停止”时才正确。若要求刷新后继续，断开只能移除订阅者，不能隐式取消后台任务。

### 误区四：有 Redis Streams 就是 exactly-once

客户端可能在处理事件后、保存游标前断线，重连便会收到重复事件。正确目标是稳定 ID、至少一次传递、幂等处理和最终快照校正。

### 误区五：所有客户端共用一个 Consumer Group

同一 Consumer Group 会把 entry 分配给不同消费者，不会让每个查看者都拿到全量历史。SSE 广播通常使用 `XREAD`；后台 worker 分摊任务才考虑 `XREADGROUP`。

### 误区六：有 `id` 就一定能永久续传

如果内存进程重启、Stream 已裁剪或事件超过 TTL，ID 本身无法找回数据。必须定义重连窗口，并保留生命周期更长的最终快照。

### 误区七：收到 `done` 后让服务端自行关闭即可

EventSource 具有自动重连行为。客户端处理完 `done`、`cancelled` 或 `app_error` 后应主动关闭，避免终止任务反复订阅。

### 误区八：任务 ID 很随机，所以订阅接口不用鉴权

不可猜测 ID 不是授权机制。创建、订阅、查询和取消都必须校验当前用户是否有权操作该任务；无权限时常返回 404，以减少对象存在性泄露。示例为了聚焦并未实现这一层，不能原样暴露到公网。

## 13. 应该选择哪一种方案？

| 需求 | 合适的起点 | 明确限制 |
| --- | --- | --- |
| Demo、内部短任务 | 直接 FastAPI SSE | 连接通常绑定生成生命周期 |
| 断开立即省掉模型算力 | 直接 SSE，并取消上游 | 无法取回未生成内容 |
| 单进程内短时间重连 | 内存事件日志 | 不抗进程重启和跨实例调度 |
| 只要求最终答案可恢复 | 独立 worker + 数据库最终快照 | 不能逐 token 回放 |
| 多实例、短期逐事件回放 | Redis Streams + 最终数据库 | 需要连接池、TTL、裁剪和缺口处理 |
| 多 worker 分摊后台任务 | Consumer Group | 不等于 SSE 广播 |
| 长期审计每个事件 | 数据库事件表或专用日志系统 | 写放大和存储成本更高 |

不少聊天系统最终采用这样的组合：

```text
SSE                负责实时用户体验
Redis Streams      负责短期回放和跨实例共享
MySQL/PostgreSQL   负责最终消息与业务状态
```

这不是所有项目都必须采用的固定架构。若业务只关心最终答案，保存每个 token 反而增加复杂度；若连接断开就应取消，直接 SSE 更简单也更节省资源。

## 14. 如何验证这条链路确实可靠？

不要只在本机看一次“逐字出现”。至少应验证以下故障点：

1. 编码器产生的每个事件都有终止空行，多行 data 和 UTF-8 能正确解析；
2. 客户端在任意事件后断开，携带该 ID 重连时只收到后续事件；
3. 连接断开后后台任务仍按产品语义继续，最终查询接口能返回完整快照；
4. `done`、`cancelled`、`app_error` 只出现一个，迟到的取消不会覆盖 completed；
5. Nginx、Gateway 和压缩中间件接入后，首事件仍及时到达；
6. 慢客户端达到队列上限时触发预定策略，进程内存不会无限增长；
7. Stream 裁剪、Redis 短暂失败或 Web 进程重启时，客户端能降级到最终快照；
8. 无权限用户无法订阅、查询或取消其他用户的任务。

性能测试应在接近生产的代理链路和并发量下进行，分别记录首事件延迟、事件间隔、每连接待发送字节、Redis 连接占用和重连成功率。一次本机 curl 成功不能证明代理、负载均衡和慢网络下仍然正确。

## 15. 总结

开头“模型逐字生成，浏览器却最后一次性显示”的直接原因通常是链路中某一层读取了完整 body 或进行了缓冲。把 Content-Type 改成 `text/event-stream` 并不能制造流式传输；上游读取、Gateway 写入和中间代理都必须允许数据持续前进。

更重要的是，SSE 只负责当前 HTTP 连接上的传输，不负责后台任务、持久化或恰好一次交付。要支持断线恢复，应当：

1. 将生成任务与 SSE 连接解耦；
2. 为事件分配稳定 ID，并按 `Last-Event-ID` 回放；
3. 按至少一次语义设计客户端去重；
4. 保存生命周期更长的最终快照；
5. 对慢客户端、心跳、超时、裁剪和取消给出有界策略。

最实用的落地建议是：先明确“断开是否应该取消生成”这一产品语义，再选择直接 SSE、内存日志或 Redis Streams。这个选择比先挑框架 API 更能决定整条链路是否正确。

## 参考资料

- [WHATWG：Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [FastAPI：StreamingResponse](https://fastapi.tiangolo.com/advanced/custom-response/#streamingresponse)
- [Redis：XADD](https://redis.io/docs/latest/commands/xadd/)
- [Redis：XREAD](https://redis.io/docs/latest/commands/xread/)
- [Redis：XREADGROUP](https://redis.io/docs/latest/commands/xreadgroup/)
- [Drogon 官方仓库](https://github.com/drogonframework/drogon)
