---
title: "为什么 FastAPI 测试单独通过，整套运行却失败？"
date: 2026-07-13 15:35:52
updated: 2026-07-13 15:35:52
categories:
  - "学习"
  - "Linux 与 C++ 工程化"
permalink: /notes/liunx-c-工程化/2-pytest-fixture-monkeypatch-fastapi-testclient/
series: "Linux 与 C++ 工程化"
series_order: 2
---

时间：2026/05/12
整理：2026/06/20

> 关键词：pytest、fixture、monkeypatch、Mock、tmp_path、TestClient、依赖覆盖、问题定位

---

你刚写完一个 FastAPI 接口测试，单独运行一切正常：

```bash
python -m pytest tests/test_api.py::test_get_document_returns_404
```

结果是绿色的 `1 passed`。可是一旦运行整个测试目录，同一个用例有时返回 200，有时访问了真实数据库，还有时在 CI 中因为缺少环境变量直接失败。把测试顺序调换一下，结果甚至又变了。

这类问题通常不是接口逻辑“随机出错”，而是测试之间泄漏了状态。例如，前一个测试写入的 `dependency_overrides` 没有清理，module scope fixture 共享了可变 Fake，或者 patch 错了名字，真实网络请求悄悄穿过了测试边界。单个测试没有暴露这些问题，因为它启动时恰好处在一个干净进程里。

本文围绕这个现场，串起 pytest fixture、`monkeypatch`、`tmp_path`、Mock 和 FastAPI `TestClient`。目标不是记住更多测试 API，而是建立一条可重复的原则：每个测试都应明确拥有自己的输入和依赖，并在结束时把环境恢复到执行前的状态。

文中示例使用现代 Python 3、pytest、FastAPI 与 Pydantic 2 风格 API。FastAPI 的 `TestClient` 由 Starlette 提供并依赖 HTTPX；真实项目应固定一组经过测试的依赖版本。旧版 FastAPI/Pydantic 的校验错误内容可能不同，需要结合项目锁文件验证断言。

## 1. 为什么“能运行”还不等于“可重复”？

### 1.1 各工具负责什么

| 工具 | 作用 |
| --- | --- |
| pytest | 收集、运行测试，展示失败现场 |
| fixture | 准备依赖、管理生命周期、清理状态 |
| monkeypatch | 临时修改环境变量、函数、属性、字典 |
| `unittest.mock` | 模拟依赖，检查调用参数、次数和异常 |
| `tmp_path` | 给测试提供独立临时目录 |
| FastAPI TestClient | 不启动 Uvicorn，直接测试 ASGI 接口 |
| dependency override | 用 Fake/Stub 替换 FastAPI 依赖 |

这些工具最终要保证两件事：

```text
可控：时间、环境变量、数据库、网络、LLM 返回值可以固定
隔离：每个测试从干净状态开始，不依赖其他测试
```

### 1.2 一个测试的基本结构

```text
Arrange：准备条件
Act：执行行为
Assert：验证结果
```

```python
def test_build_citations_keeps_document_identity():
    # Arrange
    results = [
        SearchResult(
            doc_id=7,
            chunk_id=3,
            text="fixture 用来管理测试依赖",
            score=0.91,
        )
    ]

    # Act
    citations = build_citations(results)

    # Assert
    assert citations[0]["doc_id"] == 7
    assert citations[0]["chunk_id"] == 3
```

> 记忆点：测试外部可观察行为，不测试无关实现步骤。

### 1.3 测试分层

| 层级 | 测什么 | 外部依赖 |
| --- | --- | --- |
| 单元测试 | chunk、prompt、citation、校验、排序 | 全部替换 |
| Service 测试 | `RagService`、`IngestService` | Fake/Mock |
| API 测试 | 路由、状态码、请求校验、依赖注入 | 通常替换 |
| 集成测试 | MySQL、Redis、向量库、Celery | 测试环境 |
| E2E | 上传 → 解析 → 检索 → 生成 | 少量真实依赖 |

推荐：

```text
大量单元测试
  → 适量 Service/API 测试
  → 少量集成测试
  → 极少量 E2E
```

---

## 2. 项目结构与 pytest 配置

```text
rag_app/
├── app/
│   ├── main.py
│   ├── api/
│   ├── services/
│   └── repositories/
├── tests/
│   ├── conftest.py
│   ├── test_rag_service.py
│   └── test_api.py
└── pyproject.toml
```

`pyproject.toml`：

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
python_files = ["test_*.py"]
python_functions = ["test_*"]
addopts = "-ra --strict-markers"
markers = [
  "unit: fast tests without external services",
  "integration: tests using external test services",
  "e2e: end-to-end tests",
  "slow: intentionally slow tests",
]
```

常用运行方式：

```bash
# 全部测试
python -m pytest

# 指定文件
python -m pytest tests/test_api.py

# 指定测试
python -m pytest \
  tests/test_api.py::test_get_document_returns_404

# 按名字筛选
python -m pytest -k 'document and not upload'

# 按 marker 筛选
python -m pytest -m unit
python -m pytest -m 'not integration'
```

> 习惯使用 `python -m pytest`，可以明确 pytest 属于当前 Python 环境。

---

## 3. 单元测试：正常、边界、非法

测试一个函数时，至少检查：

```text
正常输入：常规业务是否正确
边界输入：空值、最大值、最小值、刚好越界
非法输入：错误类型、缺失字段、不允许的状态
依赖失败：超时、异常、空结果
```

例：citation 截断。

```python
def test_build_citations_returns_empty_list_for_no_results():
    assert build_citations([]) == []

def test_build_citations_truncates_long_snippet():
    results = [
        SearchResult(
            doc_id=1,
            chunk_id=2,
            text="a" * 100,
            score=0.75,
        )
    ]

    citations = build_citations(results)

    assert citations[0]["snippet"] == "a" * 80
```

边界测试容易发现：

- `[:80]` 写成 `[:79]`；
- 空列表时访问 `results[0]`；
- top-k 没生效；
- 排序方向写反；
- Unicode、换行处理错误。

### 3.1 参数化测试

同一规则、多组数据：

```python
import pytest

@pytest.mark.parametrize(
    ("filename", "expected"),
    [
        pytest.param("paper.pdf", True, id="pdf"),
        pytest.param("README.MD", True, id="uppercase"),
        pytest.param("archive.exe", False, id="blocked"),
        pytest.param("", False, id="empty"),
        pytest.param("paper.pdf.exe", False, id="double-extension"),
    ],
)
def test_is_allowed_file(filename, expected):
    assert is_allowed_file(filename) is expected
```

失败时会看到：

```text
test_is_allowed_file[double-extension]
```

> 参数化适合“同一规则，不同数据”，不适合把不同业务流程硬塞进一个测试。

### 3.2 异常测试

```python
import pytest

def test_parse_document_rejects_executable(tmp_path):
    path = tmp_path / "data.exe"

    with pytest.raises(
        ValueError,
        match="unsupported extension",
    ):
        parse_document(path)
```

如果异常类型和消息属于接口契约，就一起检查。

### 3.3 断言与浮点数

pytest 会重写普通 `assert`，失败时展示左右值和差异，不需要使用 `self.assertEqual()`：

```python
def test_document_status():
    document = {"id": 1, "status": "failed"}

    assert document["status"] == "ready"
```

失败信息会直接显示：

```text
E   AssertionError: assert 'failed' == 'ready'
```

浮点结果使用 `pytest.approx`：

```python
def test_similarity_score():
    score = compute_score()

    assert score == pytest.approx(0.9, abs=1e-6)
```

不要随意放大误差让测试通过。容差应来自业务精度要求。

### 3.4 测试命名

推荐：

```python
def test_packet_decoder_rejects_truncated_header():
    ...

def test_chat_returns_422_when_question_is_empty():
    ...
```

名称尽量表达：

```text
被测对象 + 条件/场景 + 预期行为
```

避免 `test_1`、`test_normal`、`test_api_works` 这类无法帮助定位失败的名字。

---

## 4. fixture

### 4.1 核心写法

```python
import pytest

@pytest.fixture
def sample_results():
    return [
        SearchResult(
            doc_id=1,
            chunk_id=10,
            text="fixture 用来管理测试依赖",
            score=0.91,
        )
    ]

def test_citation_uses_result_identity(sample_results):
    citations = build_citations(sample_results)

    assert citations[0]["doc_id"] == 1
```

pytest 的执行过程：

```text
测试参数中发现 sample_results
→ 查找同名 fixture
→ 执行 fixture
→ 将返回值传给测试
→ 测试结束后清理
```

### 4.2 fixture 可以互相依赖

```python
@pytest.fixture
def fake_retriever(sample_results):
    return FakeRetriever(sample_results)

@pytest.fixture
def rag_service(fake_retriever, fake_llm):
    return RagService(fake_retriever, fake_llm)
```

不要把所有初始化都塞进一个巨大 fixture。让依赖关系从参数中直接可见。

### 4.3 scope

| scope | 生命周期 |
| --- | --- |
| `function` | 每个测试一次，默认 |
| `class` | 每个测试类一次 |
| `module` | 每个模块一次 |
| `package` | 每个测试包一次 |
| `session` | 整个测试会话一次 |

默认优先使用：

```python
@pytest.fixture
def fake_repo():
    return FakeDocumentRepo()
```

等价于：

```python
@pytest.fixture(scope="function")
def fake_repo():
    return FakeDocumentRepo()
```

> 可变对象、Repository、数据库状态不要随意提升到 session scope。

### 4.4 同一个测试内会缓存

```python
@pytest.fixture
def state():
    return []

@pytest.fixture
def append_ready(state):
    state.append("ready")

def test_state(state, append_ready):
    assert state == ["ready"]
```

同一个测试中，`state` 只创建一次。

### 4.5 `conftest.py` 与 fixture 可见范围

跨测试文件共享的 fixture 通常放在 `conftest.py`，测试文件不需要手动 import：

```text
tests/
├── conftest.py          # tests/ 及子目录可用
├── test_api.py
└── integration/
    ├── conftest.py      # 只影响 integration/ 及子目录
    └── test_database.py
```

pytest 会从测试文件所在目录向上查找 `conftest.py`。

注意：

- 通用 fixture 放上层；
- 只服务某类测试的 fixture 放对应子目录；
- 不要把业务函数和大量测试辅助逻辑都堆进根 `conftest.py`；
- fixture 名冲突时，离测试更近的定义会覆盖上层定义。

### 4.6 autouse fixture

```python
@pytest.fixture(autouse=True)
def clean_cache():
    cache.clear()
    yield
    cache.clear()
```

`autouse=True` 会自动影响作用域内所有测试。

适合：

- 所有测试都必须执行的状态清理；
- 统一时区、固定基础环境；
- 明确限制范围的安全保护。

风险：

- 测试函数看不出隐式依赖；
- setup 变慢；
- patch 范围过大；
- 容易误伤集成测试和 TestClient。

默认优先显式请求 fixture，autouse 只用于真正全局的约束。

### 4.7 参数化 fixture

同一套测试需要在多种实现上运行：

```python
@pytest.fixture(params=["memory", "sqlite"])
def repository(request, tmp_path):
    if request.param == "memory":
        return MemoryRepository()
    return SqliteRepository(tmp_path / "test.db")

def test_repository_round_trip(repository):
    repository.save({"id": 1})

    assert repository.get(1) == {"id": 1}
```

pytest 会为每个参数生成独立测试实例。

---

## 5. yield fixture：清理资源

```python
@pytest.fixture
def index_dir(tmp_path):
    path = tmp_path / "index"
    path.mkdir()

    yield path

    # yield 后执行清理
```

生命周期：

```text
yield 前  → setup
yield 值  → 传给测试
yield 后  → teardown
```

多个 fixture 的清理顺序：

```text
创建 A → 创建 B → 测试 → 清理 B → 清理 A
```

适合：

- 数据库事务回滚；
- TestClient 关闭；
- 临时用户删除；
- 文件句柄释放；
- `dependency_overrides` 清理。

### 5.1 dependency override 清理

```python
@pytest.fixture
def app():
    test_app = create_app()
    test_app.dependency_overrides[get_repo] = lambda: FakeRepo()

    try:
        yield test_app
    finally:
        test_app.dependency_overrides.clear()
```

不能只在测试末尾手动清理：

```python
# 测试中途失败时，这行可能不会执行
app.dependency_overrides.clear()
```

### 5.2 setup 失败时的清理

如果 fixture 在 `yield` 之前抛异常：

- 当前 fixture 的 `yield` 后代码不会执行；
- 已经成功完成 setup 的其他 fixture 仍会正常 teardown。

因此每个 fixture 尽量只创建一种资源：

```text
创建数据库用户 → 一个 fixture
创建上传文件   → 一个 fixture
启动客户端     → 一个 fixture
```

这样某一步失败时，已经创建的资源仍能按逆序可靠清理。

### 5.3 fixture factory

需要动态构造测试数据：

```python
@pytest.fixture
def make_result():
    def _make_result(
        *,
        doc_id=1,
        chunk_id=1,
        text="default text",
        score=0.9,
    ):
        return SearchResult(
            doc_id=doc_id,
            chunk_id=chunk_id,
            text=text,
            score=score,
        )

    return _make_result
```

```python
def test_citations_keep_order(make_result):
    results = [
        make_result(chunk_id=2),
        make_result(chunk_id=1),
    ]

    citations = build_citations(results)

    assert [item["chunk_id"] for item in citations] == [2, 1]
```

---

## 6. tmp_path

每个测试获得独立临时目录：

```python
def test_parse_text(tmp_path):
    source = tmp_path / "note.txt"
    source.write_text("  hello rag\n", encoding="utf-8")

    text = parse_text(source)

    assert text == "hello rag"
```

适合：

- 文档解析；
- 上传落盘；
- 索引文件；
- SQLite 测试库；
- 配置加载；
- 导出文件。

不推荐：

```python
# 会产生共享状态和残留文件
Path("outputs/test.json").write_text(...)
```

测试文件不存在：

```python
def test_parse_text_reports_missing_file(tmp_path):
    missing = tmp_path / "missing.txt"

    with pytest.raises(FileNotFoundError):
        parse_text(missing)
```

---

## 7. monkeypatch

作用：只在当前测试中临时修改运行环境，测试结束后自动恢复。

常用方法：

| 方法 | 用途 |
| --- | --- |
| `setenv` / `delenv` | 环境变量 |
| `setattr` / `delattr` | 模块、类、对象属性 |
| `setitem` / `delitem` | 字典 |
| `chdir` | 当前工作目录 |
| `syspath_prepend` | `sys.path` |
| `context` | 限定 patch 作用范围 |

### 7.1 环境变量

业务代码：

```python
import os

def get_redis_url() -> str:
    return os.getenv(
        "REDIS_URL",
        "redis://127.0.0.1:6379/0",
    )
```

测试：

```python
def test_get_redis_url_from_env(monkeypatch):
    monkeypatch.setenv(
        "REDIS_URL",
        "redis://test-redis:6379/1",
    )

    assert get_redis_url() == "redis://test-redis:6379/1"

def test_get_redis_url_uses_default(monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)

    assert get_redis_url() == "redis://127.0.0.1:6379/0"
```

### 7.2 import 时读取配置的问题

```python
# 模块首次导入时就固定了
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
```

模块导入后再 `setenv`，这个常量不会变化。

更易测试的方式：

- 调用函数时读取；
- 注入 Settings；
- 每次创建配置对象；
- 不要依赖 `importlib.reload()` 修补设计问题。

### 7.3 patch 正确的位置

```python
# app/clients/llm.py
def call_llm(prompt: str) -> str:
    ...
```

```python
# app/services/answer.py
from app.clients.llm import call_llm

def answer_question(question: str) -> str:
    return call_llm(f"问题：{question}")
```

测试应 patch `answer.py` 使用的名字：

```python
from app.services import answer

def test_answer_question(monkeypatch):
    def fake_call_llm(prompt: str) -> str:
        assert prompt == "问题：fixture 是什么？"
        return "fixture 管理测试依赖。"

    monkeypatch.setattr(
        answer,
        "call_llm",
        fake_call_llm,
    )

    assert (
        answer.answer_question("fixture 是什么？")
        == "fixture 管理测试依赖。"
    )
```

速记：

```text
patch 使用时查找的位置，
不是最初定义的位置。
```

易错写法：

```python
# answer.py 已经绑定了自己的 call_llm，
# 修改原始模块不一定影响它。
monkeypatch.setattr(
    "app.clients.llm.call_llm",
    fake_call_llm,
)
```

### 7.4 `raising` 与 `monkeypatch.context()`

`setattr` 默认 `raising=True`，属性不存在时立即失败：

```python
monkeypatch.setattr(service, "send", fake_send)
```

这可以发现属性拼写错误。只有明确允许目标不存在时才写：

```python
monkeypatch.setattr(
    service,
    "optional_hook",
    fake_hook,
    raising=False,
)
```

只想在一小段代码中 patch：

```python
with monkeypatch.context() as patch:
    patch.setenv("MODE", "test")
    assert load_mode() == "test"

# 离开 with 后立即恢复
```

---

## 8. Fake、Mock、monkeypatch 怎么选

| 工具 | 关注点 | 例子 |
| --- | --- | --- |
| Fake | 简化但可工作的实现 | 内存 Repository |
| Stub | 固定返回结果 | Retriever 固定返回 3 个结果 |
| Mock | 调用是否符合预期 | LLM 是否调用一次 |
| monkeypatch | 临时替换名字或环境 | 环境变量、模块函数 |

### 8.1 Fake + Mock 组合

```python
from unittest.mock import Mock

class FakeRetriever:
    def __init__(self, results):
        self.results = results

    def search(self, question: str, limit: int):
        return self.results[:limit]

def test_rag_service_sends_context_to_llm():
    retriever = FakeRetriever(
        [
            SearchResult(
                doc_id=1,
                chunk_id=2,
                text="fixture 管理测试依赖",
                score=0.9,
            )
        ]
    )
    llm = Mock()
    llm.generate.return_value = "fixture 可以复用准备逻辑。"
    service = RagService(retriever, llm)

    response = service.answer("fixture 是什么？")

    assert response["answer"] == "fixture 可以复用准备逻辑。"
    llm.generate.assert_called_once()
    assert "fixture 管理测试依赖" in llm.generate.call_args.args[0]
```

### 8.2 测异常

```python
def test_rag_service_propagates_llm_timeout():
    retriever = FakeRetriever(
        [
            SearchResult(
                doc_id=1,
                chunk_id=1,
                text="context",
                score=0.9,
            )
        ]
    )
    llm = Mock()
    llm.generate.side_effect = TimeoutError("LLM timed out")
    service = RagService(retriever, llm)

    with pytest.raises(TimeoutError, match="LLM timed out"):
        service.answer("question")
```

### 8.3 测“不应该调用”

```python
def test_rag_service_skips_llm_without_context():
    retriever = FakeRetriever([])
    llm = Mock()
    service = RagService(retriever, llm)

    response = service.answer("unknown")

    assert response["citations"] == []
    llm.generate.assert_not_called()
```

> 纯函数直接测真实逻辑，不要为了使用 Mock 而 Mock。

### 8.4 使用 spec 防止 Mock 偏离真实接口

裸 `Mock()` 可以访问任意拼错的属性，测试可能错误通过：

```python
llm = Mock()
llm.generete.return_value = "typo"
```

使用 `spec_set`：

```python
llm = Mock(spec_set=LlmClient)
llm.generate.return_value = "answer"
```

方法签名也需要校验时：

```python
from unittest.mock import create_autospec

llm = create_autospec(LlmClient, instance=True)
```

异步方法使用 `AsyncMock`：

```python
from unittest.mock import AsyncMock

class AsyncLlmClient:
    async def generate(self, prompt: str) -> str:
        ...

@pytest.mark.anyio
async def test_async_llm_client():
    client = AsyncMock(spec=AsyncLlmClient)
    client.generate.return_value = "answer"

    result = await client.generate("prompt")

    assert result == "answer"
    client.generate.assert_awaited_once_with("prompt")
```

> Mock 越接近真实接口，越容易在接口改动时发现测试替身已经过期。

### 8.5 不要全局 patch HTTPX

```python
@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.setattr(httpx.Client, "request", blocked)
```

这可能连 FastAPI TestClient 一起破坏。

更稳妥：

- 在自己的 HTTP Client 边界替换；
- 注入 Fake Client；
- 使用 HTTPX transport；
- 仅在明确范围内禁网。

---

## 9. FastAPI TestClient

### 9.1 最小接口

```python
from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field

class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=500)

def get_repo():
    raise RuntimeError("repo is not configured")

def get_rag_service():
    raise RuntimeError("rag service is not configured")

def create_app() -> FastAPI:
    app = FastAPI()

    @app.get("/internal/documents/{doc_id}")
    def get_document(doc_id: int, repo=Depends(get_repo)):
        document = repo.get(doc_id)
        if document is None:
            raise HTTPException(
                status_code=404,
                detail="document not found",
            )
        return document

    @app.post("/internal/chat")
    def chat(
        payload: ChatRequest,
        service=Depends(get_rag_service),
    ):
        return service.answer(payload.question)

    return app
```

### 9.2 TestClient fixture

```python
from fastapi.testclient import TestClient

@pytest.fixture
def fake_repo():
    return FakeDocumentRepo()

@pytest.fixture
def fake_rag_service():
    return FakeRagService()

@pytest.fixture
def app(fake_repo, fake_rag_service):
    test_app = create_app()
    test_app.dependency_overrides[get_repo] = lambda: fake_repo
    test_app.dependency_overrides[get_rag_service] = (
        lambda: fake_rag_service
    )

    yield test_app

    test_app.dependency_overrides.clear()

@pytest.fixture
def client(app):
    with TestClient(app) as test_client:
        yield test_client
```

这里保证：

```text
每个测试获得新的 Fake
→ 每个测试获得新的 app
→ override 在测试后清理
→ TestClient 正确关闭
```

如果应用使用 lifespan，必须使用：

```python
with TestClient(app) as client:
    ...
```

直接写 `TestClient(app)` 不会按相同方式管理完整 lifespan。

### 9.3 lifespan 测试

```python
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.ready = True
    yield
    app.state.ready = False

app = FastAPI(lifespan=lifespan)
```

测试 startup 状态：

```python
def test_app_is_ready_during_lifespan(app):
    assert not hasattr(app.state, "ready")

    with TestClient(app):
        assert app.state.ready is True

    assert app.state.ready is False
```

适合验证数据库连接池、缓存、模型加载等启动与关闭逻辑，但单元测试中不要真的加载大型模型。

---

## 10. API 测试写法

### 10.1 成功响应

```python
def test_get_document_returns_document(client):
    response = client.get("/internal/documents/1")

    assert response.status_code == 200
    assert response.json() == {
        "doc_id": 1,
        "name": "pytest-notes.md",
        "status": "ready",
    }
```

### 10.2 404

```python
def test_get_document_returns_404(client):
    response = client.get("/internal/documents/404")

    assert response.status_code == 404
    assert response.json() == {
        "detail": "document not found",
    }
```

### 10.3 验证依赖收到的参数

```python
def test_chat_passes_question_to_service(
    client,
    fake_rag_service,
):
    response = client.post(
        "/internal/chat",
        json={"question": "fixture 是什么？"},
    )

    assert response.status_code == 200
    assert fake_rag_service.questions == ["fixture 是什么？"]
```

### 10.4 422 请求校验

```python
def test_chat_rejects_empty_question(client):
    response = client.post(
        "/internal/chat",
        json={"question": ""},
    )

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail[0]["loc"] == ["body", "question"]
```

API 测试至少检查：

```text
method + path
status code
关键 JSON
错误结构
必要 header
鉴权/权限边界
依赖收到的参数
```

不要只写：

```python
assert response.status_code == 200
```

状态码正确，不代表 body、权限和副作用正确。

### 10.5 TestClient 请求参数速查

```python
# Query
client.get("/documents", params={"limit": 10})

# JSON body
client.post("/chat", json={"question": "hello"})

# Form
client.post("/login", data={"username": "alice"})

# Header / Bearer token
client.get(
    "/me",
    headers={"Authorization": "Bearer test-token"},
)

# Cookie
client.get("/session", cookies={"session_id": "test-session"})

# File
client.post(
    "/documents",
    files={"file": ("note.txt", b"hello", "text/plain")},
)
```

不要手工 `json.dumps()` 后再传给 `json=`。测试鉴权时同时覆盖缺失、非法、过期和无权限场景。

---

## 11. TestClient 如何暴露异常

默认情况下，应用中的未处理异常会直接抛给测试：

```python
class BrokenRepo:
    def get(self, doc_id: int):
        raise RuntimeError("database unavailable")

def test_repo_error_is_visible(app):
    app.dependency_overrides[get_repo] = lambda: BrokenRepo()

    with TestClient(app) as client:
        with pytest.raises(
            RuntimeError,
            match="database unavailable",
        ):
            client.get("/internal/documents/1")
```

优点：pytest 直接显示真实 Python traceback。

如果要测试最终 500 响应：

```python
def test_repo_error_returns_500(app):
    app.dependency_overrides[get_repo] = lambda: BrokenRepo()

    with TestClient(
        app,
        raise_server_exceptions=False,
    ) as client:
        response = client.get("/internal/documents/1")

    assert response.status_code == 500
```

速记：

```text
调试内部异常：保留默认 raise_server_exceptions=True
测试 500 响应：显式设为 False
```

### 11.1 状态码排查表

| 现象 | 优先检查 |
| --- | --- |
| 404 | path、router prefix、path 参数 |
| 405 | HTTP method |
| 401 | 鉴权 header、鉴权依赖 |
| 403 | 用户权限、资源所有者 |
| 413 | 上传大小限制 |
| 422 | JSON、字段名、类型、Pydantic 约束 |
| 500 | traceback、异常中间件、日志 |
| startup 状态不存在 | 是否使用 `with TestClient(app)` |
| override 不生效 | key 是否为 `Depends()` 使用的同一函数对象 |

调试 422：

```python
assert response.status_code == 422, response.text
print(response.json()["detail"])
```

`detail[*].loc` 会指出错误在 body、query、path 或具体字段。

---

## 12. 上传、SSE、异步接口

### 12.1 文件上传

```python
def test_upload_document(client):
    response = client.post(
        "/internal/documents",
        files={
            "file": (
                "note.txt",
                b"hello rag",
                "text/plain",
            )
        },
    )

    assert response.status_code == 200
    assert response.json()["filename"] == "note.txt"
    assert response.json()["size"] == len(b"hello rag")
```

补充场景：

- 缺少文件；
- 空文件；
- `limit + 1` 字节；
- 非法扩展名；
- MIME 与扩展名不一致；
- 文件名包含路径；
- 解析失败；
- 落盘失败。

> FastAPI 使用 `UploadFile` 时通常需要 `python-multipart`。

### 12.2 SSE

先测协议内容：

```python
def parse_sse(raw: str):
    events = []
    for block in raw.strip().split("\n\n"):
        event = {}
        for line in block.splitlines():
            if line.startswith("event:"):
                event["event"] = line.removeprefix("event:").strip()
            elif line.startswith("data:"):
                event["data"] = line.removeprefix("data:").strip()
        events.append(event)
    return events

def test_stream_ends_with_done_event(client):
    response = client.get("/internal/chat/stream")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith(
        "text/event-stream"
    )

    events = parse_sse(response.text)
    assert events[-1]["event"] == "done"
```

TestClient 适合检查：

- `content-type`；
- `event:` / `data:`；
- done/error 事件；
- 多行 data；
- 特殊字符。

不适合充分证明：

- 首 token 延迟；
- 真实网络断连；
- 背压；
- 数据是否实时逐块到达。

这些属于集成测试。

### 12.3 异步测试

普通 API 测试优先同步 TestClient，即使路由是 `async def`：

```python
def test_health(client):
    assert client.get("/health").status_code == 200
```

测试本身需要 `await` 时：

```python
from httpx import ASGITransport, AsyncClient

@pytest.mark.anyio
async def test_get_document_async(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
    ) as client:
        response = await client.get("/internal/documents/1")

    assert response.status_code == 200
```

注意：

- 需要 AnyIO 或 pytest-asyncio；
- async 测试里不要嵌套同步 TestClient；
- `ASGITransport` 不一定自动执行 lifespan；
- 依赖 startup/shutdown 时要单独管理 lifespan。

---

## 13. pytest 如何定位问题

### 13.1 先判断失败阶段

| 输出 | 含义 | 优先检查 |
| --- | --- | --- |
| collection error | 测试还没收集 | import、语法、插件、路径 |
| `ERROR at setup` | 测试体还没执行 | fixture、配置、依赖创建 |
| `FAILED` | 测试调用或断言失败 | 业务行为、期望值 |
| `ERROR at teardown` | 测试结束后失败 | 回滚、关闭、清理 |

### 13.2 最常用命令

```bash
# 只重跑上次失败项
python -m pytest --last-failed

# 失败项优先，然后运行全部
python -m pytest --failed-first

# 第一个失败立即停止
python -m pytest -x

# 最多显示两个失败
python -m pytest --maxfail=2

# 详细 node id 和参数
python -m pytest -vv

# 简短 / 完整 traceback
python -m pytest --tb=short
python -m pytest --tb=long

# 失败时进入调试器
python -m pytest --pdb
```

### 13.3 测试没有被发现

```bash
python -m pytest --collect-only -q
```

检查：

- 文件是否叫 `test_*.py`；
- 函数是否叫 `test_*`；
- `testpaths` 是否正确；
- collection 阶段是否 import 失败；
- 当前目录是否为项目根目录；
- 当前 Python 是否装了项目和依赖。

辅助命令：

```bash
# pytest 来自哪个环境
python -m pytest --version

# 当前可用 fixture
python -m pytest --fixtures

# 查看 fixture setup/teardown
python -m pytest --setup-show \
  tests/test_api.py::test_health
```

### 13.4 一套固定排查顺序

```text
1. --last-failed -vv 缩小范围
2. 判断 collection/setup/call/teardown
3. 找 traceback 中第一个项目代码栈帧
4. 对比实际值和期望值
5. 检查测试数据是否真的触发目标分支
6. 判断是产品缺陷还是测试缺陷
7. 缩成一个测试、一个输入、一个断言
8. 修复后运行相关模块，再运行完整测试集
```

产品缺陷：

```text
行为违反明确需求
边界处理错误
状态码或状态转换错误
```

测试缺陷：

```text
测试数据错误
期望已经过时
依赖实现细节
Mock 与真实接口不一致
共享状态污染
```

### 13.5 skip 与 xfail

环境不满足时跳过：

```python
@pytest.mark.skipif(
    not cuda_available(),
    reason="CUDA is not available",
)
def test_gpu_embedding():
    ...
```

已知缺陷但仍希望保留测试：

```python
@pytest.mark.xfail(
    reason="known issue: #123",
    strict=True,
)
def test_unicode_filename():
    ...
```

区别：

```text
skip  → 当前环境不运行
xfail → 运行，但预期失败
```

`strict=True` 很重要：如果缺陷意外修复，测试会以 XPASS 失败，提醒删除 xfail。不要用 xfail 长期隐藏不稳定测试。

---

## 14. 日志、输出、Warning

### 14.1 caplog

```python
import logging

def test_missing_document_is_logged(caplog):
    with caplog.at_level(logging.WARNING):
        document = load_document(repo, 404)

    assert document is None
    assert "document not found: 404" in caplog.text
```

适合验证：

- 安全日志；
- 关键降级；
- 失败原因；
- 审计事件。

不要对所有内部日志文本做严格断言。

### 14.2 capsys

```python
def test_cli_prints_task_id(capsys):
    print("task-id: 123")

    captured = capsys.readouterr()

    assert captured.out == "task-id: 123\n"
    assert captured.err == ""
```

临时关闭捕获：

```bash
python -m pytest -s
```

### 14.3 Warning

```python
import warnings

import pytest

def old_parser():
    warnings.warn(
        "old_parser is deprecated",
        DeprecationWarning,
    )

def test_old_parser_warns():
    with pytest.warns(
        DeprecationWarning,
        match="deprecated",
    ):
        old_parser()
```

Warning 往往提前暴露弃用 API 和兼容性问题，不要在 CI 中全部无条件忽略。

---

## 15. 状态污染与偶发失败

### 15.1 状态污染

典型症状：

```text
单独运行通过，整套运行失败
交换测试顺序后结果改变
本地通过，CI 失败
```

优先检查：

- module/session fixture 中的可变对象；
- `dependency_overrides` 未清理；
- 环境变量未恢复；
- 全局缓存、单例；
- 固定输出文件；
- 数据库未回滚；
- 测试依赖上一个测试的数据。

复现顺序依赖：

```bash
python -m pytest \
  tests/test_a.py::test_a \
  tests/test_b.py::test_b \
  -vv

python -m pytest \
  tests/test_b.py::test_b \
  tests/test_a.py::test_a \
  -vv
```

### 15.2 Flaky test

常见来源：

| 原因 | 处理 |
| --- | --- |
| 真实时间 | 注入 Clock |
| 随机数 | 固定并记录 seed |
| 真实网络 | Fake/Mock/测试 transport |
| 固定端口 | 动态端口 |
| 共享文件 | `tmp_path` |
| 线程调度 | 等待明确状态 |
| 最终一致性 | 有上限地轮询目标状态 |

不要用下面的方式“修复”：

```python
time.sleep(2)
```

也不要把重试插件当成根因修复。重试只能帮助观察失败概率。

---

## 16. RAG 项目测试清单

### 16.1 Chunking

- 空文本；
- 小于、等于、大于 chunk size；
- overlap；
- 中文、emoji、换行；
- 是否丢字符；
- 是否产生空 chunk；
- metadata 是否保留。

关键不变量：

```text
chunk 不超过限制
顺序稳定
doc_id 不丢失
空 chunk 被过滤
overlap 符合约定
```

### 16.2 Retrieval

- top-k；
- 分数排序；
- threshold；
- 相同分数时的稳定性；
- 空索引；
- 重复 chunk；
- tenant/user 过滤；
- 无权限文档不得返回。

单元测试使用固定 SearchResult，不让真实 embedding 的浮点波动影响断言。

### 16.3 Prompt

- question 和 context 的位置；
- context 顺序；
- citation 编号；
- 无结果行为；
- 最大上下文长度；
- 系统指令与用户文本边界；
- prompt injection 防护规则。

不要要求真实 LLM 每次生成完全相同句子。

### 16.4 Citation

- `doc_id` / `chunk_id` 映射；
- 顺序与上下文一致；
- snippet 截断；
- 重复 citation；
- 不泄漏内部路径和敏感 metadata；
- score 格式。

### 16.5 Ingestion

- 解析失败；
- chunk 失败；
- embedding 部分失败；
- 索引写入失败；
- Repository 更新失败；
- 重试幂等；
- 重复提交；
- 成功后才标记 ready。

### 16.6 Celery

Task 保持薄：

```python
@celery_app.task
def ingest_document_task(doc_id: int):
    service = build_ingest_service()
    return service.ingest(doc_id)
```

测试顺序：

```text
大量测试直接调用 IngestService
→ 测 API 是否正确提交任务
→ 少量集成测试使用测试 broker/worker
```

不要在所有单元测试中启动真实 worker。

### 16.7 数据库与 Redis 集成测试

原则：

```text
绝不连接生产实例
每个测试从已知状态开始
测试数据必须可清理
数据库结构与生产保持一致
```

数据库常用隔离方式：

- 每个测试开启事务，结束后 rollback；
- 每个测试使用独立 schema/database；
- SQLite 只适合与生产数据库语义差异不重要的场景；
- migration 本身应有测试，不要只靠 `create_all()`。

Redis：

- 使用独立测试 DB 或独立 key prefix；
- 测试前后清理当前测试命名空间；
- TTL 测试注入时间或使用短而有上限的等待；
- 不要执行可能清空共享实例的 `FLUSHALL`。

---

## 17. 无效测试与覆盖率

### 17.1 “通过但没用”的测试

```python
def test_chat(client):
    response = client.post(
        "/internal/chat",
        json={"question": "hello"},
    )
    assert response
```

`Response` 对象通常为真，这个断言没有验证业务。

至少检查：

```python
assert response.status_code == 200
assert response.json()["answer"] == expected_answer
assert response.json()["citations"] == expected_citations
```

其他无效模式：

- 把被测函数本身 patch 掉；
- Mock 所有内部函数，最后只验证 Mock；
- 只测正常路径；
- `except Exception: pass`；
- 只断言“不为 None”；
- 测试名不说明行为；
- 只追求覆盖率数字。

快速自检：

```text
如果故意把关键条件写反，这个测试会失败吗？
```

不会失败，就没有真正约束该行为。

### 17.2 覆盖率怎么看

覆盖率能发现：

```text
哪些代码没执行
哪些异常分支没覆盖
哪些模块没有测试
```

覆盖率不能证明：

```text
断言正确
边界完整
业务正确
没有并发或集成问题
```

```bash
python -m pytest \
  --cov=app \
  --cov-report=term-missing
```

重点看关键业务分支，不要为了百分比补机械测试。

---

## 18. CI、检查清单与速查

### 18.1 最小 CI

```yaml
name: python-tests

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - name: Install
        run: python -m pip install -e '.[test]'

      - name: Test
        run: python -m pytest --tb=short
```

CI 不连接生产数据库、生产 Redis 或付费 LLM。

建议拆分：

```text
快速任务：unit + API
独立任务：integration
定时任务：E2E、真实模型兼容性
```

### 18.2 提交前检查

- [ ] 测试名描述场景和预期；
- [ ] 正常、边界、非法输入经过考虑；
- [ ] 外部 LLM、数据库、网络没有误调用；
- [ ] fixture 默认保持 function scope；
- [ ] 可变对象没有跨测试共享；
- [ ] autouse fixture 的影响范围足够小；
- [ ] yield fixture 可靠清理；
- [ ] monkeypatch 修改使用位置；
- [ ] Mock 使用 spec/autospec 约束真实接口；
- [ ] dependency override 测试后清理；
- [ ] TestClient 正确管理 lifespan；
- [ ] API 同时检查状态码和关键 body；
- [ ] 依赖失败路径有测试；
- [ ] skip/xfail 有明确原因，xfail 没有隐藏 flaky test；
- [ ] 数据库、Redis 使用隔离测试环境；
- [ ] 单独运行和整套运行结果一致；
- [ ] 新测试能被 `--collect-only` 发现；
- [ ] 测试速度适合日常执行。

### 18.3 一页速记

```text
fixture：
    准备依赖，function scope 保证隔离
    yield 管理清理
    conftest.py 跨文件共享

monkeypatch：
    修改环境变量、属性、函数
    patch 使用位置，不是定义位置
    测试结束自动恢复

Fake / Mock：
    Fake 提供简化实现
    Mock 验证调用和异常
    纯函数直接测真实逻辑

TestClient：
    不启动 Uvicorn
    dependency_overrides 替换外部依赖
    with TestClient(app) 管理 lifespan
    默认抛出服务端未处理异常

发现问题：
    collection error → import / 配置
    setup error      → fixture
    assertion fail   → 业务行为
    teardown error   → 清理
    422              → response.detail
    单独过、整体挂   → 共享状态
    偶发失败         → 时间 / 随机 / 并发 / 网络
```

---

## 19. 官方参考

- pytest：<https://docs.pytest.org/en/stable/>
- pytest 调用与筛选：<https://docs.pytest.org/en/stable/how-to/usage.html>
- pytest Fixture：<https://docs.pytest.org/en/stable/how-to/fixtures.html>
- pytest monkeypatch：<https://docs.pytest.org/en/stable/how-to/monkeypatch.html>
- pytest 参数化：<https://docs.pytest.org/en/stable/how-to/parametrize.html>
- pytest 重跑失败项：<https://docs.pytest.org/en/stable/how-to/cache.html>
- pytest 失败处理：<https://docs.pytest.org/en/stable/how-to/failures.html>
- pytest 日志：<https://docs.pytest.org/en/stable/how-to/logging.html>
- pytest Flaky Tests：<https://docs.pytest.org/en/stable/explanation/flaky.html>
- Python `unittest.mock`：<https://docs.python.org/3/library/unittest.mock.html>
- FastAPI Testing：<https://fastapi.tiangolo.com/tutorial/testing/>
- FastAPI Dependency Overrides：<https://fastapi.tiangolo.com/advanced/testing-dependencies/>
- FastAPI Lifespan Testing：<https://fastapi.tiangolo.com/advanced/testing-events/>
- FastAPI Async Tests：<https://fastapi.tiangolo.com/advanced/async-tests/>
