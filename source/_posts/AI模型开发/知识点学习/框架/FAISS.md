---
title: "FAISS 搜得很快，为什么召回的不是正确答案？"
date: 2026-07-13 18:52:44
updated: 2026-07-13 18:52:44
categories:
  - "学习"
  - "AI 模型开发"
  - "知识点学习"
  - "框架"
permalink: /notes/ai模型开发/知识点学习/框架/faiss/
series: "AI 模型开发"
---

很多 RAG 项目第一次接入 FAISS 时，都能很快得到一组 Top-K：文档被切成 chunk，embedding 被写进索引，用户问题也能在几毫秒内返回结果。但真正上线后，问题才开始出现：

- 明明存在答案，排在前面的却是不相关段落；
- 离线测试正常，换一次 embedding 模型后召回突然失效；
- 设置了 `nprobe`，召回率却没有变化；
- 删除文档后，旧 chunk 仍偶尔出现在结果里；
- 服务重启后，向量 ID 与业务数据对不上；
- 多个进程同时更新索引，某次发布后文件无法加载。

这些问题往往不是“FAISS 算错了”，而是系统没有维护好一份完整的**检索契约**：向量由哪个模型生成、维度是多少、是否归一化、分数越大还是越小、ID 如何映射、索引和元数据是不是同一版本。

本文从一个核心问题出发：**怎样让一次向量检索既快，又能证明它没有悄悄用错数据？**

## 一、先划清边界：FAISS 不是向量数据库

FAISS 是高性能的向量相似度搜索库。它擅长保存向量索引，并根据距离或相似度返回邻居；它不会自动替项目处理这些事情：

- chunk 原文、标题、页码和文件路径；
- 字符串业务 ID；
- 用户、租户和文档权限；
- 事务、主从复制和分布式一致性；
- embedding 模型版本与索引版本的对应关系。

在一个 RAG 系统中，更合理的职责划分是：

```text
业务数据库：chunk_id -> 文本、来源、权限、状态
Embedding： 文本 -> 固定维度向量
FAISS：     int64 chunk_id + 向量 -> Top-K chunk_id
LLM：       问题 + 检索证据 -> 回答
```

FAISS 只接受 64 位整数 ID。UUID、URL 等字符串 ID 应保存在业务数据库中，再映射为稳定且不重复的 `int64`。不要把数组行号当作永久业务 ID：重建、删除或重新排序后，行号很容易改变。

## 二、第一类错误：距离契约不一致

### 1. L2、内积和余弦不是同一个分数

FAISS 常见的两个度量是：

| 目标 | 常用索引 | `D` 的含义 | 更相似的方向 |
|---|---|---|---|
| 欧氏距离 | `IndexFlatL2` | **平方**欧氏距离 | 越小越好 |
| 内积 | `IndexFlatIP` | 向量内积 | 越大越好 |
| 余弦相似度 | 归一化后使用 `IndexFlatIP` | 单位向量内积 | 越大越好 |

`IndexFlatL2` 返回的是平方 L2 距离，不是开方后的欧氏距离。排序不受平方影响，但如果业务要展示真实欧氏距离，需要自行开方。

内积也不能直接等同于余弦相似度。向量长度会影响内积，因此做余弦检索时，**库向量和查询向量都必须归一化**：

```python
xb = np.ascontiguousarray(xb, dtype=np.float32)
xq = np.ascontiguousarray(xq, dtype=np.float32)

faiss.normalize_L2(xb)
faiss.normalize_L2(xq)
index = faiss.IndexFlatIP(xb.shape[1])
```

单位向量满足：

```text
平方 L2 距离 = 2 - 2 × 内积
```

所以归一化后，L2 与内积的排序等价，但返回的分数仍不一样。

### 2. 零向量不能归一化

空文本、异常模型输出或错误的池化逻辑可能产生零向量。对它归一化没有数学意义。工程代码至少应检查：

- 输入必须是二维数组 `(n, d)`；
- 类型统一为 `float32`；
- 所有值都是有限数，拒绝 `NaN` 和无穷；
- 维度与索引一致；
- 范数不能接近零。

还要先复制数组。`faiss.normalize_L2()` 会原地修改数据，如果直接传入共享缓存，后续代码看到的值也会变化。

## 三、一个可运行、可持久化的精确余弦索引

下面的示例不是把 `add()`、`search()` 包一层就结束，而是明确处理最容易出错的四件事：

1. 统一验证并归一化向量；
2. 使用稳定的业务 `int64` ID；
3. 用 manifest 固化模型和距离契约；
4. 通过不可变版本目录发布索引，避免读到半写文件。

安装依赖时应使用项目既有环境，不要同时混用多个包管理器：

```bash
python -m pip install numpy faiss-cpu
```

完整代码如下：

```python
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

import faiss
import numpy as np

VERSION_PATTERN = re.compile(r"[A-Za-z0-9._-]+")

@dataclass(frozen=True)
class Manifest:
    schema_version: int
    index_version: str
    embedding_model: str
    embedding_revision: str
    dimension: int
    metric: str
    normalized: bool
    index_type: str
    vector_count: int
    index_sha256: str

def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

def prepare_vectors(values: np.ndarray, dimension: int) -> np.ndarray:
    vectors = np.asarray(values, dtype=np.float32)
    if vectors.ndim != 2 or vectors.shape[1] != dimension:
        raise ValueError(
            f"expected shape (n, {dimension}), got {vectors.shape}"
        )
    if not np.isfinite(vectors).all():
        raise ValueError("vectors contain NaN or infinity")

    # copy 避免 normalize_L2 修改调用者持有的原数组。
    vectors = np.ascontiguousarray(vectors.copy())
    norms = np.linalg.norm(vectors, axis=1)
    if np.any(norms <= 1e-12):
        raise ValueError("zero or near-zero vector cannot be normalized")
    faiss.normalize_L2(vectors)
    return vectors

def prepare_ids(values: Iterable[int], expected: int) -> np.ndarray:
    ids = np.asarray(list(values), dtype=np.int64)
    if ids.ndim != 1 or len(ids) != expected:
        raise ValueError(f"expected {expected} one-dimensional IDs")
    if len(np.unique(ids)) != len(ids):
        raise ValueError("IDs must be unique")
    return np.ascontiguousarray(ids)

class ExactCosineIndex:
    """用 IndexFlatIP 实现的不可变精确余弦索引。"""

    def __init__(self, dimension: int) -> None:
        if dimension <= 0:
            raise ValueError("dimension must be positive")
        self.dimension = dimension
        self.index = faiss.IndexIDMap2(faiss.IndexFlatIP(dimension))

    def build(self, vectors: np.ndarray, ids: Iterable[int]) -> None:
        if self.index.ntotal:
            raise RuntimeError("build a new version instead of mutating this index")
        prepared = prepare_vectors(vectors, self.dimension)
        prepared_ids = prepare_ids(ids, len(prepared))
        self.index.add_with_ids(prepared, prepared_ids)

    def search(
        self,
        queries: np.ndarray,
        top_k: int,
        allowed_ids: set[int] | None = None,
        oversample: int = 4,
    ) -> list[list[tuple[int, float]]]:
        if top_k <= 0:
            raise ValueError("top_k must be positive")
        if self.index.ntotal == 0:
            return [[] for _ in range(len(queries))]

        prepared = prepare_vectors(queries, self.dimension)
        factor = oversample if allowed_ids is not None else 1
        raw_k = min(self.index.ntotal, top_k * max(1, factor))
        scores, ids = self.index.search(prepared, raw_k)

        batches: list[list[tuple[int, float]]] = []
        for row_ids, row_scores in zip(ids, scores):
            hits = []
            for item_id, score in zip(row_ids, row_scores):
                item_id = int(item_id)
                # 当 k 大于可用结果数时，FAISS 可能用 -1 补位。
                if item_id == -1:
                    continue
                if allowed_ids is not None and item_id not in allowed_ids:
                    continue
                hits.append((item_id, float(score)))
                if len(hits) == top_k:
                    break
            batches.append(hits)
        return batches

    def publish(
        self,
        root: Path,
        version: str,
        embedding_model: str,
        embedding_revision: str,
    ) -> Path:
        if not VERSION_PATTERN.fullmatch(version):
            raise ValueError("version may contain only letters, digits, '.', '_' and '-'")
        root.mkdir(parents=True, exist_ok=True)
        version_dir = root / version
        # 版本目录不可覆盖；要更新就发布一个新版本。
        version_dir.mkdir(exist_ok=False)

        index_path = version_dir / "vectors.faiss"
        faiss.write_index(self.index, str(index_path))
        manifest = Manifest(
            schema_version=1,
            index_version=version,
            embedding_model=embedding_model,
            embedding_revision=embedding_revision,
            dimension=self.dimension,
            metric="cosine_via_inner_product",
            normalized=True,
            index_type="IndexIDMap2(IndexFlatIP)",
            vector_count=self.index.ntotal,
            index_sha256=sha256_file(index_path),
        )
        (version_dir / "manifest.json").write_text(
            json.dumps(asdict(manifest), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        # 索引和 manifest 都完成后才切换指针。
        pointer_tmp = root / f"CURRENT.{os.getpid()}.tmp"
        pointer_tmp.write_text(version, encoding="utf-8")
        os.replace(pointer_tmp, root / "CURRENT")
        return version_dir

    @classmethod
    def load_current(
        cls,
        root: Path,
        expected_model: str,
        expected_revision: str,
    ) -> "ExactCosineIndex":
        version = (root / "CURRENT").read_text(encoding="utf-8").strip()
        if not VERSION_PATTERN.fullmatch(version):
            raise ValueError("invalid CURRENT pointer")

        version_dir = root / version
        manifest = Manifest(
            **json.loads((version_dir / "manifest.json").read_text("utf-8"))
        )
        if manifest.schema_version != 1:
            raise ValueError("unsupported manifest schema")
        if (manifest.embedding_model, manifest.embedding_revision) != (
            expected_model,
            expected_revision,
        ):
            raise ValueError("embedding model does not match the index")
        if manifest.metric != "cosine_via_inner_product" or not manifest.normalized:
            raise ValueError("distance contract does not match")

        index_path = version_dir / "vectors.faiss"
        if sha256_file(index_path) != manifest.index_sha256:
            raise ValueError("index hash mismatch")

        loaded = faiss.read_index(str(index_path))
        if loaded.d != manifest.dimension or loaded.ntotal != manifest.vector_count:
            raise ValueError("index structure does not match manifest")

        result = cls(manifest.dimension)
        result.index = loaded
        return result

def demo() -> None:
    vectors = np.array(
        [
            [1.0, 0.0, 0.0, 0.0],
            [0.9, 0.1, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
        ],
        dtype=np.float32,
    )
    chunk_ids = [1001, 1002, 2001]

    store = ExactCosineIndex(dimension=4)
    store.build(vectors, chunk_ids)
    query = np.array([[1.0, 0.0, 0.0, 0.0]], dtype=np.float32)
    print(store.search(query, top_k=2))

    # 使用临时目录演示发布与重载，不污染项目目录。
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        store.publish(root, "2026-07-13-v1", "demo-embedding", "rev-1")
        restored = ExactCosineIndex.load_current(
            root, "demo-embedding", "rev-1"
        )
        print(restored.search(query, top_k=2))

if __name__ == "__main__":
    demo()
```

预期两次输出都类似：

```text
[[(1001, 1.0), (1002, 0.9938837)]]
```

这个实现刻意采用“重建新版本”而不是原地增删。发布中断时，最多留下一个没有被 `CURRENT` 指向的不完整目录；读进程仍使用旧版本。它没有解决多写者竞争，生产中仍应只允许一个索引构建/发布任务，或在外层使用项目已有的分布式锁。

索引文件应当视为受信任的构建产物。示例在反序列化前验证 SHA-256，但哈希只能发现文件变化，不能证明来源可信；跨机器发布时还需要可信存储、访问控制或签名机制。

## 四、为什么稳定 ID 比 `add()` 更重要

直接对 `IndexFlatIP` 调用 `add()` 时，FAISS 使用连续位置作为 ID：第一条是 0，第二条是 1。删除后，不同索引类型对编号的处理并不完全相同；某些连续编号索引会移动后续 ID。

`IndexIDMap2` 包装器允许调用 `add_with_ids()`，并保留业务提供的 `int64` ID：

```python
base = faiss.IndexFlatIP(768)
index = faiss.IndexIDMap2(base)
index.add_with_ids(vectors, chunk_ids)
```

推荐把 ID 关系存成：

```text
FAISS int64 chunk_id
        |
        v
业务数据库 chunk_id -> document_id、文本、权限、embedding_version、deleted_at
```

不要使用 Python 内置 `hash(string)` 生成持久 ID，因为它可能在不同进程中变化。可以由数据库分配自增 ID，或用稳定摘要生成 63 位整数并在写入时检测碰撞。

## 五、权限过滤为什么会让 Top-K 不够

假设 FAISS 返回 10 条结果，其中只有 2 条属于当前租户。先取 Top-10、再做权限过滤，最终只能得到 2 条；如果相关结果排在第 11～20 名，它们根本没有机会进入过滤阶段。

示例中的 `allowed_ids + oversample` 会多取一些候选，再过滤：

```python
hits = store.search(
    query,
    top_k=5,
    allowed_ids={1001, 1002},
    oversample=10,
)
```

但 oversampling 只是启发式方法，不能保证一定补满。权限比例很低时，可以考虑：

- 按租户或知识库拆分索引；
- 使用索引支持的 ID selector，但先确认具体索引与操作是否支持；
- 先在元数据库得到候选 ID，再做精排；
- 需要复杂过滤、事务和在线更新时，改用合适的向量数据库。

无论采用哪种方式，**权限校验必须在返回 chunk 原文之前再次执行**。向量候选过滤不能替代最终授权检查。

## 六、索引怎么选：先建立精确基线

### 1. Flat：慢一点，但结果精确

`IndexFlatL2` 和 `IndexFlatIP` 会扫描所有向量，不需要训练，也不会因为近似搜索漏掉邻居。`IndexFlat` 以 float32 保存原向量，内存大约是：

```text
4 × 向量维度 × 向量数量 字节
```

100 万个 768 维向量，仅原始向量约占 2.86 GiB，尚未包含 ID、元数据和进程开销。即便最终要上近似索引，也应保留 Flat 作为小规模精确基线。

### 2. HNSW：低延迟，但图结构占内存

HNSW 用近邻图换取较低的查询延迟：

```python
index = faiss.IndexHNSWFlat(768, 32, faiss.METRIC_INNER_PRODUCT)
index.hnsw.efConstruction = 200
index.hnsw.efSearch = 64
```

- `M`：每个节点的连接规模，越大通常召回更好、内存也更高；
- `efConstruction`：建图时的候选范围；
- `efSearch`：查询时的候选范围，增大通常提高召回和延迟。

具体收益依赖数据分布，不能只抄一组参数。

### 3. IVF：先分桶，再搜索部分桶

IVF 需要代表性训练数据：

```python
quantizer = faiss.IndexFlatIP(d)
index = faiss.IndexIVFFlat(
    quantizer, d, nlist, faiss.METRIC_INNER_PRODUCT
)
index.train(training_vectors)
index.add(database_vectors)

faiss.ParameterSpace().set_index_parameter(index, "nprobe", 16)
```

- `nlist`：聚类桶数量；
- `nprobe`：查询时探测多少个桶；
- `nprobe` 越大，通常召回更高、查询更慢。

训练样本与线上分布差异太大时，分桶质量会下降。若索引被 `IndexIDMap`、`PreTransform` 等包装，直接写 `index.nprobe = 16` 可能只是在 Python 对象上生成一个同名字段，没有改变内部 IVF 参数。使用 `ParameterSpace().set_index_parameter()` 更稳妥。

### 4. PQ：用精度换内存

PQ 把向量拆成多个子向量并量化编码，适合原始 float32 放不下的场景。它会引入量化误差，并受维度、子量化器数量等约束。没有明确的内存瓶颈和召回评估时，不应仅因为数据“看起来很多”就先上 PQ。

| 场景 | 建议起点 | 主要代价 |
|---|---|---|
| 小中规模、先验证质量 | `IndexFlatIP` | 扫描成本随数据线性增长 |
| 内存足、追求低延迟 | HNSW | 图结构内存与建索引时间 |
| 大规模、可训练 | IVFFlat | 需要训练并调 `nprobe` |
| 内存是主要瓶颈 | IVFPQ / PQ | 量化导致精度损失 |

## 七、如何证明近似索引没有漏太多

“检索效果”包含两个不同问题：

1. **ANN 质量**：近似索引能否找回 Flat 的真实近邻；
2. **业务相关性**：向量近邻是否真是回答问题所需的证据。

前者可以用 Flat 作为 ground truth，计算邻居集合重叠率：

```python
def ann_recall_at_k(exact_ids: np.ndarray, ann_ids: np.ndarray) -> float:
    if exact_ids.shape != ann_ids.shape or exact_ids.ndim != 2:
        raise ValueError("ID matrices must have the same two-dimensional shape")
    k = exact_ids.shape[1]
    if k == 0:
        raise ValueError("k must be positive")

    recalls = []
    for exact_row, ann_row in zip(exact_ids, ann_ids):
        expected = {int(item) for item in exact_row if item != -1}
        actual = {int(item) for item in ann_row if item != -1}
        recalls.append(len(expected & actual) / len(expected) if expected else 1.0)
    return float(np.mean(recalls))
```

评估时对同一批查询分别运行 Flat 和 ANN，并同时记录 P50/P95/P99 延迟。调 HNSW 的 `efSearch` 或 IVF 的 `nprobe`，画出“召回率—延迟”曲线，而不是只报一个最快数字。

业务相关性则需要标注问题集：每个问题有哪些相关 chunk，再计算 Recall@K、MRR 或 nDCG。ANN Recall@K 很高，只能说明它接近精确向量搜索；如果 embedding 模型不适合领域、chunk 切分破坏语义，业务检索仍可能很差。

## 八、删除、更新与重建

FAISS 不同索引对删除、重建 ID 和直接映射的支持不同。例如 IVF 若要按 ID 重建或更新向量，通常需要配置 `DirectMap`；顺序 ID 与显式 ID 的删除行为也不同。因此不要假设所有索引都能用同一套 `remove_ids()` 逻辑。

文档更新通常意味着：

```text
原文变化
-> 重新切分 chunk
-> 重新计算 embedding
-> 生成新的稳定 chunk ID
-> 构建新索引版本
-> 同版本发布元数据
-> 切换 CURRENT
```

对以批量更新为主的 RAG 知识库，全量或分片重建往往比在复杂索引上做原地修改更容易验证。数据库可以先把旧 chunk 标记为删除，查询端在新版本切换完成前继续做最终状态检查。

## 九、并发和部署：读写分离

最简单可靠的服务结构是：

```text
构建进程：读取快照 -> 生成新版本 -> 校验 -> 发布
                                      |
                                      v
查询进程：启动/收到通知 -> 加载完整版本 -> 只读查询
```

需要遵守几条边界：

- 不让多个 Web worker 同时覆盖同一个索引文件；
- 不在查询进行时修改同一个内存索引；
- 新索引完整加载并自检后，再替换进程持有的引用；
- 旧引用等正在执行的请求结束后再释放；
- 索引版本和元数据快照必须一起切换。

如果单机内存放不下索引，可以考虑 IVF 的磁盘倒排列表或分片，但磁盘随机访问、缓存命中和故障恢复都会成为新的设计约束。GPU 索引也不是简单地“打开开关”：需要核对 CUDA、FAISS 构建版本、显存容量、CPU/GPU 转换支持和批量大小，并用真实流量压测。

## 十、问题排查清单

当“FAISS 返回了结果，但答案不对”时，按下面顺序排查通常最快：

1. **模型契约**：库向量和查询向量是否来自同一模型、同一 revision、同一 pooling 方法？
2. **维度与数值**：是否为 `(n, d)`、`float32`、有限值且没有零向量？
3. **度量契约**：余弦检索是否同时归一化两端？分数方向是否解释正确？
4. **ID 映射**：FAISS ID 是否能唯一对应当前版本的 chunk？是否过滤了 `-1`？
5. **版本一致性**：索引、manifest 和业务元数据是否来自同一次构建？
6. **权限过滤**：是否因为先 Top-K 后过滤而丢失候选？
7. **ANN 参数**：提高 `nprobe` 或 `efSearch` 后，与 Flat 的重叠率是否上升？
8. **上游质量**：chunk 是否切断答案，embedding 是否适合当前语言和领域？

如果把 IVF 的 `nprobe` 调到足够大后仍与 Flat 差异明显，应先检查预处理、度量和包装索引上的参数设置，而不是继续盲调。

## 十一、总结

FAISS 的 API 很短，可靠检索系统的难点却不在 `index.search()`。真正需要长期维护的是：

- 用明确的距离契约约束归一化和分数方向；
- 用稳定 `int64` ID 连接索引与业务数据；
- 用 manifest 绑定模型、维度、索引类型和文件哈希；
- 用 Flat 建立精确基线，再为延迟或内存选择 HNSW、IVF、PQ；
- 用不可变版本和读写分离避免半写文件与版本错配；
- 将 ANN 召回率与业务相关性分开评估；
- 在返回原文前执行最终权限与状态检查。

做到这些，FAISS 才不只是“能快速返回几个 ID”，而是一个结果可解释、版本可追踪、故障可回滚的检索组件。

## 参考资料

- [FAISS：MetricType 与距离说明](https://github.com/facebookresearch/faiss/wiki/MetricType-and-distances)
- [FAISS：索引类型与内存开销](https://github.com/facebookresearch/faiss/wiki/Faiss-indexes)
- [FAISS：索引工厂语法](https://github.com/facebookresearch/faiss/wiki/The-index-factory)
- [FAISS：删除、重建与 DirectMap](https://github.com/facebookresearch/faiss/wiki/Special-operations-on-indexes)
- [FAISS FAQ](https://github.com/facebookresearch/faiss/wiki/FAQ)
- [FAISS：百万向量索引基准](https://github.com/facebookresearch/faiss/wiki/Indexing-1M-vectors)
- [FAISS：无法完全放入内存的索引](https://github.com/facebookresearch/faiss/wiki/Indexes-that-do-not-fit-in-RAM)
