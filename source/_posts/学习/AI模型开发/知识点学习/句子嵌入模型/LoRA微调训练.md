---
title: "LoRA 微调训练笔记"
date: 2026-04-20 09:03:11
updated: 2026-04-20 09:03:11
categories:
  - "学习"
  - "AI模型开发"
  - "知识点学习"
  - "句子嵌入模型"
permalink: /notes/ai模型开发/知识点学习/句子嵌入模型/lora微调训练/
---

# LoRA 微调训练笔记

## 1. 什么是 LoRA

LoRA（Low-Rank Adaptation）是一种参数高效微调方法。

它的核心思路不是更新整个基座模型，而是：

- 冻结原始预训练权重
- 只在部分线性层旁边插入可训练的低秩矩阵
- 训练时只更新这部分新增参数

对句子嵌入模型来说，LoRA 特别适合下面几类场景：

- 显存有限，无法稳定做全量微调
- 想快速做领域适配，例如法律、医疗、电商、代码检索
- 希望保留同一个基座模型，同时维护多个领域 adapter
- 想减少模型发布体积，只保存 adapter 权重

可以先把 LoRA 看成一种轻量改造：不大动原来的基座模型，只额外训练一小部分增量参数。和全量微调相比，它更省显存，也更适合快速做领域适配。

---

## 2. LoRA 的算法原理

假设原始线性层权重是 `W`，全量微调要学的是一个完整的权重更新量 `ΔW`：

`W' = W + ΔW`

LoRA 认为这个更新量通常可以被一个低秩分解近似表示：

`ΔW ≈ sBA`

其中：

- `A` 的形状通常可写作 `r x d_in`
- `B` 的形状通常可写作 `d_out x r`
- `r` 是秩，远小于 `d_in` 和 `d_out`
- `s` 是缩放因子，常见写法是 `alpha / r`

因此 LoRA 后的线性层可写成：

`W' = W + sBA`

训练时：

- `W` 冻结不动
- 只训练 `A` 和 `B`

这样做的直接收益是：

- 可训练参数从 `d_out x d_in` 降到 `r x (d_in + d_out)`
- 反向传播只覆盖 LoRA 参数，显存占用更低
- 一个基座模型可以挂多个 adapter，便于多任务和多领域切换

常见初始化方式还会让 `B` 初始为 0，这样刚插入 LoRA 时输出和原模型基本一致，训练过程就相当于逐步学出一个增量更新。

---

## 3. LoRA 在句子嵌入训练中的位置

LoRA 只改变“哪些参数参与训练”，但不会改变 embedding 任务本身。

通常不变的东西有：

- 训练数据格式
- loss 设计
- pooling 方式
- 向量归一化策略
- 评估指标

真正变化的是：

- 原来训练全部 encoder 参数
- 现在只训练插入到 attention 或线性层里的 LoRA 参数

所以如果你原本是这样训练 embedding：

- `query-positive` 对配合对比学习
- `query-positive-negative` 三元组配合 triplet loss
- STS 打分数据配合回归 loss

换成 LoRA 后，训练主流程通常不用重写，主要改的是参数更新范围。

---

## 4. 一个适合 embedding 的 LoRA 训练流程

检索类句子嵌入任务里，比较实用的一条路线通常是：

1. 选一个已有 embedding 基座，例如 BGE、E5、GTE、MiniLM、MPNet
2. 保持原有文本预处理、prompt 前缀、pooling 逻辑不变
3. 给编码器的部分线性层插入 LoRA
4. 用 `query-positive` 或 `query-positive-negative` 数据做对比学习
5. 优先使用 batch 内负样本，再配合 hard negative
6. 用 Recall@K、MRR、NDCG 做离线评估
7. 只保存 adapter，部署时加载到相同基座模型上
8. 如有需要再把 LoRA 权重 merge 回基座权重

关键点要记住：

- LoRA 解决的是“训练成本”问题
- 数据质量、难例挖掘、线上预处理一致性，依然决定最终效果

---

## 5. LoRA 训练时重点关注哪些超参数

### 5.1 `r`（rank）

- 决定低秩矩阵容量
- 常见起点：`8 / 16 / 32 / 64`
- `r` 越大，表达能力越强，但参数量和显存也会上升

### 5.2 `lora_alpha`

- 决定 LoRA 更新量的缩放强度
- 常见会设置成 `r` 的 2 倍或 4 倍

### 5.3 `lora_dropout`

- 常见取值：`0.0 ~ 0.1`
- 数据量较小或容易过拟合时，可以适当加一点

### 5.4 `target_modules`

- BERT / MiniLM 一类 encoder，常见目标层是 `query`、`value`
- Llama / Qwen 一类 Transformer，常见目标层是 `q_proj`、`v_proj`
- 如果不想按架构手写模块名，也可以考虑 `all-linear`

### 5.5 learning rate

- LoRA 通常可以比全量微调用更大的学习率
- 工程上常从 `1e-4` 或 `2e-4` 开始试，再根据验证集回调

此外，embedding 任务原本重要的参数依旧重要：

- batch size
- max length
- hard negative 数量
- warmup ratio
- 训练轮数

---

## 6. 一个常见实现方式：Sentence Transformers + PEFT

如果本来就在做句子嵌入，最直接的工程组合通常是：

- `Sentence Transformers` 负责 embedding 训练流程
- `PEFT` 负责 LoRA adapter 注入与保存

一个常见写法如下：

```python
from datasets import load_dataset
from peft import LoraConfig, TaskType
from sentence_transformers import (
    SentenceTransformer,
    SentenceTransformerTrainer,
    SentenceTransformerTrainingArguments,
)
from sentence_transformers.losses import MultipleNegativesRankingLoss

# 1. 选择基座模型
model = SentenceTransformer("BAAI/bge-small-zh-v1.5")

# 2. 配置 LoRA
peft_config = LoraConfig(
    task_type=TaskType.FEATURE_EXTRACTION,
    inference_mode=False,
    r=32,
    lora_alpha=64,
    lora_dropout=0.05,
    target_modules=["query", "value"],
)
model.add_adapter(peft_config)

# 3. 准备数据
train_dataset = load_dataset("json", data_files="train.jsonl", split="train")
eval_dataset = load_dataset("json", data_files="dev.jsonl", split="train")

# 4. 定义 loss
loss = MultipleNegativesRankingLoss(model)

# 5. 训练参数
args = SentenceTransformerTrainingArguments(
    output_dir="outputs/bge-small-zh-lora",
    num_train_epochs=1,
    per_device_train_batch_size=128,
    per_device_eval_batch_size=128,
    learning_rate=1e-4,
    warmup_ratio=0.1,
    fp16=True,
)

# 6. 启动训练
trainer = SentenceTransformerTrainer(
    model=model,
    args=args,
    train_dataset=train_dataset,
    eval_dataset=eval_dataset,
    loss=loss,
)
trainer.train()

# 7. 保存 adapter
model.save_pretrained("outputs/bge-small-zh-lora/final")
```

如果你的数据是检索三元组，也可以把 loss 换成：

- `TripletLoss`
- `CachedMultipleNegativesRankingLoss`
- `MultipleNegativesRankingLoss`

经验上：

- 检索召回优先，通常先试 `MultipleNegativesRankingLoss`
- batch 很大时，可优先考虑 `CachedMultipleNegativesRankingLoss`
- 有明确三元组时，可尝试 `TripletLoss`

---

## 7. LoRA 层到底做了什么

如果原来的线性层输出写成：

`y = Wx`

那么加上 LoRA 后，输出就变成：

`y = Wx + sBAx`

也就是说：

- 主干路径还是原始的 `Wx`
- LoRA 只是在旁边额外加了一条低秩增量路径

训练完成后，通常有两种部署方式。

### 7.1 保留 adapter

优点：

- 体积小
- 方便多领域切换
- 基座模型只保留一份

缺点：

- 部署时需要同时管理 base model 和 adapter

### 7.2 merge 回基座权重

优点：

- 部署形态更像普通模型
- 推理链路更简单

缺点：

- 不方便在同一个基座上频繁切换多个 adapter

---

## 8. LoRA 适合什么，不适合什么

LoRA 更适合：

- 中小规模领域适配
- 训练资源紧张
- 想快速验证方向
- 同一个基座服务多个垂类任务

LoRA 不一定最优的情况：

- 域迁移特别大，任务和原始预训练差异非常明显
- 你追求极限指标，并且训练资源足够
- 需要同时修改很多非线性模块或特殊组件

这时更适合的思路可能是：

- 全量微调
- LoRA + 更强数据构造
- LoRA 的变体，例如 DoRA、rsLoRA、QLoRA

---

## 9. 一份可直接抄的 LoRA 检查清单

1. 基座模型是否适合你的语种和场景
2. 训练和推理的文本预处理是否完全一致
3. pooling 方式是否与原模型保持一致
4. `target_modules` 是否匹配当前模型架构
5. loss 是否与任务目标一致
6. 是否准备了足够强的 hard negative
7. 是否有稳定的验证集和 badcase 集
8. 保存的是 adapter，还是 merge 后模型
9. 部署时是否保证 base model 版本完全一致
10. 线上是否监控向量分布、召回率和 badcase

---

## 10. 论文、官方文档与博客参考

论文与官方资料：

- LoRA 原始论文：https://arxiv.org/abs/2106.09685
- Hugging Face PEFT LoRA 文档：https://huggingface.co/docs/peft/en/package_reference/lora
- Hugging Face PEFT LoRA 使用指南：https://huggingface.co/docs/peft/en/developer_guides/lora
- Sentence Transformers PEFT / LoRA 文档：https://www.sbert.net/examples/sentence_transformer/training/peft/README.html
- Sentence Transformers 官方 LoRA 训练脚本：https://github.com/huggingface/sentence-transformers/blob/main/examples/sentence_transformer/training/peft/training_gooaq_lora.py

博客参考：

- Hugging Face: Parameter-Efficient Fine-Tuning using PEFT
  https://huggingface.co/blog/peft
- Hugging Face: 用 Sentence Transformers v3 训练和微调嵌入模型
  https://huggingface.co/blog/zh/train-sentence-transformers
- Sebastian Raschka: Improving LoRA - Implementing Weight-Decomposed Low-Rank Adaptation (DoRA) from Scratch
  https://magazine.sebastianraschka.com/p/lora-and-dora-from-scratch

---

## 11. 一句话总结

LoRA 用在句子嵌入模型上，归根到底做的是：

> 保留原来的 embedding 训练目标，只把全量参数更新改成低秩增量更新。

重点依然是数据质量、难例构造和线上一致性。
