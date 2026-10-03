---
title: "vLLM Embedding 服务启动成功，为什么写入 FAISS 后结果却不可信？"
date: 2026-07-13 19:22:52
updated: 2026-07-13 19:22:52
categories:
  - "学习"
  - "AI 模型开发"
  - "详细分析纪录"
  - "VLLM"
permalink: /notes/ai模型开发/详细分析纪录/vllm/embedding/
series: "AI 模型开发"
---

Embedding 服务最危险的验收方式，是看到 `/health` 返回成功、`/v1/embeddings` 返回一串浮点数，就直接开始构建索引。

真正上线后才发现：

- 服务加载的是另一个 revision；
- 输出维度与模型卡或旧索引不同；
- query instruction 没有加，document 却误加了；
- 客户端以为向量已归一化，实际范数并非 1；
- batch 响应顺序被错误映射到 chunk ID；
- “降到 256 维”只在客户端截断，却没有重新归一化和评估；
- 一个生成模型被强行转换成 pooling 模型，虽然有向量，检索质量却没有证据。

vLLM 能高效执行和服务 pooling 模型，但它不会替应用证明模型语义正确。本文从一个核心问题出发：**怎样把“接口有响应”升级为“这批向量满足可写入索引的完整契约”？**

## 一、先撤回没有来源的模型参数

原笔记列出过 896 维、32k 上下文、512 训练长度、若干 Matryoshka 维度、Mean Pooling 和双向 Attention。但没有记录：

```text
model repository
immutable model revision
tokenizer revision
model/code revision
pooling config
adapter/合并权重版本
vLLM version
```

这些数字无法审计，也不能安全复用。

即使某个底座模型 hidden size 是 896，最终 embedding 维度也可能被 projection 或 pooling head 改变；模型 config 声明 32k，也不代表该 embedding checkpoint 在 32k 检索任务上经过有效训练；支持裁剪维度更不代表任意截取前 N 维都能保持质量。

正确顺序是：

1. 固定模型仓库与不可变 revision；
2. 阅读该 revision 的 model card、config、pooling 配置与代码；
3. 用 vLLM 实际响应测维度、范数和确定性；
4. 用固定检索集验证 query/document 格式与降维；
5. 把验收结果写入索引 manifest。

## 二、vLLM 中的 pooling task 不止一种

当前 vLLM 将 pooling 模型的典型用途区分为：

| 用途 | task | 输出 |
|---|---|---|
| Sequence embedding | `embed` | 每条输入一个向量 |
| Token embedding | `token_embed` | 每个 token 一个向量/嵌套结果 |
| Classification | `classify` | 类别概率或分数 |
| Pair scoring/rerank | 相应 score/classify 能力 | query-document 分数 |

RAG 使用普通 FAISS 单向量检索，通常需要 sequence embedding：

```text
输入 N 条文本 -> 输出 N 个一维向量
```

Late-interaction/ColBERT 类检索使用 token embedding，一条文本会产生多个 token 向量，不能直接塞进“每个 chunk 一个向量”的 `IndexFlatIP` 封装。

在线接口也应选择具体用途：

- `/v1/embeddings`：OpenAI-compatible sequence embedding；
- `/v2/embed`：Cohere 风格 embedding；
- `/pooling`：更通用的 pooling 输出；
- `/classify`、`/score`、`/rerank`：相应模型用途。

“都能返回数组”不表示它们可以互换。

## 三、启动命令：固定版本和安全边界

一个示意启动命令：

```bash
vllm serve "$EMBEDDING_MODEL" \
  --runner pooling \
  --served-model-name rag-embedding-v1 \
  --revision "$MODEL_REVISION" \
  --tokenizer-revision "$TOKENIZER_REVISION" \
  --max-model-len 1024 \
  --dtype bfloat16 \
  --api-key "$VLLM_API_KEY"
```

参数不是推荐值模板：

- `--runner pooling` 明确使用 pooling runner；
- `--served-model-name` 是 API 请求使用的逻辑名称；
- model/tokenizer revision 应固定到经过审核的不可变提交；
- `--max-model-len` 是服务接受的最大序列约束，不代表模型只在这个长度上有效；
- `--dtype` 必须与硬件、权重和质量评估一致；
- API Key 通过秘密管理注入，不能写进脚本或笔记。

`--trust-remote-code` 默认关闭。只有模型确实需要、代码已经审查、revision 已固定时才开启。它会执行模型仓库中的代码，不是一个无风险兼容选项。

生产中还需要 TLS/可信网络、请求体限制、并发限制和身份授权。vLLM API Key 是入口认证的一部分，不提供租户级知识库权限。

## 四、启动后先做四层验收

### 1. 进程存活

```bash
curl --fail --silent \
  -H "Authorization: Bearer $VLLM_API_KEY" \
  http://127.0.0.1:8000/health
```

存活只说明服务进程能回应。

### 2. 模型身份

```bash
curl --fail --silent \
  -H "Authorization: Bearer $VLLM_API_KEY" \
  http://127.0.0.1:8000/v1/models
```

确认调用方使用 `rag-embedding-v1`，并在部署系统另行记录底层仓库与 revision。served name 只是别名，不能替代不可变构建信息。

### 3. 单条语义 smoke test

```bash
curl --fail --silent http://127.0.0.1:8000/v1/embeddings \
  -H "Authorization: Bearer $VLLM_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"rag-embedding-v1","input":["检索系统需要稳定的模型版本。"]}'
```

### 4. 批量契约测试

检查响应条数、每项 `index`、维度、有限值、范数、model 名和 usage。健康检查通过但这一步失败，实例不能接流量。

## 五、一个不依赖 OpenAI SDK 的严格客户端

下面使用 Python 标准库发请求，便于看清协议和验证逻辑。真实项目可以换成现有 HTTP 客户端，但校验不能省略。

```python
from __future__ import annotations

import json
import math
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Literal

Role = Literal["query", "document"]

@dataclass(frozen=True)
class EmbeddingContract:
    served_model: str
    model_revision: str
    dimension: int
    normalized: bool
    query_prefix: str
    document_prefix: str

class VllmEmbeddingClient:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        contract: EmbeddingContract,
        timeout_seconds: float = 30.0,
    ) -> None:
        if contract.dimension <= 0:
            raise ValueError("dimension must be positive")
        self.url = base_url.rstrip("/") + "/v1/embeddings"
        self.api_key = api_key
        self.contract = contract
        self.timeout_seconds = timeout_seconds

    def _format(self, text: str, role: Role) -> str:
        text = " ".join(text.strip().split())
        if not text:
            raise ValueError("embedding input must not be empty")
        prefix = (
            self.contract.query_prefix
            if role == "query"
            else self.contract.document_prefix
        )
        return prefix + text

    def encode(self, texts: list[str], role: Role) -> list[list[float]]:
        if not texts:
            return []
        body = json.dumps(
            {
                "model": self.contract.served_model,
                "input": [self._format(text, role) for text in texts],
            },
            ensure_ascii=False,
        ).encode("utf-8")
        request = urllib.request.Request(
            self.url,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(
                request, timeout=self.timeout_seconds
            ) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as exc:
            # 生产日志记录 status/request_id，不回显敏感输入或完整响应。
            raise RuntimeError(f"embedding HTTP error: {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError("embedding service unavailable") from exc

        if payload.get("model") != self.contract.served_model:
            raise ValueError("served model mismatch")
        data = payload.get("data")
        if not isinstance(data, list) or len(data) != len(texts):
            raise ValueError("embedding response count mismatch")

        by_index = {}
        for item in data:
            if not isinstance(item, dict):
                raise ValueError("invalid embedding item")
            index = item.get("index")
            vector = item.get("embedding")
            if not isinstance(index, int) or isinstance(index, bool):
                raise ValueError("invalid embedding index")
            if index in by_index or not 0 <= index < len(texts):
                raise ValueError("duplicate or out-of-range embedding index")
            if not isinstance(vector, list) or len(vector) != self.contract.dimension:
                raise ValueError("embedding dimension mismatch")
            if not all(
                isinstance(value, (int, float)) and not isinstance(value, bool)
                for value in vector
            ):
                raise ValueError("embedding contains non-numeric value")
            converted = [float(value) for value in vector]
            if not all(math.isfinite(value) for value in converted):
                raise ValueError("embedding contains NaN or infinity")
            norm = math.sqrt(sum(value * value for value in converted))
            if norm <= 1e-12:
                raise ValueError("embedding is a zero vector")
            if self.contract.normalized and not math.isclose(
                norm, 1.0, rel_tol=1e-5, abs_tol=1e-5
            ):
                raise ValueError(f"expected normalized vector, norm={norm}")
            by_index[index] = converted

        return [by_index[index] for index in range(len(texts))]

    def encode_query(self, query: str) -> list[float]:
        return self.encode([query], "query")[0]

    def encode_documents(self, documents: list[str]) -> list[list[float]]:
        return self.encode(documents, "document")
```

响应 `data` 即使当前通常有顺序，也应按显式 `index` 重排。chunk ID 不放进标准 embedding 请求时，调用方必须保留“请求位置 -> chunk ID”的不可变映射；更稳妥的内部网关可接受带 item ID 的请求，并在响应中原样返回。

## 六、query/document 前缀由谁负责

`/v1/embeddings` 接收文本，但不会普遍替所有模型猜测 query/document 角色。是否需要前缀、instruction、prompt name 或特殊模板，取决于具体模型实现和 model card。

客户端示例把它写进 contract：

```text
query    -> query_prefix + normalized query
document -> document_prefix + normalized chunk
```

某些模型两端前缀都为空；某些模型只给 query 加 instruction；另一些使用不同模板。不要复制 BGE/E5/其他模型的前缀到未知 checkpoint。

一旦前缀变化，就相当于 preprocessing version 变化：全量 document 重新编码、构建新索引，query 服务与新索引一起切换。

## 七、Pooling、activation 和归一化不能靠猜

Sequence embedding 通常经历：

```text
token hidden states
-> pooling（mean/last/CLS/模型自定义）
-> 可选 projection
-> 可选 activation/normalization
-> sequence vector
```

实际行为可能来自模型架构、`pooling_config.json`、vLLM model implementation 或 `--pooler-config`。不能看到 hidden size 就断定输出维度，也不能看到“embed”就只凭记忆断定范数。

验收时测：

```python
def l2_norm(vector: list[float]) -> float:
    return math.sqrt(sum(value * value for value in vector))

def dot(left: list[float], right: list[float]) -> float:
    if len(left) != len(right):
        raise ValueError("dimensions differ")
    return sum(a * b for a, b in zip(left, right))
```

若 contract 要求余弦：

- 服务端已归一化：直接用 FAISS inner product；
- 服务端未归一化：客户端统一 L2 归一化后再写索引/query；
- 不允许一端归一化、一端不归一化；
- 把最终决定写进 manifest，并用向量范数测试守住。

## 八、`dimensions` 与 Matryoshka：支持裁剪也必须重建索引

vLLM 当前 embedding pooling 参数可包含 `dimensions`，但具体模型是否支持有效降维，要看模型训练与实现。普通模型直接截取前 256 维没有质量保证。

即使模型明确支持 Matryoshka Representation Learning，也要对每个候选维度独立执行：

1. document 和 query 使用相同维度；
2. 按 model card 要求重新归一化；
3. 新建对应维度的 FAISS 索引；
4. 比较 Recall@K、MRR、延迟和内存；
5. manifest 记录 dimension 和 pooling 参数。

内存粗估：

```python
def flat_vector_gib(count: int, dimension: int) -> float:
    if count < 0 or dimension <= 0:
        raise ValueError("invalid count or dimension")
    return count * dimension * 4 / (1024**3)

assert round(flat_vector_gib(1_000_000, 896), 2) == 3.34
assert round(flat_vector_gib(1_000_000, 256), 2) == 0.95
```

896 只在这里作为容量示例，不是对某个未指明模型输出维度的确认。

## 九、`max-model-len` 与训练有效长度不是同一个概念

`--max-model-len` 限制服务可接受的序列长度，未指定时通常从模型 config 推导。它不能证明：

- checkpoint 在最大长度上训练过检索；
- 长 passage 的 mean pooling 仍能保留局部事实；
- 你的 GPU 在目标 batch 下不会 OOM；
- chunk 越长召回越好。

要从 tokenizer 对最终输入计数，并在客户端或网关选择：超长拒绝、显式截断或上游重新切块。不要让入库脚本静默截断却不记录。

测试集至少按长度分桶，比较 128、256、512、1024 等真实输入范围的 Recall 和吞吐。最终 chunk 上限来自模型质量与容量曲线，不来自 config 中最大的数字。

## 十、Embedding 服务没有 Decode，但仍会 OOM

Embedding 是一次前向/pooling，不像生成模型逐 token decode，因此没有不断增长的生成 KV Cache 生命周期。但显存仍包括：

- 模型权重；
- Attention/MLP 临时激活；
- batch 中的 token 与 padding；
- kernel workspace 与框架缓存；
- tensor/pipeline parallel 通信缓冲；
- 并发请求的调度峰值。

影响容量的常见关系：

```text
batch 中总 token 越多 -> 计算/激活越大
batch 内长度差异越大 -> padding 浪费越多
max sequence 越长     -> 单请求峰值越高
并发越高              -> 排队或同时调度压力越大
```

因此调优不是只增大 `--max-num-seqs`。要用真实长度分布压测：samples/s、tokens/s、P50/P95、队列、GPU 利用率、峰值显存和 OOM。

## 十一、批处理：item identity 比顺序更重要

一种稳妥入库记录：

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class EmbeddingItem:
    chunk_id: int
    text: str

def pair_vectors(
    items: list[EmbeddingItem],
    vectors: list[list[float]],
) -> list[tuple[int, list[float]]]:
    if len(items) != len(vectors):
        raise ValueError("item/vector count mismatch")
    return [(item.chunk_id, vector) for item, vector in zip(items, vectors)]
```

远程任务重试时，写入用 `(index_version, chunk_id)` 唯一键或不可变构建目录幂等。不能因超时就假定服务端没有完成，也不能把第二次返回 append 到旧结果。

## 十二、LoRA/微调模型怎样接入

原笔记中的 `r=32`、`alpha=64`、`dropout=0.05` 等是训练实验参数，不是通用最佳值。是否适合由训练数据、目标层、模型、损失和验证结果决定。

vLLM 对 pooling 模型的 LoRA 支持取决于具体架构，官方支持表会标注，不能由“生成模型能挂 LoRA”推断 embedding 也能。部署前要确认：

- base model、adapter 与 tokenizer revision；
- pooling head 是否被训练/保存/正确加载；
- adapter 是否合并，served model 身份如何表示；
- query/document prompt 与训练一致；
- 输出 dimension、norm 和检索集质量；
- 多 adapter 并发的显存与路由。

动态加载 LoRA 接口不应在生产任意暴露。模型切换属于受控发布，而不是客户端可调用的普通业务操作。

## 十三、从服务到 FAISS 的发布契约

索引 manifest 至少保存：

```json
{
  "schema_version": 1,
  "served_model": "rag-embedding-v1",
  "model_repository": "org/model",
  "model_revision": "immutable-commit",
  "tokenizer_revision": "immutable-commit",
  "adapter_revision": null,
  "vllm_version": "pinned-version",
  "pooling_task": "embed",
  "pooling_config_hash": "sha256:...",
  "query_prefix_hash": "sha256:...",
  "document_prefix_hash": "sha256:...",
  "dimension": 896,
  "normalized": true,
  "similarity": "cosine_via_inner_product",
  "max_input_tokens": 1024,
  "index_version": "2026-07-13-v1"
}
```

示例 dimension 仍只是占位，构建时必须由已验收 contract 写入。

查询服务加载索引时，先比较当前 embedding client contract 与 manifest。任何不匹配都应拒绝启动或拒绝切流，而不是打印 warning 后继续搜索。

## 十四、质量验收：API 一致不等于检索一致

### 1. 协议测试

- model 名正确；
- batch 数量和 index 完整；
- dimension、finite、非零、范数正确；
- query/document 格式正确；
- 超长输入和错误认证符合预期。

### 2. 数值回归

保留少量无敏感信息的 canary 文本，记录预期维度、范数和相似度关系。跨硬件/精度允许合理浮点容差，不必要求每一位完全相等。

```text
sim("数据库事务", "commit 与 rollback")
  > sim("数据库事务", "篮球比赛规则")
```

### 3. 检索评估

固定 corpus、query、relevant chunk IDs，计算 Recall@K、MRR 和按领域/长度切片的结果。比较：

- 本地参考实现 vs vLLM；
- FP32/BF16/FP16；
- 不同 batch 与 max length；
- 不同 query/document 前缀；
- 完整维度与每个 MRL 候选维度；
- base 与微调/LoRA。

只有服务吞吐提升、质量又不低于门槛，部署变化才成立。

## 十五、上线观测与排查

至少监控：

```text
请求数、错误率、429/5xx
请求/批次样本数与 token 数
队列、P50/P95/P99 延迟
samples/s、tokens/s
GPU 利用率、显存峰值、OOM
输入截断/拒绝数量
响应维度/范数异常
model/revision mismatch
下游 FAISS Recall 与空召回率
```

排查“向量有了但召回差”的顺序：

1. 当前服务实际 model/revision 是否与索引 manifest 相同？
2. query/document 是否使用训练时的格式？
3. 服务输出维度、范数和 pooling task 是否正确？
4. 输入是否被静默截断？
5. 文档和 query 是否同时归一化，FAISS 是否使用正确度量？
6. 本地参考实现与 vLLM 的向量相似度/排名是否一致？
7. 精确 Flat 基线是否能找到正确 chunk？
8. 最后才调整 batch、精度、降维或更换模型。

## 十六、上线检查清单

1. 模型、tokenizer、code 和 adapter 是否固定不可变 revision？
2. 是否确认该架构支持 vLLM pooling/embed，而不是强行转换后就上线？
3. served model 别名能否映射到完整构建 manifest？
4. 是否验证 batch index、dimension、finite、zero 和 norm？
5. query/document 前缀是否按 model card 和评估集固定？
6. `max-model-len` 是否来自真实长度质量/容量测试？
7. dimensions/MRL 是否被模型明确支持并独立评估？
8. 入库是否以 chunk ID 幂等对齐，不依赖异步完成顺序？
9. FAISS manifest 是否记录完整 embedding contract？
10. 新服务是否构建新索引并通过 shadow/canary 后切换？
11. API Key、TLS、限流和模型管理端点是否受控？
12. 是否有回滚到旧服务 + 旧索引的成对方案？

## 十七、总结

vLLM 能把 pooling 模型高效服务化，但可靠部署必须建立在可验证事实上：

- `embed`、`token_embed`、`classify` 和 score/rerank 不是同一输出；
- hidden size、最大上下文和 MRL 维度不能从无来源表格推断；
- 固定模型/tokenizer/code/adapter revision，再测真实响应；
- query/document 格式是模型契约，不由通用 API 自动猜；
- 客户端验证 model、batch index、维度、数值、零向量和范数；
- 降维、精度和 max length 都要在固定检索集上评估；
- 每个 batch 用稳定 chunk ID 幂等落地；
- embedding 服务与 FAISS 索引必须作为同一个版本一起发布和回滚。

只有当 `/v1/embeddings` 的每一项都能追溯到模型 revision、输入角色和索引版本时，“接口返回了一串浮点数”才真正升级为可用于生产检索的 embedding 服务。

## 参考资料

- [vLLM：Pooling Models](https://docs.vllm.ai/en/latest/models/pooling_models/)
- [vLLM：Embedding Usages](https://docs.vllm.ai/en/stable/models/pooling_models/embed/)
- [vLLM：Token Embedding Usages](https://docs.vllm.ai/en/stable/models/pooling_models/token_embed/)
- [vLLM：OpenAI-compatible Online Serving](https://docs.vllm.ai/en/stable/serving/openai_compatible_server/)
- [vLLM：`serve` CLI](https://docs.vllm.ai/en/stable/cli/serve/)
- [vLLM：生产指标](https://docs.vllm.ai/en/latest/usage/metrics/)
