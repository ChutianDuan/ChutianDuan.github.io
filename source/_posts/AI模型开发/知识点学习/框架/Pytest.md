---
title: "Pytest 全绿，为什么线上 RAG 仍然一改就坏？"
date: 2026-07-13 19:06:00
updated: 2026-07-13 19:06:00
categories:
  - "学习"
  - "AI 模型开发"
  - "知识点学习"
  - "框架"
permalink: /notes/ai模型开发/知识点学习/框架/pytest/
series: "AI 模型开发"
---

测试数量很多、覆盖率超过 90%、CI 里一片绿色，并不代表系统真的可靠。最常见的情况是：测试只证明 mock 按预期被调用，却没有证明用户看到的行为正确。

例如下面这条测试几乎没有业务价值：

```python
def test_answer_calls_retriever(mocker):
    retriever = mocker.Mock()
    service = AnswerService(retriever)

    service.answer("什么是 RAG？")

    retriever.search.assert_called_once()
```

它没有检查检索结果是否经过权限过滤、引用编号是否正确、空证据是否拒绝生成。只要 `search()` 被调用一次，即使最终把别人的私有文档返回给用户，测试仍然通过。

Pytest 的核心能力不是让测试写得短，而是让**输入、依赖、行为和清理**表达得清楚。本文以 pytest 9.x 为当前基线，用一个小型 RAG 服务讲清怎样测试真正重要的契约。

## 一、先确定测试要保护什么

测试最值得保护的是可观察行为和不变量：

- 非法输入必须被拒绝；
- 未授权 chunk 永远不能进入 Prompt 和响应；
- 引用编号与返回来源一一对应；
- 没有证据时不能让模型自由猜测；
- 外部服务超时要变成稳定错误；
- 索引版本、模型版本和元数据必须匹配；
- 事务失败必须回滚；
- 临时文件和依赖覆盖必须清理。

测试内部实现细节会产生脆弱用例。一次等价重构把两个私有函数合并，用户行为没变，测试却全部失败；团队随后不敢重构，或者机械地更新 mock 断言，测试就变成了维护负担。

一个实用判断是：

> 如果换一种内部实现仍应产生相同外部结果，这条测试就不该绑定旧实现的调用顺序。

## 二、测试分层：不同问题需要不同证据

| 层次 | 验证目标 | 外部依赖 | 速度与数量 |
|---|---|---|---|
| 单元测试 | 纯规则、边界、状态转换 | Fake/内存对象 | 最快、最多 |
| 组件测试 | API、Repository、索引封装 | 单个真实组件 | 中等 |
| 集成测试 | MySQL、Redis、FAISS 等交互契约 | 测试实例 | 较少 |
| 端到端测试 | 上传到问答的关键用户路径 | 完整测试环境 | 最少、最慢 |
| 模型评估 | 召回、答案、引用质量 | 固定模型/数据集 | 独立执行 |

单元测试不能证明 SQL 在 MySQL 上的锁行为，SQLite 集成测试也不能替代 MySQL 的排序规则、JSON、事务隔离和 `SKIP LOCKED`。反过来，每个输入边界都启动完整数据库又会让反馈过慢。

测试金字塔的意义不是固定比例，而是让每个风险由成本最低、又足够真实的测试覆盖。

## 三、一个可测试的 RAG 服务

先写被测代码 `rag_service.py`。它只依赖标准库，并通过 Protocol 表达外部边界：

```python
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Protocol

@dataclass(frozen=True)
class Chunk:
    chunk_id: int
    text: str
    score: float
    allowed_user_ids: frozenset[int]

@dataclass(frozen=True)
class Source:
    number: int
    chunk_id: int

@dataclass(frozen=True)
class Answer:
    text: str
    sources: tuple[Source, ...]

class Retriever(Protocol):
    def search(self, question: str, limit: int) -> list[Chunk]: ...

class Generator(Protocol):
    def generate(self, question: str, context: str) -> str: ...

CITATION_PATTERN = re.compile(r"\[C(\d+)]")

class RagService:
    def __init__(
        self,
        retriever: Retriever,
        generator: Generator,
        candidate_k: int = 8,
        final_k: int = 3,
    ) -> None:
        if candidate_k < final_k or final_k <= 0:
            raise ValueError("candidate_k must be >= final_k > 0")
        self.retriever = retriever
        self.generator = generator
        self.candidate_k = candidate_k
        self.final_k = final_k

    def answer(self, question: str, user_id: int) -> Answer:
        question = question.strip()
        if len(question) < 2:
            raise ValueError("question is too short")

        candidates = self.retriever.search(question, self.candidate_k)
        selected = []
        seen_ids = set()
        for chunk in candidates:
            if user_id not in chunk.allowed_user_ids:
                continue
            if chunk.chunk_id in seen_ids:
                continue
            seen_ids.add(chunk.chunk_id)
            selected.append(chunk)
            if len(selected) == self.final_k:
                break

        if not selected:
            return Answer("无法从已授权资料中确定。", ())

        context = "\n\n".join(
            f"[C{number}] {chunk.text}"
            for number, chunk in enumerate(selected, 1)
        )
        text = self.generator.generate(question, context)
        cited_numbers = []
        for raw in CITATION_PATTERN.findall(text):
            number = int(raw)
            if number < 1 or number > len(selected):
                raise ValueError(f"unknown citation [C{number}]")
            if number not in cited_numbers:
                cited_numbers.append(number)

        sources = tuple(
            Source(number, selected[number - 1].chunk_id)
            for number in cited_numbers
        )
        return Answer(text, sources)
```

这里没有为测试增加复杂框架。真正让它可测试的是：外部检索与生成被放在边界上，权限、去重和引用是普通确定性逻辑。

## 四、第一个高价值测试：断言结果，而不是调用次数

文件 `tests/test_rag_service.py`：

```python
from rag_service import Answer, Chunk, RagService, Source

class FakeRetriever:
    def __init__(self, chunks: list[Chunk]) -> None:
        self.chunks = chunks

    def search(self, question: str, limit: int) -> list[Chunk]:
        return self.chunks[:limit]

class FakeGenerator:
    def __init__(self, answer: str) -> None:
        self.answer = answer
        self.contexts: list[str] = []

    def generate(self, question: str, context: str) -> str:
        self.contexts.append(context)
        return self.answer

def test_answer_filters_permissions_and_maps_citations() -> None:
    retriever = FakeRetriever(
        [
            Chunk(10, "其他用户的秘密", 0.99, frozenset({7})),
            Chunk(20, "RAG 在生成前检索证据。", 0.95, frozenset({42})),
            Chunk(20, "重复候选", 0.90, frozenset({42})),
            Chunk(30, "引用需要稳定 ID。", 0.85, frozenset({42})),
        ]
    )
    generator = FakeGenerator("RAG 先检索 [C1]，引用映射到 chunk [C2]。")
    service = RagService(retriever, generator)

    result = service.answer(" 什么是 RAG？ ", user_id=42)

    assert result == Answer(
        "RAG 先检索 [C1]，引用映射到 chunk [C2]。",
        (Source(1, 20), Source(2, 30)),
    )
    assert "其他用户的秘密" not in generator.contexts[0]
    assert generator.contexts[0] == (
        "[C1] RAG 在生成前检索证据。\n\n"
        "[C2] 引用需要稳定 ID。"
    )
```

这条测试允许重写检索器、把循环改成辅助函数，甚至替换 Prompt 模板实现；只要安全和引用契约不变，它仍会通过。

Fake 与 Mock 的区别不在类名。Fake 提供一个小而真实的行为模型，通常比堆叠 `return_value` 和 `assert_called_with` 更容易读。Mock 适合验证确实重要的边界交互，例如“事务失败必须调用 rollback”，但不应成为所有测试的默认工具。

## 五、用参数化覆盖决策表

同一规则的多组输入适合 `@pytest.mark.parametrize`：

```python
import pytest

from rag_service import Chunk, RagService
from tests.test_rag_service import FakeGenerator, FakeRetriever

@pytest.mark.parametrize(
    "question",
    [
        pytest.param("", id="empty"),
        pytest.param(" ", id="whitespace"),
        pytest.param("a", id="one-character"),
    ],
)
def test_answer_rejects_short_question(question: str) -> None:
    service = RagService(FakeRetriever([]), FakeGenerator("unused"))

    with pytest.raises(ValueError, match="too short"):
        service.answer(question, user_id=42)

@pytest.mark.parametrize(
    "generated",
    ["不存在的引用 [C2]", "编号从零开始 [C0]", "负号不是合法格式 [C9]"],
)
def test_answer_rejects_unknown_citation(generated: str) -> None:
    chunk = Chunk(20, "证据", 1.0, frozenset({42}))
    service = RagService(
        FakeRetriever([chunk]),
        FakeGenerator(generated),
    )

    with pytest.raises(ValueError, match="unknown citation"):
        service.answer("有效问题", user_id=42)
```

参数值不会被 pytest 自动复制。若一个用例修改了传入列表，后续参数可能看到被改过的数据；可变参数应在 fixture 或用例中创建新对象。

pytest 9 把 subtests 合入核心，适合运行时才知道检查对象的场景：

```python
from pathlib import Path

import pytest

def test_all_markdown_notes_have_titles(
    note_paths: list[Path],
    subtests: pytest.Subtests,
) -> None:
    for path in note_paths:
        with subtests.test(path=str(path)):
            first_line = path.read_text(encoding="utf-8").splitlines()[0]
            assert first_line.startswith("# ")
```

收集阶段已知的数据优先 parametrize，因为每组用例有独立 node ID，可被 `-k`、`--lf` 和并行插件单独选择。subtests 目前属于 pytest 9 的较新能力，报告形式仍可能演进。

## 六、fixture 管理依赖，不是隐藏业务步骤

fixture 适合：

- 创建每个测试独立的新对象；
- 建立数据库连接或临时目录；
- 在 `yield` 后可靠释放资源；
- 组合多个可复用测试依赖。

```python
import pytest

from rag_service import Chunk, RagService
from tests.test_rag_service import FakeGenerator, FakeRetriever

@pytest.fixture
def private_chunk() -> Chunk:
    return Chunk(10, "私有内容", 0.9, frozenset({7}))

@pytest.fixture
def service(private_chunk: Chunk) -> RagService:
    return RagService(
        FakeRetriever([private_chunk]),
        FakeGenerator("不应被调用"),
    )

def test_no_authorized_evidence_returns_safe_fallback(service: RagService) -> None:
    result = service.answer("可以回答吗？", user_id=42)

    assert result.text == "无法从已授权资料中确定。"
    assert result.sources == ()
```

作用域从小到大通常有 `function`、`class`、`module`、`package`、`session`。默认 `function` 最隔离。把可变数据库或 Fake 放到 session scope，容易让测试依赖执行顺序。

需要清理时使用 yield：

```python
import pytest

@pytest.fixture
def opened_resource():
    resource = acquire_resource()
    try:
        yield resource
    finally:
        resource.close()
```

不要把大量场景逻辑藏在 fixture 中。读一条测试时，如果需要跳进五层 `conftest.py` 才知道数据从何而来，测试就失去了文档作用。

`conftest.py` 会按目录范围自动提供 fixture，不需要显式导入。根目录只放真正全局的少量能力；业务域 fixture 可以放在对应测试子目录。

## 七、临时文件用 `tmp_path`，不要污染仓库

```python
import json

def save_manifest(path, version: str) -> None:
    path.write_text(json.dumps({"version": version}), encoding="utf-8")

def test_save_manifest(tmp_path) -> None:
    target = tmp_path / "manifest.json"

    save_manifest(target, "v2")

    assert json.loads(target.read_text("utf-8")) == {"version": "v2"}
```

`tmp_path` 为每个测试提供独立的 `pathlib.Path`。大而昂贵、只读的会话级样本可以通过 `tmp_path_factory` 构建一次，但测试不能修改共享文件。

不要把测试输出写到项目的 `data/`、`outputs/` 或固定 `/tmp/demo`，否则并行运行、异常中断和不同机器会互相影响。

## 八、monkeypatch 要修补“被查找的位置”

假设 `rag_app/config.py`：

```python
import os

def load_model_name() -> str:
    return os.environ.get("MODEL_NAME", "default-model")
```

测试环境变量：

```python
from rag_app.config import load_model_name

def test_load_model_name(monkeypatch) -> None:
    monkeypatch.setenv("MODEL_NAME", "test-model")
    assert load_model_name() == "test-model"

def test_load_model_name_uses_default(monkeypatch) -> None:
    monkeypatch.delenv("MODEL_NAME", raising=False)
    assert load_model_name() == "default-model"
```

修改会在当前测试结束后自动撤销。

如果 `rag_app.qa` 使用 `from clients import call_llm`，运行时查找的是 `rag_app.qa.call_llm`，就应修补那里：

```python
monkeypatch.setattr("rag_app.qa.call_llm", fake_call_llm)
```

修补原始定义 `clients.call_llm` 可能没有效果，因为被测模块已经持有自己的引用。优先通过构造参数或依赖注入传 Fake；monkeypatch 更适合环境、时间、随机数和难以注入的旧代码边界。

## 九、异常、浮点、日志分别怎么断言

异常要验证类型和稳定消息：

```python
with pytest.raises(ValueError, match="candidate_k"):
    RagService(FakeRetriever([]), FakeGenerator(""), candidate_k=1, final_k=2)
```

浮点数不要直接使用绝对相等：

```python
assert cosine_score == pytest.approx(0.8, abs=1e-6)
```

容差必须来自数值需求，不要为了让失败用例通过而不断放大。

日志使用 `caplog`，但优先断言结构化字段或稳定片段，不要把时间戳和整行格式写死：

```python
import logging

def test_failure_is_logged(caplog) -> None:
    with caplog.at_level(logging.ERROR):
        log_retrieval_failure(request_id="req-7", error_code="timeout")

    assert any(
        record.levelname == "ERROR" and "req-7" in record.message
        for record in caplog.records
    )
```

## 十、异步测试：先固定事件循环策略

pytest 核心不会自动执行任意 `async def` 测试，通常使用 `pytest-asyncio`：

```python
import asyncio

import pytest

async def fetch_chunk(chunk_id: int) -> dict[str, int]:
    await asyncio.sleep(0)
    return {"chunk_id": chunk_id}

@pytest.mark.asyncio
async def test_fetch_chunk() -> None:
    assert await fetch_chunk(7) == {"chunk_id": 7}
```

当前项目应明确选择 pytest-asyncio 的模式和 loop scope，并依据项目锁定版本配置。`strict` 模式适合同时存在 asyncio/trio 等多种异步后端的项目；`auto` 模式减少装饰器样板，但会自动接管异步测试。

不要用真实 `sleep(2)` 等超时。把时钟或等待器注入被测对象，或直接驱动状态变化。若一定要验证取消，使用毫秒级事件同步和外层测试超时，避免 CI 卡死。

异步 fixture 使用当前 pytest-asyncio 文档推荐的装饰器：

```python
import pytest_asyncio

@pytest_asyncio.fixture
async def client():
    resource = await create_client()
    try:
        yield resource
    finally:
        await resource.aclose()
```

## 十一、FastAPI 测试必须进入 lifespan

```python
from fastapi.testclient import TestClient

def test_search_api(app) -> None:
    with TestClient(app) as client:
        response = client.post(
            "/v1/search",
            headers={"x-api-key": "test-key"},
            json={"question": "什么是 RAG？", "top_k": 3},
        )

    assert response.status_code == 200
    assert response.json()["sources"][0]["chunk_id"] == 20
```

上下文管理器会运行应用 lifespan 的启动和清理部分。全局 `client = TestClient(app)` 容易让资源初始化与清理行为没有被真实覆盖。

接口测试至少覆盖：

- 成功响应的状态、schema 和关键 header；
- 输入校验错误；
- 未认证与无权限的区别；
- 资源不存在；
- 下游超时与异常映射；
- lifespan 资源是否关闭；
- 流式协议的事件顺序和结束事件。

覆盖 FastAPI dependency 后，要在 teardown 中清空 `app.dependency_overrides`，避免影响后续用例。

## 十二、数据库集成测试：Fake 与真实库各测一层

业务层可以用 Fake Repository 测状态规则；SQL、事务和锁必须在与生产相同的数据库引擎上验证。

真实 MySQL 集成测试应：

1. 使用隔离的测试数据库和最小权限账号；
2. 由迁移工具创建与生产一致的 schema；
3. 每个测试使用独立数据标识；
4. 清理策略不依赖测试成功；
5. 禁止连接生产主机；
6. 标记为 `integration`，普通快速测试可跳过。

```python
import pytest

@pytest.mark.integration
def test_idempotency_key_is_unique(mysql_connection) -> None:
    insert_job(mysql_connection, document_id=1, key="same-key")

    with pytest.raises(DuplicateKeyError):
        insert_job(mysql_connection, document_id=1, key="same-key")
```

把每个测试包在事务里然后回滚很方便，但它也可能隐藏真实提交、连接切换、锁等待和 `after_commit` 行为。需要验证这些行为时，使用独立 schema/记录并真实提交，再显式清理。

## 十三、RAG 与 LLM 测试要拆开

普通 CI 不应每次调用真实收费模型。单元测试使用 Fake 验证：

- Prompt 是否只包含已授权证据；
- token 预算与截断顺序；
- 空召回降级；
- citation 编号与 chunk ID；
- 超时和错误转换。

少量 contract test 可以验证模型客户端请求/响应 schema，但要固定模型名、参数、超时和预算，并由显式 marker 控制。

答案质量不是普通布尔单测能完全表达的，应维护版本化评估集：

```text
question
relevant_chunk_ids
required_facts
forbidden_claims
expected_abstain
```

每次模型、Prompt、chunk 或索引变更时比较 Recall@K、引用正确率、拒答率、延迟和费用。阈值应允许合理数值波动，但不能通过反复重跑挑一次最好结果。

## 十四、marker、skip 与 xfail 的边界

- `skip`：当前环境不适用，例如没有 GPU；
- `xfail`：已知缺陷，测试应失败；
- 自定义 marker：选择测试集合，例如 `integration`、`model_eval`；
- 不要用 skip/xfail 隐藏不稳定测试。

已知缺陷推荐严格 xfail：意外通过时也提醒团队，避免修好后继续永久标记。

```python
@pytest.mark.xfail(reason="issue-231", strict=True)
def test_known_citation_bug() -> None:
    assert reproduce_bug() == "fixed"
```

每个 xfail 都应有关联问题和清理条件。没有负责人和截止策略的 xfail 会变成测试墓地。

## 十五、pytest 9 配置

pytest 9 支持 `pyproject.toml` 原生 TOML 配置：

```toml
[tool.pytest]
minversion = "9.0"
testpaths = ["tests"]
addopts = ["-ra"]
strict = true
markers = [
  "integration: requires real infrastructure",
  "model_eval: calls a fixed model evaluation environment",
]
```

`strict = true` 当前会启用多项严格检查，包括未知 marker、配置警告、参数化 ID 和 xfail。未来 pytest 增加新的严格项时也可能自动纳入，因此只在锁定 pytest 版本或愿意主动跟进时使用。

需要兼容 pytest 6～8 时，继续使用：

```toml
[tool.pytest.ini_options]
minversion = "8.0"
addopts = "-ra --strict-markers --strict-config"
testpaths = ["tests"]
markers = [
  "integration: requires real infrastructure",
]
```

两个表不能同时使用。项目已有配置时应沿用，不要为了新语法无必要地要求全团队升级。

## 十六、常用命令只保留真正高频的

```bash
# 最小快速验证
python -m pytest -q

# 单文件或单用例
python -m pytest tests/test_rag_service.py -q
python -m pytest tests/test_rag_service.py::test_answer_filters_permissions_and_maps_citations -q

# 关键字与 marker
python -m pytest -k 'citation and not slow'
python -m pytest -m integration

# 首次失败停止、上次失败、最慢用例
python -m pytest -x
python -m pytest --lf
python -m pytest --durations=10
```

`python -m pytest` 会把当前目录加入 `sys.path`，与直接 `pytest` 在某些 import 场景下存在差异。更稳妥的做法是按项目包管理方式安装本项目（常见为 editable install），而不是在测试里手改 `sys.path`。

覆盖率和并行运行来自插件，不是 pytest 核心。新增插件前先写入项目依赖并说明用途。并行测试只有在测试真正隔离时才安全：固定端口、共享数据库记录、全局缓存和 session 可变 fixture 都可能造成随机失败。

## 十七、为什么测试会 flaky

常见根因：

- 依赖真实时间，用 `sleep()` 等某个状态；
- 随机种子没有记录；
- 测试依赖执行顺序或共享可变对象；
- 并行用例复用同一端口、文件名或数据库行；
- 调用不稳定的外部网络和模型；
- 超时预算小于 CI 的正常抖动；
- 浮点断言容差不合理。

修复 flaky 的方法是找到不确定性来源并控制它，不是失败后自动重跑三次。重跑可以暂时收集证据，但会掩盖竞态和真实可靠性问题。

## 十八、评审测试时的检查清单

1. 测试名是否说明场景与预期行为？
2. 失败时能否从断言看出哪个业务契约被破坏？
3. 是否过度断言私有函数、SQL 文本或调用顺序？
4. 成功、边界、错误和权限场景是否都有代表性用例？
5. fixture 是否返回新对象并可靠清理？
6. monkeypatch 是否修补被测模块实际查找的名字？
7. 单元测试是否意外访问真实网络、磁盘固定目录或生产配置？
8. 异步测试是否没有长时间 sleep，取消和资源关闭是否被验证？
9. 数据库特性是否在相同引擎上做集成测试？
10. LLM 质量是否由固定评估集而非一次字符串完全匹配判断？
11. xfail/skip 是否有明确原因，没有被用来掩盖 flaky？
12. 测试是否能独立运行、任意排序，并为并行做好隔离？

## 十九、总结

Pytest 提供了普通 `assert`、fixture、参数化、临时目录、monkeypatch 和插件体系，但这些工具本身不会保证测试有价值。可靠测试的核心是：

- 优先保护用户可观察行为和安全不变量；
- 用 Fake 隔离外部边界，避免把测试写成 mock 调用脚本；
- 让单元、组件、集成、端到端和模型评估分别回答不同问题；
- 用参数化覆盖决策表，用 fixture 管资源而不是隐藏场景；
- 在生产同类数据库上验证 SQL、事务和锁；
- 把不确定的 LLM 质量评估与确定性工程单测分开；
- 控制时间、随机、网络和共享状态，从根因消除 flaky；
- 使用严格配置和清晰 marker，让拼写与错误配置尽早失败。

测试全绿真正应该表达的不是“所有 mock 都被调用了”，而是“当前最重要的业务契约有足够证据仍然成立”。

## 参考资料

- [pytest 官方文档](https://docs.pytest.org/en/stable/)
- [pytest fixture 说明](https://docs.pytest.org/en/stable/explanation/fixtures.html)
- [pytest 参数化](https://docs.pytest.org/en/stable/how-to/parametrize.html)
- [pytest monkeypatch](https://docs.pytest.org/en/stable/how-to/monkeypatch.html)
- [pytest 临时目录](https://docs.pytest.org/en/stable/how-to/tmp_path.html)
- [pytest 9 subtests](https://docs.pytest.org/en/stable/how-to/subtests.html)
- [pytest 配置文件](https://docs.pytest.org/en/stable/reference/customize.html)
- [pytest-asyncio 文档](https://pytest-asyncio.readthedocs.io/en/stable/)
