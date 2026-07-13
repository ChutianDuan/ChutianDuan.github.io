---
title: "FastAPI 写了 `async def`，为什么一个慢请求仍会拖住整个服务？"
date: 2026-07-13 18:55:56
updated: 2026-07-13 18:55:56
categories:
  - "学习"
  - "AI 模型开发"
  - "知识点学习"
  - "框架"
permalink: /notes/ai模型开发/知识点学习/框架/fasthapi/
series: "AI 模型开发"
---

FastAPI 很容易给人一种错觉：只要把接口写成 `async def`，服务就自动拥有了高并发能力。开发环境中只有一个请求时，这个错觉尤其牢固；等到线上同时出现文件上传、数据库查询、向量检索和模型推理，接口延迟才突然从几十毫秒变成数秒。

问题不在 `async` 这个关键字本身，而在于：**请求处理过程中究竟在等待什么，这段等待能不能把执行权交还事件循环？**

本文用一个 RAG 查询接口讲清 FastAPI 的关键工程边界：参数从哪里来、依赖怎样管理、资源何时创建、同步代码为什么阻塞、异常如何变成稳定响应，以及测试怎样覆盖真实生命周期。

## 一、FastAPI 到底替我们做了什么

下面这个接口只有几行：

```python
from fastapi import FastAPI

app = FastAPI()

@app.get("/hello")
async def hello(name: str) -> dict[str, str]:
    return {"message": f"hello, {name}"}
```

启动开发服务：

```bash
uvicorn main:app --reload
```

访问 `/hello?name=Alice` 时，FastAPI 已经完成了这些工作：

1. 根据路径和 HTTP 方法选择函数；
2. 从查询字符串解析 `name`；
3. 按类型注解校验数据；
4. 调用路径函数；
5. 将返回值序列化成 JSON；
6. 根据类型和路由信息生成 OpenAPI 文档。

开发环境可查看 `/docs`。`--reload` 只适合开发；生产中的进程守护、TLS、超时、日志、容量和滚动发布仍需要部署层负责。

## 二、先回答核心问题：`async def` 为什么还会阻塞

### 1. 并发不是并行

异步并发适合“等待很多次”的任务。例如服务请求数据库时，网络包还没回来，协程可以暂时让出执行权，让同一线程处理其他请求：

```python
@app.get("/documents/{document_id}")
async def get_document(document_id: int):
    document = await async_database.fetch(document_id)
    return document
```

关键不在函数声明，而在内部调用确实支持 `await`。下面的代码虽然写成 `async def`，`time.sleep()` 仍会阻塞事件循环：

```python
import time

@app.get("/bad")
async def bad_endpoint():
    time.sleep(2)  # 两秒内，当前事件循环线程不能处理其他协程。
    return {"ok": True}
```

异步等待应使用：

```python
import asyncio

@app.get("/wait")
async def wait_endpoint():
    await asyncio.sleep(2)
    return {"ok": True}
```

### 2. `def` 路由并不是错误

FastAPI 调用普通 `def` 路由和普通 `def` 依赖时，会把它们放入外部线程池，避免它们直接阻塞事件循环。因此使用只提供同步 API 的数据库客户端时，可以把路径函数声明为 `def`。

但要注意一个容易忽略的区别：**普通工具函数不会因为被 `async def` 路由调用，就自动进入线程池。**

```python
def blocking_sdk_call() -> str:
    # 同步网络请求、同步文件读取或耗时计算
    ...

@app.get("/still-bad")
async def still_bad():
    result = blocking_sdk_call()  # 直接执行，仍会阻塞事件循环。
    return {"result": result}
```

确实需要在异步路由里调用短时同步 I/O 时，可以显式送入线程池：

```python
from fastapi.concurrency import run_in_threadpool

@app.get("/legacy-sdk")
async def call_legacy_sdk():
    result = await run_in_threadpool(blocking_sdk_call)
    return {"result": result}
```

线程池不是 CPU 加速器。大模型推理、OCR、视频转码等长时间 CPU/GPU 工作，会占住线程、内存或显存。它们通常应由独立推理服务或任务队列执行，API 进程只负责校验、提交、限流和返回结果。

### 3. 一个实用判断表

| 工作 | 推荐入口 | 原因 |
|---|---|---|
| 支持异步的 HTTP/数据库客户端 | `async def` + `await` | 等待时可让出事件循环 |
| 只提供同步 API 的短时 I/O | `def` 路由，或显式线程池 | 避免直接阻塞事件循环 |
| 很短的纯 Python 逻辑 | `async def` 中直接执行 | 调度成本没有意义 |
| 长时间 CPU/GPU 推理 | 独立服务/任务系统 | 线程池不能解决算力争用 |
| 需要可靠重试的离线任务 | Celery 等任务队列 | 与 Web 进程生命周期解耦 |

## 三、参数从哪里来：让接口契约一眼可见

FastAPI 会根据路由和类型推断参数来源：

```python
from typing import Annotated

from fastapi import Body, Header, Path, Query
from pydantic import BaseModel, Field

class SearchRequest(BaseModel):
    question: str = Field(min_length=2, max_length=2000)
    top_k: int = Field(default=5, ge=1, le=20)

@app.post("/documents/{document_id}/search")
async def search(
    document_id: Annotated[int, Path(gt=0)],
    request: SearchRequest,                         # JSON 请求体
    trace: Annotated[bool, Query()] = False,       # 查询参数
    x_api_key: Annotated[str | None, Header()] = None,
):
    ...
```

- 路径中的 `{document_id}` 是路径参数；
- `BaseModel` 对象通常来自 JSON 请求体；
- `Query()`、`Header()` 明确标注查询参数和请求头；
- 不满足约束的请求在进入业务函数前就会得到校验错误。

类型校验只代表“数据形状合法”，不代表“业务允许”。例如 `document_id > 0` 不能证明当前用户有权读取该文档，权限仍要在依赖或业务层校验。

## 四、完整示例：一个边界清楚的 RAG 查询 API

下面的示例只依赖 FastAPI 自带的 Pydantic 能力。它没有真的连接向量库，而是注入一个异步 `Retriever`，这样既能展示真实服务边界，也能在测试中换成可控实现。

文件 `app.py`：

```python
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Annotated, Protocol

from fastapi import Depends, FastAPI, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

class SearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    question: str = Field(min_length=2, max_length=2000)
    top_k: int = Field(default=3, ge=1, le=20)

class Chunk(BaseModel):
    chunk_id: int
    text: str
    score: float

class SearchResponse(BaseModel):
    request_id: str
    hits: list[Chunk]

class ErrorBody(BaseModel):
    request_id: str
    code: str
    message: str

class Retriever(Protocol):
    async def search(self, question: str, top_k: int) -> list[Chunk]: ...

class DemoRetriever:
    async def search(self, question: str, top_k: int) -> list[Chunk]:
        await asyncio.sleep(0)  # 模拟可让出执行权的异步 I/O。
        candidates = [
            Chunk(chunk_id=101, text="async 用于协作式并发。", score=0.92),
            Chunk(chunk_id=102, text="CPU 密集任务需要独立容量。", score=0.86),
        ]
        return candidates[:top_k]

    async def close(self) -> None:
        pass

@dataclass(frozen=True)
class Settings:
    api_key: str
    search_timeout_seconds: float = 2.0

class AppError(Exception):
    def __init__(self, code: str, message: str, status_code: int) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code

def get_settings(request: Request) -> Settings:
    return request.app.state.settings

def get_retriever(request: Request) -> Retriever:
    return request.app.state.retriever

def require_api_key(
    settings: Annotated[Settings, Depends(get_settings)],
    x_api_key: Annotated[str | None, Header()] = None,
) -> None:
    # 示例使用普通比较；真实密钥服务应配合 HTTPS、安全存储和轮换策略。
    if x_api_key != settings.api_key:
        raise AppError("unauthorized", "invalid API key", 401)

def create_app(
    settings: Settings | None = None,
    retriever: Retriever | None = None,
) -> FastAPI:
    resolved_settings = settings or Settings(api_key="dev-only-key")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        resource = retriever or DemoRetriever()
        app.state.settings = resolved_settings
        app.state.retriever = resource
        try:
            yield
        finally:
            close = getattr(resource, "close", None)
            if close is not None:
                await close()

    app = FastAPI(title="RAG Search API", version="1.0.0", lifespan=lifespan)

    @app.middleware("http")
    async def add_request_context(request: Request, call_next):
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
        request.state.request_id = request_id
        started = time.perf_counter()
        response = await call_next(request)
        response.headers["x-request-id"] = request_id
        response.headers["x-process-time-ms"] = (
            f"{(time.perf_counter() - started) * 1000:.2f}"
        )
        return response

    @app.exception_handler(AppError)
    async def handle_app_error(request: Request, exc: AppError):
        body = ErrorBody(
            request_id=request.state.request_id,
            code=exc.code,
            message=exc.message,
        )
        return JSONResponse(
            status_code=exc.status_code,
            content=body.model_dump(),
        )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post(
        "/v1/search",
        response_model=SearchResponse,
        responses={401: {"model": ErrorBody}, 504: {"model": ErrorBody}},
        dependencies=[Depends(require_api_key)],
    )
    async def search(
        body: SearchRequest,
        request: Request,
        engine: Annotated[Retriever, Depends(get_retriever)],
        config: Annotated[Settings, Depends(get_settings)],
    ) -> SearchResponse:
        try:
            hits = await asyncio.wait_for(
                engine.search(body.question, body.top_k),
                timeout=config.search_timeout_seconds,
            )
        except TimeoutError as exc:
            raise AppError(
                "retriever_timeout", "retrieval timed out", 504
            ) from exc
        except AppError:
            raise
        except Exception as exc:
            logger.exception("retriever failed")
            raise AppError(
                "retriever_unavailable", "retrieval is temporarily unavailable", 503
            ) from exc

        return SearchResponse(
            request_id=request.state.request_id,
            hits=hits,
        )

    return app

app = create_app()
```

启动：

```bash
uvicorn app:app --reload
```

请求：

```bash
curl -X POST 'http://127.0.0.1:8000/v1/search' \
  -H 'content-type: application/json' \
  -H 'x-api-key: dev-only-key' \
  -d '{"question":"async 为什么会阻塞？","top_k":2}'
```

可能得到：

```json
{
  "request_id": "5f7c...",
  "hits": [
    {"chunk_id": 101, "text": "async 用于协作式并发。", "score": 0.92},
    {"chunk_id": 102, "text": "CPU 密集任务需要独立容量。", "score": 0.86}
  ]
}
```

### 这个示例解决了什么

`SearchRequest` 拒绝未知字段，避免客户端把拼错的 `topk` 当作有效请求；`response_model` 又约束输出，防止内部对象和敏感字段意外透传。

`Depends` 在这里表达的是请求依赖图：路由依赖 API Key 校验，同时注入配置和检索器。它不是“全局单例容器”，资源的真正创建和释放由 lifespan 管理。

`asyncio.wait_for()` 限制单次检索等待时间。超时只终止当前等待；下游是否真正停止工作，取决于下游库是否正确响应取消。因此数据库和 HTTP 客户端本身也要配置连接、读取和总超时。

统一错误响应不应把原始异常文本返回给客户端。数据库地址、SQL、文件路径和上游响应可能出现在异常中，应完整写服务端日志，对外只返回稳定错误码和安全描述。

## 五、lifespan：资源不是导入模块时随手创建的

数据库连接池、可复用 HTTP Client、模型句柄和检索器都具有生命周期。把它们写在模块顶层会带来几个问题：

- 导入模块就建立连接，测试收集阶段也会触发副作用；
- 资源无法保证在退出时关闭；
- 多 worker 下每个进程都会各创建一份；
- 测试不容易替换资源。

FastAPI 推荐使用 `lifespan`：`yield` 之前初始化，之后清理。若给应用传入 lifespan，旧式 `startup`/`shutdown` 事件不会再同时执行，因此不要混用两套机制。

模型服务尤其要关注多进程：运行 4 个 Uvicorn worker 意味着 4 个独立进程。通常每个进程都会加载自己的 Python 对象；一个 8 GiB 模型不会因为使用 FastAPI 就自动在 4 个 worker 间共享。先做容量计算，再决定“单模型进程 + 多 API 客户端”还是“每 worker 一份模型”。

## 六、用 TestClient 测真实生命周期

测试文件 `test_app.py`：

```python
from fastapi.testclient import TestClient

from app import Chunk, Settings, create_app

class FakeRetriever:
    def __init__(self) -> None:
        self.closed = False

    async def search(self, question: str, top_k: int) -> list[Chunk]:
        return [Chunk(chunk_id=7, text=question, score=1.0)][:top_k]

    async def close(self) -> None:
        self.closed = True

def test_search_and_lifespan() -> None:
    retriever = FakeRetriever()
    app = create_app(Settings(api_key="test-key"), retriever)

    # 上下文管理器会执行 lifespan 的启动与关闭部分。
    with TestClient(app) as client:
        response = client.post(
            "/v1/search",
            headers={"x-api-key": "test-key", "x-request-id": "req-1"},
            json={"question": "如何测试？", "top_k": 1},
        )
        assert response.status_code == 200
        assert response.headers["x-request-id"] == "req-1"
        assert response.json() == {
            "request_id": "req-1",
            "hits": [{"chunk_id": 7, "text": "如何测试？", "score": 1.0}],
        }

    assert retriever.closed is True

def test_rejects_bad_request_and_key() -> None:
    app = create_app(Settings(api_key="test-key"), FakeRetriever())
    with TestClient(app) as client:
        unauthorized = client.post(
            "/v1/search",
            headers={"x-api-key": "wrong"},
            json={"question": "有效问题"},
        )
        assert unauthorized.status_code == 401
        assert unauthorized.json()["code"] == "unauthorized"

        invalid = client.post(
            "/v1/search",
            headers={"x-api-key": "test-key"},
            json={"question": "", "top_k": 100},
        )
        assert invalid.status_code == 422
```

运行最小测试：

```bash
python -m pytest -q test_app.py
```

`with TestClient(app)` 很重要：它保证 lifespan 在断言前启动、离开上下文时关闭。单独创建 `client = TestClient(app)` 不应被用来证明生命周期资源已经按预期初始化。

接口测试至少覆盖：成功、认证失败、输入校验失败、业务不存在、下游超时和下游异常。不要只验证状态码，还要验证响应契约和关键响应头。

## 七、文件上传：收到 `UploadFile` 不等于可以放心保存

FastAPI 处理表单上传需要 `python-multipart`。`UploadFile` 适合流式读取，避免一次性把整个文件读入 Python 字节串，但应用仍要限制请求体和读取量：

```python
from typing import Annotated

from fastapi import File, HTTPException, UploadFile

MAX_BYTES = 10 * 1024 * 1024

@app.post("/v1/documents")
async def upload_document(
    file: Annotated[UploadFile, File()],
):
    if file.content_type not in {"text/plain", "application/pdf"}:
        raise HTTPException(status_code=415, detail="unsupported media type")

    total = 0
    while chunk := await file.read(1024 * 1024):
        total += len(chunk)
        if total > MAX_BYTES:
            raise HTTPException(status_code=413, detail="file too large")
        # 把 chunk 写入项目管理的临时对象或存储层。
    await file.close()
    return {"bytes_received": total}
```

还应在反向代理层限制请求大小，并考虑：

- 不直接信任 `filename`，防止路径穿越和同名覆盖；
- MIME 类型来自客户端，必要时检查真实文件格式；
- 压缩包可能体积很小、解压后极大；
- 临时文件要有清理策略；
- 文档解析、OCR 和 embedding 应交给独立任务，而不是占住上传请求。

示例省略了持久化，正是为了避免给出一个看似能用、实则会覆盖文件的 `open(file.filename, "wb")`。

## 八、`BackgroundTasks` 与任务队列不是一回事

`BackgroundTasks` 在响应发送后，由同一个应用进程继续执行适合短小、允许随进程退出而中断的工作，例如非关键审计日志。它不提供持久化队列、跨机器 worker、可靠重试和任务状态。

```python
from fastapi import BackgroundTasks

def write_noncritical_log(message: str) -> None:
    ...

@app.post("/notify")
async def notify(tasks: BackgroundTasks):
    tasks.add_task(write_noncritical_log, "request accepted")
    return {"accepted": True}
```

文档解析、批量 embedding、训练和长时间推理应提交给 Celery 等外部任务系统。接口返回 `202 Accepted + task_id`，客户端再查询状态。即使有任务队列，也要通过幂等键防止客户端重试产生重复任务。

## 九、中间件、依赖和业务服务分别放什么

三者都能在路由前后执行逻辑，但职责不同：

| 位置 | 适合 | 不适合 |
|---|---|---|
| 中间件 | request ID、统一日志、耗时、CORS | 依赖请求体的复杂业务授权 |
| `Depends` | 认证、权限、数据库会话、分页参数 | 长时间后台工作 |
| 服务函数/类 | 检索、业务规则、事务边界 | 直接拼 HTTP 响应细节 |

小项目不必为了“分层”创建十几个空目录。一个可维护的起点通常是：

```text
app/
  main.py          # create_app、lifespan、中间件
  api.py           # 路由与 HTTP 契约
  schemas.py       # 请求/响应模型
  service.py       # 业务用例
tests/
  test_api.py
```

当某个文件确实出现多个独立业务域，再按业务拆 router。不要为了复制模板提前制造 repository、manager、factory、adapter 等没有实际差异的层。

## 十、上线前最容易漏掉的六件事

### 1. 超时不是只配一层

入口代理、ASGI 服务、HTTP 客户端、数据库和任务队列都可能有自己的超时。外层超时应略大于内层预算，并明确取消与重试是否会让下游工作继续运行。

### 2. 重试只用于安全操作

客户端超时不代表服务端没有执行成功。`POST` 创建任务若自动重试，可能创建两次；使用幂等键并保存第一次结果，不能只在客户端“重试三次”。

### 3. CORS 不是认证

CORS 只约束浏览器脚本可否读取跨域响应，不阻止 curl 或后端服务调用接口。生产环境应列出确切来源，认证和授权仍需单独实现。

### 4. 多 worker 会复制内存资源

增加 worker 能利用多个 CPU 核，但也会复制连接池、缓存和模型。资源容量按“每进程占用 × 进程数”估算，并给操作系统和请求峰值留余量。

### 5. 不把内部异常直接返回

对外使用稳定的 `code`，对内日志记录堆栈、request ID、下游耗时和版本信息。日志不得包含 API Key、完整上传内容或不必要的用户隐私。

### 6. 健康检查分层

存活检查只回答进程是否活着；就绪检查回答当前实例能否接流量。不要让每次存活检查都查询所有下游，否则下游故障可能诱发整批实例被重启。

## 十一、排查“服务突然变慢”的顺序

1. 查看 P50、P95、P99，而不是只看平均延迟；
2. 用 request ID 将入口日志与数据库、检索、推理耗时对齐；
3. 查找 `async def` 内的同步 HTTP、磁盘、数据库和 `time.sleep()`；
4. 查看线程池、数据库连接池和下游连接池是否排队；
5. 确认 CPU、内存、显存和 worker 数是否发生争用；
6. 对单个依赖做超时与故障注入，确认错误是否快速返回；
7. 检查重试是否放大了下游压力；
8. 最后再考虑增加 worker 或实例数量。

如果根因是所有请求都同步调用同一个饱和模型，增加 API worker 只会让更多请求同时争抢同一资源，延迟甚至会更差。

## 十二、总结

FastAPI 的核心价值不是让函数前面多一个 `async`，而是把 Python 类型、HTTP 契约、依赖关系和 ASGI 生命周期连接起来。一个稳定的 AI API 应做到：

- 只有真正异步的 I/O 才在 `async def` 中 `await`；
- 同步短 I/O 明确隔离，长时间 CPU/GPU 工作移出 Web 进程；
- 用 Pydantic 同时约束输入和输出，但把业务授权单独处理；
- 用 lifespan 创建并关闭连接池、客户端和模型资源；
- 用依赖表达认证和请求级资源，用中间件处理通用上下文；
- 为下游调用设置超时，并输出稳定、安全的错误结构；
- 用 `with TestClient(app)` 验证完整生命周期；
- 按每个进程都会复制资源来计算多 worker 容量。

先把这些边界做好，再拆路由、接数据库或任务队列，项目才不会从“能返回 JSON”迅速滑向“偶尔卡住但不知道为什么”。

## 参考资料

- [FastAPI：并发与 async/await](https://fastapi.tiangolo.com/async/)
- [FastAPI：Lifespan 事件](https://fastapi.tiangolo.com/advanced/events/)
- [FastAPI：依赖注入](https://fastapi.tiangolo.com/tutorial/dependencies/)
- [FastAPI：测试事件与 lifespan](https://fastapi.tiangolo.com/advanced/testing-events/)
- [FastAPI：文件上传](https://fastapi.tiangolo.com/tutorial/request-files/)
- [FastAPI：多 worker 部署](https://fastapi.tiangolo.com/deployment/server-workers/)
