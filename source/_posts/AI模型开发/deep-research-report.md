---
title: "8 周 RAG 项目为什么容易在第三周失控？用可验收的垂直切片完成 C++ + Python 交付"
date: 2026-07-13 18:04:10
updated: 2026-07-13 18:04:10
categories:
  - "学习"
  - "AI 模型开发"
permalink: /notes/ai模型开发/deep-research-report/
series: "AI 模型开发"
---

单人规划 RAG 系统时，很容易在第一天画出这样的架构：

```text
C++ Gateway + FastAPI + Celery + MySQL + Redis Streams
+ FAISS + Embedding + Reranker + Local LLM
+ SSE + 会话记忆 + Docker + 鉴权 + 监控
```

图很完整，八周后却可能没有一条稳定的“上传文档 → 提问 → 返回引用”链路。原因通常不是技术不会，而是按组件横向推进：第一周搭网关，第二周建数据库，第三周研究向量库；直到项目中期，用户仍然无法完成一次端到端操作。每个局部都“完成了 80%”，系统却没有任何可验收版本。

更可靠的做法是先完成一条纵向切片（vertical slice）：哪怕检索只是简单词项匹配、回答只是摘录，它也必须从输入走到结果，并返回来源。之后每一周只替换链路中的一个薄弱环节，同时保留上一周可运行的版本。

本文给出一份单人 8 周交付方案，目标是本地部署一个科研文档 RAG 系统：C++ Drogon 负责外部入口与连接治理，Python 负责模型和文档生态，MySQL 保存长期业务状态，Redis/Celery 承担异步任务与短期事件，FAISS 提供本地向量检索。重点不是堆齐技术名词，而是回答三个工程问题：最小闭环是什么、每周用什么证据验收、需求超期时先砍什么。

## 1. 先定义“交付成功”，否则八周只是日历长度

项目目标不能写成“实现 RAG、支持高并发、具有记忆”。这些描述无法直接测试。一个可验收的 P0（必须完成）闭环应该是：

```text
上传一份 TXT/Markdown
    -> 后台切片并建立索引
    -> 提交一个问题
    -> 检索出相关 chunk
    -> 返回回答与 chunk 级引用
    -> 刷新页面后仍能查询最终结果
```

八周结束时，至少要提供以下证据：

| 能力 | 可执行验收 |
| --- | --- |
| 本地启动 | 按 README 启动后，Gateway 和 RAG API 健康检查均为 200 |
| 文档处理 | 上传固定测试文档后，job 从 queued 进入 succeeded，chunk 数量可查 |
| 检索 | 固定问题的 top-k 中包含标注的相关 chunk |
| 回答与引用 | 最终响应包含非空文本及可定位到原文的 `citations[]` |
| 流式体验 | 客户端逐步收到事件，最终收到唯一的 `done` 或 `app_error` |
| 断线恢复 | 使用最后事件 ID 重连，或通过结果接口取得最终快照 |
| 可复现 | 全新环境按锁定版本和文档能够重复完成上述流程 |

“回答看起来不错”不够稳定。项目还需要一个小型评测集，例如 20 个问题，每个问题标注相关文档和 chunk。检索首先看 Recall@k（相关 chunk 是否进入前 k 个结果），最终回答再检查引用是否真的支撑结论。生成语言流畅不能证明检索正确。

### P0、P1 与明确不做的内容

在单人八周窗口内，推荐这样控制范围：

| 级别 | 内容 |
| --- | --- |
| P0 | TXT/Markdown、单一 embedding、FAISS Flat 索引、一个本地 LLM 接口、引用、最终结果、基础 SSE、Docker Compose、最小鉴权与限流 |
| P1 | PDF、reranker、断线逐事件回放、取消生成、会话摘要、质量仪表盘 |
| 暂不做 | 微调、多种向量数据库、复杂前端、WebSocket、分布式扩缩容、插件系统、多租户计费 |

P1 不是“换个名字的必做项”。任何 P1 开始前，都要重新运行 P0 的端到端测试。若第六周 P0 仍不稳定，PDF、rerank 和长期记忆必须继续推迟。

## 2. 最小可运行切片：先不用模型，也要把数据契约跑通

第一版不必等模型、GPU、FAISS 和 Celery 全部就绪。下面的 Python 3.9+ 标准库程序用词项重叠模拟检索，再把最相关 chunk 作为回答并附带引用。它不是生产 RAG，也不能代表 embedding 的语义能力；它的作用是验证系统最重要的数据契约：query 进入、chunk 被选择、answer 与 citation 一起返回。

```python
import json
import math
import re
from dataclasses import asdict, dataclass

@dataclass(frozen=True)
class Chunk:
    id: str
    document_id: str
    text: str

@dataclass(frozen=True)
class Citation:
    document_id: str
    chunk_id: str
    score: float
    snippet: str

def terms(text: str) -> set[str]:
    """提取英文单词、数字和单个汉字，仅用于零依赖演示。"""
    return set(re.findall(r"[a-z0-9_]+|[\u4e00-\u9fff]", text.lower()))

def similarity(query: str, chunk: str) -> float:
    query_terms = terms(query)
    chunk_terms = terms(chunk)
    if not query_terms or not chunk_terms:
        return 0.0
    overlap = len(query_terms & chunk_terms)
    return overlap / math.sqrt(len(query_terms) * len(chunk_terms))

def retrieve(query: str, chunks: list[Chunk], top_k: int = 2) -> list[tuple[float, Chunk]]:
    if top_k <= 0:
        raise ValueError("top_k must be positive")

    ranked = sorted(
        ((similarity(query, chunk.text), chunk) for chunk in chunks),
        key=lambda item: (-item[0], item[1].id),
    )
    return [item for item in ranked[:top_k] if item[0] > 0]

def answer(query: str, chunks: list[Chunk]) -> dict[str, object]:
    hits = retrieve(query, chunks)
    if not hits:
        return {
            "answer": "当前知识库没有找到足够相关的内容。",
            "citations": [],
            "query": query,
        }

    score, best = hits[0]
    citation = Citation(
        document_id=best.document_id,
        chunk_id=best.id,
        score=round(score, 4),
        snippet=best.text,
    )
    return {
        "answer": f"根据知识库：{best.text}",
        "citations": [asdict(citation)],
        "query": query,
    }

def main() -> None:
    chunks = [
        Chunk("c-1", "doc-faiss", "FAISS 用固定维度向量建立索引并执行相似度搜索。"),
        Chunk("c-2", "doc-stream", "Redis Streams 可以保存流式事件，事件 ID 可用于断线后的继续读取。"),
        Chunk("c-3", "doc-gateway", "Drogon Gateway 负责外部 HTTP 入口、鉴权和限流。"),
    ]
    result = answer("流式事件怎样保存并支持断线恢复？", chunks)

    assert result["citations"]
    assert result["citations"][0]["chunk_id"] == "c-2"
    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
```

保存为 `minimal_rag.py` 后运行：

```bash
python3 minimal_rag.py
```

输出中的分数会由代码确定，关键结构应类似：

```json
{
  "answer": "根据知识库：Redis Streams 可以保存流式事件，事件 ID 可用于断线后的继续读取。",
  "citations": [
    {
      "document_id": "doc-stream",
      "chunk_id": "c-2",
      "score": 0.4507,
      "snippet": "Redis Streams 可以保存流式事件，事件 ID 可用于断线后的继续读取。"
    }
  ],
  "query": "流式事件怎样保存并支持断线恢复？"
}
```

这里的 `score` 只是占位检索器的词项相似度。它不能和 FAISS 距离、余弦相似度或 reranker 分数直接比较。

这段程序刻意把 `answer` 与 `citations` 放在同一个结果里。后续接入 LLM 时，不能只替换回答文本而丢掉来源；接入数据库时，也不能只保存 answer 而让引用只能从过期缓存里寻找。最小切片定义的是长期接口形状，而不是临时 demo。

## 3. 最终架构应该怎样分工，才不会两个服务争写同一状态？

目标架构可以保持 C++ + Python 双服务，但要按能力和数据所有权划界：

```text
Browser / CLI
      |
      | HTTP JSON / SSE
      v
C++ Drogon Gateway
  鉴权、限流、request_id、会话入口、代理、SSE
      |
      | internal HTTP JSON
      v
Python FastAPI Control API
  文档/任务接口、参数校验、提交 Celery
      |
      v
Celery Worker
  parse -> chunk -> embed -> FAISS
  retrieve -> optional rerank -> LLM
      |             |              |
      v             v              v
   MySQL       FAISS files     Redis Streams
```

建议给表设置唯一写入方，而不是让 C++ 和 Python 随意更新同一行：

| 数据 | 权威所有者 | 说明 |
| --- | --- | --- |
| 用户、API key、会话入口 | Gateway | 若项目只是单用户 demo，可大幅简化 |
| 文档、chunk、索引版本、ingest job | RAG Service | 文档处理链由 Python 控制，避免跨语言共享内部状态机 |
| 用户消息、最终回答、引用快照 | 明确选一个服务 | MVP 可由 RAG Service 落库，Gateway 只代理，减少双写 |
| Celery task ID | RAG Service 的实现细节 | 不能直接成为稳定外部业务 ID |
| 流式 token 事件 | Worker 写 Redis，SSE endpoint 读 | 短期回放，不是最终业务记录 |

如果已有项目要求 Gateway 持有 MySQL，也可以让 Gateway 成为消息和会话的唯一写入方，但必须通过清晰的内部完成事件落库，不能让两个服务“谁方便谁 UPDATE”。单人项目最怕隐式双写：一次崩溃就可能出现 MySQL 已 completed、Redis 没有 done，或者反过来。

### 为什么内部先用 HTTP + JSON？

同机容器中的 C++ 与 Python 使用 HTTP + JSON，性能未必最优，却容易用 curl 复现、记录和测试。八周项目中，这通常比立即引入 gRPC 和 protobuf 更划算。只有通过测量确认序列化或协议开销成为瓶颈，再评估迁移。

C++ 不应该直接伪造 Celery broker 消息。Celery 消息协议、序列化和重试语义属于 Python 任务系统内部；Gateway 调用 FastAPI，由 FastAPI 校验参数并提交任务，能把跨语言边界稳定在业务 JSON 上。

## 4. API 应怎样围绕业务资源，而不是 Celery 细节设计？

最小外部 API 可以控制在六组：

| Method | Path | 作用 | 成功语义 |
| --- | --- | --- | --- |
| `GET` | `/health` | 进程存活检查 | 200；依赖就绪可另设 readiness |
| `POST` | `/v1/documents` | 上传并创建 ingest job | 202，返回 `document_id`、`job_id` |
| `GET` | `/v1/documents/{id}` | 查询文档及索引状态 | 200 或 404 |
| `POST` | `/v1/sessions/{id}/messages` | 创建问题与生成 job | 202，返回 `message_id`、`job_id` |
| `GET` | `/v1/jobs/{id}` | 查询业务任务状态 | 200，返回稳定业务状态 |
| `GET` | `/v1/messages/{id}/events` | 订阅 SSE | `text/event-stream` |
| `GET` | `/v1/messages/{id}` | 查询最终快照与引用 | 200、202 或失败状态 |

外部 job 状态不要直接照搬 Celery：

```text
queued -> running -> succeeded
                  -> failed
                  -> cancelled
```

Celery 的 `PENDING` 可能还表示 backend 不知道这个 task ID，而不一定是“已经排队等待”。因此应在 MySQL 中创建业务 job，并保存可选的 `celery_task_id`、阶段、进度和错误摘要。客户端看到的是业务状态；Celery backend 是执行层证据之一，不是唯一事实来源。

提交 ingest 的内部请求只传稳定信息：

```json
{
  "job_id": "job-01",
  "document_id": "doc-01",
  "storage_key": "documents/01/input.md",
  "chunking": {
    "max_tokens": 500,
    "overlap_tokens": 50
  }
}
```

不要把宿主机绝对路径当作跨服务协议。容器挂载点、对象存储 key 或受控相对路径更容易迁移，也不会泄露开发机器目录。`chunk_size` 的单位必须写清是字符、词还是 tokenizer token，不能只传一个 800。

最终消息响应应保留可验证来源：

```json
{
  "message_id": "msg-01",
  "status": "succeeded",
  "answer": "……",
  "citations": [
    {
      "document_id": "doc-01",
      "chunk_id": "chunk-17",
      "snippet": "……",
      "retrieval_score": 0.81
    }
  ]
}
```

分数的方向和含义必须随 retriever 记录。FAISS 的 L2 距离通常越小越近，内积通常越大越近；若把归一化向量的内积当作余弦相似度，也要把归一化步骤写进索引元数据。

## 5. MySQL、Redis 和 FAISS 各自保存什么？

把三者都叫“存储”会掩盖它们不同的可靠性职责：

```text
MySQL       -> 可查询的长期业务真相
Redis       -> 短期状态、任务传递、可过期事件
FAISS file  -> 可重建的向量检索派生物
```

### MySQL：先从六张表开始

| 表 | 关键字段 | 关键约束 |
| --- | --- | --- |
| `documents` | id、storage_key、sha256、status、created_at | `UNIQUE(sha256)` 是否带 owner 取决于去重语义 |
| `chunks` | id、document_id、ordinal、text、token_count | `UNIQUE(document_id, ordinal)` |
| `index_versions` | id、embedding_model、dimension、metric、file_key、status | 只有 ready 版本可被查询使用 |
| `jobs` | id、type、state、stage、progress、celery_task_id、error_code | 状态转移受控，错误信息不存敏感堆栈 |
| `messages` | id、session_id、role、content、status、created_at | `(session_id, created_at, id)` 查询索引 |
| `citations` | message_id、chunk_id、rank、score、snippet | `UNIQUE(message_id, rank)` |

用户与 session 表可以根据产品边界添加，不要为了未来多租户先制造十几张空表。引用保存 snippet 的价值在于：源文档以后重新切片时，历史回答仍能展示当时使用的证据；代价是额外存储和潜在敏感信息，需要结合业务决定。

### Redis：所有 key 都要回答“何时删除”

| Key | 类型 | 用途 | 生命周期 |
| --- | --- | --- | --- |
| `rag:stream:{message_id}` | Stream | token、done、app_error | 完成后设置有限重连窗口 |
| `rag:cancel:{job_id}` | String | 协作式取消标记 | 短 TTL，任务终止后删除 |
| `rag:rate:{subject}:{route}:{window}` | String | 固定窗口计数 | 与窗口一致的 TTL |
| `rag:job-hot:{job_id}` | Hash | 可选热点状态缓存 | 短 TTL，MySQL 仍是权威来源 |

不要同时把 Redis 当 Celery broker、result backend、业务状态库、限流器和永久事件库，却不给每类 key 前缀、容量与过期策略。共享实例至少需要明确命名空间、最大内存策略和故障影响；更严格的环境会进一步隔离用途。

### FAISS：索引文件必须和元数据原子切换

Faiss 的 `IndexFlatL2`/`IndexFlatIP` 适合数据量尚可装入内存、需要精确基线的 MVP。Flat 索引可以作为质量基准，后续确认内存或延迟达不到目标时再评估 IVF、HNSW 或压缩索引。

索引版本至少绑定：

```text
embedding model + revision
vector dimension
normalization rule
distance metric
chunk dataset version
FAISS file checksum/path
```

构建新索引时先写临时文件并验证 `ntotal`、维度和映射，再将数据库中的 active version 切换到新版本。不能覆盖在线文件到一半就让查询线程加载。`IndexFlat` 默认返回向量序号；若业务需要稳定 chunk ID，可使用适合的 ID 映射索引或维护经过版本校验的外部映射，不能假定数据库自增 ID 永远等于向量行号。

## 6. Redis Streams 怎样服务 SSE，而不是错误地分摊消息？

Worker 产生的事件可以写入：

```text
XADD rag:stream:msg-01 * event token data '{"delta":"实验"}'
XADD rag:stream:msg-01 * event done  data '{"message_id":"msg-01"}'
```

Gateway 读取事件后编码为 SSE：

```text
id: 1710000000000-0
event: token
data: {"delta":"实验"}

id: 1710000000123-0
event: done
data: {"message_id":"msg-01"}

```

每个查看者都需要看到完整序列时，应使用各自游标的 `XREAD`。Redis 官方文档明确说明，多个普通 `XREAD` 客户端可以分别获得同一批 entry；同一 Consumer Group 内的 `XREADGROUP` 则把 entry 分配给不同 consumer，并维护待确认列表，更适合 worker 分摊任务。

因此可以这样区分：

```text
Celery/worker 竞争消费任务 -> 队列或 Consumer Group 语义
多个 SSE 客户端回放回答 -> XREAD + 各自 Last-Event-ID
```

第一次订阅若要回放当前历史，从 `0-0` 或已保存游标之后读取；`$` 只关注调用之后的新 entry，使用不当会跳过任务已经生成的 token。Redis Stream ID 可以直接作为 SSE `id`，客户端重连时传回 `Last-Event-ID`。

Redis 事件不是最终答案。Worker 应先保存最终 message/citations，再发布 `done`；即使 Stream 已过期，`GET /v1/messages/{id}` 仍能返回权威快照。数据库与 Redis 之间没有自动跨系统事务，需要幂等完成逻辑和补偿检查，不能把 Redis pipeline 称为跨库事务。

## 7. 八周应该怎样安排，才能每周都有可演示版本？

下面按每周约 25～40 小时估算。真实进度受已有代码、硬件、模型下载和依赖熟悉度影响，必须用每周验收结果滚动调整，不能把工时表当承诺。

| 周次 | 本周只解决的核心问题 | 主要工作 | 周末可验证证据 |
| --- | --- | --- | --- |
| 1 | 数据能否端到端走通？ | 标准库检索切片；确定 JSON 契约；Drogon/FastAPI 健康检查与最小代理 | 固定 query 返回 answer + citation；两个服务可独立健康检查 |
| 2 | 长任务怎样脱离 HTTP 请求？ | TXT/MD 上传；业务 jobs 表；Celery + Redis broker；幂等 ingest | 上传返回 202；job 经过 queued/running/succeeded；重复执行不重复 chunk |
| 3 | 语义检索是否比占位检索可靠？ | 锁定 embedding；建立 FAISS Flat；索引版本与 chunk 映射；20 题评测集 | 记录 Recall@k；索引保存、重载后结果一致 |
| 4 | 回答怎样受证据约束？ | 接本地 LLM 统一接口；上下文预算；保存引用和最终消息；失败降级 | 每个测试问题返回最终快照；引用能定位原文；无命中时明确拒答 |
| 5 | 流式链路能否恢复？ | Worker XADD；Gateway/FastAPI SSE；XREAD 游标；心跳、TTL、代理缓冲 | curl 逐事件输出；断线重连不漏终止状态；Stream 过期后仍可查最终结果 |
| 6 | 系统怎样面对真实用户行为？ | 基础鉴权、对象授权、限流、上传限制、取消；可选 rerank | 越权访问被拒绝；过载返回 429/503；取消后状态唯一终止 |
| 7 | 新机器能否复现并定位失败？ | Compose、healthcheck、迁移、pytest/C++ 测试、E2E、request_id、故障演练 | 全新环境一条文档完成启动；断 Redis/LLM 时错误可定位且不丢最终状态 |
| 8 | 是否达到交付而非继续加功能？ | 冻结功能；质量/延迟测量；修复；README、限制、演示脚本、录屏 | 连续运行 E2E 3 次；10 分钟演示无手工改数据；结果和限制有报告 |

第一周将占位检索接入真实 C++/Python 服务，并不是为了保留它。它让跨服务 contract、错误格式和引用结构尽早暴露。第三周替换 retriever 时，上层 API 不应重写；第四周替换 generator 时，citation contract 不应消失。这就是垂直切片降低集成风险的价值。

### 每周的止损规则

如果当周最后一天仍无法通过核心验收，只能做三种选择：缩小输入范围、关闭 P1、回退到上一稳定版本。不能通过再引入一个框架解决集成问题。例如 PDF 解析不稳定时先只支持 TXT/Markdown；本地大模型跑不动时选更小或量化模型，并记录硬件边界；SSE 回放来不及实现时，至少保证最终结果查询正确。

## 8. Compose 能启动容器，为什么应用仍可能不可用？

容器“已创建”不等于数据库“已就绪”。Compose 可以通过 `depends_on` 的 `condition: service_healthy` 等待依赖 healthcheck 通过，但应用仍需实现连接重试和运行期故障处理，因为依赖可能在启动后再次断开。

下面只是结构骨架，镜像 tag、凭证注入、数据卷和资源限制需要项目自己锁定；不要把示例密码提交到仓库：

```yaml
services:
  mysql:
    image: ${MYSQL_IMAGE}
    environment:
      MYSQL_DATABASE: ${MYSQL_DATABASE}
      MYSQL_USER: ${MYSQL_USER}
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -u root -p$${MYSQL_ROOT_PASSWORD}"]
      interval: 5s
      timeout: 3s
      retries: 20
      start_period: 20s

  redis:
    image: ${REDIS_IMAGE}
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

  rag-api:
    build: ./python_rag
    depends_on:
      mysql:
        condition: service_healthy
      redis:
        condition: service_healthy

  celery-worker:
    build: ./python_rag
    command: celery -A app.celery_app worker --loglevel=INFO
    depends_on:
      mysql:
        condition: service_healthy
      redis:
        condition: service_healthy

  gateway:
    build: ./cpp_gateway
    depends_on:
      rag-api:
        condition: service_started
```

当前 Docker Compose 文档支持这些条件，但旧版 Compose 或不同实现可能存在差异，必须在目标环境运行 `docker compose version` 并验证。`service_started` 只表示容器启动，不代表 HTTP readiness 已通过；如 Gateway 启动必须依赖 RAG API 就绪，应为 API 定义 healthcheck 并使用 `service_healthy`，或者让 Gateway 自己容忍暂时不可用。

启动命令不是验收本身：

```bash
docker compose up --build -d
docker compose ps
curl --fail --show-error http://127.0.0.1:8080/health
curl --fail --show-error http://127.0.0.1:8000/internal/health
```

项目还应有对应的 `docker compose down`、日志查看、数据库迁移和测试命令。不要让 README 只写“启动成功”，却不说明如何停止与清理测试资源；生产数据卷的删除必须是显式、谨慎的操作。

## 9. 从“能回答”走向工程可用，最先补哪些边界？

### 上传文件不是普通字符串

不要使用客户端原始文件名拼接保存路径。服务端生成不可预测的 storage key，校验大小、允许的媒体类型和解析器资源上限；文件内容与扩展名不一致时也要拒绝或隔离。解析 PDF、压缩包等不可信输入时，最好放在受限 worker 中，限制 CPU、内存和执行时间。

### 索引更新必须幂等

Celery 任务可能因重试或 worker 故障重复执行。以 `job_id`、文档 checksum 和 index version 设计幂等键；先写临时产物，验证后再切换 ready 状态。重复执行同一个 ingest 不应产生两套不可区分的 chunk。

### 本地 LLM 的“可部署”受硬件约束

模型大小、量化方式、上下文长度、CPU/GPU 和并发数都会改变内存与延迟。计划中不能写一个脱离硬件的固定吞吐承诺。Week 1 就记录目标机器的 RAM、VRAM、CPU、操作系统和可接受首 token/总延迟，再选择模型与服务端；具体 API 和启动参数需要结合锁定版本验证。

### 会话记忆不能无限拼接历史

P0 可先使用最近若干轮 + 检索证据，并显式计算 prompt token 预算。长期摘要是有损压缩，必须保留原消息作为事实来源；不要把“50 轮仍记得所有细节”当成没有评测方法的验收语句。

### 观测要覆盖阶段，而不是只有总耗时

每次请求至少关联 request ID、job ID、message ID 和 index version，并记录 parse、embed、search、rerank、first-token、generation 等阶段耗时。Redis Stream 长度、worker 队列深度、任务失败率和 SSE 活跃连接数都需要容量上限或告警。

## 10. 哪些常见设计看起来完整，实际会拖垮八周计划？

### 误区一：先把所有基础设施搭完，再做业务闭环

没有真实业务流量，表结构、缓存 key 和队列状态很难验证。先用占位实现跑通一条垂直切片，再按测得的问题替换组件。

### 误区二：用了 RAG，回答就不会产生幻觉

检索可能召回错误内容，LLM 也可能忽略证据或错误归因。RAG 提供外部知识与来源条件，不提供自动真实性保证；必须评估检索、引用支撑和最终回答。

### 误区三：FAISS 返回的第一个结果就是“最相关”

结果取决于 embedding、归一化、metric 和索引。L2 距离与内积分数方向不同；没有标注评测集时，“看起来相似”无法支持质量结论。

### 误区四：Celery SUCCESS 就等于业务完成

worker 可能完成计算但最终消息尚未提交，或者 backend 结果已过期。业务 jobs/messages 表必须有自己的终止状态，并定义先保存最终结果、再发布完成事件的顺序。

### 误区五：SSE 客户端应该共用一个 Consumer Group

同组 consumer 会分摊 entry，而每个查看者通常需要完整回答。广播与回放使用 `XREAD`；Consumer Group 留给真正需要竞争消费的 worker。

### 误区六：Redis Stream 保存了 token，所以不用存最终回答

Stream 会裁剪或过期，客户端也可能丢失游标。最终 answer 和 citations 必须落入生命周期更长的权威存储。

### 误区七：Docker Compose 能启动，就等于可交付

可交付还包括固定版本、迁移、健康检查、失败恢复、测试、停止步骤和硬件限制说明。只在开发者电脑已有缓存的情况下启动成功，不能证明可复现。

### 误区八：C++ 必须承担所有高性能部分才有价值

模型、tokenizer 和文档处理生态主要在 Python。C++ Gateway 在 TLS 入口、连接管理、鉴权、限流和协议治理上已经有明确价值；把模型调用强行移到 C++ 可能增加工期，却没有测得的性能收益。

## 11. 什么时候应该采用这套双服务架构？

| 场景 | 建议 |
| --- | --- |
| 目标包含 C++ 工程实践，且有 6～8 周交付窗口 | C++ Gateway + Python RAG 合理，但严格控制接口数量 |
| 只需数日验证 RAG 质量 | 先做全 Python 单服务，避免跨语言集成成本 |
| 数据量小、单机可放入内存 | FAISS Flat 是良好精确基线 |
| 多实例共享、在线高频更新和复杂过滤 | 需要重新评估专用向量数据库，不能直接套用本地文件索引 |
| 只要最终答案，不要求逐 token 恢复 | 数据库最终快照即可，Redis Streams 可以不引入 |
| 多客户端需要同看完整流 | Redis `XREAD` 或应用层广播，不使用同一 Consumer Group 分摊 |
| 任务很短且请求断开即可取消 | 可直接用异步 HTTP，不一定需要 Celery |

架构选择的依据应是任务时长、故障恢复、并发、数据规模和团队目标。技术栈越多，部署、观测和一致性边界越多；没有明确需求支撑的组件，就是八周计划里的风险，而不是亮点。

## 12. 最终交付物应该让别人怎样复现？

交付不以“代码写完”为终点，而以陌生人在目标环境中复现为终点。仓库至少应包含：

```text
README.md                 架构、硬件、固定版本、启动/停止、已知限制
compose.yaml              本地依赖与健康检查
cpp_gateway/              Drogon 入口及其最小测试
python_rag/               FastAPI、Celery、检索与生成模块
migrations/               可重复执行的数据库迁移
tests/fixtures/           固定文档、问题与相关 chunk 标注
scripts/e2e_demo.sh       不依赖人工改数据库的验收脚本
docs/evaluation.md        Recall@k、引用检查和延迟结果
```

十分钟演示应按固定顺序完成：启动并展示健康状态；上传一份小文档；观察 job 状态；提出固定问题；展示逐步事件、最终答案和引用；断线或查询最终快照；最后展示一条带 request ID 的日志。录屏前连续运行 E2E 三次，任何一次需要手动修表都说明流程还没有交付。

## 13. 总结

八周 RAG 项目失控，通常不是因为缺少一张更完整的架构图，而是每个组件都先做了一部分，却迟迟没有可运行的用户路径。解决方法是从第一周就建立最小垂直切片，并让后续每周围绕一个可测问题演进。

真正值得保留的原则有五条：

1. 先固定“上传、检索、回答、引用”的长期 contract，再替换内部实现；
2. MySQL 保存业务真相，Redis 保存有期限的执行状态和事件，FAISS 是可重建派生索引；
3. Celery 状态、Redis Stream 与业务 job 各有职责，不能互相冒充唯一真相；
4. 每周必须交付可执行证据，失败时砍 P1，而不是继续增加框架；
5. 最终质量要同时评估检索、引用和回答，不能只凭一次流畅演示。

最实用的下一步不是先写完整 Compose，而是运行本文的最小程序，然后把它的 query、answer 和 citations contract 接入一条真实 HTTP 路由。只要这条路径始终可运行，八周中的每一次技术升级才有稳定落点。

## 参考资料

- [Lewis 等：Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks](https://arxiv.org/abs/2005.11401)
- [FAISS 官方 Getting started](https://github.com/facebookresearch/faiss/wiki/Getting-started)
- [FAISS 官方索引选择指南](https://github.com/facebookresearch/faiss/wiki/Guidelines-to-choose-an-index)
- [Celery：Using Redis](https://docs.celeryq.dev/en/stable/getting-started/backends-and-brokers/redis.html)
- [Redis：XREAD](https://redis.io/docs/latest/commands/xread/)
- [Redis：XREADGROUP](https://redis.io/docs/latest/commands/xreadgroup/)
- [WHATWG：Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [Docker Compose：Control startup order](https://docs.docker.com/compose/how-tos/startup-order/)
- [Drogon 官方仓库](https://github.com/drogonframework/drogon)
