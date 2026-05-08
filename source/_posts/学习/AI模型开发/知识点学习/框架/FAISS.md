---
title: "FAISS 学习笔记"
date: 2026-04-23 10:58:19
updated: 2026-04-23 10:58:19
categories:
  - "学习"
  - "AI模型开发"
  - "知识点学习"
  - "框架"
permalink: /notes/ai模型开发/知识点学习/框架/faiss/
---

# FAISS 学习笔记

## 1. FAISS 是什么

FAISS，全称 Facebook AI Similarity Search，是一个用于高效向量相似度搜索和聚类的库。

它最常见的用途是：

- 语义检索
- 图片检索
- 推荐系统召回
- RAG 文档检索
- 大规模 embedding 向量查找

可以先这样理解：

> Embedding 模型负责把文本变成向量，FAISS 负责在一堆向量里快速找到最相似的几个。

在 RAG 里，FAISS 通常位于这条链路中：

```text
文档
  -> 切分 chunk
  -> embedding 模型生成向量
  -> FAISS 建索引
  -> 用户问题生成 query embedding
  -> FAISS Top-K 检索
  -> 把检索结果交给 LLM 生成回答
```

FAISS 本身不是完整数据库，它主要管理向量索引。文档标题、chunk 内容、文件路径、页码、用户 ID、权限等元数据，通常还要放在 MySQL、PostgreSQL、MongoDB 或其他业务数据库里。

## 2. 为什么需要 FAISS

如果有 10 个向量，直接遍历计算相似度就够了。

但如果有：

- 10 万个 chunk
- 100 万个商品向量
- 1000 万张图片特征

每次查询都全量遍历会很慢。

FAISS 解决的是：

- 怎么快速找到最近邻
- 怎么在速度、召回率、内存之间做取舍
- 怎么支持百万级、千万级甚至更大规模的向量检索

在小规模 RAG 项目里，`IndexFlat` 就能跑通完整链路；数据量上来后，再考虑 IVF、HNSW、PQ 等索引结构。

## 3. FAISS 的核心概念

### 3.1 向量

FAISS 处理的是固定维度的向量。

例如一个 embedding 模型输出 768 维向量：

```text
[0.12, -0.03, 0.88, ..., 0.41]
```

那么 FAISS 里的所有向量都必须是 768 维。

如果数据库向量是 768 维，而查询向量是 1024 维，就不能放在同一个 index 里检索。

### 3.2 `d`

`d` 表示向量维度。

```python
d = 768
index = faiss.IndexFlatL2(d)
```

这个 `d` 必须和 embedding 模型输出维度一致。

### 3.3 `xb` 和 `xq`

FAISS 官方示例里经常用两个名字：

- `xb`：database vectors，要被索引的向量集合
- `xq`：query vectors，查询向量

它们通常都是 NumPy 数组：

```python
xb.shape == (num_vectors, dimension)
xq.shape == (num_queries, dimension)
```

例如：

```text
xb: 10000 个文档 chunk 向量，每个 768 维
xq: 1 个用户问题向量，每个 768 维
```

### 3.4 Index

FAISS 的核心对象是 `Index`。

Index 可以理解成：

> 存放向量并支持相似度搜索的数据结构。

常用操作：

- `add()`：添加向量
- `search()`：查询最近的 Top-K 向量
- `train()`：训练索引，部分索引需要
- `ntotal`：当前索引中有多少条向量
- `is_trained`：索引是否已经训练完成

### 3.5 `D` 和 `I`

FAISS 搜索结果通常返回两个数组：

```python
D, I = index.search(query_vectors, k)
```

含义：

- `D`：距离或相似度分数
- `I`：检索到的向量 ID 或内部下标

例如：

```text
I = [[12, 88, 102]]
D = [[0.13, 0.20, 0.35]]
```

表示当前查询最相关的 3 个结果分别是第 12、88、102 个向量。

注意：

- L2 距离下，`D` 越小越相似。
- Inner Product 下，`D` 越大越相似。

## 4. 安装

CPU 版本：

```bash
pip install faiss-cpu
```

GPU 版本通常需要匹配 CUDA 环境，安装方式会和系统、CUDA、Python 版本有关。初学和普通 RAG 后端项目，先用 CPU 版本就够。

## 5. 最小可运行示例

```python
import faiss
import numpy as np

d = 4
xb = np.array(
    [
        [1.0, 0.0, 0.0, 0.0],
        [0.9, 0.1, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
    ],
    dtype="float32",
)

xq = np.array([[1.0, 0.0, 0.0, 0.0]], dtype="float32")

index = faiss.IndexFlatL2(d)
index.add(xb)

k = 2
D, I = index.search(xq, k)

print(D)
print(I)
```

这段代码做了几件事：

1. 准备一批数据库向量 `xb`
2. 准备查询向量 `xq`
3. 创建 L2 距离索引 `IndexFlatL2`
4. 把数据库向量加入索引
5. 查询最相近的 2 个向量

## 6. 数据格式要求

FAISS 对输入数据有几个常见要求：

- NumPy 数组通常要是 `float32`
- shape 要是二维：`(n, d)`
- 数据最好是连续内存
- 所有向量维度必须一致

推荐这样处理：

```python
vectors = np.asarray(vectors, dtype="float32")
vectors = np.ascontiguousarray(vectors)
```

如果只有一个查询向量，不要传一维数组：

```python
# 不推荐
query.shape == (768,)

# 推荐
query.shape == (1, 768)
```

可以这样修正：

```python
query = np.asarray(query, dtype="float32").reshape(1, -1)
```

## 7. 距离和相似度

FAISS 里最常见的两种检索方式：

- L2 距离
- Inner Product 内积

### 7.1 L2 距离

L2 距离就是欧氏距离。

FAISS 的 `METRIC_L2` 返回的是平方 L2 距离，不开根号。排序结果不受影响，因为平方距离和真实欧氏距离是单调一致的。

使用方式：

```python
index = faiss.IndexFlatL2(d)
```

特点：

- `D` 越小越相似
- 适合直接按距离找最近邻

### 7.2 Inner Product

Inner Product 是内积，常用于最大内积搜索。

使用方式：

```python
index = faiss.IndexFlatIP(d)
```

特点：

- `D` 越大越相似
- 常用于已经归一化的 embedding 检索

### 7.3 余弦相似度怎么做

很多文本 embedding 检索习惯使用余弦相似度。

FAISS 里常见做法是：

1. 使用 `IndexFlatIP`
2. 添加向量前先做 L2 归一化
3. 查询向量也做 L2 归一化

代码：

```python
import faiss
import numpy as np

d = 768
xb = np.asarray(xb, dtype="float32")
xq = np.asarray(xq, dtype="float32")

faiss.normalize_L2(xb)
faiss.normalize_L2(xq)

index = faiss.IndexFlatIP(d)
index.add(xb)

D, I = index.search(xq, k=5)
```

注意：

> 如果只归一化文档向量，不归一化查询向量，或者反过来，只归一化查询向量不归一化文档向量，结果都会不一致。

## 8. 常见索引类型

FAISS 有很多索引。初学阶段先掌握这几类就够。

### 8.1 `IndexFlatL2`

精确 L2 检索。

```python
index = faiss.IndexFlatL2(d)
```

特点：

- 不需要训练
- 暴力搜索，结果精确
- 数据量小到中等时很好用
- 内存占用约等于 `向量数量 * 维度 * 4 字节`

适合：

- 本地 demo
- 小规模 RAG
- 先验证业务链路
- 作为评测近似索引 recall 的 ground truth

### 8.2 `IndexFlatIP`

精确内积检索。

```python
index = faiss.IndexFlatIP(d)
```

特点：

- 不需要训练
- 暴力搜索，结果精确
- 搭配向量归一化后，常用于余弦相似度检索

适合：

- 文本 embedding 语义检索
- RAG 原型
- 中小规模知识库

### 8.3 `IndexHNSWFlat`

HNSW 是一种基于图的近似最近邻搜索方法。

```python
index = faiss.IndexHNSWFlat(d, 32)
```

第二个参数通常叫 `M`，可以理解成图里每个节点连接的邻居数量。

特点：

- 不需要像 IVF 那样单独训练
- 搜索速度快
- 召回率通常不错
- 内存比 Flat 更高，因为要额外存图结构

常见调参：

```python
index.hnsw.efSearch = 64
index.hnsw.efConstruction = 200
```

简单理解：

- `M` 越大，图更密，召回更好，内存更高。
- `efSearch` 越大，搜索更认真，召回更好，速度更慢。
- `efConstruction` 越大，建图更慢，但图质量可能更好。

适合：

- 希望查询快
- 数据规模比 Flat 更大
- 可以接受近似结果

### 8.4 `IndexIVFFlat`

IVF，全称 Inverted File，可以理解成“先粗分类，再局部搜索”。

基本思路：

1. 先把向量空间分成很多个簇
2. 添加向量时，把每个向量放进对应簇里
3. 查询时，只搜索最相关的几个簇

代码：

```python
import faiss

d = 768
nlist = 100

quantizer = faiss.IndexFlatIP(d)
index = faiss.IndexIVFFlat(
    quantizer,
    d,
    nlist,
    faiss.METRIC_INNER_PRODUCT,
)

faiss.normalize_L2(train_vectors)
faiss.normalize_L2(database_vectors)
faiss.normalize_L2(query_vectors)

index.train(train_vectors)
index.add(database_vectors)

index.nprobe = 10
D, I = index.search(query_vectors, k=5)
```

关键参数：

- `nlist`：聚类中心数量，也就是分多少个桶
- `nprobe`：查询时搜索多少个桶

简单理解：

- `nlist` 越大，桶越多，每个桶里数据越少，但训练和管理更复杂。
- `nprobe` 越大，搜的桶越多，召回更高，速度更慢。

注意：

> IVF 类索引通常需要先 `train()`，再 `add()`。

适合：

- 数据量较大
- 希望比 Flat 更快
- 能接受近似检索

### 8.5 `IndexIVFPQ`

PQ，全称 Product Quantization，核心目的是压缩向量。

`IndexIVFPQ` 可以理解成：

> IVF 负责缩小搜索范围，PQ 负责压缩每个向量，降低内存占用。

特点：

- 内存占用明显降低
- 查询速度可以更快
- 结果是近似的
- 实现和调参比 Flat、HNSW、IVFFlat 更复杂

适合：

- 向量数量很大
- 内存压力明显
- 可以接受召回率下降

对于普通 RAG 项目，不建议一开始就用 IVFPQ。先用 `IndexFlatIP` 或 `IndexHNSWFlat` 跑通业务，再根据数据量和性能瓶颈升级。

## 9. `index_factory`

FAISS 提供 `index_factory` 用字符串快速创建索引。

例如：

```python
index = faiss.index_factory(d, "Flat", faiss.METRIC_INNER_PRODUCT)
```

HNSW：

```python
index = faiss.index_factory(d, "HNSW32,Flat", faiss.METRIC_INNER_PRODUCT)
```

IVF：

```python
index = faiss.index_factory(d, "IVF100,Flat", faiss.METRIC_INNER_PRODUCT)
```

IVFPQ：

```python
index = faiss.index_factory(d, "IVF100,PQ16", faiss.METRIC_INNER_PRODUCT)
```

`index_factory` 的好处是：

- 创建复合索引更方便
- 配置可以字符串化
- 适合写到配置文件里

缺点是：

- 初学时不如显式构造容易理解
- 写错字符串时排查成本更高

建议：

- 学习阶段先显式构造
- 熟悉索引类型后再用 `index_factory`

## 10. 向量 ID 和业务 ID

### 10.1 默认 ID

如果直接这样添加：

```python
index.add(vectors)
```

FAISS 会使用内部连续 ID：

```text
0, 1, 2, 3, ...
```

这适合简单 demo，但真实项目里通常不够。

因为 RAG 里你真正关心的是：

- 这个向量属于哪个文档
- 是第几个 chunk
- 对应 MySQL 里的哪条记录
- 原文内容是什么
- 页码、标题、来源是什么

### 10.2 使用 `IndexIDMap`

可以给向量指定自己的 ID：

```python
import faiss
import numpy as np

base_index = faiss.IndexFlatIP(d)
index = faiss.IndexIDMap(base_index)

vectors = np.asarray(vectors, dtype="float32")
ids = np.asarray([101, 102, 103], dtype="int64")

faiss.normalize_L2(vectors)
index.add_with_ids(vectors, ids)

D, I = index.search(query, k=3)
```

这里返回的 `I` 就是你传入的业务 ID。

### 10.3 RAG 项目里的 ID 设计

推荐做法：

```text
MySQL chunk 表：
- id: chunk_id
- document_id
- chunk_index
- content
- page
- metadata
- embedding_model
- created_at

FAISS：
- 向量 ID 使用 chunk_id
```

搜索后：

```text
FAISS 返回 chunk_id
  -> 用 chunk_id 查 MySQL
  -> 取 content、document_id、page、source
  -> 组装 prompt 和 citation
```

不要把大量元数据硬塞进 FAISS。FAISS 适合管向量，不适合替代业务数据库。

## 11. 索引保存和加载

FAISS index 可以保存到磁盘。

```python
faiss.write_index(index, "docs.index")
```

加载：

```python
index = faiss.read_index("docs.index")
```

RAG 项目里常见做法：

```text
data/
└── indexes/
    ├── kb_1.index
    ├── kb_2.index
    └── kb_3.index
```

同时在数据库里记录：

```text
knowledge_base_id
index_path
embedding_model
embedding_dim
metric_type
index_type
chunk_count
version
updated_at
```

这样做的好处：

- 服务重启后可以直接加载 index
- 可以知道 index 对应哪个 embedding 模型
- 模型切换后能判断旧索引是否需要重建

## 12. RAG 项目中的 FAISS 封装

在项目里不要把 FAISS 操作散落在 router 或 service 里，建议封装成 `VectorStore`。

示例：

```python
from pathlib import Path

import faiss
import numpy as np

class FaissVectorStore:
    def __init__(self, dim: int, index_path: str | None = None):
        self.dim = dim
        self.index_path = Path(index_path) if index_path else None

        if self.index_path and self.index_path.exists():
            self.index = faiss.read_index(str(self.index_path))
            if self.index.d != dim:
                raise ValueError("index dimension mismatch")
        else:
            base_index = faiss.IndexFlatIP(dim)
            self.index = faiss.IndexIDMap(base_index)

    def add(self, vectors: np.ndarray, ids: np.ndarray) -> None:
        vectors = np.asarray(vectors, dtype="float32")
        vectors = np.ascontiguousarray(vectors)
        ids = np.asarray(ids, dtype="int64")

        if vectors.ndim != 2 or vectors.shape[1] != self.dim:
            raise ValueError("invalid vector shape")

        faiss.normalize_L2(vectors)
        self.index.add_with_ids(vectors, ids)

    def search(self, query: np.ndarray, top_k: int = 5):
        query = np.asarray(query, dtype="float32").reshape(1, -1)
        query = np.ascontiguousarray(query)

        if query.shape[1] != self.dim:
            raise ValueError("invalid query dimension")

        faiss.normalize_L2(query)
        scores, ids = self.index.search(query, top_k)
        return scores[0], ids[0]

    def save(self) -> None:
        if not self.index_path:
            raise ValueError("index_path is required")
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        faiss.write_index(self.index, str(self.index_path))
```

这层封装负责：

- 统一检查向量维度
- 统一转 `float32`
- 统一做归一化
- 统一保存和加载 index
- 对上层隐藏 FAISS 细节

## 13. 在 FastAPI + Celery + FAISS 中的位置

结合你的 RAG 项目，可以这样拆：

```text
FastAPI：
- 接收上传请求
- 创建 document 和 task 记录
- 返回 task_id

Celery：
- 解析文档
- chunk 切分
- 调 embedding 模型
- 调 VectorStore.add()
- 保存 FAISS index
- 更新任务状态

FastAPI chat 接口：
- 接收用户问题
- 调 embedding 模型生成 query vector
- 调 VectorStore.search()
- 根据 chunk_id 查 MySQL
- 拼接上下文
- 调 LLM
- 保存 message 和 citation
```

一个简化链路：

```text
upload document
  -> Celery ingest task
  -> chunks
  -> embeddings
  -> FAISS index
  -> MySQL chunk metadata

chat question
  -> query embedding
  -> FAISS top-k chunk_id
  -> MySQL load chunk content
  -> LLM answer
```

## 14. 单文档索引和知识库索引

### 14.1 单文档索引

每个文档一个 FAISS index。

优点：

- 实现简单
- 删除文档方便
- 文件和索引一一对应

缺点：

- 多文档检索麻烦
- 查询多个文档时要搜多个 index
- 不适合知识库级检索

### 14.2 知识库索引

一个知识库一个 FAISS index，里面包含多个文档的 chunk。

优点：

- 支持多文档统一检索
- 更接近真实 RAG 系统
- 检索流程简单

缺点：

- 删除单个文档更麻烦
- 索引版本管理更重要
- 需要维护 chunk_id 到文档元数据的映射

推荐：

- demo 阶段可以单文档索引
- 简历项目和真实项目更建议做知识库索引

## 15. 更新和删除

FAISS 不是传统数据库，更新和删除要谨慎设计。

### 15.1 添加

添加新 chunk 比较简单：

```python
index.add_with_ids(new_vectors, new_ids)
faiss.write_index(index, index_path)
```

### 15.2 删除

部分索引支持 `remove_ids()`，但工程上仍然要考虑：

- 删除后 MySQL 元数据是否同步
- index 文件是否需要重新保存
- 删除大量数据后索引质量是否下降
- 多进程读写是否冲突

更稳妥的做法：

```text
少量删除：
- 数据库标记 chunk/document 为 deleted
- 检索后过滤 deleted 结果

大量删除或周期整理：
- 根据有效 chunk 重新构建 index
- 原子替换旧 index 文件
```

### 15.3 更新

更新文档一般等价于：

1. 删除旧文档对应 chunk
2. 重新解析文档
3. 重新生成 embedding
4. 重新加入 index

如果更新频率高，就要认真设计索引重建策略。

## 16. 检索参数怎么选

### 16.1 `top_k`

`top_k` 表示返回几个候选 chunk。

RAG 常见取值：

- `top_k = 3`
- `top_k = 5`
- `top_k = 10`

取太小：

- 可能漏掉关键信息

取太大：

- prompt 变长
- 噪声变多
- LLM 成本上升

可以先用 `top_k=5`，后续根据实际效果调。

### 16.2 `nprobe`

IVF 索引里最重要的搜索参数是 `nprobe`。

```python
index.nprobe = 10
```

简单理解：

- `nprobe` 小：速度快，可能漏结果
- `nprobe` 大：召回高，速度慢

调参时要看：

- 查询耗时
- recall
- 最终回答质量

### 16.3 HNSW 参数

HNSW 常看：

- `M`
- `efConstruction`
- `efSearch`

经验理解：

- `M` 控制图连接密度
- `efConstruction` 控制建图质量
- `efSearch` 控制查询时探索范围

如果检索结果质量不够，先尝试调大 `efSearch`。

## 17. 如何评估 FAISS 检索效果

只看“能不能返回结果”是不够的。

RAG 项目里至少可以做几个简单评估：

### 17.1 Recall@K

如果你有标准答案 chunk，可以看：

```text
Recall@K = 正确 chunk 是否出现在 Top-K 结果里
```

例如：

- `Recall@1`
- `Recall@3`
- `Recall@5`

### 17.2 MRR

MRR 关注正确结果排在第几位。

如果正确 chunk 总是排在第一名，效果就很好。

### 17.3 人工问题集

最实用的方式是为每份文档准备一批问题：

```text
问题：论文里使用的数据集是什么？
期望命中的 chunk：chunk_id = 123
```

然后统计：

- 是否命中
- 排名第几
- 分数是多少
- LLM 最终回答是否引用了正确片段

### 17.4 检索耗时

RAG 链路里建议记录：

- embedding 耗时
- FAISS search 耗时
- MySQL 查 chunk 耗时
- LLM 生成耗时

这样才能知道瓶颈在哪里。

## 18. FAISS 和向量数据库的区别

FAISS 更像一个向量检索引擎或向量索引库。

向量数据库通常还提供：

- 数据持久化管理
- 元数据过滤
- 分布式存储
- 多租户
- 权限管理
- 在线增删改查
- 服务化 API

常见向量数据库：

- Milvus
- Qdrant
- Weaviate
- pgvector

对比：

```text
FAISS：
- 轻量
- 本地库
- 性能强
- 灵活
- 需要自己做元数据和服务封装

向量数据库：
- 功能完整
- 更偏生产服务
- 自带元数据过滤和管理能力
- 部署和维护成本更高
```

你的 RAG 项目如果是学习和简历展示，用 FAISS 很合适。它能让你真正理解向量检索、索引、召回率、Top-K、元数据映射这些底层概念。

## 19. 常见坑

### 19.1 忘记转 `float32`

很多 embedding 模型或 Python 处理流程会给出 `float64`。

FAISS 通常期望 `float32`。

```python
vectors = vectors.astype("float32")
```

### 19.2 向量维度不一致

比如：

```text
索引维度：768
查询向量：1024
```

这通常是因为：

- embedding 模型换了
- 文档向量和查询向量用了不同模型
- reshape 错了

解决：

- 数据库记录 `embedding_model` 和 `embedding_dim`
- 加载 index 时检查配置
- 查询前检查 query shape

### 19.3 做余弦检索但忘记归一化

如果用 `IndexFlatIP` 模拟余弦相似度，一定要：

- 入库向量归一化
- 查询向量归一化

否则内积会受到向量长度影响。

### 19.4 IVF 忘记 `train()`

IVF、PQ 这类索引通常需要训练。

错误流程：

```python
index = faiss.IndexIVFFlat(...)
index.add(vectors)
```

正确流程：

```python
index.train(train_vectors)
index.add(vectors)
```

可以检查：

```python
print(index.is_trained)
```

### 19.5 只保存 FAISS，不保存元数据

如果只保存 index 文件，不保存 chunk 元数据，搜索结果只会给你 ID，无法还原原文。

正确做法：

- FAISS 存向量
- MySQL 存 chunk 内容和元数据
- FAISS ID 对应 MySQL chunk_id

### 19.6 多进程同时写 index

如果 FastAPI 和多个 Celery worker 同时写同一个 index 文件，容易出问题。

建议：

- 写操作集中到单个任务队列
- 使用文件锁或数据库状态锁
- 写新文件后原子替换旧文件
- 查询服务读取稳定版本

### 19.7 把 FAISS 当数据库用

FAISS 适合相似度搜索，不适合做复杂业务查询。

这些事情应该交给业务数据库：

- 用户权限
- 文档状态
- 删除标记
- 文件来源
- 页码
- 文本内容
- citation 信息

## 20. RAG 项目里的推荐方案

如果是你的当前 RAG 文档检索项目，我建议这样选：

### 20.1 初版

```text
索引：IndexIDMap(IndexFlatIP)
相似度：归一化向量 + Inner Product
元数据：MySQL chunk 表
持久化：faiss.write_index()
任务：Celery 构建索引
```

优点：

- 简单
- 准确
- 方便调试
- 很适合简历项目说明

### 20.2 数据量变大后

如果 Flat 查询变慢，可以升级：

```text
IndexHNSWFlat
```

或者：

```text
IndexIVFFlat
```

建议顺序：

1. 先用 Flat 建基准
2. 再上 HNSW 或 IVF
3. 用 Recall@K 对比召回损失
4. 记录查询耗时变化

### 20.3 简历里可以怎么讲

可以写成：

```text
使用 FAISS 构建文档 chunk 向量索引，采用 chunk_id 作为向量 ID，并在 MySQL 中维护文档、chunk、索引版本和 citation 元数据；查询阶段对用户问题生成 embedding 后执行 Top-K 召回，再根据 chunk_id 回表获取原文内容并拼接上下文供 LLM 生成回答。
```

如果你做了评测，还可以加：

```text
基于人工问题集评估 Recall@K 和检索耗时，对比 IndexFlatIP、HNSW、IVFFlat 在召回率、延迟和内存占用上的差异。
```

## 21. 一个完整的 RAG 检索示例

```python
import faiss
import numpy as np

class SimpleRagIndex:
    def __init__(self, dim: int):
        self.dim = dim
        self.index = faiss.IndexIDMap(faiss.IndexFlatIP(dim))

    def add_chunks(self, embeddings: list[list[float]], chunk_ids: list[int]) -> None:
        vectors = np.asarray(embeddings, dtype="float32")
        vectors = np.ascontiguousarray(vectors)

        ids = np.asarray(chunk_ids, dtype="int64")

        if vectors.ndim != 2:
            raise ValueError("embeddings must be 2D")
        if vectors.shape[1] != self.dim:
            raise ValueError("embedding dimension mismatch")
        if len(ids) != len(vectors):
            raise ValueError("ids length mismatch")

        faiss.normalize_L2(vectors)
        self.index.add_with_ids(vectors, ids)

    def search(self, query_embedding: list[float], top_k: int = 5):
        query = np.asarray(query_embedding, dtype="float32").reshape(1, -1)
        query = np.ascontiguousarray(query)

        if query.shape[1] != self.dim:
            raise ValueError("query dimension mismatch")

        faiss.normalize_L2(query)
        scores, chunk_ids = self.index.search(query, top_k)

        results = []
        for score, chunk_id in zip(scores[0], chunk_ids[0]):
            if chunk_id == -1:
                continue
            results.append(
                {
                    "chunk_id": int(chunk_id),
                    "score": float(score),
                }
            )
        return results

rag_index = SimpleRagIndex(dim=4)

rag_index.add_chunks(
    embeddings=[
        [1.0, 0.0, 0.0, 0.0],
        [0.9, 0.1, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
    ],
    chunk_ids=[1001, 1002, 1003],
)

results = rag_index.search([1.0, 0.0, 0.0, 0.0], top_k=2)
print(results)
```

真实项目里，拿到 `chunk_id` 后再去 MySQL 查：

```text
chunk_id -> chunk content -> document metadata -> citation
```

## 22. 学习顺序

建议按这个顺序学：

1. 理解 embedding 和向量相似度
2. 跑通 `IndexFlatL2`
3. 跑通 `IndexFlatIP + normalize_L2`
4. 学会 `add()`、`search()`、`D/I`
5. 学会 `IndexIDMap` 绑定业务 ID
6. 学会 `write_index()` 和 `read_index()`
7. 接入 RAG 项目：chunk_id 回表查 MySQL
8. 数据量变大后再学 HNSW、IVF、PQ
9. 用 Recall@K 和耗时评估索引效果

## 23. 总结

FAISS 的核心价值是：

- 快速做向量相似度搜索
- 支持精确检索和近似检索
- 支持不同索引结构，在速度、内存、召回率之间取舍
- 非常适合 RAG 项目里的 Top-K chunk 召回

初学时先记住：

```text
Embedding 负责把文本变成向量
FAISS 负责从向量里找相似内容
MySQL 负责保存 chunk 内容和元数据
LLM 负责基于检索结果生成回答
```

对于你的 RAG 项目，最实用的起点是：

```text
IndexIDMap(IndexFlatIP) + normalize_L2 + chunk_id 回表查 MySQL
```

等数据量、延迟和内存真的成为问题，再升级 HNSW、IVF 或 PQ。

## 24. 参考

- FAISS GitHub: https://github.com/facebookresearch/faiss
- FAISS Wiki: https://github.com/facebookresearch/faiss/wiki
- FAISS Getting Started: https://github.com/facebookresearch/faiss/wiki/Getting-started
- FAISS Indexes: https://github.com/facebookresearch/faiss/wiki/Faiss-indexes
- FAISS MetricType and distances: https://github.com/facebookresearch/faiss/wiki/MetricType-and-distances
- FAISS Index Factory: https://github.com/facebookresearch/faiss/wiki/The-index-factory
