---
title: "LLM 部署学习笔记"
date: 2026-04-20 20:07:56
updated: 2026-04-20 20:07:56
categories:
  - "学习"
  - "AI模型开发"
  - "知识点学习"
  - "大模型部署"
permalink: /notes/ai模型开发/知识点学习/大模型部署/llm/
---

# LLM 部署学习笔记

## 1. 先抓住部署的核心矛盾

部署大模型，本质上一直在解决 3 个问题：

- 模型权重怎么加载进来
- 有限的 GPU / CPU / 磁盘内存怎么分配
- 多张卡之间怎么协调，才能兼顾“能跑、跑得稳、跑得快”

如果把它再压缩成一句话：

> 大模型部署，本质就是“权重放哪、缓存放哪、计算在哪做、卡和卡之间怎么通信”。

---

## 2. 模型加载：模型到底是怎么被搬进来的

### 2.1 传统加载流程

普通 PyTorch 模型通常这样加载：

1. 先创建模型结构
2. 再把权重文件读进内存
3. 再把权重拷贝进模型
4. 再把模型搬到 GPU

小模型这样没问题，但大模型会有明显问题：

- 创建模型时，会先生成一份“空模型参数”
- 读取 `state_dict` 时，又会在 CPU 内存里出现第二份权重
- 最后再拷到 GPU，还会产生一次设备搬运

所以大模型加载时，最容易遇到的第一个问题不是算不动，而是：

> 还没开始推理，CPU 内存或显存就先爆了。

---

### 2.2 为什么大模型加载难

大模型加载难，主要难在下面几件事：

- 参数量太大，权重本身就已经很占内存
- 传统加载流程会出现“双份内存峰值”
- 单卡显存不一定放得下完整模型
- 就算 GPU 放不下，CPU 内存也不一定足够
- 真正上线时还要给 KV Cache、临时 buffer、CUDA runtime 留空间

例如只看权重本体：

- `7B` 参数，`FP16/BF16` 大约需要 `14GB`
- `70B` 参数，`FP16/BF16` 大约需要 `140GB`

这还只是权重，不包含：

- KV Cache
- 中间激活
- CUDA allocator 预留空间
- 框架工作区和临时 buffer

---

### 2.3 更合理的大模型加载流程

大模型部署里，更常见的是这种思路：

1. 先只读取配置，不真实分配完整参数
2. 先构建一个“空壳模型”
3. 提前规划每一层该放到哪块设备
4. 按分片逐步加载权重
5. 加载完后再做 warmup 和运行时缓存初始化

这就是很多框架里常见的：

- `meta device`
- `init_empty_weights`
- `device_map`
- `load_checkpoint_and_dispatch`
- `low_cpu_mem_usage=True`

一句话理解：

> 先规划，再搬运；先知道每层去哪，再真正把权重加载进去。

---

### 2.4 典型加载手段

#### 1）分片权重

大模型通常不会保存成一个超大的单文件，而是拆成多个 shard。

这样做的好处：

- 单次读入的文件更小
- CPU 峰值内存更容易控制
- 可以边读边放到目标设备

常见格式有：

- `pytorch_model.bin`
- `model-00001-of-000xx.safetensors`

现在更推荐 `safetensors`，因为它更适合做安全加载和高效读取。

#### 2）空壳初始化

先在 `meta` 设备上把模型结构搭出来，只保留：

- shape
- dtype
- 层结构信息

此时不真正占用完整参数内存。

这一步的意义很大，因为只有先得到“模型骨架”，后面才能：

- 估算每层参数量
- 计算 device map
- 决定哪些层放 GPU、哪些层放 CPU、哪些层甚至落盘

#### 3）自动或手动 `device_map`

加载前先决定每一层该去哪。

典型策略：

- `device_map="auto"`：框架自动做层到设备的映射
- 手动指定：自己定义哪些层放 `cuda:0`、`cuda:1`、`cpu`

这一步解决的是：

> 不是把整个模型整体搬到一个设备上，而是按层切开后分别放。

#### 4）CPU / NVMe Offload

如果 GPU 还是装不下，就把一部分权重放到：

- CPU 内存
- NVMe 磁盘

推理时再按层搬到 GPU。

这类方案的本质是：

> 用更便宜、更大的存储层，换取“能跑起来”的可能性。

代价也很明显：

- 延迟会上升
- PCIe 传输会成为瓶颈
- 更适合吞吐优先，不一定适合极低延迟

---

### 2.5 一个常见加载示例

如果是 Hugging Face Transformers，最常见的写法会是：

```python
from transformers import AutoModelForCausalLM, AutoTokenizer
import torch

model_id = "meta-llama/Meta-Llama-3-8B-Instruct"

tokenizer = AutoTokenizer.from_pretrained(model_id)
model = AutoModelForCausalLM.from_pretrained(
    model_id,
    torch_dtype=torch.bfloat16,
    device_map="auto",
    low_cpu_mem_usage=True,
)
```

这里几项的意义分别是：

- `torch_dtype=torch.bfloat16`：减小权重占用
- `device_map="auto"`：自动把层分配到多个设备
- `low_cpu_mem_usage=True`：尽量降低 CPU 加载峰值

如果模型更大，还可能配合：

- `load_checkpoint_and_dispatch`
- `max_memory`
- `offload_folder`

---

### 2.6 服务真正启动时发生了什么

部署系统真正启动时，通常不只是“把模型读进来”，还会顺手做这些事：

- 初始化 CUDA context
- 创建 tokenizer
- 加载权重并分配设备
- 预留 runtime workspace
- 预分配或按需分配 KV Cache
- 执行一次 warmup，让 kernel、graph、memory pool 进入稳定状态

所以线上冷启动慢，往往不只是“模型文件大”，而是整套运行时都在初始化。

---

## 3. 内存分配：显存到底都花到哪里了

### 3.1 推理时内存的主要组成

推理阶段最重要的几部分内存通常是：

| 内存项 | 作用 | 特点 |
| --- | --- | --- |
| 权重 `weights` | 存模型参数 | 静态为主，启动时确定 |
| 激活 `activations` | 当前 forward 的中间结果 | 瞬时占用，prefill 更明显 |
| KV Cache | 保存历史 token 的 key/value | 会随上下文和并发增长 |
| Workspace / 临时 buffer | kernel、attention、通信缓冲 | 容易被忽略 |
| CUDA allocator 保留区 | 运行时内存池 | 看起来“没用完”，实际已被预留 |

部署里最常见的误区之一：

> 以为显存主要都花在权重上，但很多时候真正把服务顶爆的是 KV Cache。

---

### 3.2 权重占用怎么估算

最基础的估算公式：

```text
权重内存 ≈ 参数量 × 每个参数字节数
```

常见精度：

| 精度 | 每参数字节数 |
| --- | --- |
| FP32 | 4 Bytes |
| FP16 | 2 Bytes |
| BF16 | 2 Bytes |
| INT8 | 1 Byte |
| 4-bit | 约 0.5 Byte，外加量化元数据 |

所以只看权重大致可以这么记：

- `7B @ FP16/BF16` 约 `14GB`
- `13B @ FP16/BF16` 约 `26GB`
- `70B @ FP16/BF16` 约 `140GB`

注意这只是“裸权重体积”，实际部署还要留余量。

---

### 3.3 KV Cache 为什么这么重要

自回归推理不是每次都从头算完整上下文，而是把历史 token 的注意力结果缓存起来。

这个缓存就是 KV Cache。

它的近似规模可以理解为：

```text
KV Cache ≈ batch × seq_len × layers × num_kv_heads × head_dim × 2 × bytes
```

这里的 `2` 是因为要存：

- Key
- Value

几个关键结论：

- 上下文越长，KV Cache 越大
- 并发请求越多，KV Cache 越大
- 层数越多，KV Cache 越大
- `GQA / MQA` 会减少 `num_kv_heads`，因此能降低 KV Cache 压力

所以部署时经常会出现这种现象：

- 模型能加载成功
- 一跑高并发或长上下文就 OOM

这通常不是权重问题，而是 KV Cache 膨胀了。

---

### 3.4 Prefill 和 Decode 的内存特征不同

大模型推理通常可以分成两个阶段：

#### Prefill

也就是先把整段输入 prompt 跑一遍。

特点：

- 计算量大
- 激活更明显
- 更偏“算力瓶颈”

#### Decode

也就是一 token 一 token 地生成。

特点：

- 每步计算量没那么大
- 但 KV Cache 要一直留着
- 更容易受显存和内存带宽影响

一句话记忆：

> Prefill 更像“重算一遍输入”，Decode 更像“带着缓存持续往前推”。

---

### 3.5 为什么会有显存碎片

在真实服务里，请求长度通常不一样：

- 有的 prompt 很短
- 有的输出很长
- 有的请求很快结束
- 有的请求会长期占着上下文

如果 KV Cache 按大块连续内存预留，就容易出现：

- 过度预分配
- 空洞
- 碎片
- 大量“看起来空着，但其实不好再利用”的显存

这也是为什么 vLLM 的 `PagedAttention` 很重要：

> 它把 KV Cache 按 block 管理，像操作系统分页一样按需分配，而不是死板地整段连续申请。

---

### 3.6 常见的内存优化手段

#### 1）降低权重精度

常见选择：

- `BF16 / FP16`
- `INT8`
- `4-bit`

作用：

- 直接压缩权重内存
- 往往也能降低带宽压力

但要注意：

> 权重量化通常主要解决“模型本体太大”，不一定直接解决 KV Cache 过大。

#### 2）KV Cache 分块管理

这类思路常见于：

- `PagedAttention`
- paged KV cache
- block-based cache allocator

作用：

- 降低碎片
- 提高 cache 复用率
- 提升 batch 能力

#### 3）Continuous Batching / In-flight Batching

不是等整个 batch 全结束才接新请求，而是：

- 谁先结束就先释放
- 空出来的位置立即塞新请求

这样可以让 GPU 持续保持高利用率。

#### 4）Offload

把一部分数据放到：

- CPU
- NVMe

适合：

- 显存不够
- 可以接受额外延迟

#### 5）控制上下文和并发

线上很多时候最有效的办法非常朴素：

- 限制 `max_model_len`
- 限制 `max_num_seqs`
- 限制 `max_new_tokens`

因为这些参数直接决定了 KV Cache 的上限。

---

## 4. 多卡协调：多张 GPU 是怎么配合的

### 4.1 为什么需要多卡

需要多卡，通常有 3 个原因：

- 单卡放不下模型
- 单卡吞吐不够
- 希望用更多卡降低单请求延迟或提升整体并发

但“多卡”不是一个方案，而是一组不同的并行方式。

---

### 4.2 数据并行 Data Parallel

最容易理解的一种方式：

- 每张 GPU 放一整份完整模型
- 不同请求分发到不同 GPU

优点：

- 最简单
- 卡间通信最少
- 很适合模型能完整放入单卡时做水平扩展

缺点：

- 每张卡都要复制完整权重
- 模型太大时根本放不下

适合场景：

- 单卡能装下模型
- 主要目标是提高 QPS

---

### 4.3 张量并行 Tensor Parallel

张量并行的思路是：

- 不复制整层
- 而是把一层里的大矩阵切到多张卡上

例如一个大的线性层，可以按列切、按行切，让多张 GPU 同时算一层。

优点：

- 单卡装不下时还能跑
- 对超大模型很常见

代价：

- 几乎每一层都会发生通信
- 对 GPU 间互联非常敏感

典型通信包括：

- `AllReduce`
- `AllGather`
- `ReduceScatter`

一句话理解：

> Tensor Parallel 是“同一层一起算”，所以卡和卡之间必须频繁交换部分结果。

---

### 4.4 流水线并行 Pipeline Parallel

流水线并行是把模型按层切成几段：

- 前几层在 GPU0
- 中间层在 GPU1
- 后几层在 GPU2

数据像流水线一样一段段往后传。

优点：

- 每张卡只放一部分层
- 适合层数很多、模型特别深的情况

缺点：

- 会有 pipeline bubble
- 微批次设计更复杂
- 延迟不一定最优

一句话理解：

> Pipeline Parallel 是“不同卡负责不同楼层”，输入像坐电梯一样逐层往上走。

---

### 4.5 FSDP / ZeRO

这类方案的核心不是“把一层切开一起算”，而是：

> 把参数、梯度、优化器状态分片，谁需要时再临时聚合。

最典型的是训练或微调场景。

FSDP 背后的核心动作可以这样理解：

- 平时每张卡只保留自己那一份 shard
- 前向计算到某层时，先 `all-gather` 出完整参数
- 算完后，把不需要的部分释放
- 反向时再做 `reduce-scatter`

它解决的是：

- 大模型训练时显存冗余过高
- DDP 每卡都存一整份参数太浪费

在部署里要注意：

- 纯在线低延迟推理，主流更常见的是 `Tensor Parallel`
- FSDP / ZeRO 更常用于训练、SFT、继续预训练
- 但 ZeRO-Inference 这类方案会把“分片和 offload”思路带到推理场景

---

### 4.6 多卡通信时到底在传什么

多卡协同时，常见通信原语如下：

| 通信原语 | 常见用途 |
| --- | --- |
| `Broadcast` | 把参数或控制信息同步给所有卡 |
| `AllReduce` | 汇总每张卡的部分结果并让所有卡都拿到 |
| `AllGather` | 把各卡持有的分片拼回完整结果 |
| `ReduceScatter` | 先归约再分片返回 |
| `Send / Recv` | 流水线并行中前后 stage 传递激活 |

底层常见通信库：

- `NCCL`
- `RCCL`

如果是部署视角，需要记住一个关键点：

> 多卡不只是“卡多了”，而是“通信也多了”。如果通信成本压不住，卡越多不一定越快。

---

### 4.7 什么时候选哪种多卡方案

| 场景 | 更常见的选择 |
| --- | --- |
| 模型能放进单卡，只想提 QPS | Data Parallel |
| 模型单卡放不下，但在同机多卡内运行 | Tensor Parallel |
| 模型很深，想把层按 stage 切开 | Pipeline Parallel |
| 训练 / SFT / 继续预训练，显存压力极大 | FSDP / ZeRO |
| 显存不够，但可以接受更高延迟 | CPU / NVMe Offload |

很多真实系统是混合方案，例如：

- `TP + PP`
- `TP + Data Parallel`
- `ZeRO + Offload`

---

### 4.8 多卡部署里最真实的瓶颈

线上真正会卡住的地方，通常不是论文里那一句“支持多卡”，而是这些细节：

- GPU 之间是 `NVLink` 还是只有 `PCIe`
- 通信拓扑是否对称
- 小 batch 下通信时间会不会盖过计算时间
- scheduler 是否能把动态长度请求组织好
- KV Cache 是否会在高并发下失控
- 某一张卡是否变成热点卡

所以多卡性能调优，本质是在看：

- 算得快不快
- 传得快不快
- 分得均不均

---

## 5. 把三件事串起来：一条完整的部署链路

从服务启动到返回 token，大致会经历这条路径：

1. 读取模型配置和 tokenizer
2. 创建空壳模型，估算权重规模
3. 计算 `device_map` 或并行策略
4. 分片加载权重到 GPU / CPU / NVMe
5. 初始化 runtime buffer 和 KV Cache 管理器
6. 收到请求后，scheduler 做 batch 编排
7. 先做 prefill
8. 再进入 decode，持续使用 KV Cache
9. 如果是多卡，则在层间或 stage 间做通信
10. 请求结束后释放对应 KV block

这条链路里：

- 模型加载决定“能不能启动”
- 内存分配决定“能不能稳定跑”
- 多卡协调决定“吞吐和延迟能不能达标”

---

## 6. 高频结论

- 大模型加载难，首先难在内存峰值，而不是算力。
- 推理阶段最核心的两块内存通常是“权重 + KV Cache”。
- 权重决定你能否把模型装进系统，KV Cache 决定你能支撑多少上下文和并发。
- `4-bit / 8-bit` 量化主要缓解权重压力，不自动等于 KV Cache 压力消失。
- 模型能跑起来，不代表服务能稳定支撑高并发。
- 多卡不总是更快；如果互联差、通信重，延迟可能更差。
- 部署里最常见的几类手段是：分片加载、精度压缩、KV Cache 优化、动态 batching、多卡并行。

---

## 7. 延伸阅读：推荐几篇博客

下面这几篇我按“加载 -> 内存 -> 多卡”这条线推荐，基本都是官方博客或官方文档，适合继续往下读。

### 1）模型加载

- [How Accelerate runs very large models thanks to PyTorch](https://huggingface.co/blog/accelerate-large-models)
  2022-09-27，Hugging Face。
  这篇很适合用来理解 `meta device`、空壳初始化、`device_map`、分片加载到底解决了什么问题。

### 2）内存分配 / KV Cache

- [vLLM: Easy, Fast, and Cheap LLM Serving with PagedAttention](https://vllm.ai/blog/vllm)
  2023-06-20，vLLM 官方博客。
  这篇非常值得看，重点就是为什么 LLM 服务的瓶颈经常在内存，尤其是 KV Cache 的碎片和过度预留问题。

### 3）FSDP 和分片思想

- [Accelerate Large Model Training using PyTorch Fully Sharded Data Parallel](https://huggingface.co/blog/pytorch-fsdp)
  2022-05-02，Hugging Face。
  适合理解 FSDP 的核心动作：为什么要分片、什么时候 `all-gather`、什么时候 `reduce-scatter`。

### 4）Offload 和异构内存

- [ZeRO-Inference: Democratizing massive model inference](https://www.deepspeed.ai/2022/09/09/zero-inference.html)
  2022-09-09，DeepSpeed。
  如果你想理解“GPU 装不下怎么办”，这篇很有代表性，重点讲 CPU / NVMe offload、层预取、多 GPU 拉取权重。

### 5）多卡通信

- [3x Faster AllReduce with NVSwitch and TensorRT-LLM MultiShot](https://developer.nvidia.com/blog/3x-faster-allreduce-with-nvswitch-and-tensorrt-llm-multishot/)
  2024-11-01，NVIDIA Technical Blog。
  这篇适合在你已经理解 Tensor Parallel 之后继续看，能更具体地理解多卡通信为什么会成为低延迟推理瓶颈。

---

## 8. 建议的阅读顺序

如果你想按一条比较顺的路径学习，我建议：

1. 先看 Hugging Face 的大模型加载文章
2. 再看 vLLM 的 PagedAttention
3. 再看 DeepSpeed 的 ZeRO-Inference
4. 再看 NVIDIA 那篇多卡通信博客
5. 最后补 FSDP，把“分片和通信”的训练视角补齐

---

## 9. 一句话总结

大模型部署的核心，不是“把模型跑起来”这么简单，而是：

> 用尽量少的显存和通信开销，把权重、缓存和计算稳定地组织起来。
