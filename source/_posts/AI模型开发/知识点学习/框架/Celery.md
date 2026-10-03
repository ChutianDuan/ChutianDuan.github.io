---
title: "Celery 任务提交成功，为什么仍会丢或重复？从 FastAPI 到幂等重试"
date: 2026-07-13 18:43:42
updated: 2026-07-13 18:43:42
categories:
  - "学习"
  - "AI 模型开发"
  - "知识点学习"
  - "框架"
permalink: /notes/ai模型开发/知识点学习/框架/celery/
series: "AI 模型开发"
---

把耗时操作改成 `task.delay()` 很容易：HTTP 接口立即返回 task ID，worker 在后台处理文件、发送通知或生成 embedding。

真正困难的是失败窗口：API 已写入业务记录但消息没发出去；worker 已扣费却在 ack 前崩溃；调用方超时后重复提交；周期任务上一轮没结束，下一轮又开始。Celery 能提高任务投递和执行的可靠性，却不会自动提供业务上的 exactly-once。

本文围绕一个核心问题展开：

> 当消息可能重复投递、worker 可能中途退出、外部服务可能暂时失败时，怎样让任务仍然得到正确的业务结果？

示例以 Celery 5.6 的稳定文档为参考，使用 FastAPI + Celery + Redis 展示结构。第三方 API 会变化，实际项目应锁定依赖版本并以对应版本文档为准。

## 一、Celery 解决了什么

Celery 把一次后台任务拆成几个角色：

```text
FastAPI / Producer
       |
       | task message
       v
Broker (Redis / RabbitMQ)
       |
       v
Celery Worker ------> 外部 API / 文件 / 数据库 / GPU
       |
       v
Result Backend（可选，保存短期状态或返回值）
```

- Producer：创建任务消息；
- Broker：排队并把消息交给 worker；
- Worker：执行任务函数；
- Result Backend：保存 `SUCCESS`、`FAILURE` 等结果，非必需；
- Beat：发布周期任务，本身不执行任务。

Celery 适合长耗时、需要排队、重试、路由和独立扩容的后台工作。它不应被当作数据库事务、永久审计系统或同步 RPC 的替代品。

## 二、为什么 `PENDING` 不等于“正在排队”

Celery 常见状态包括：

| 状态 | 含义 |
| --- | --- |
| `PENDING` | backend 没有该 task ID 的已知状态，可能未入队、排队中、过期或 ID 错误 |
| `STARTED` | worker 已开始，默认不一定记录 |
| `RETRY` | 任务已安排重试 |
| `SUCCESS` | 返回成功 |
| `FAILURE` | 最终失败 |
| `REVOKED` | 被撤销，但不保证已运行的副作用回滚 |

因此，不能只靠 `AsyncResult(task_id).state` 维护业务任务列表。订单、文档解析和索引构建应在业务数据库保存自己的状态、所有者、进度和错误；Result Backend 更适合短期调试或小结果查询。

## 三、四个最重要的失败窗口

### 1. API 先返回，消息发布失败

如果接口在 broker 确认消息前就返回，客户端拿到 task ID，但队列里可能没有任务。Celery 的 publish retry 能处理部分临时连接故障，却不能跨越进程崩溃等所有场景。

### 2. 业务记录已提交，消息没发布

数据库事务与 Redis/RabbitMQ 发布不是同一事务：

```text
INSERT job -> COMMIT -> 进程崩溃 -> apply_async 尚未执行
```

需要更强保证时，可采用 transactional outbox：同一数据库事务写入 job 和 outbox，再由独立发布器可靠投递。定时扫描未投递 job 是较简单的补偿方案。

### 3. 副作用完成，ack 之前 worker 崩溃

late ack 下消息可能重新投递，另一个 worker 会再次执行。若任务是“扣款”“发券”或“发通知”，就可能重复。

### 4. 调用方超时后重复提交

第一次提交可能已成功，只是响应丢失。调用方重试会创建第二个任务。解决它需要业务 idempotency key，而不是随机生成两个 task ID。

这四个窗口说明：可靠消息通常追求至少一次处理，业务正确性依赖幂等和对账补偿。

## 四、最小项目结构

```text
project/
├── app.py
├── celery_app.py
├── tasks.py
└── job_store.py
```

依赖应加入项目自己的依赖文件，并在虚拟环境中安装。不要把 broker 密码写进源码或提交 `.env`。

### `celery_app.py`

```python
import os

from celery import Celery
from kombu import Exchange, Queue

broker_url = os.environ["CELERY_BROKER_URL"]
result_backend = os.environ.get("CELERY_RESULT_BACKEND")

celery_app = Celery(
    "document_jobs",
    broker=broker_url,
    backend=result_backend,
    include=["tasks"],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    enable_utc=True,
    timezone="Asia/Shanghai",
    task_track_started=True,
    result_expires=3600,
    task_publish_retry=True,
    task_publish_retry_policy={
        "max_retries": 3,
        "interval_start": 0.2,
        "interval_step": 0.5,
        "interval_max": 2.0,
    },
    worker_prefetch_multiplier=1,
    # Celery 5.6：限制 worker 内存中持有的 ETA/countdown 任务。
    worker_eta_task_limit=1000,
    task_queues=(
        Queue("default", Exchange("default"), routing_key="default"),
        Queue("documents", Exchange("documents"), routing_key="documents"),
        Queue("gpu", Exchange("gpu"), routing_key="gpu"),
    ),
    task_routes={
        "tasks.process_document": {
            "queue": "documents",
            "routing_key": "documents",
        },
        "tasks.build_embeddings": {
            "queue": "gpu",
            "routing_key": "gpu",
        },
    },
)
```

这里有几个刻意选择：

- 只允许 JSON，避免不受信任 pickle 反序列化风险；
- broker/backend 从环境读取，不硬编码凭证；
- 长短任务分队列，避免长 PDF 阻塞短任务；
- prefetch multiplier 为 1，减少一个 worker 囤积大量长任务；
- Result Backend 可选，因为业务状态不应只放在这里。

`worker_eta_task_limit` 是 Celery 5.6 的配置；若项目锁定旧版本，应删除而不是假设可用。ETA/countdown 任务会被 worker 提前取到内存，且不完全受普通 prefetch 窗口约束，因此不适合一次发布几十万个远期任务。

## 五、先建立业务任务记录，再投递 Celery 消息

业务表可包含：

```sql
CREATE TABLE jobs (
    id VARCHAR(36) PRIMARY KEY,
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    owner_id VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    result_location TEXT,
    error_code VARCHAR(64),
    error_message TEXT,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);
```

`idempotency_key` 应来自业务请求，例如“租户 + 文档内容哈希 + 处理版本”，而不是每次随机 UUID：

```python
import hashlib

def document_job_key(
    tenant_id: str,
    content_sha256: str,
    pipeline_version: str,
) -> str:
    raw = f"{tenant_id}\0{content_sha256}\0{pipeline_version}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()

key = document_job_key("tenant-7", "abc123", "pipeline-v4")
assert key == document_job_key("tenant-7", "abc123", "pipeline-v4")
```

数据库的 unique constraint 才能抵抗两个 API 进程同时提交相同请求。应用层先查再插仍有竞态，应捕获唯一键冲突并返回已存在 job。

## 六、FastAPI 提交接口：task ID 不是访问凭证

下面省略具体 ORM，`job_store` 表示项目已有的数据访问层：

```python
from uuid import UUID

from fastapi import FastAPI, Header, HTTPException, status
from pydantic import BaseModel

from job_store import JobConflict, job_store
from tasks import process_document

app = FastAPI()

class DocumentJobRequest(BaseModel):
    document_id: UUID
    pipeline_version: str

@app.post("/jobs", status_code=status.HTTP_202_ACCEPTED)
def create_job(
    body: DocumentJobRequest,
    tenant_id: str = Header(alias="X-Tenant-ID"),
) -> dict[str, str]:
    try:
        job = job_store.create_or_get(
            tenant_id=tenant_id,
            document_id=str(body.document_id),
            pipeline_version=body.pipeline_version,
        )
    except JobConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    if job.should_publish:
        process_document.apply_async(
            args=[job.id],
            task_id=job.id,
            queue="documents",
        )
        job_store.mark_published(job.id)

    return {"job_id": job.id, "status": job.status}

@app.get("/jobs/{job_id}")
def get_job(
    job_id: str,
    tenant_id: str = Header(alias="X-Tenant-ID"),
) -> dict[str, object]:
    job = job_store.get_for_tenant(job_id, tenant_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job.to_public_dict()
```

接口返回 `202 Accepted`，表示请求已接受但尚未完成。查询时必须按当前租户/用户过滤，不能认为“知道 UUID 就有权限”。

示例仍存在“数据库已创建、消息未发布”的间隙。低风险项目可用扫描器补发 `created` 但未 `published` 的 job；严格场景应使用 outbox。即使复用 `task_id=job.id`，也不能依赖 Celery 自动去重，相同 ID 的重复消息仍要由业务幂等处理。

## 七、任务实现：只重试瞬时错误

```python
from celery.exceptions import SoftTimeLimitExceeded

from celery_app import celery_app
from job_store import job_store

class TemporaryDependencyError(RuntimeError):
    """超时、限流或暂时不可用，稍后重试可能成功。"""

class PermanentInputError(ValueError):
    """文件损坏或参数非法，重试不会恢复。"""

@celery_app.task(
    bind=True,
    name="tasks.process_document",
    acks_late=True,
    reject_on_worker_lost=True,
    autoretry_for=(TemporaryDependencyError,),
    retry_backoff=True,
    retry_backoff_max=300,
    retry_jitter=True,
    max_retries=5,
    soft_time_limit=300,
    time_limit=330,
)
def process_document(self, job_id: str) -> dict[str, object]:
    job = job_store.get(job_id)
    if job is None:
        raise PermanentInputError(f"unknown job: {job_id}")

    # 已成功的重复消息直接返回已有结果。
    if job.status == "succeeded":
        return {"job_id": job_id, "result": job.result_location}

    # 数据库实现应使用行锁、租约或原子条件更新，避免两个 worker
    # 同时 claim 同一个 job。这里把并发控制封装在 claim() 中。
    if not job_store.claim(job_id, celery_task_id=self.request.id):
        return {"job_id": job_id, "status": "already_claimed"}

    try:
        job_store.update_progress(job_id, step="parse", progress=10)
        source = job_store.load_source(job.document_id)
        if not source.is_valid:
            raise PermanentInputError("document is invalid")

        parsed = parse_with_explicit_io_timeouts(source)
        job_store.update_progress(job_id, step="store", progress=80)

        # result_location 应指向数据库/对象存储，不把大结果塞进 Redis。
        result_location = store_result_idempotently(
            job_id=job_id,
            parsed=parsed,
        )
        job_store.mark_succeeded(job_id, result_location)
        return {"job_id": job_id, "result": result_location}
    except SoftTimeLimitExceeded:
        job_store.release_for_retry(job_id, "soft_time_limit")
        raise
    except TemporaryDependencyError:
        job_store.release_for_retry(job_id, "temporary_dependency")
        raise
    except PermanentInputError as exc:
        job_store.mark_failed(job_id, "invalid_input", str(exc))
        raise
    except Exception as exc:
        job_store.mark_failed(job_id, "unexpected_error", str(exc))
        raise
```

`parse_with_explicit_io_timeouts` 和 `store_result_idempotently` 是项目需要实现的业务函数，不是 Celery API。它们强调两个原则：网络、数据库、对象存储调用本身要设置连接/读取超时；写结果要以 job ID 做 upsert 或唯一约束。

### 为什么不写 `except Exception: self.retry()`

损坏 PDF、无权限、schema 错误和代码 bug 重试五次仍会失败，只会占队列并延迟告警。重试应针对超时、限流、短暂 5xx 等明确瞬时错误；永久错误立即失败。

指数退避与 jitter 能避免依赖恢复时所有任务同时重试形成惊群。

## 八、幂等不只是“成功后查一下状态”

正确幂等通常需要多层约束：

### 提交层

业务 idempotency key + 数据库唯一约束，防止重复创建 job。

### 执行层

用数据库行锁、租约或原子状态迁移，只允许一个 worker 获得执行权。租约要能在 worker 死亡后过期，否则任务会永远卡在 `running`。

### 写入层

结果表以 job ID/业务键唯一，使用 upsert 或条件更新。不要先“查是否存在”再无约束插入。

### 外部副作用层

调用支付、邮件或第三方 API 时，把同一 idempotency key 传给对方；若对方不支持幂等，就需要本地发送记录、状态机和对账补偿。

最难的窗口是：外部系统已成功，但 worker 在本地记录成功前崩溃。仅靠 Celery 无法原子提交跨系统事务，必须依赖对方幂等、查询接口或人工/自动对账。

## 九、`acks_late` 到底改变了什么

默认 early ack 会在任务执行前确认消息，worker 中途丢失时通常不会因该消息再次执行；好处是降低重复，风险是任务未完成却不再投递。

`acks_late=True` 把确认推迟到任务返回之后，worker 丢失时 broker 有机会重投；代价是同一任务可能执行多次。因此官方明确建议只对幂等任务使用。

还有一个容易漏掉的细节：即使 late ack，执行任务的子进程被终止时，Celery 在一些情形下仍会确认消息。若确实希望 worker lost 时拒绝并重投，需要考虑 `reject_on_worker_lost=True` / `task_reject_on_worker_lost`。

这仍不是 exactly-once，并可能让确定性 OOM 或崩溃任务反复杀 worker。必须配合重试上限、死信/隔离队列和告警。

## 十、prefetch 为什么让队列看起来“不公平”

Celery 默认 prefetch 数约为：

```text
worker_prefetch_multiplier × concurrency slots
```

如果 multiplier 为 4、并发进程为 8，一个 worker 可提前保留多条消息。任务都很短时能提高吞吐；任务耗时从 1 秒到 30 分钟不等时，一个 worker 可能囤积慢任务，其他 worker 却空闲。

长任务常从下面配置起步：

```python
celery_app.conf.worker_prefetch_multiplier = 1
```

这表示把预取限制到每个执行槽一个附近，不是完全禁用 broker prefetch。Celery 5.6 在 Redis broker 下还提供 `worker_disable_prefetch`，让 worker 仅在执行槽空闲时取新任务；它并非所有 broker 都支持，不能作为跨 broker 通用配置。

## 十一、CPU、I/O 与 GPU 任务为什么应分队列

```text
default   -> 短小业务任务
documents -> PDF/OCR/解析等长 CPU 或 I/O 任务
gpu       -> embedding / 推理
```

不同 worker 可以独立扩缩容：

```bash
celery -A celery_app:celery_app worker -Q documents --concurrency=4 -l INFO
celery -A celery_app:celery_app worker -Q gpu --concurrency=1 -l INFO
```

GPU worker 常从单进程开始，避免每个 prefork 子进程各加载一份模型导致显存翻倍。模型可在 worker 进程内惰性缓存，但要注意 fork、CUDA 初始化和连接对象的进程安全，按所用框架文档初始化。

I/O 任务并发可比 CPU 核数高一些，CPU 密集任务通常接近可用核心数起步。结论必须通过资源与队列延迟监控验证。

## 十二、任务参数只传引用，不传大对象

适合放入消息：

- job/document/user ID；
- 小型字符串、数字、布尔和 JSON；
- 对象存储 key；
- 处理版本与幂等键。

不适合放入消息：

- `Request`、`UploadFile`、数据库 Session；
- 打开的文件句柄；
- 模型实例；
- 二进制 PDF、图片或大向量；
- 密钥与不必要的个人数据。

消息会经过 broker、日志和失败存储。大 payload 增加传输、内存和重投成本，也扩大敏感数据暴露面。FastAPI 应先把文件流式写入对象存储，再只传 object key；worker 使用自己的短生命周期连接读取。

## 十三、结果后端不应保存大结果或永久历史

若只需要 fire-and-forget，可为任务设置 `ignore_result=True`；若需要状态，设置合理 `result_expires`。大文本、embedding 和 PDF 结果应存数据库/对象存储，Celery 只返回引用。

业务状态表是权限、审计、分页和长期查询的来源；Result Backend 是 Celery 协调与短期结果设施。两者职责不同。

另外，`AsyncResult.get()` 会阻塞。HTTP 提交接口若调用：

```python
def bad_synchronous_endpoint(job_id: str) -> object:
    result = process_document.delay(job_id)
    return result.get(timeout=300)
```

就把异步队列重新变成了慢同步 RPC。需要即时结果的轻任务应直接调用合适服务；长任务使用 202 + 查询、Webhook 或 SSE 推送状态。

## 十四、进度更新应该写在哪里

Celery 自定义状态可用于临时展示：

```python
@celery_app.task(bind=True)
def demo_progress(self) -> dict[str, int]:
    for progress in (10, 50, 90):
        self.update_state(
            state="PROGRESS",
            meta={"progress": progress},
        )
    return {"progress": 100}
```

关键任务还应更新业务表：

```text
job_id, status, progress, current_step,
attempt_count, lease_until, error_code,
created_at, started_at, finished_at
```

进度不必假装精确。解析 100 页 PDF 可以按页计数；无法估计的模型任务更适合报告阶段而不是从 37% 缓慢爬到 99%。更新频率也要限制，避免进度写入反而成为数据库瓶颈。

## 十五、超时应先在依赖调用处设置

任务可能卡在 DNS、连接、读取、数据库锁或子进程。优先为每个 I/O 操作设置明确 timeout，并让任务可取消、可清理。

`soft_time_limit` 会抛出 `SoftTimeLimitExceeded`，任务有机会清理；`time_limit` 是强制终止的最后防线。硬终止可能让临时文件、锁和外部操作处于未知状态，不能代替正常超时。

定时任务、GPU kernel 或 C 扩展对软信号的响应还取决于 worker pool 和平台。上线前要用真实卡死场景验证，而不是只读配置。

## 十六、Beat 只负责发布，且要防止周期任务重叠

```python
from celery.schedules import crontab

celery_app.conf.beat_schedule = {
    "cleanup-expired-results": {
        "task": "tasks.cleanup_expired_results",
        "schedule": crontab(hour=3, minute=0),
    }
}
```

需要 worker 才会真正执行；通常只运行一个该 schedule 的 beat 实例，否则每个 scheduler 都会发布一份任务。

Beat 不保证上一轮完成后才发布下一轮。如果清理需要 20 分钟却每 10 分钟触发，就会重叠。任务仍需分布式锁、租约或幂等状态机，并考虑锁持有者崩溃后的过期恢复。

大量远期 `countdown`/ETA 任务可能长期占 worker 内存。数天、数月后的业务计划更适合数据库调度表 + 周期扫描，或专用调度系统。

## 十七、什么时候不用 Celery

### FastAPI `BackgroundTasks`

适合很轻、与当前进程绑定、失败可接受的收尾操作。进程退出会丢失，没有独立 broker、跨机 worker 和持久重试。

### 同步调用

用户必须立即得到结果、耗时稳定且在 HTTP SLO 内时，同步更简单。不要为了“架构感”给 20 ms 计算加消息队列。

### 工作流引擎

跨天、多步骤、人工审批、强可视化和复杂补偿的业务，专用 durable workflow 系统可能比 Celery Canvas 更合适。

### 流式模型服务

交互式 LLM token streaming 需要持续连接、动态 batching 和取消，通常由专用推理服务处理；Celery 更适合批量 embedding、离线评测和文档摄取。

## 十八、监控不能只看 worker 在线

至少监控：

- 每队列 ready/reserved/active 数；
- 最老消息等待时间，而不只是队列长度；
- 发布失败和 broker 连接错误；
- 成功、失败、重试、拒绝与撤销率；
- 排队耗时和执行耗时的 P50/P95/P99；
- 每种错误码、重试次数和最终失败；
- worker 心跳、重启、OOM、内存和 CPU/GPU；
- stuck `running` job、过期租约和 outbox 积压。

常用诊断命令：

```bash
celery -A celery_app:celery_app inspect ping
celery -A celery_app:celery_app inspect registered
celery -A celery_app:celery_app inspect active
celery -A celery_app:celery_app inspect reserved
```

inspect 依赖 worker 响应，生产监控还应从 broker、业务库和指标系统观察，不能把一次 ping 当作端到端健康。

## 十九、常见症状与排查

### task ID 一直 PENDING

检查 producer 是否确认发布、worker 是否消费目标队列、任务名是否注册、backend 是否配置/过期，以及 ID 是否属于当前环境。PENDING 本身无法区分这些原因。

### 某些 worker 很忙，其他 worker 空闲

检查队列路由、prefetch、任务长度差异和 concurrency。长短任务应分队列。

### 同一业务执行两次

检查调用方重试、publish 重试、late ack 重投、手工补偿和 beat 多实例。修复点通常是业务 idempotency key、唯一约束和幂等副作用，而不是关闭所有重试。

### worker OOM 后任务消失

核对 ack 策略与 `reject_on_worker_lost`，同时修复 OOM 根因。盲目重投同一个确定性超大任务会形成崩溃循环。

### 外部 API 故障时队列爆炸

使用超时、有限重试、指数退避、jitter、熔断/限流和独立队列。Celery `rate_limit` 是每 worker 实例，不天然是全局限流。

### Redis 结果越来越大

缩短 `result_expires`、忽略无用结果，并把大结果移到业务存储。还要检查客户端是否真的需要 Celery backend。

## 二十、上线检查清单

1. 任务名、参数 schema 与 serializer 是否固定；
2. broker/backend 凭证是否来自安全配置；
3. 是否有业务 idempotency key 和唯一约束；
4. DB commit 与消息发布间隙如何补偿；
5. late ack 任务是否真正幂等；
6. 瞬时错误与永久错误是否分开；
7. 每个网络调用是否有 timeout；
8. 重试是否有限、退避并带 jitter；
9. CPU、I/O、GPU 和长短任务是否隔离；
10. prefetch 与 concurrency 是否按负载验证；
11. Result Backend 是否有过期且不存大对象；
12. 周期任务是否防重叠且只有一个 scheduler；
13. 能否发现并修复 stuck job、过期租约和 outbox 积压；
14. 是否测试 worker kill、broker 断开、依赖 5xx 和重复提交；
15. 是否有死信/隔离、人工补偿和对账路径。

## 官方资料

- [Celery：First Steps](https://docs.celeryq.dev/en/stable/getting-started/first-steps-with-celery.html)
- [Celery：Tasks、ack 与 retry](https://docs.celeryq.dev/en/stable/userguide/tasks.html)
- [Celery：Calling Tasks](https://docs.celeryq.dev/en/stable/userguide/calling.html)
- [Celery：Configuration](https://docs.celeryq.dev/en/stable/userguide/configuration.html)
- [Celery：Optimizing](https://docs.celeryq.dev/en/stable/userguide/optimizing.html)
- [FastAPI：Background Tasks](https://fastapi.tiangolo.com/tutorial/background-tasks/)

## 总结

Celery 的价值是把耗时工作放进可路由、可扩容、可重试的队列，但消息队列无法替业务完成 exactly-once。

可靠任务的核心是：提交端用幂等键抵抗重复请求，执行端用状态机/租约抵抗并发 worker，写入端用唯一约束和幂等 API 抵抗重复副作用，再用 late ack、有限退避重试和补偿扫描减少丢失窗口。

一句话记住：

> 把 Celery 当作“任务至少会被尝试”，把业务代码设计成“尝试多次仍只有一次有效结果”。
