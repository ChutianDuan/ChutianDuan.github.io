---
title: "Embedding 模型换了，维度明明一样，为什么召回率仍然崩了？"
date: 2026-07-13 19:16:16
updated: 2026-07-13 19:16:16
categories:
  - "学习"
  - "AI 模型开发"
  - "知识点学习"
  - "框架"
permalink: /notes/ai模型开发/知识点学习/框架/embedding/
series: "AI 模型开发"
---

很多系统把 embedding 兼容性简化成一句话：新旧模型输出都是 768 维，所以可以直接替换。上线后服务没有报维度错误，FAISS 也能正常搜索，召回结果却像随机的一样。

原因很简单：**维度相同只表示数组形状相同，不表示两个向量空间相同。**

模型权重、revision、pooling、query/document 指令、归一化、截断甚至 tokenizer 变化，都会改变坐标含义。用模型 B 生成 query，在模型 A 建成的索引中搜索，就像拿一张城市 A 的坐标去城市 B 找街道：都是二维坐标，但不是同一张地图。

本文不再重复“embedding 是把文本变成向量”的入门概念，而是围绕工程问题展开：**怎样把 embedding 从一个返回浮点数组的函数，变成可验证、可升级、可回滚的服务契约？**

## 一、Embedding 在 RAG 中的真实职责

RAG 的离线和在线链路必须共享同一份契约：

```text
离线：document -> 清洗/切块 -> document 编码 -> 向量索引
在线：query    -> 同类预处理 -> query 编码    -> Top-K 检索
```

embedding 决定“哪些证据进入候选集”，LLM 决定“怎样根据证据组织答案”。如果正确 chunk 没被召回，后面的 Prompt 和大模型再强也无法可靠恢复缺失事实。

Bi-Encoder 分别编码 query 与 document，向量可以预计算并快速搜索；Cross-Encoder 同时读取 `(query, document)`，通常更准确但成本高。因此常见两阶段结构是：

```text
Bi-Encoder 粗召回 30～100 条
-> 权限过滤/去重
-> Cross-Encoder 重排
-> 最终 3～8 条证据
```

不要把 reranker 当成召回器。正确文档若没进入粗召回候选，重排无法把它凭空找回来。

## 二、维度之外，还要固定哪些契约

一个可用的 embedding contract 至少包含：

| 字段 | 为什么重要 |
|---|---|
| model ID | 模型家族不同，向量空间不同 |
| immutable revision | 同名模型仓库可能更新 |
| tokenizer/pooling | 输入切分和聚合方式影响向量 |
| query/document 路由 | 非对称检索可能使用不同 prompt/task |
| dimension | 索引的硬形状约束 |
| normalization | 决定内积能否代表余弦 |
| similarity | L2、内积和余弦的分数方向不同 |
| max length/truncation | 长文是否被静默截断 |
| output dtype | 存储、精度和索引兼容性 |
| preprocessing version | 清洗、前缀和模板变化也会改变结果 |

把它写成代码，而不是只留在 README：

```python
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Literal

@dataclass(frozen=True)
class EmbeddingContract:
    schema_version: int
    model_id: str
    model_revision: str
    dimension: int
    normalized: bool
    similarity: Literal["cosine", "dot", "squared_l2"]
    query_route: str
    document_route: str
    max_tokens: int
    truncation: str
    output_dtype: str
    preprocessing_version: str

    def validate(self) -> None:
        if self.schema_version != 1:
            raise ValueError("unsupported contract schema")
        if self.dimension <= 0 or self.max_tokens <= 0:
            raise ValueError("dimension and max_tokens must be positive")
        if self.output_dtype != "float32":
            raise ValueError("index contract requires float32")
        if self.similarity == "cosine" and not self.normalized:
            raise ValueError("this service requires normalized cosine vectors")

    def fingerprint(self) -> str:
        self.validate()
        payload = json.dumps(
            asdict(self),
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(payload).hexdigest()
```

索引 manifest、缓存 key、数据库 `embedding_version` 和服务健康信息都记录该 fingerprint。只要任一字段变化，就构建新索引版本，不与旧向量混写。

## 三、为什么 query 和 document 不能总用同一个入口

语义相似度任务比较两句地位相同的文本；检索任务常是短 query 寻找长 passage，角色并不对称。许多模型在训练时给两端使用不同 prompt 或 task 路由。

Sentence Transformers 当前推荐检索任务使用：

```python
query_vectors = model.encode_query(queries)
document_vectors = model.encode_document(documents)
```

`encode_query()` 会使用模型定义的 query prompt/task；`encode_document()` 会选择 document、passage 或 corpus 路由。如果模型没有定义相应 prompt，二者可能与普通 `encode()` 接近，但调用方仍明确表达了角色。

某些模型的 model card 要求给 query 添加 instruction，而 document 不加；另一些模型使用固定 prompt name；还有些模型不需要前缀。不能从另一个模型复制字符串。**模型卡和本地评估集共同决定调用约定。**

一个常见灾难是：入库脚本使用 `encode()`，在线服务升级后改用 `encode_query()`，但 manifest 没记录路由。两端不再遵循同一训练约定，系统却没有任何报错。

## 四、完整封装：编码后立即验证

下面的类不绑定某个模型库，只要求底层 encoder 能按角色返回 NumPy 数组。

```python
from __future__ import annotations

from typing import Literal, Protocol

import numpy as np

Role = Literal["query", "document"]

class Encoder(Protocol):
    def encode(self, texts: list[str], role: Role) -> np.ndarray: ...

class ValidatedEmbeddingService:
    def __init__(self, encoder: Encoder, contract: EmbeddingContract) -> None:
        contract.validate()
        self.encoder = encoder
        self.contract = contract

    def encode(self, texts: list[str], role: Role) -> np.ndarray:
        if not texts:
            return np.empty((0, self.contract.dimension), dtype=np.float32)
        if any(not isinstance(text, str) or not text.strip() for text in texts):
            raise ValueError("texts must be non-empty strings")

        raw = self.encoder.encode(texts, role)
        vectors = np.asarray(raw, dtype=np.float32)
        expected = (len(texts), self.contract.dimension)
        if vectors.shape != expected:
            raise ValueError(f"expected vector shape {expected}, got {vectors.shape}")
        if not np.isfinite(vectors).all():
            raise ValueError("embedding contains NaN or infinity")

        vectors = np.ascontiguousarray(vectors)
        norms = np.linalg.norm(vectors, axis=1)
        if np.any(norms <= 1e-12):
            raise ValueError("embedding contains zero vector")

        if self.contract.normalized:
            vectors = vectors / norms[:, None]
            normalized_norms = np.linalg.norm(vectors, axis=1)
            if not np.allclose(normalized_norms, 1.0, atol=1e-5):
                raise ValueError("normalization failed")
        return np.ascontiguousarray(vectors, dtype=np.float32)

    def encode_query(self, query: str) -> np.ndarray:
        return self.encode([query], "query")

    def encode_documents(self, documents: list[str]) -> np.ndarray:
        return self.encode(documents, "document")
```

强制校验看似麻烦，却能在向量进入 FAISS 前发现：

- 服务返回了一维数组；
- API 把 batch 顺序或数量弄错；
- 模型 OOM 后返回空值；
- 混合精度出现 `NaN`；
- 清洗产生空文本或零向量；
- 模型升级改变维度。

不要在发现零向量后偷偷用全零占位。它会进入索引并制造无法解释的邻居；应标记原始记录失败并修复上游。

## 五、Sentence Transformers 适配器

项目已经选择 Sentence Transformers 时，可以把库细节限制在一个很薄的适配器中：

```python
from __future__ import annotations

from typing import Literal

import numpy as np
from sentence_transformers import SentenceTransformer

class SentenceTransformerEncoder:
    def __init__(
        self,
        model_id: str,
        revision: str,
        batch_size: int = 32,
    ) -> None:
        self.model = SentenceTransformer(
            model_id,
            revision=revision,
            trust_remote_code=False,
        )
        self.batch_size = batch_size

    def encode(
        self,
        texts: list[str],
        role: Literal["query", "document"],
    ) -> np.ndarray:
        method = (
            self.model.encode_query
            if role == "query"
            else self.model.encode_document
        )
        return method(
            texts,
            batch_size=self.batch_size,
            convert_to_numpy=True,
            normalize_embeddings=False,
            show_progress_bar=False,
        )
```

外层统一归一化，所以底层显式设为 `False`，避免归一化责任分散两处。也可以让底层归一化，但 contract 与测试必须验证最终范数。

`revision` 应尽可能使用不可变 commit，而不是会移动的 branch/tag。若模型需要 `trust_remote_code=True`，那意味着会执行仓库提供的代码；必须审查来源、固定 revision，并在隔离构建环境中评估，不能为了“跑起来”无条件开启。

## 六、余弦、内积和 L2：分数方向不能写反

| 度量 | 计算 | 更相似的方向 |
|---|---|---|
| 余弦 | 夹角相似度 | 越大越好 |
| 内积 | `q · d` | 越大越好 |
| 平方 L2 | `Σ(q-d)²` | 越小越好 |

当 query 与 document 都进行 L2 归一化时：

```text
cosine(q, d) = inner_product(q, d)
squared_l2(q, d) = 2 - 2 * inner_product(q, d)
```

因此常用 `IndexFlatIP + 两端归一化` 实现余弦检索。但这份约定必须同时用于入库、查询和评估。

不要从其他模型复制固定阈值。例如某模型相关结果常在 0.8 以上，不代表另一个模型也适用。模型卡也可能明确提醒绝对相似度分布不适合用通用阈值。阈值应从当前领域验证集的正负样本分布选择，并在升级时重估。

## 七、长文本被截断，服务为什么没有报错

Tokenizer 通常会把超过最大长度的输入截断。接口仍返回形状正确的向量，因此这类问题不会被维度校验发现。

假设答案在文档末尾：

```text
[前 2000 tokens 的背景介绍] ... [最后 50 tokens 才给出关键结论]
```

若模型只读前 512 tokens，关键结论从未进入向量。解决方案不是简单提高 `chunk_size`，而是：

- 用目标 tokenizer 统计 token，不用字符数代替；
- 切块上限小于模型有效最大长度，为 prompt/instruction 留预算；
- 记录每个 batch 的 token 长度、截断数量和最大值；
- 对超长标题、表格、代码和 OCR 异常文本单独处理；
- 用评估集比较不同 chunk 边界和 overlap。

必要时在预处理层选择“拒绝超长”而不是静默截断。若允许截断，manifest 要记录策略，日志要能统计发生频率。

## 八、批处理：吞吐、延迟和显存的三角关系

batch 越大，通常越能利用向量化和 GPU；但输入会 padding 到 batch 内较长序列，长度差异大时浪费显存。可以按 token 长度分桶，再组成 batch：

```python
from collections.abc import Callable, Iterable, Iterator

def length_aware_batches(
    texts: list[str],
    token_length: Callable[[str], int],
    batch_size: int,
) -> Iterator[list[str]]:
    if batch_size <= 0:
        raise ValueError("batch_size must be positive")
    ordered = sorted(texts, key=token_length)
    for start in range(0, len(ordered), batch_size):
        yield ordered[start : start + batch_size]
```

但排序改变了输出顺序。生产实现必须同时携带稳定 item ID，在结果返回后恢复原顺序：

```text
(chunk_id, text) -> 长度分桶 -> encode -> (chunk_id, vector) -> 按 ID 写入
```

不能假设第 `i` 个返回向量永远对应数据库第 `i` 行，尤其是远程服务、并发 batch 和失败重试混合时。

调参应记录：样本/秒、P50/P95 延迟、GPU 利用率、峰值显存、OOM、平均/最大 token 和 padding 比例。只看 GPU 利用率可能掩盖排队延迟。

## 九、Embedding 缓存 key 也属于模型契约

错误 key：

```text
emb:<model-name>:sha256(raw-text)
```

它遗漏了 revision、角色、预处理、截断和归一化。正确做法是对“最终模型输入 + 完整 contract + role”做稳定摘要：

```python
from __future__ import annotations

import hashlib

def embedding_cache_key(
    contract: EmbeddingContract,
    role: str,
    final_model_input: str,
) -> str:
    if role not in {"query", "document"}:
        raise ValueError("role must be query or document")
    digest = hashlib.sha256(
        (contract.fingerprint() + "\0" + role + "\0" + final_model_input)
        .encode("utf-8")
    ).hexdigest()
    return f"embedding:v1:{digest}"
```

key 不含原文，降低敏感内容暴露。不同 revision 自然生成不同 key，无需扫描删除旧缓存；旧值由 TTL 回收。

缓存是优化层。缓存损坏或不存在时应能重新编码；任务状态、chunk 关系和索引发布记录仍存权威数据库。

## 十、远程 Embedding API 的边界

远程服务请求应携带：

```text
request_id
model_id + revision/served version
role=query|document
items=[{item_id, text}, ...]
expected_dimension
normalization contract
```

响应应携带 item ID，而不是只有向量数组：

```json
{
  "model": "embedding-model",
  "revision": "immutable-revision",
  "dimension": 768,
  "normalized": true,
  "items": [
    {"item_id": "chunk-7", "embedding": [0.01, -0.02]}
  ]
}
```

示例为简写，真实数组长度必须等于声明维度。

客户端需要配置连接、读取和总超时，并区分错误：

- 4xx 输入错误不应原样重试；
- 短暂 429/5xx 可按服务约定有限退避；
- 超时后结果状态未知，batch 写入以 item ID 幂等；
- 响应 model/revision/dimension 不匹配立即拒绝；
- 部分成功要明确协议，不能默默丢行；
- 不在日志中记录完整敏感文本或向量。

## 十一、模型怎么选：排行榜只负责缩小候选

评估维度包括：

- 目标语言、代码、表格和专业术语；
- query 到 passage 是否非对称；
- 最大有效长度与截断策略；
- 开源许可、远程代码和供应链风险；
- 向量维度带来的内存与检索成本；
- CPU/GPU 延迟、吞吐和 batch 能力；
- 是否有明确 query/document prompt；
- 是否需要 dense、sparse 或多向量能力；
- 与 reranker 的组合收益。

向量原始存储粗略为：

```python
def gib_for_float32_vectors(count: int, dimension: int) -> float:
    if count < 0 or dimension <= 0:
        raise ValueError("invalid count or dimension")
    return count * dimension * 4 / (1024**3)

assert round(gib_for_float32_vectors(1_000_000, 768), 2) == 2.86
```

这还不包含索引结构、ID、元数据、进程和临时峰值。维度更大并不自动代表效果更好，需要用质量收益抵消真实成本。

## 十二、评估：先测召回，再测答案

最小检索评估集：

```text
query_id
query
relevant_chunk_ids（可以不止一个）
tenant/user scope
语言/主题/难度标签
```

Recall@K：正确证据是否进入前 K：

```python
def recall_at_k(
    retrieved: list[list[int]],
    relevant: list[set[int]],
) -> float:
    if len(retrieved) != len(relevant):
        raise ValueError("query counts differ")
    if not relevant:
        raise ValueError("evaluation set is empty")

    scores = []
    for found, expected in zip(retrieved, relevant):
        if not expected:
            raise ValueError("each query needs at least one relevant ID")
        scores.append(len(set(found) & expected) / len(expected))
    return sum(scores) / len(scores)
```

还应计算 MRR、nDCG、按主题切片的 Recall、延迟和成本。整体平均值可能掩盖中文、代码或长文档上的回退。

模型比较必须固定：语料快照、chunk、候选数、距离度量、权限过滤和评估脚本。否则同时改模型和切块，无法判断提升来自哪里。

上线前采用 shadow/canary：新模型建立独立索引，对相同 query 同时记录新旧 Top-K 差异，但不影响用户；通过质量和容量阈值后切换版本，旧索引保留回滚窗口。

## 十三、什么时候考虑微调

先按顺序排查：

1. 标注是否正确，相关 chunk 是否真的存在；
2. chunk 是否把答案切断或被模型截断；
3. query/document 路由与指令是否按 model card 使用；
4. 归一化、度量和索引版本是否一致；
5. 关键词 + dense 混合检索是否改善；
6. reranker 是否能修复候选排序；
7. 更合适的现成模型是否满足需求。

这些都验证后，且拥有足够的 `(query, positive, hard negative)` 数据，再考虑微调。Hard negative 是“看起来很像但答案错误”的文档，通常比随机负样本更能训练模型理解细粒度差异。

微调后得到的是新模型 revision，必须重新生成全量语料向量、构建新索引并重新选择阈值，不能只更新在线 query encoder。

## 十四、排查“搜不到正确答案”的顺序

1. 正确 chunk 是否存在，是否被权限过滤？
2. 入库与查询是否使用完全相同的 contract fingerprint？
3. query/document 角色和 prompt 是否正确？
4. 输入是否超长并被静默截断？
5. 向量是否 finite、非零、维度正确且按契约归一化？
6. FAISS 使用的是 IP、L2 还是余弦等价实现，分数方向是否正确？
7. 精确 Flat 能否找到，还是 ANN 参数漏召回？
8. 提高 candidate_k 后，正确 chunk 是否出现？
9. 混合检索或 rerank 是否能解决术语、编号和细粒度歧义？
10. 最后才换模型或微调。

## 十五、上线检查清单

1. 模型 ID 是否固定到不可变 revision？
2. contract 是否包含角色、维度、归一化、度量、截断和预处理版本？
3. 索引 manifest、数据库与缓存是否记录同一 fingerprint？
4. query/document 是否使用模型推荐的独立入口或 prompt？
5. 是否拒绝空文本、NaN、无穷和零向量？
6. 是否统计 token 长度和截断率？
7. batch 是否携带稳定 item ID，并处理部分失败与重试？
8. 缓存 key 是否包含完整 contract 和 role，且不暴露原文？
9. 阈值是否来自当前模型和领域数据，而非复制经验值？
10. 新模型是否构建独立索引并支持 canary/回滚？
11. 是否同时评估 Recall、引用、延迟、吞吐、显存和存储？
12. 模型许可证、远程代码和数据隐私是否审查？

## 十六、总结

Embedding 不只是“文本进、数组出”的模型调用。它是一份连接语料、查询、索引、缓存和评估的版本化契约：

- 同维度不代表同一向量空间；
- 模型 revision、pooling、角色 prompt 和预处理都属于版本；
- 检索任务明确区分 query 与 document 编码；
- 编码后立刻验证 shape、dtype、finite、范数和连续内存；
- 余弦、内积和 L2 的归一化与分数方向必须一致；
- 长文本截断和 batch padding 要可观测；
- 所有远程 batch 用 item ID 对齐并幂等写入；
- 缓存 key 包含完整 contract fingerprint；
- 模型升级建立新索引，用固定评估集和 canary 验证后切换。

当 contract fingerprint 能贯穿模型服务、FAISS manifest、MySQL 和 Redis 时，embedding 升级才是一次可验证的版本发布，而不是在同一个 768 维数组接口后悄悄换了一张地图。

## 参考资料

- [Sentence Transformers 使用指南](https://sbert.net/docs/sentence_transformer/usage/usage.html)
- [Sentence Transformers 推理效率](https://sbert.net/docs/sentence_transformer/usage/efficiency.html)
- [Sentence Transformers 信息检索评估器](https://www.sbert.net/docs/package_reference/sentence_transformer/evaluation.html)
- [Sentence Transformers Retrieve & Re-rank](https://www.sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html)
- [BAAI BGE 模型卡：query instruction 与分数说明](https://huggingface.co/BAAI/bge-base-en)
- [FAISS 距离说明](https://github.com/facebookresearch/faiss/wiki/MetricType-and-distances)
