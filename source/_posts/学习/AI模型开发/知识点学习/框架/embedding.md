---
title: "Embedding 入门笔记"
date: 2026-04-20 09:03:11
updated: 2026-04-20 09:03:11
categories:
  - "学习"
  - "AI模型开发"
  - "知识点学习"
  - "框架"
permalink: /notes/ai模型开发/知识点学习/框架/embedding/
---

# Embedding 入门笔记

## 1. 什么是 Embedding

Embedding 做的事情可以先这样看：

- 把文本、图片、代码等内容，转换成一串数字
- 这串数字不是随便生成的，而是尽量保留原内容的“语义信息”
- 语义越接近的内容，转成的向量通常越接近

更直接一点说，Embedding 是把人能理解的内容，变成机器更容易比较和计算的向量表示。

---

## 2. 为什么需要 Embedding

计算机不直接理解“意思”，它更擅长处理数字。

例如这两句话：

- 今天天气很好
- 今天阳光不错

如果只看关键词，它们并不完全一样；
但如果转成 embedding，它们在向量空间里通常会比较近，因为语义接近。

所以 embedding 的核心价值是：

- 不只看字面是否一样
- 更关注内容“意思像不像”

---

## 3. Embedding 的直观类比

可以把 embedding 想成“给每段内容找一个坐标”。

- 语义相近的内容，坐标位置更近
- 语义差别大的内容，坐标位置更远

例如：

- “苹果手机”
- “iPhone”

它们可能在向量空间里很接近。

而：

- “苹果手机”
- “高等数学”

它们通常会相距很远。

---

## 4. Embedding 的输出长什么样

Embedding 的结果一般是一个高维向量，例如：

```text
[0.021, -0.184, 0.337, ..., 0.092]
```

特点：

- 从形式上看，就是一串浮点数组成的列表
- 维度可能是几百到几千
- 人看不懂具体数值，但模型和检索系统可以利用它做计算

你不需要记住每个数值，只需要理解：

- 向量本身没有直观意义
- 向量之间的“距离/相似度”有意义

---

## 5. Embedding 主要解决什么问题

### 5.1 语义检索

最常见用途。

用户搜索：

- “怎么提高学习效率”

文档里写的是：

- “如何建立高效的学习习惯”

虽然字面不完全一致，但 embedding 检索可能仍然能找到这段内容。

### 5.2 推荐系统

- 给用户推荐相似文章
- 推荐相似商品
- 推荐相似视频

### 5.3 聚类

把意思接近的内容自动分到一组。

### 5.4 分类

把新文本和已有标签进行相似度比较，辅助分类。

### 5.5 RAG

这是现在最常见的 AI 应用场景之一。

流程通常是：

1. 先把知识库文本切块
2. 每个块生成 embedding
3. 用户提问时，也生成问题的 embedding
4. 用相似度检索最相关的文本块
5. 把检索结果交给大模型生成回答

---

## 6. Embedding 的基本工作流程

以文本为例：

### 第一步：准备文本

原始文档通常不会整篇直接做 embedding，而是先切成多个小块（chunk）。

原因：

- 太长会超过模型限制
- 粒度太大不利于精确检索
- 分块后更适合做 RAG

### 第二步：调用 embedding 模型

把每个文本块输入 embedding 模型，得到一个向量。

### 第三步：存储向量

常见存储方式：

- 向量数据库
- FAISS
- pgvector
- Milvus
- Weaviate

### 第四步：用户提问

把用户问题也转成 embedding。

### 第五步：计算相似度

把“问题向量”和“文本块向量”做相似度计算，找到最相近的几个结果。

### 第六步：返回结果或交给大模型

- 可以直接返回检索结果
- 也可以把结果交给 LLM 生成更完整的回答

---

## 7. 常见的相似度计算方式

Embedding 常见比较方式有：

- 余弦相似度（Cosine Similarity）
- 点积（Dot Product）
- 欧氏距离（Euclidean Distance）

初学阶段重点理解一个结论：

- 两个向量越相似，通常说明两段内容语义越接近

实际工程里，很多系统常用余弦相似度。

---

## 8. Embedding 和关键词搜索的区别

### 关键词搜索

优点：

- 简单直接
- 精确匹配效果好

缺点：

- 容易受措辞影响
- 同义词、近义表达处理较弱

### Embedding 搜索

优点：

- 更关注语义
- 能处理“说法不同但意思接近”的情况

缺点：

- 成本更高
- 结果不一定完全可解释
- 有时会召回“看起来像，但其实不对”的内容

结论：

- 关键词搜索适合精确匹配
- embedding 搜索适合语义检索
- 很多实际系统会把两者结合起来

---

## 9. Embedding 在 RAG 里的位置

RAG 可以粗略理解成：

- Embedding 负责“找资料”
- 大模型负责“组织答案”

也就是说：

- Embedding 决定你能不能找到相关上下文
- LLM 决定你能不能把上下文回答得清楚

如果 embedding 检索不到有用内容，那么后面的生成效果通常也会变差。

所以在 RAG 里，embedding 不是配角，而是基础能力。

---

## 10. 初学者最容易混淆的几个点

### 10.1 Embedding 不是生成答案

Embedding 主要做“表示”和“检索”，不是直接生成自然语言回答。

### 10.2 Embedding 不等于关键词匹配

它更偏向语义空间中的相似性，而不是简单的词面重合。

### 10.3 向量维度不是越大越好

维度更高不一定代表效果一定更强，还要考虑：

- 模型质量
- 成本
- 存储空间
- 检索速度

### 10.4 文本切块很重要

很多检索效果差，不一定是 embedding 模型不行，可能是：

- 切块太大
- 切块太碎
- 重叠设置不合理
- 清洗文本质量差

---

## 11. 一个最小例子

假设知识库里有三段文本：

1. Python 是一种编程语言
2. 篮球是一项团队运动
3. 机器学习是人工智能的重要分支

用户问题是：

> 什么是 AI 的一个重要领域？

系统流程：

1. 先把这三段文本转成 embedding
2. 再把用户问题转成 embedding
3. 比较问题与三段文本的相似度
4. 第 3 段大概率最相近
5. 系统返回第 3 段，或者交给大模型生成最终答案

这就是 embedding 在检索中的基本逻辑。

---

## 12. 学习 Embedding 时建议先掌握的关键词

- 向量（vector）
- 维度（dimension）
- 语义相似度（semantic similarity）
- 文本切块（chunking）
- 向量检索（vector search）
- 召回（recall）
- 重排（rerank）
- RAG

---

## 13. 初学者学习路线

### 第一阶段：先懂概念

重点搞清楚：

- embedding 是什么
- 为什么能做语义检索
- 它和关键词搜索有什么区别

### 第二阶段：能跑一个小 demo

例如：

- 准备几段文本
- 生成 embedding
- 输入一个问题
- 找出最相似的文本

### 第三阶段：结合 RAG 理解

重点理解：

- 文档如何切块
- 向量如何存储
- 如何检索 top-k
- 为什么还需要 rerank

### 第四阶段：再看工程优化

例如：

- 检索召回率
- 多语言效果
- 成本控制
- 延迟优化

---

## 14. 一句话总结

Embedding 的本质，是把内容变成可以计算“语义距离”的向量表示。
它是语义检索、推荐系统、聚类分析和 RAG 的基础能力之一。

---

## 15. Embedding 模型怎么选

初学者选 embedding 模型时，重点不要只盯着“排行榜”，而要先看是否适合自己的场景。

可以先看 4 个维度：

### 15.1 语言

- 主要是中文，就优先选中文效果好的模型
- 中英混合，就选多语言模型
- 如果业务是代码、医学、法律等领域，最好找更贴近领域语料的模型

### 15.2 成本和速度

- 在线 API：接入快，但按量付费
- 本地开源模型：可控性高，但需要本地算力和部署成本

### 15.3 向量维度

- 维度更高，不代表一定更好
- 维度越高，通常存储成本和检索开销也会更高

### 15.4 是否适合检索任务

有些模型更偏“通用表征”，有些模型更偏“检索优化”。

做 RAG 时，优先选择明确用于 embedding / retrieval 的模型，而不是随便拿一个生成模型来代替。

### 15.5 初学者建议

如果你只是入门，建议先用一个成熟模型把流程跑通，不要一开始就在模型上反复切换。

可以按这个顺序来理解：

- 第一阶段先验证流程能跑通
- 第二阶段再比较不同模型的效果

---

## 16. 文本切块怎么做

Embedding 效果好不好，很多时候不只是模型问题，切块策略同样重要。

### 16.1 为什么要切块

因为原始文档通常太长，不适合直接拿整篇去做检索。

切块的目标是：

- 每块内容尽量表达一个相对完整的意思
- 不能太长，否则检索不精准
- 也不能太短，否则上下文不足

### 16.2 常见切块方式

#### 固定长度切块

比如每 300 字或每 500 tokens 切一块。

优点：

- 简单
- 容易实现

缺点：

- 可能把完整段落切断

#### 按段落 / 标题切块

根据自然段、标题、小节来切。

优点：

- 语义更完整

缺点：

- 长度不稳定

#### 混合切块

先按标题和段落切，再对过长部分按长度继续细分。

这是实际项目里很常见的方式。

### 16.3 什么是 overlap

`overlap` 就是相邻 chunk 之间保留一部分重复内容。

作用：

- 避免关键信息刚好被切断
- 提高上下文连续性

例如：

- chunk1: 第 1~300 字
- chunk2: 第 260~560 字

这里就有 40 字重叠。

### 16.4 初学者的默认思路

可以先从下面这个简单策略开始：

- 中文笔记或普通文档：每块 300~500 字
- overlap：10%~20%
- 优先按标题和段落切，长度超了再二次切分

这不是固定标准，只是适合作为第一版 baseline。

---

## 17. 向量数据库和 FAISS 是什么关系

很多初学者会把 embedding、FAISS、向量数据库混在一起，其实它们不是一回事。

### 17.1 Embedding 模型负责什么

负责把文本转成向量。

### 17.2 FAISS 负责什么

FAISS 是一个向量检索库，重点是：

- 存向量
- 建索引
- 做近似或精确检索

它更像“本地检索引擎”，适合：

- 学习
- 单机实验
- 本地部署

### 17.3 向量数据库负责什么

向量数据库除了向量检索，还经常提供：

- 元数据过滤
- 持久化
- 集群能力
- 权限和服务化接口

### 17.4 怎么选

- 只是学习原理：先用 FAISS
- 已经有 PostgreSQL：可以考虑 `pgvector`
- 需要完整服务化能力：再考虑 Milvus、Weaviate、Pinecone 一类方案

职责可以这样拆开看：embedding 负责生成向量，FAISS 或向量数据库负责保存、索引和检索这些向量。

---

## 18. 为什么检索后还需要 Rerank

很多 RAG 系统不是“检索完直接交给大模型”，而是会多一步 rerank。

### 18.1 检索和 rerank 的区别

第一阶段检索：

- 用 embedding 先快速找出 top-k 候选片段
- 目标是“尽量别漏掉相关内容”

第二阶段 rerank：

- 对候选片段重新打分排序
- 目标是“把最相关的排到最前面”

### 18.2 为什么要这样做

因为 embedding 检索更像“粗筛”，速度快，但有时不够精细。
rerank 更像“精筛”，速度慢一些，但相关性通常更好。

常见做法是：

1. embedding 先召回 top 10 或 top 20
2. rerank 再选出 top 3 或 top 5
3. 把这几个最相关片段交给 LLM

### 18.3 初学者什么时候需要 rerank

如果你的知识库还比较小，可以先不加 rerank。
当你发现“明明检索到了相关内容，但排序不理想”时，再加 rerank 会更有感觉。

---

## 19. RAG 的完整工作流

把 embedding 放到 RAG 里，可以拆成两条链路来看。

### 19.1 入库链路

1. 读取原始文档
2. 清洗文本
3. 按规则切块
4. 为每个 chunk 生成 embedding
5. 保存 chunk 文本、元数据和向量
6. 建立向量索引

这里通常还会一起保存：

- `doc_id`
- `chunk_id`
- `source`
- `title`
- `section`
- `text`

这样后面才能做引用返回和结果定位。

### 19.2 查询链路

1. 用户输入问题
2. 把问题转成 embedding
3. 到向量库里召回 top-k chunks
4. 如果有 rerank，再重排一次
5. 把相关 chunks 拼进 prompt
6. 交给 LLM 生成答案
7. 返回答案和引用来源

### 19.3 在这个流程里谁最关键

- chunking 决定“切得好不好”
- embedding 决定“能不能找对”
- rerank 决定“排得准不准”
- LLM 决定“答得顺不顺”

所以 RAG 的质量不是只靠一个大模型决定的。

---

## 20. 一个最小可运行示例

下面这个例子演示：

- 先把几段文本转成 embedding
- 用 FAISS 建索引
- 再用问题去检索最相近的内容

安装：

```bash
pip install sentence-transformers faiss-cpu numpy
```

示例代码：

```python
import numpy as np
import faiss
from sentence_transformers import SentenceTransformer

docs = [
    "Python 是一种通用编程语言。",
    "Celery 用来处理异步任务。",
    "Embedding 可以把文本表示成向量。",
]

query = "什么技术可以把文本变成向量？"

# 这里只是示例，模型名可以按你的语言和场景替换
model = SentenceTransformer("BAAI/bge-small-zh-v1.5")

# normalize_embeddings=True 时，常配合内积检索
doc_vectors = model.encode(docs, normalize_embeddings=True)
doc_vectors = np.asarray(doc_vectors, dtype="float32")

index = faiss.IndexFlatIP(doc_vectors.shape[1])
index.add(doc_vectors)

query_vector = model.encode([query], normalize_embeddings=True)
query_vector = np.asarray(query_vector, dtype="float32")

scores, ids = index.search(query_vector, k=2)

for score, idx in zip(scores[0], ids[0]):
    print(f"score={score:.4f} text={docs[idx]}")
```

如果结果里把：

- `Embedding 可以把文本表示成向量。`

排在最前面，就说明最基本的语义检索已经跑通了。

---

## 21. 检索效果不好时怎么排查

很多时候不是“模型不行”，而是流程某一环出了问题。

建议按这个顺序排查：

### 21.1 先看 chunk

- 是否切得太碎
- 是否一块里塞了太多主题
- 标题和正文是否被拆散

### 21.2 再看文本清洗

- 是否有大量乱码
- 是否混入无关模板文字
- 是否把表格、代码块、换行结构破坏了

### 21.3 再看相似度设置

- 向量是否做了归一化
- 模型推荐的是 cosine、dot product 还是 L2
- 索引方式是否和模型假设一致

### 21.4 再看召回数量

- `top_k` 太小可能漏召回
- `top_k` 太大又可能引入太多噪声

### 21.5 最后再考虑 rerank 和模型替换

先把 chunking、清洗、召回这些基础问题处理好，再换模型，效率会更高。

---

## 22. 参考博客 / 文档

适合初学者先看的几篇：

- OpenAI Embeddings Guide: <https://platform.openai.com/docs/guides/embeddings>
- OpenAI Key Concepts - Embeddings: <https://platform.openai.com/docs/concepts#embeddings>
- Pinecone - What Are Vector Embeddings?: <https://www.pinecone.io/learn/vector-embeddings/>
- Pinecone - Vector Embeddings for Developers: <https://www.pinecone.io/learn/vector-embeddings-for-developers/>
- Sentence Transformers Documentation: <https://www.sbert.net/>
- FAISS Documentation: <https://faiss.ai/>

继续深入可以看：

- pgvector: <https://github.com/pgvector/pgvector>
- Cohere - Reranking Best Practices: <https://docs.cohere.com/docs/reranking-best-practices>

---

## 23. 一句话总结

Embedding 不是单独存在的技术点，而是语义检索、向量数据库、rerank 和 RAG 整条链路中的基础环节。
真正做项目时，要把它放进“切块 -> 向量化 -> 检索 -> 重排 -> 生成”的完整流程里理解。
