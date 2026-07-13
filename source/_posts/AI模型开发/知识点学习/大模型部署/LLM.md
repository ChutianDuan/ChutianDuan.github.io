---
title: "模型已经装进显存，为什么一并发就 OOM？LLM 部署的容量与性能实战"
date: 2026-07-13 18:36:16
updated: 2026-07-13 18:36:16
categories:
  - "学习"
  - "AI 模型开发"
  - "知识点学习"
  - "大模型部署"
permalink: /notes/ai模型开发/知识点学习/大模型部署/llm/
series: "AI 模型开发"
---

本地执行一次 `generate()` 成功，只能说明模型在这组输入下能推理。线上服务还要同时面对长短不一的 prompt、持续增长的 KV Cache、并发排队、流式输出、取消请求和多卡通信。

最常见的事故是：一个 7B 模型以 BF16 加载后只占十几 GiB，看起来 24 GiB 显卡还有余量；一开放长上下文和并发，显存很快耗尽。另一个常见误判是总 tokens/s 提升了，却发现每个用户看到首 token 的时间变得很长。

理解部署需要分开回答三个问题：

1. **装得下吗**：权重、运行时和 KV Cache 是否超过内存；
2. **跑得稳吗**：请求边界、调度、取消和过载保护是否可靠；
3. **跑得快吗**：TTFT、ITL、吞吐和成本能否满足目标流量。

本文围绕这三个问题，讲清模型加载、KV Cache、prefill/decode、批处理、量化和多卡，并提供一份可运行的容量粗算器。

## 一、先建立一张内存账单

推理显存不只存模型权重：

| 内存项 | 是否长期占用 | 主要受什么影响 |
| --- | --- | --- |
| 模型权重 | 是 | 参数量、权重 dtype、量化元数据 |
| KV Cache | 请求存活期间 | 活跃 token、层数、KV head、cache dtype |
| 激活 | 一次 forward 内 | batch 中的 token、模型宽度、kernel |
| CUDA/通信工作区 | 通常长期或复用 | kernel、CUDA Graph、NCCL、并行方式 |
| 内存池与碎片 | 动态 | 分配器、请求长度差异、cache 管理 |

因此，不能用“显存容量减去权重文件大小”直接当作可用 KV Cache。驱动、运行时、工作区和峰值激活都要留余量。

## 二、权重内存怎样粗算

未考虑额外元数据时：

\[
M_{weights} \approx N_{params} \times bytes_{weight}
\]

常见理论字节数：

| 权重格式 | 每参数理论字节数 |
| --- | ---: |
| FP32 | 4 |
| FP16 / BF16 | 2 |
| INT8 | 1 |
| 4-bit | 0.5 |

所以 7B 参数的 BF16 裸权重约为 14 GB。这里是十进制 GB；监控工具常显示二进制 GiB，二者不能混用：

```text
1 GB  = 1,000,000,000 bytes
1 GiB = 1,073,741,824 bytes
```

量化模型不能只按 `0.5 byte × 参数量` 估算，因为 scale、zero point、未量化层、对齐和运行时表示都会增加开销。最终应以实际 engine 和硬件测量为准。

## 三、KV Cache 为什么随着并发迅速增长

自回归模型生成新 token 时，不会重复计算全部历史 key/value，而是把它们缓存起来。对常见 Transformer，可用下面的近似式估算整个模型每个活跃 token 的 KV：

\[
M_{KV/token} \approx 2 \times L \times H_{kv} \times D_{head} \times bytes_{kv}
\]

其中：

- 2 表示 Key 和 Value；
- \(L\) 是层数；
- \(H_{kv}\) 是 KV head 数；
- \(D_{head}\) 是每个 head 的维度；
- `bytes_kv` 是 KV Cache 的存储精度。

若有多个请求，再乘以当前所有活跃序列实际占用的 token 数。注意是 prompt 与已生成 token 的总和，而不是只看 `max_new_tokens`。

GQA/MQA 使用比 query head 更少的 KV head，能显著降低 cache；这也是估算时必须读取 `num_key_value_heads` 而不能总拿 attention head 数代替的原因。

## 四、可运行的容量粗算器

以下 Python 3.9+ 代码只使用标准库。它假设权重和 KV 在 tensor parallel GPU 之间理想均分，用于早期方案比较；真实引擎可能复制 KV head、词嵌入、通信缓冲或其他模块，不能用它替代压测。

```python
from __future__ import annotations

from dataclasses import dataclass

GIB = 1024**3
MIB = 1024**2

@dataclass(frozen=True)
class ModelSpec:
    parameters_billion: float
    layers: int
    kv_heads: int
    head_dim: int
    weight_bytes: float
    kv_bytes: float
    tensor_parallel: int
    gpu_memory_gib: float
    gpu_utilization_limit: float = 0.90
    weight_overhead: float = 1.05
    runtime_reserve_gib: float = 2.0

def estimate(
    spec: ModelSpec,
    concurrency: int,
    average_active_tokens: int,
) -> dict[str, float | bool]:
    if spec.tensor_parallel <= 0 or concurrency < 0:
        raise ValueError("parallel size must be positive; concurrency cannot be negative")
    if average_active_tokens < 0:
        raise ValueError("average_active_tokens cannot be negative")

    weight_total = (
        spec.parameters_billion
        * 1_000_000_000
        * spec.weight_bytes
        * spec.weight_overhead
    )
    kv_per_token = (
        2
        * spec.layers
        * spec.kv_heads
        * spec.head_dim
        * spec.kv_bytes
    )
    active_tokens = concurrency * average_active_tokens
    kv_total = active_tokens * kv_per_token

    weight_per_gpu = weight_total / spec.tensor_parallel
    kv_per_gpu = kv_total / spec.tensor_parallel
    required_per_gpu = (
        weight_per_gpu
        + kv_per_gpu
        + spec.runtime_reserve_gib * GIB
    )
    usable_per_gpu = (
        spec.gpu_memory_gib * spec.gpu_utilization_limit * GIB
    )

    return {
        "weight_cluster_gib": weight_total / GIB,
        "kv_per_token_kib": kv_per_token / 1024,
        "active_tokens": float(active_tokens),
        "kv_cluster_gib": kv_total / GIB,
        "required_per_gpu_gib": required_per_gpu / GIB,
        "usable_per_gpu_gib": usable_per_gpu / GIB,
        "fits_idealized": required_per_gpu <= usable_per_gpu,
    }

def print_report(name: str, report: dict[str, float | bool]) -> None:
    print(name)
    for key, value in report.items():
        if isinstance(value, bool):
            print(f"  {key}: {value}")
        else:
            print(f"  {key}: {value:.2f}")

if __name__ == "__main__":
    model = ModelSpec(
        parameters_billion=7,
        layers=32,
        kv_heads=8,
        head_dim=128,
        weight_bytes=2,
        kv_bytes=2,
        tensor_parallel=1,
        gpu_memory_gib=24,
    )

    small = estimate(model, concurrency=16, average_active_tokens=2048)
    large = estimate(model, concurrency=100, average_active_tokens=4096)

    print_report("16 requests × 2048 active tokens", small)
    print_report("100 requests × 4096 active tokens", large)

    assert small["kv_per_token_kib"] == 128
    assert small["fits_idealized"] is True
    assert large["fits_idealized"] is False
```

这个假设模型每个 token 的 KV 是 128 KiB。16 个请求平均各占 2048 token 时，KV 约 4 GiB；100 个请求各占 4096 token 时，KV 约 50 GiB。权重完全没变，服务却从粗算可容纳变成明显超限。

### 怎样把粗算变成容量结论

1. 从实际模型配置读取参数量、层数、KV head 和 head dim；
2. 确认 engine 的权重与 KV dtype；
3. 用线上 prompt/output 长度分布，而不是全部假设最大值；
4. 了解 TP 下 KV 是分片还是有复制；
5. 加载模型后测空载显存，校准运行时保留量；
6. 用阶梯并发压测到目标 P95/P99，而不是压到第一次 OOM；
7. 为突发流量、碎片和框架升级留安全余量。

若业务允许 32K 上下文，但绝大多数请求只有 1K，也不应为每个请求静态预留 32K 的连续 cache。现代 serving 引擎的分页式 KV 管理正是在解决按需分配和碎片问题。

## 五、Paged KV Cache 解决什么，又不解决什么

传统做法若为每个序列预留一大段连续 KV 空间，会出现内部浪费和外部碎片。分页式管理把 cache 切成固定 block，再按请求实际进度分配和回收，类似虚拟内存分页。

它可以：

- 降低长度差异造成的浪费；
- 更灵活地回收已结束请求；
- 支持 continuous batching；
- 在特定场景复用共享前缀 block。

它不能：

- 让每 token 的 KV 数据凭空消失；
- 消除模型架构和 cache dtype 带来的物理容量；
- 保证任意并发和上下文都不会 OOM；
- 替代请求限额和过载保护。

因此，PagedAttention 提高的是内存利用率，不是无限容量。

## 六、Prefill 与 Decode 是两种不同负载

### Prefill：先读完整个 prompt

服务收到 prompt 后，对所有输入 token 做前向，建立初始 KV Cache。长 prompt 的 prefill 往往计算密集，直接影响首 token 等待。

### Decode：逐 token 生成

之后每一步通常只生成一个新 token，并读取历史 KV。decode 常更受内存带宽、并发组织和 cache 访问影响。

这会产生调度冲突：一个超长 prompt 的 prefill 若占据大量计算，正在流式生成的其他请求可能出现 token 间卡顿；若始终优先 decode，长 prompt 又可能迟迟得不到首 token。

线上 scheduler 要在 prefill chunk、decode batch、公平性和吞吐之间权衡。所谓“同一个模型每秒生成多少 token”必须同时写明输入长度、输出长度、并发和调度配置。

## 七、Continuous Batching 为什么比静态 batch 更适合服务

静态 batch 会等待一组请求凑齐，并常常等到最慢请求结束才整体释放。LLM 输出长度差异很大，这会产生空槽。

Continuous batching 允许在迭代边界动态加入新请求、移除完成或取消的请求：

```text
step 1: A B C
step 2: A B C
step 3: A B完成 C -> 释放 B
step 4: A D C       -> 新请求 D 加入
```

它通常提高 GPU 利用率和总吞吐，但高负载下也可能增加单用户延迟。调度器若不断扩 batch，总 tokens/s 很漂亮，ITL 却可能恶化。因此要同时设吞吐和延迟 SLO。

## 八、不要用一个“平均延迟”评价流式服务

LLM serving 常用指标如下：

| 指标 | 定义 | 用户感受 |
| --- | --- | --- |
| TTFT | 请求发出到首个有效 token | 多久开始回答 |
| ITL / TPOT | 首 token 后相邻输出 token 的平均间隔 | 回答是否流畅 |
| E2E latency | 请求到最后一个 token | 整体多久结束 |
| output tokens/s | 系统单位时间输出 token | 总吞吐 |
| requests/s | 单位时间完成请求数 | 请求吞吐 |

一种常见 ITL 定义是：

\[
ITL = \frac{E2E-TTFT}{N_{output}-1}
\]

不同压测工具对首 token、网络、tokenization 和空事件的计时口径可能不同，比较结果前必须统一定义。

TTFT 通常包含排队、prefill 和网络时间；长输入与过载排队都会推高它。ITL 更接近 decode 节奏。系统总 tokens/s 随并发增加可能上升，但每个用户的 token 速度通常会下降。

线上至少看 P50、P95、P99，而不是只看均值。还应按输入长度、输出长度、租户和请求类型切片。

## 九、模型加载成功不等于适合在线 serving

传统 PyTorch 加载可能经历模型初始化、CPU state dict 和 GPU 权重的多份峰值。大模型常采用：

1. 在 meta device 构造无真实存储的模型骨架；
2. 读取分片 checkpoint；
3. 先计算 device map；
4. 边加载边把权重放到目标设备；
5. 必要时 offload 到 CPU 或磁盘。

Transformers/Accelerate 可通过 `device_map="auto"` 进行 Big Model Inference；传入 `device_map` 时，当前 Transformers 文档说明会自动启用低 CPU 内存加载路径。它适合让超出单卡容量的模型先运行起来，但自动 layer dispatch 和 CPU/NVMe offload 不等同于高吞吐 serving engine。

一个用于实验环境的典型加载方式是：

```python
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

model_path = "/path/to/a/reviewed-local-model"

tokenizer = AutoTokenizer.from_pretrained(
    model_path,
    local_files_only=True,
)
model = AutoModelForCausalLM.from_pretrained(
    model_path,
    torch_dtype=torch.bfloat16,
    device_map="auto",
    max_memory={0: "20GiB", "cpu": "48GiB"},
    local_files_only=True,
)

print(model.hf_device_map)
```

这里使用本地、已审核模型路径，避免示例隐含模型许可、访问令牌和远程代码信任问题。实际模型是否支持 BF16、是否需要自定义代码、chat template 如何使用，都要查看对应模型卡并固定 revision。

### Offload 是容量方案，不是免费显存

CPU offload 需要通过 PCIe 或其他互联搬运权重；NVMe offload 还多一层存储传输。它可以让模型“能跑”，却可能让每层都等待数据，严重增加延迟。

适合 offload 的场景通常是离线、低 QPS 或容量优先。低延迟线上服务应先比较更小模型、量化、增加合适 GPU 或高效并行，而不是默认把磁盘当显存。

## 十、量化要先说清楚量化了什么

“4-bit 部署”可能只表示权重量化，而 KV Cache 仍是 FP16/BF16。它能显著降低模型本体，却不能按相同比例降低长上下文 cache。

需要分别记录：

- weight dtype / quantization scheme；
- activation dtype；
- KV cache dtype；
- accumulator dtype；
- 哪些层保持高精度；
- engine、kernel 与硬件支持。

量化验收至少包含：

1. 固定任务集的质量指标；
2. 长短输入下的 TTFT 和 ITL；
3. 目标并发下的总吞吐；
4. 实际空载和满载显存；
5. 极端输入、结构化输出和工具调用正确性。

模型文件更小不保证推理更快；如果硬件没有匹配 kernel，反量化或数据转换可能抵消收益。

## 十一、多张 GPU 应该怎样协作

### Data Parallel：完整副本处理不同请求

每个 replica 放完整模型，请求在副本间分流。单卡能容纳模型时，它通常是最直接的吞吐扩展方式，卡间推理通信少，故障域也更清晰。

代价是每张卡都复制权重，无法解决单卡放不下。

### Tensor Parallel：同一层分到多卡

大矩阵按维度切分，多卡共同计算一层，并通过 AllReduce、AllGather 或 ReduceScatter 交换部分结果。它能让单卡装不下的模型运行，也可能降低单请求计算时间。

但每层通信频繁，对 NVLink、NVSwitch、PCIe、跨节点网络和拓扑非常敏感。小 batch 或慢互联下，加卡可能让吞吐/卡和延迟都更差。

### Pipeline Parallel：不同卡负责不同层段

模型按连续层划分 stage，激活在 stage 间 Send/Recv。它适合模型跨更多 GPU 或节点，但会出现 pipeline bubble 和负载不均，调度也更复杂。

### Expert Parallel：MoE 的专家分片

Mixture-of-Experts 模型还可能把不同专家放在不同设备。每个 token 只路由到部分专家，但 All-to-All 通信与负载不均可能成为新瓶颈，不能只按“激活参数量”估算部署成本。

### FSDP / ZeRO 不应与 serving 并行混为一谈

FSDP 和 ZeRO 主要解决训练中参数、梯度和优化器状态的冗余。推理系统也可能借鉴分片/offload 思路，但纯在线 serving 更常讨论 TP、PP、DP 和 EP。看到“支持 FSDP”不能直接推导为低延迟推理方案。

## 十二、什么时候选择哪种并行

| 条件 | 优先比较的方案 |
| --- | --- |
| 单卡能放下，目标是更高 QPS | 多个 data-parallel replica |
| 单卡放不下，同机有高速互联 | Tensor Parallel |
| 单节点仍放不下 | TP + PP，或换更小/量化模型 |
| MoE 模型跨多卡 | 结合 TP/DP 的 Expert Parallel |
| 低 QPS 且硬件不足 | CPU/NVMe offload，接受延迟 |

选择 TP size 时不能只看整除和显存。应在真实拓扑上比较：

- 单请求 TTFT/ITL；
- 目标并发下 tokens/s；
- 每 GPU tokens/s 和成本；
- 各 rank 显存与利用率；
- 通信占比和跨节点流量。

如果两张卡都能各放一个完整模型，两个独立 replica 的总吞吐可能优于 TP=2；如果单请求延迟是首要目标，TP=2 又可能更合适。答案来自基准，不来自卡数。

## 十三、Prefix Cache 能省 prefill，但有使用边界

系统 prompt、工具描述或文档前缀在多个请求间完全相同时，可以缓存其 KV，减少重复 prefill。收益取决于前缀长度、命中率和 cache 淘汰。

必须注意：

- 只有 token 序列完全一致的前缀才能安全复用；
- chat template、空白或工具顺序变化都会导致 miss；
- cache key 应包含模型、adapter、tokenizer 和相关配置版本；
- 多租户敏感前缀要考虑隔离与数据残留风险；
- prefix cache 仍占显存，命中率低时可能挤压普通 KV。

它是用 cache 容量换 prefill 计算，不是无成本加速。

## 十四、服务必须有过载保护

只设置模型最大上下文还不够。请求层至少应约束：

- 最大输入 token；
- 最大输出 token；
- 单请求总 token；
- 同租户并发和速率；
- 全局等待队列长度和超时；
- 取消与断连后的资源回收；
- 可用工具、响应体和日志大小。

过载时无限排队会让 TTFT 从几百毫秒增长到几十秒，同时占用连接和应用内存。应采用有界队列、明确拒绝或降级，而不是等 GPU OOM。

流式客户端断开后，后端必须尽快取消生成并回收 KV block。否则“幽灵请求”仍在消耗 token 和显存。

## 十五、怎样做可信的压测

### 1. 固定模型与环境

记录模型 revision、engine 版本、容器、driver、CUDA、GPU 型号/拓扑、量化、TP/PP/DP、最大长度和 scheduler 配置。

### 2. 使用真实长度联合分布

输入和输出长度不是独立常量。摘要任务可能长输入短输出，代码生成可能短输入长输出。至少按业务类型分别压测。

### 3. 区分 closed-loop 与 open-loop

closed-loop 客户端等上一个请求完成再发下一个，可能低估真实到达压力；open-loop 按目标请求率到达，更容易观察排队和饱和点。报告必须说明负载模型。

### 4. 预热但不要隐藏退化

预热可排除首次 kernel、内存池和图捕获成本；冷启动也要单独测，因为扩容和故障恢复会遇到它。

### 5. 扫描并发而非只测一个点

从低并发逐步增加，记录 TTFT、ITL、E2E、tokens/s、队列长度和显存。通常会出现一个饱和拐点：吞吐继续缓慢增长，但排队延迟陡升。生产容量应在 SLO 内，而不是饱和极限上。

### 6. 校验输出

超时、空响应、截断和错误请求不能从分母中消失。性能测试同时要检查状态码、finish reason、token 数和输出有效性。

## 十六、上线后监控什么

### 请求与队列

- 到达率、完成率、拒绝率；
- running、waiting、preempted 请求；
- 排队时长和取消率；
- 输入/输出 token 分布。

### 用户体验

- TTFT P50/P95/P99；
- ITL/TPOT P50/P95/P99；
- E2E latency；
- 流式中断和超时。

### GPU 与引擎

- GPU 利用率、显存、功耗；
- KV Cache 使用率和 prefix cache 命中率；
- prefill/decode token 吞吐；
- 各 TP/PP rank 的显存和利用率；
- NCCL 错误、通信时间和重启次数。

### 质量与成本

- 每请求输入/输出 token；
- 每百万 token 成本；
- 截断、拒答和格式错误；
- 模型/adapter 路由分布。

只监控 GPU 利用率会漏掉“GPU 很忙但用户一直排队”，只监控请求延迟又无法判断是 prefill、decode 还是队列导致。

## 十七、常见症状的排查顺序

### 启动就 OOM

核对权重 dtype、加载峰值、量化实际格式、device map、空载运行时开销和其他进程。不要先调并发，因为请求尚未进入。

### 单请求正常，高并发 OOM

统计所有活跃 token 与 KV 使用率，检查最大输入/输出、分页 cache 配置、取消回收和 prefix cache。权重量化未必能解决。

### TTFT 很高，ITL 正常

检查队列、长 prompt prefill、prefill 调度和网络首包；按输入长度切片。

### TTFT 正常，输出一卡一卡

检查 decode batch、ITL、长序列 KV、通信、抢占和是否有大 prefill 干扰。

### 加 GPU 后反而更慢

确认使用的是 TP 还是 replica；查看互联拓扑、collective 时间、跨 NUMA/跨节点流量和 batch 大小。比较每 GPU 吞吐，而不只看总吞吐。

### 吞吐很高但用户投诉

总 tokens/s 可能通过扩大 batch 获得，同时牺牲 TTFT/ITL。回到用户 SLO，在满足延迟约束的区域比较吞吐。

## 十八、一条务实的部署路线

1. 明确模型质量、输入/输出长度、TTFT/ITL 和流量目标；
2. 用配置与容量脚本粗算权重和 KV；
3. 单卡、低并发跑通，测实际空载显存；
4. 设置输入、输出、队列和租户限额；
5. 用真实长度分布扫描并发，找到 SLO 内容量；
6. 单卡放不下再比较量化、TP 和更小模型；
7. 单卡放得下但 QPS 不足，优先比较多 replica；
8. 上线前验证取消、超时、OOM 恢复和滚动升级；
9. 灰度观察 TTFT、ITL、队列与 KV，而非只看 GPU；
10. 每次 engine、模型或 kernel 升级都重跑质量与性能基准。

## 官方资料

- [Hugging Face Transformers：实例化大模型](https://huggingface.co/docs/transformers/main/big_models)
- [Hugging Face Accelerate：Big Model Inference](https://huggingface.co/docs/accelerate/v1.10.0/usage_guides/big_modeling)
- [vLLM：Distributed Inference and Serving](https://docs.vllm.ai/en/v0.8.4/serving/distributed_serving.html)
- [vLLM：PagedAttention 官方介绍](https://vllm.ai/blog/vllm)
- [NVIDIA：LLM serving 指标定义](https://docs.nvidia.com/nim/benchmarking/llm/latest/metrics.html)

## 总结

LLM 部署的核心不是把模型文件搬进 GPU，而是持续管理权重、活跃 token、KV Cache、计算和通信。

权重决定模型是否能启动，KV Cache 决定长上下文与并发容量，scheduler 决定吞吐与用户延迟怎样交换，多卡拓扑决定增加 GPU 是否真正有收益。

可以用一句话记住：

> 先算清每个 token 占多少内存，再定义每个用户能等多久，最后才谈用多少张卡把吞吐堆上去。
