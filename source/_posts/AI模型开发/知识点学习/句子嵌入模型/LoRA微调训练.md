---
title: "LoRA 训练能跑，为什么检索效果没提升？句子嵌入微调实战"
date: 2026-07-13 18:24:47
updated: 2026-07-13 18:24:47
categories:
  - "学习"
  - "AI 模型开发"
  - "知识点学习"
  - "句子嵌入模型"
permalink: /notes/ai模型开发/知识点学习/句子嵌入模型/lora微调训练/
series: "AI 模型开发"
---

显存不足时，LoRA 往往是微调 embedding 模型的第一选择。它只训练少量增量参数，checkpoint 也比完整模型小得多。

但“loss 在下降”和“检索效果在提升”是两回事。常见失败包括：

- adapter 加到了错误的线性层，真正影响句向量的模块几乎没被训练；
- 正样本在同一个 batch 中互为假负样本，模型学到了错误边界；
- 训练时有 query 前缀，线上却忘了加；
- 只看训练 loss，没有用 Recall@K 或 NDCG 评估检索；
- adapter 部署到了另一个 base model revision，向量整体漂移；
- 新模型上线后没有重建语料向量，query 和 corpus 来自两套编码器。

因此，LoRA 解决的主要是**可训练参数量和训练资源**，不能替代数据、损失函数、评估和部署一致性。本文从这些真实问题出发，给出一套可复用的句子嵌入 LoRA 流程。

## 一、LoRA 到底减少了什么

一个线性层原本计算：

\[
y = Wx
\]

其中权重 \(W\) 的形状是 \(d_{out} \times d_{in}\)。全量微调会学习与它同形状的更新量 \(\Delta W\)：

\[
W' = W + \Delta W
\]

LoRA 假设任务需要的更新可以用低秩矩阵近似：

\[
\Delta W = sBA
\]

其中：

- \(A \in \mathbb{R}^{r \times d_{in}}\)；
- \(B \in \mathbb{R}^{d_{out} \times r}\)；
- \(r\) 远小于输入和输出维度；
- 原始 LoRA 的缩放通常是 \(s = \alpha / r\)。

前向计算变成：

\[
y = Wx + \frac{\alpha}{r}BAx
\]

训练时冻结 \(W\)，只更新 \(A\) 和 \(B\)。忽略 bias 等额外配置时，一个线性层的可训练参数从：

\[
d_{out}d_{in}
\]

变为：

\[
r(d_{in}+d_{out})
\]

例如输入、输出维度都是 768，rank 为 8：

```python
def lora_parameter_ratio(d_in: int, d_out: int, rank: int) -> float:
    full = d_in * d_out
    lora = rank * (d_in + d_out)
    return lora / full

ratio = lora_parameter_ratio(768, 768, 8)
print(f"LoRA 参数约为原线性层的 {ratio:.2%}")
# LoRA 参数约为原线性层的 2.08%
```

这个比例只比较某一个被注入的线性层。整个模型的真实可训练参数还取决于 `target_modules`、bias、可训练 embedding 或 `modules_to_save`，因此训练前必须从模型中实际统计，不能只用公式猜。

PEFT 默认初始化会让 LoRA B 矩阵为 0，使新 adapter 在刚注入时近似 no-op。也就是说，训练前输出应与原模型基本一致；若刚注入就明显变化，应检查初始化配置和推理模式。

## 二、LoRA 没有改变 embedding 任务本身

LoRA 改变的是“哪些参数更新”，不是“模型应该学什么”。以下环节仍然决定检索质量：

- query、positive、negative 的业务含义；
- pooling 和向量归一化；
- query/document prompt 或前缀；
- 最大序列长度与截断；
- 对比学习 loss；
- batch 内负样本和 hard negative；
- Recall@K、MRR、NDCG 等检索指标。

如果原来的全量微调数据有标签泄漏、假负样本或线上预处理偏差，换成 LoRA 并不会自动修复它们。

### 一个典型的假负样本

假设 batch 中有两条数据：

```text
query_1: Python 如何读取 JSON？
positive_1: 使用 json.load 读取文件对象。

query_2: json.load 和 json.loads 有什么区别？
positive_2: json.load 接收文件对象，json.loads 接收字符串。
```

使用 Multiple Negatives Ranking Loss 时，其他样本的 positive 常被当作当前 query 的负样本。但 `positive_2` 对 `query_1` 也有帮助，它就是假负样本。数据去重和 batch 采样策略往往比把 rank 从 8 调到 64 更重要。

## 三、第一处高风险配置：target_modules

`target_modules` 决定 LoRA 注入哪些模块。不同模型的命名并不统一：

- 一些 BERT 系 encoder 使用 `query`、`key`、`value`；
- 一些模型使用 `q_proj`、`k_proj`、`v_proj`；
- 还有模型采用自定义名称或复合模块。

把别人的 `target_modules=["query", "value"]` 原样复制过来，可能直接报“找不到目标模块”，也可能只命中你没有预期到的层。

### 先观察，再配置

下面的诊断代码可在注入 adapter 前列出线性层名称：

```python
import torch
from sentence_transformers import SentenceTransformer

model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")

linear_names = [
    name
    for name, module in model.named_modules()
    if isinstance(module, torch.nn.Linear)
]

for name in linear_names[:30]:
    print(name)
print("linear layer count:", len(linear_names))
```

然后再根据模型结构和对照实验决定目标层。三种选择各有边界：

1. 不传 `target_modules`：让 PEFT 根据已知模型架构选择默认模块；未知架构可能报错。
2. 显式传模块后缀列表或正则：控制最清晰，但迁移模型时必须重新核对。
3. 使用 `target_modules="all-linear"`：覆盖面更广，也会增加可训练参数和优化器状态，不等同于“总是最好”。

PEFT 对列表的匹配规则包含精确名称或模块名后缀匹配。若模型命名相似，最好在注入后打印实际可训练参数名，确认没有误命中。

## 四、可运行训练模板：Sentence Transformers + PEFT

下面示例采用 Sentence Transformers 官方支持的 PEFT adapter 接口。它使用一个极小的内存数据集演示完整链路，方便先验证代码；这些样本不足以训练出可用模型。

示例涉及快速更新的第三方 API。运行前应在项目自己的虚拟环境中记录版本，并以当前官方文档为准。所需包为 `sentence-transformers`、`peft`、`datasets` 和它们的依赖；不要安装到系统 Python。

```python
from __future__ import annotations

from pathlib import Path

from datasets import Dataset
from peft import LoraConfig, TaskType
from sentence_transformers import (
    SentenceTransformer,
    SentenceTransformerTrainer,
    SentenceTransformerTrainingArguments,
)
from sentence_transformers.evaluation import InformationRetrievalEvaluator
from sentence_transformers.losses import MultipleNegativesRankingLoss
from sentence_transformers.training_args import BatchSamplers

BASE_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
OUTPUT_DIR = Path("artifacts/minilm-lora-demo")

def count_parameters(model: SentenceTransformer) -> tuple[int, int]:
    total = sum(parameter.numel() for parameter in model.parameters())
    trainable = sum(
        parameter.numel()
        for parameter in model.parameters()
        if parameter.requires_grad
    )
    return trainable, total

def build_train_dataset() -> Dataset:
    # MultipleNegativesRankingLoss 使用成对文本；正式训练要准备更多样本。
    rows = [
        {
            "anchor": "How do I parse a JSON file in Python?",
            "positive": "Use json.load with an opened file object.",
        },
        {
            "anchor": "What is the difference between load and loads?",
            "positive": "json.load reads a file object; json.loads reads a string.",
        },
        {
            "anchor": "How can I create a virtual environment?",
            "positive": "Run python -m venv followed by an environment path.",
        },
        {
            "anchor": "How do I serialize a dictionary as JSON?",
            "positive": "Use json.dump for a file or json.dumps for a string.",
        },
    ]
    return Dataset.from_list(rows)

def build_evaluator() -> InformationRetrievalEvaluator:
    queries = {
        "q1": "How do I read JSON from a file?",
        "q2": "How do I make an isolated Python environment?",
    }
    corpus = {
        "d1": "Use json.load with an opened file object.",
        "d2": "json.loads converts a JSON string into a Python value.",
        "d3": "Run python -m venv followed by an environment path.",
        "d4": "Use json.dumps to serialize a value into a string.",
    }
    relevant_docs = {"q1": {"d1"}, "q2": {"d3"}}
    return InformationRetrievalEvaluator(
        queries=queries,
        corpus=corpus,
        relevant_docs=relevant_docs,
        name="tiny-retrieval-dev",
    )

def main() -> None:
    model = SentenceTransformer(BASE_MODEL)

    peft_config = LoraConfig(
        task_type=TaskType.FEATURE_EXTRACTION,
        inference_mode=False,
        r=8,
        lora_alpha=16,
        lora_dropout=0.05,
        # 先使用 PEFT 对已知架构的默认映射。
        # 更换模型后应检查模块名，再决定是否显式设置。
    )
    model.add_adapter(peft_config)

    trainable, total = count_parameters(model)
    print(
        f"trainable={trainable:,}, total={total:,}, "
        f"ratio={trainable / total:.2%}"
    )
    if trainable == 0 or trainable == total:
        raise RuntimeError("LoRA trainable parameter range is unexpected")

    train_dataset = build_train_dataset()
    evaluator = build_evaluator()
    loss = MultipleNegativesRankingLoss(model)

    args = SentenceTransformerTrainingArguments(
        output_dir=str(OUTPUT_DIR),
        max_steps=20,
        per_device_train_batch_size=4,
        learning_rate=1e-4,
        warmup_ratio=0.1,
        batch_sampler=BatchSamplers.NO_DUPLICATES,
        eval_strategy="steps",
        eval_steps=10,
        save_strategy="steps",
        save_steps=10,
        save_total_limit=2,
        logging_steps=5,
        report_to=[],
        # 为了让示例在 CPU/MPS/CUDA 上都容易起步，这里不强制半精度。
        fp16=False,
        bf16=False,
    )

    # 训练前先记录基线，否则无法判断 20 步后究竟变好还是变差。
    print("before training:", evaluator(model))

    trainer = SentenceTransformerTrainer(
        model=model,
        args=args,
        train_dataset=train_dataset,
        loss=loss,
        evaluator=evaluator,
    )
    trainer.train()

    print("after training:", evaluator(model))
    model.save_pretrained(str(OUTPUT_DIR / "final"))

if __name__ == "__main__":
    main()
```

这个模板有几个刻意的选择：

- `TaskType.FEATURE_EXTRACTION` 对应 encoder 表征任务，而不是生成式语言建模；
- 不写死目标模块，先走官方对已知架构的映射；更换基座时仍需检查；
- `BatchSamplers.NO_DUPLICATES` 降低 batch 内重复文本破坏负样本的风险；
- 明确设置 `eval_strategy="steps"`，否则传入 evaluator 并不代表训练中会自动定期评估；
- 训练前后都运行检索 evaluator，防止只盯 loss；
- 不强制 `fp16=True`，因为 CPU、Apple Silicon、不同 CUDA 卡的半精度支持不同。

正式训练时不要保留 `max_steps=20` 和四条样本。应把它们替换为经过清洗的训练集、独立验证集和符合业务分布的检索语料。

## 五、训练数据决定模型学到什么

### 1. query-positive 对

检索训练最常见的数据形式是：

```json
{"anchor": "Redis 如何避免缓存穿透？", "positive": "可以使用布隆过滤器或缓存空值。"}
```

`MultipleNegativesRankingLoss` 会让匹配对更接近，并把 batch 内其他 positive 当作负样本。它简单有效，但依赖两个前提：batch 足够多样，并且其他 positive 真的是负样本。

### 2. hard negative

随机负样本往往太容易，例如用“Linux 文件权限”回答“Redis 缓存穿透”。模型很快就能区分，却学不到细粒度边界。

hard negative 应该“看起来相关但不能回答问题”：

```json
{
  "anchor": "Redis 如何避免缓存穿透？",
  "positive": "可以使用布隆过滤器或缓存空值。",
  "negative": "缓存雪崩可以通过随机过期时间降低同时失效风险。"
}
```

这个负样本同属缓存问题，却回答的是雪崩。构造时必须人工抽查，避免把实际可回答 query 的文本错误标为负例。

### 3. 泄漏与重复

同一文档切出的相邻 chunk 可能高度重叠。若一个进入训练集、另一个进入验证集，指标会虚高。数据划分应尽量按 `document_id`、用户或时间分组，而不是在 chunk 行级随机切分。

## 六、rank、alpha 和 dropout 应怎样理解

### rank：容量，不是质量旋钮

增大 `r` 会增加 LoRA 的表达能力，也增加参数量、优化器状态和过拟合空间。合理做法是从较小 rank 建立基线，再根据验证集和任务复杂度增加；不存在对所有模型都正确的 `8/16/32/64` 配方。

### alpha：更新缩放

原始 LoRA 默认缩放为 `alpha / r`。如果只增大 rank 而保持 alpha 不变，缩放也会改变，因此比较 rank 时应明确控制策略。PEFT 还支持 rsLoRA，此时缩放公式不同；启用变体后要在实验记录中写清楚。

### dropout：只针对 LoRA 路径的正则化之一

小数据上适量 dropout 可能缓解过拟合，但它不能修复脏标签。验证指标持续下降时，应先检查数据和学习率，再考虑增加 dropout。

### learning rate：LoRA 可以更大，不代表越大越好

LoRA 常能使用比全量微调更高的学习率，但最合适的值仍取决于 batch、rank、数据量和目标模块。训练 loss 突然下降而检索指标恶化，可能是模型快速记住了训练对。

建议每次实验至少记录：base revision、数据版本、seed、rank、alpha、dropout、目标模块、有效 batch、学习率、最大长度和 evaluator 指标。

## 七、评估时为什么不能只看相似度均值

句子嵌入模型最终服务的是排序或召回。检索任务应准备：

- `queries`：查询 ID 到查询文本；
- `corpus`：文档 ID 到文档文本；
- `relevant_docs`：每个查询对应哪些正确文档。

常用指标含义如下：

| 指标 | 回答的问题 |
| --- | --- |
| Recall@K | 正确证据是否出现在前 K 条中 |
| MRR | 第一条正确结果排得是否靠前 |
| NDCG@K | 多个不同相关度结果的整体排序是否合理 |
| Precision@K | 返回的前 K 条中有多少真正相关 |

如果线上还有 reranker，应分别评估 embedding 召回阶段和完整链路。否则 reranker 可能掩盖召回退化，也可能因为正确文档根本没进入候选集而无能为力。

LoRA 的可靠结论应来自同一测试集上的对照：

```text
base model
vs. LoRA checkpoint A
vs. full fine-tuning（资源允许时）
```

同时保留通用语料测试，检查领域适配是否造成灾难性遗忘或其他查询类型退化。

## 八、部署 adapter 最容易发生的三个错位

### 1. base model 错位

adapter 只保存增量权重，必须配合训练时的 base model、配置和 revision。模型名相同但 revision 不同，也可能产生不可预期结果。发布记录应固定：

```text
base_model_name_or_path
base_model_revision
adapter_revision
tokenizer_revision
sentence-transformers / transformers / peft 版本
```

Sentence Transformers 官方支持直接加载完整 adapter 目录：

```python
from sentence_transformers import SentenceTransformer

model = SentenceTransformer("artifacts/minilm-lora-demo/final")
vectors = model.encode(
    ["How do I read JSON?", "Use json.load with a file object."],
    normalize_embeddings=True,
)
print(vectors.shape)
```

也可先加载 base，再调用 `load_adapter()`；但这时更要确保 base 一致。

### 2. 预处理错位

训练时的 prompt、大小写处理、最大长度、pooling 和归一化必须进入部署配置。只复制 adapter 权重而忘记这些约定，服务虽能启动，向量语义却可能不同。

### 3. 索引错位

同一双塔模型同时编码 query 和 corpus 时，adapter 更新后通常需要重新编码语料库。不能用新 adapter 生成 query，却继续检索旧 base model 生成的文档向量，除非你的训练设计本来就是固定 corpus encoder 的非对称方案，并且已做过验证。

## 九、保留 adapter 还是 merge

保留 adapter 的优点是文件小、一个 base 可切换多个领域；代价是部署必须同时管理 base 与 adapter，并确保激活了正确 adapter。

merge 后的模型部署形态更简单，但体积接近完整模型，多领域切换也失去轻量优势。不同 Sentence Transformers、Transformers 和 PEFT 版本的合并入口可能不同，不应直接操作未经确认的内部模块。若必须 merge，应基于项目锁定版本按官方 PEFT 流程执行，并验证合并前后的向量近似一致：

```python
import numpy as np

# before 和 after 分别是同一批固定文本在合并前后的向量。
assert np.allclose(before, after, rtol=1e-4, atol=1e-5)
```

还要检查归一化、dtype 和推理模式，否则数值误差可能来自部署配置，而非合并本身。

## 十、故障排查：从现象反推原因

### 注入时报“target modules not found”

先打印 `named_modules()`，不要继续猜模块名。确认当前加载的到底是哪个模型架构，再选择默认映射、明确后缀或 `all-linear`。

### 可训练参数为 0 或接近 100%

0 表示没有成功注入；接近 100% 则可能没有正确冻结 base，或额外模块被设为可训练。用代码统计参数，并打印前几十个 `requires_grad=True` 的名称。

### loss 下降，Recall@K 不升

优先检查训练/验证泄漏、假负样本、评价 query 分布、prompt 一致性和 hard negative，而不是立刻增大 rank。

### 验证集一直没有输出

检查 `eval_strategy` 是否仍为默认的 `"no"`，以及是否传入 evaluator 或 `eval_dataset`。仅构造验证数据不会自动安排评估频率。

### adapter 能加载，但效果像 base model

检查 adapter 是否处于 active 状态、是否加载了正确目录、权重是否真的变化，以及部署是否错误地禁用了 adapter。

### 上线后召回全面变差

检查语料是否重新编码、归一化是否一致、base/tokenizer revision 是否匹配，并对固定探针文本比较离线和线上向量。

## 十一、什么时候 LoRA 不是最佳选择

LoRA 很适合资源有限的领域适配、快速验证和多 adapter 管理，但以下情况要做对照：

- 领域与 base 差距极大，低秩增量容量不足；
- 有充足资源并追求极限指标，全量微调可能更好；
- 只需要修正少量术语，数据或检索侧增强可能比训练更便宜；
- 基线问题来自 chunking、负样本或 evaluator，任何微调都会治标不治本；
- 模型已足够好，主要瓶颈在 reranker 或结构化过滤。

DoRA、rsLoRA、QLoRA 等变体各自改变参数化、缩放或量化方式，会引入新的超参数和兼容边界。只有标准 LoRA 基线和评估链路稳定后，才值得逐项比较。

## 十二、上线前检查清单

1. base 模型是否匹配语言、长度和业务场景；
2. 训练、验证、测试是否按文档或时间隔离；
3. batch 内是否存在重复 positive 和假负样本；
4. target modules 是否来自实际模型结构；
5. 注入后的可训练参数量是否合理；
6. 训练前是否记录 base 检索指标；
7. loss、pooling、prompt、归一化是否与任务一致；
8. 是否保存数据、base、adapter 和 tokenizer revision；
9. 线上是否重新编码需要更新的 corpus；
10. 固定探针文本的离线、线上向量是否一致；
11. 是否保留通用查询集，观察领域外退化；
12. 是否能回滚到 base 模型和旧索引。

## 官方资料

- [LoRA 原始论文：Low-Rank Adaptation of Large Language Models](https://arxiv.org/abs/2106.09685)
- [Hugging Face PEFT：LoRA 配置与参数](https://huggingface.co/docs/peft/main/package_reference/lora)
- [Sentence Transformers：Training with PEFT Adapters](https://www.sbert.net/examples/sentence_transformer/training/peft/README.html)
- [Sentence Transformers：Training Overview](https://sbert.net/docs/sentence_transformer/training_overview.html)
- [Sentence Transformers：Training Arguments](https://www.sbert.net/docs/package_reference/sentence_transformer/training_args.html)

## 总结

LoRA 的本质，是冻结原权重，用低秩增量学习任务需要的变化。它让句子嵌入微调更省资源，却没有降低对数据、负样本、评估和部署一致性的要求。

训练前先确认 adapter 注入了哪些层和多少参数；训练中同时观察检索 evaluator；发布时固定 base、tokenizer 与 adapter 版本，并重建需要更新的语料向量。只有这条链路闭环，LoRA 的“小参数”才会转化为真实的检索收益。
