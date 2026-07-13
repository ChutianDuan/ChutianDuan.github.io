---
title: "Qwen3-14B 双 RTX 3090 压测：数字很好看，为什么还不能直接上线？"
date: 2026-07-13 19:27:32
updated: 2026-07-13 19:27:32
categories:
  - "学习"
  - "AI 模型开发"
  - "详细分析纪录"
  - "VLLM"
permalink: /notes/ai模型开发/详细分析纪录/vllm/qwen3_14b/
series: "AI 模型开发"
---

一轮压测跑出 `100/100` 成功、平均首 Token 时间（TTFT）`0.10 s`、平均生成速度 `36.43 tok/s`，是不是说明服务已经稳定，可以直接接入 RAG 或 Agent？

还不能。

这些数字能证明“这 100 个请求在当时的环境里成功完成”，却不能单独证明长时间稳定、真实业务延迟达标或换一组输入仍有相同性能。压测结果只有和模型版本、启动参数、请求分布、思考模式、缓存状态及统计口径绑定，才具备复现和比较价值。

本文以一次 `Qwen3-14B + RTX 3090 × 2 + vLLM` 的历史结果为例，回答五个实际问题：

1. 原始数字究竟能说明什么？
2. 为什么 TTFT 很低，不一定是 Prefix Cache 的功劳？
3. `8.92x` 理论并发为什么不能直接设成生产并发？
4. 怎样写出别人可以复现的启动与压测命令？
5. 怎样把一张“性能表”变成可执行的上线标准？

> 本文保留原笔记中的实测数字，但原记录没有保存完整命令、软件版本、模型 revision 和请求长度分布。因此，所有数字均视为**历史观测值**，不当作 Qwen3-14B 或双 RTX 3090 的通用基准。

## 一、先保存原始现场，不急着下结论

原笔记记录的环境与结果如下。

### 1. 部署快照

| 项目 | 历史观测值 | 目前可以确认的含义 |
| --- | ---: | --- |
| 模型 | Qwen3-14B | 未记录仓库路径与 revision |
| GPU | RTX 3090 × 2 | 未记录驱动、CUDA、PCIe 拓扑及 NVLink 实际状态 |
| 张量并行 | TP = 2 | 两张卡共同承载模型 |
| dtype | bfloat16 | 未记录 vLLM、PyTorch 对该配置的实际选择日志 |
| 服务上下文上限 | 8192 tokens | 这是本次服务配置，不是模型能力上限 |
| GPU KV Cache | 73,088 tokens | 来自当次引擎日志 |
| Prefix Cache | 开启 | 是否命中取决于请求是否共享完整 Token 前缀 |
| Chunked Prefill | 开启 | 具体调度行为受 vLLM 版本与参数影响 |
| CUDA Graph | 开启 | 图捕获约 38 秒 |
| Attention 后端 | Flash Attention | 未保存具体后端版本 |
| FlashInfer | 不可用 | 仅说明当次环境没有使用它 |
| Custom AllReduce | 关闭 | 原因需要结合拓扑与 vLLM 日志判断 |
| 调度策略 | FCFS | 先到先服务 |
| 引擎 | vLLM V1 | 未记录 vLLM 版本 |

Qwen 官方模型卡说明，Qwen3-14B 是约 14.8B 参数的稠密因果语言模型，原生上下文为 32,768 tokens；使用 YaRN 可扩展到更长上下文。因此这里的 `max_model_len=8192` 只代表这次部署主动限制在 8K，不能写成“模型最多支持 8K”。参见 [Qwen3-14B 官方模型卡](https://huggingface.co/Qwen/Qwen3-14B)。

### 2. 压测快照

| 指标 | 历史观测值 | 谨慎解读 |
| --- | ---: | --- |
| 成功请求 | 100 / 100 | 测试窗口内没有失败 |
| 失败请求 | 0 | 不代表长时间运行没有 OOM 或超时 |
| 普通压测并发 | 10 | 属于单一并发点，无法画出容量曲线 |
| TTFT 压测并发 | 5 | 与普通压测不是同一负载，不能混合比较 |
| 请求吞吐 | 1.21 req/s | 依赖输入、输出长度和到达模型 |
| 平均端到端延迟 | 8.28 s | 包含排队、prefill、decode 和传输 |
| P50 端到端延迟 | 8.22 s | 中位请求约 8.22 秒完成 |
| P95 / P99 延迟 | 8.83 s / 8.83 s | 样本少且经过舍入，不能说明尾部风险已消失 |
| 平均 TTFT | 0.10 s | 需要确认计时点、流式传输与输入长度 |
| P95 TTFT | 0.19 s | 只对应并发 5 的那组负载 |
| 平均生成速度 | 36.43 tok/s | 原记录未注明是单请求均值还是聚合吞吐 |
| 输出上限 | 256 tokens | “上限”不等于每个请求实际都生成 256 tokens |

### 3. 一个有用的自洽性检查

Little 定律在稳定系统中给出：

```text
系统平均在途请求数 ≈ 完成吞吐 × 平均响应时间
                    ≈ 1.21 req/s × 8.28 s
                    ≈ 10.02
```

它与压测并发 10 基本吻合。这说明“吞吐、延迟、并发”三个数在数量级上相互一致，但并不能证明每个指标的统计实现正确。

## 二、为什么漂亮数字可能会误导？

### 问题 1：100 次全部成功，能否称为“服务稳定”？

不能。`100/100` 只能说明这批请求成功，无法覆盖这些常见故障：

- 连续运行数小时后的显存碎片或资源泄漏；
- 短请求和长请求混合时的队头阻塞；
- 上下文接近 8192 时的容量下降；
- 客户端取消、连接中断、超时重试造成的额外负载；
- 输入与输出总长度越界；
- 模型进程、NCCL 或单卡异常后的恢复行为。

更准确的原始结论应是：

> 在未完整保存负载分布的一次 100 请求测试中，成功率为 100%，未观察到错误。

### 问题 2：TTFT 只有 0.10 秒，是否证明 Prefix Cache 有效？

不一定。TTFT 还会同时受以下因素影响：

- 输入 Token 数；
- 请求到达时是否排队；
- CUDA Graph 和内核是否完成预热；
- 多个请求是否具有完全相同的 Token 前缀；
- 网络、SSE 缓冲以及客户端的首包计时方式；
- Chunked Prefill 的调度配置；
- Prefix Cache 的实际命中率。

Prefix Cache 只复用相同 Token 前缀的 KV。两段文字“看起来相同”不代表 Token 序列相同：系统消息、Chat Template、空格甚至模板参数都可能改变前缀。

要证明缓存带来了收益，至少做一组受控对照：

| 组别 | Prefix Cache | 请求前缀 | 目的 |
| --- | --- | --- | --- |
| A | 关闭 | 固定 | 建立无缓存基线 |
| B | 开启 | 每次不同 | 测开启功能本身的影响 |
| C | 开启 | 完全相同 | 测高命中场景 |
| D | 开启 | 公共前缀 + 不同后缀 | 模拟 RAG 系统提示词 |

每组都应独立预热，并记录缓存命中相关的服务端指标。仅凭一次低 TTFT，最多能说“结果与缓存收益相容”，不能断言因果关系。

### 问题 3：`73,088 / 8,192 = 8.92`，为什么并发还能跑到 10？

日志里的 `Max Concurrency @ 8192 = 8.92x` 是用 KV Cache 总容量除以“每条序列占满 8192 tokens”的理论比值：

```python
def theoretical_kv_concurrency(kv_tokens: int, tokens_per_request: int) -> float:
    if kv_tokens <= 0 or tokens_per_request <= 0:
        raise ValueError("token 数必须为正数")
    return kv_tokens / tokens_per_request

print(theoretical_kv_concurrency(73_088, 8_192))  # 8.921875
```

并发 10 并不矛盾，因为压测请求很可能没有每条都占满 8192 tokens。实际 KV 使用取决于：

```text
每条序列的 KV 长度 = 已处理的输入 tokens + 已生成的输出 tokens
```

此外，还要考虑 KV block 粒度、调度中的等待序列、缓存驻留以及框架自身开销。因此 `8.92x` 不是推荐的生产并发，也不是一个硬性的请求数上限。

### 问题 4：`36.43 tok/s` 到底是哪一种速度？

至少有三种常被统称为 “tokens/s” 的指标：

1. **单请求生成速度**：对每个请求计算 decode tokens / decode 时间，再取平均；
2. **聚合输出吞吐**：所有请求的输出 Token 总数 / 整场测试时间；
3. **总 Token 吞吐**：输入和输出 Token 总数 / 整场测试时间。

若 1.21 req/s 下每个请求真的都生成 256 tokens，聚合输出吞吐应接近：

```text
1.21 × 256 = 309.76 output tok/s
```

这和 `36.43 tok/s` 差异很大，所以原值更像单请求平均生成速度，或者实际输出远少于 256 tokens。由于原始明细丢失，这只能是推断，不能写成事实。

## 三、先冻结环境，才谈复现

复现清单应和压测 JSON 一起保存，而不是靠几个月后的记忆补齐。

```python
from dataclasses import asdict, dataclass
from hashlib import sha256
import json
from typing import Tuple

@dataclass(frozen=True)
class BenchmarkManifest:
    model: str
    revision: str
    served_model_name: str
    vllm_version: str
    torch_version: str
    cuda_version: str
    driver_version: str
    gpu_names: Tuple[str, ...]
    tensor_parallel_size: int
    dtype: str
    max_model_len: int
    prefix_caching: bool
    thinking_enabled: bool
    dataset_sha256: str

    def validate(self) -> None:
        required = {
            "model": self.model,
            "revision": self.revision,
            "vllm_version": self.vllm_version,
            "dataset_sha256": self.dataset_sha256,
        }
        missing = [name for name, value in required.items() if not value]
        if missing:
            raise ValueError(f"复现信息不完整: {', '.join(missing)}")
        if self.tensor_parallel_size != len(self.gpu_names):
            raise ValueError("TP 数量与记录的 GPU 数量不一致")

    def fingerprint(self) -> str:
        payload = json.dumps(
            asdict(self), ensure_ascii=False, sort_keys=True
        ).encode("utf-8")
        return sha256(payload).hexdigest()[:16]
```

还应保存这些只读信息：

```bash
python -VV
python -m pip show vllm torch transformers
nvidia-smi
nvidia-smi topo -m
```

`nvidia-smi topo -m` 比“3090 没有 NVLink”更可靠。是否存在、是否连接、是否被当前通信路径使用是三个不同问题；Custom AllReduce 被关闭也应以当次 vLLM 日志为准，不应只凭显卡型号推断原因。

## 四、用明确参数启动服务

下面是一个用于重建 8K 基线的命令模板。`REVISION` 必须换成实际提交哈希或标签；不要在复现实验里一直跟随会变化的默认分支。

```bash
MODEL='Qwen/Qwen3-14B'
REVISION='<填入固定 revision>'

vllm serve "$MODEL" \
  --revision "$REVISION" \
  --served-model-name qwen3-14b-bench \
  --tensor-parallel-size 2 \
  --dtype bfloat16 \
  --max-model-len 8192 \
  --enable-prefix-caching \
  --reasoning-parser qwen3
```

参数需要注意：

- `--max-model-len 8192` 是这次服务的容量选择，不是模型极限；
- 不要为了让命令“看起来完整”补写原实验没有记录的显存利用率等参数；
- vLLM 的参数和默认值会随版本变化，先用当前环境的 `vllm serve --help` 核对；
- Qwen3 默认开启思考模式。vLLM 当前文档使用 `--reasoning-parser qwen3` 分离 reasoning 与最终内容，但旧版支持方式不同，必须让命令与锁定的 vLLM 版本匹配。参见 [vLLM Reasoning Outputs](https://docs.vllm.ai/en/latest/features/reasoning_outputs/)。

如果业务目标是低延迟问答，而不是复杂推理，应把非思考模式作为单独实验变量，而不是偷偷改在客户端：

```json
{
  "model": "qwen3-14b-bench",
  "messages": [{"role": "user", "content": "用一句话解释 KV Cache"}],
  "max_tokens": 256,
  "stream": true,
  "chat_template_kwargs": {"enable_thinking": false}
}
```

思考与非思考模式会明显改变输出长度、延迟和内容结构，二者的结果不能放在同一列直接比较。Qwen 官方模型卡也给出了两种模式不同的推荐采样参数。

## 五、设计一轮能回答问题的压测

### 1. 先区分闭环与开环

- **闭环并发测试**：固定最多同时在途的请求数，适合找容量拐点；
- **开环到达测试**：按目标 QPS 产生请求，适合模拟真实流量与排队。

在 vLLM 的 `bench serve` 中，`--max-concurrency` 限制同时执行的请求数，`--request-rate` 控制请求到达速率。二者同时使用时，如果服务处理不过来，实际发送速率可能低于指定值。参见 [vLLM bench serve 官方参数](https://docs.vllm.ai/en/latest/cli/bench/serve/)。

### 2. 先做固定长度的容量扫描

以下命令是当前文档风格的示例，运行前需用**已安装版本**的 `vllm bench serve --help` 校准参数：

```bash
vllm bench serve \
  --backend openai-chat \
  --base-url http://127.0.0.1:8000 \
  --endpoint /v1/chat/completions \
  --model qwen3-14b-bench \
  --dataset-name random \
  --random-input-len 1024 \
  --random-output-len 256 \
  --num-prompts 100 \
  --num-warmups 10 \
  --request-rate inf \
  --max-concurrency 10 \
  --extra-body '{"chat_template_kwargs":{"enable_thinking":false}}' \
  --percentile-metrics ttft,tpot,e2el \
  --metric-percentiles 50,95,99 \
  --save-result \
  --save-detailed
```

固定输入输出长度便于横向比较，但它不是业务负载。之后必须再用脱敏后的真实请求分布复测。

### 3. 至少覆盖这组矩阵

| 维度 | 建议测试点 | 要回答的问题 |
| --- | --- | --- |
| 并发 | 1、2、4、8、10 | 从哪里开始排队和抖动？ |
| 输入长度 | 128、1024、4096、接近 8192 | Prefill 与 KV 压力如何变化？ |
| 输出长度 | 32、256、1024 | Decode 是否成为瓶颈？ |
| 思考模式 | 开 / 关 | 质量与延迟如何权衡？ |
| Prefix Cache | 关、开但不命中、开且命中 | 缓存收益究竟是多少？ |
| 到达方式 | 突发、目标 QPS | 突发排队和稳定流量有何不同？ |

不要一次把所有组合笛卡尔积跑完。先固定输入 1024、输出 256 扫并发，找到拐点后，再在关键并发点测试长度和缓存。

## 六、自己计算指标时，口径必须写进代码

下面的标准库示例把请求级 TTFT、端到端延迟和输出数汇总成明确指标。

```python
from dataclasses import dataclass
from math import ceil
from statistics import fmean
from typing import Dict, List, Optional

@dataclass(frozen=True)
class RequestSample:
    ttft_s: float
    e2e_s: float
    input_tokens: int
    output_tokens: int

    def validate(self) -> None:
        if not 0 <= self.ttft_s <= self.e2e_s:
            raise ValueError("应满足 0 <= TTFT <= E2E")
        if self.input_tokens < 0 or self.output_tokens <= 0:
            raise ValueError("Token 数不合法")

    @property
    def decode_tokens_per_second(self) -> Optional[float]:
        # 首 Token 已包含在 TTFT 中，剩余 Token 才对应后续 decode 时间。
        remaining_tokens = self.output_tokens - 1
        decode_time = self.e2e_s - self.ttft_s
        if remaining_tokens == 0 or decode_time <= 0:
            return None
        return remaining_tokens / decode_time

def nearest_rank(values: List[float], percentile: int) -> float:
    if not values or not 0 < percentile <= 100:
        raise ValueError("数据不能为空，百分位必须在 (0, 100] 内")
    ordered = sorted(values)
    return ordered[ceil(percentile / 100 * len(ordered)) - 1]

def summarize(samples: List[RequestSample], wall_time_s: float) -> Dict[str, float]:
    if not samples or wall_time_s <= 0:
        raise ValueError("样本不能为空，墙钟时间必须为正")
    for sample in samples:
        sample.validate()

    speeds = [
        speed
        for sample in samples
        if (speed := sample.decode_tokens_per_second) is not None
    ]
    return {
        "request_throughput_rps": len(samples) / wall_time_s,
        "output_throughput_tps": sum(s.output_tokens for s in samples) / wall_time_s,
        "mean_ttft_s": fmean(s.ttft_s for s in samples),
        "p95_ttft_s": nearest_rank([s.ttft_s for s in samples], 95),
        "mean_e2e_s": fmean(s.e2e_s for s in samples),
        "p95_e2e_s": nearest_rank([s.e2e_s for s in samples], 95),
        "mean_per_request_decode_tps": fmean(speeds) if speeds else 0.0,
    }
```

这个实现刻意把“聚合输出吞吐”和“单请求平均 decode 速度”分开。百分位采用 nearest-rank；如果使用 NumPy 线性插值或压测工具自带算法，也必须在报告里注明，因为小样本下结果可能不同。

### 100 个样本为什么不适合过度解读 P99？

nearest-rank 下，100 个样本的 P99 只落在排序后的第 99 个值附近，几乎就是最慢的几个请求。若结果又只保留两位小数，P95 和 P99 都显示 `8.83 s` 完全可能只是舍入造成的，不能据此断言 Scheduler 没有堆积。

## 七、如何判断服务是否真的能上线？

先写业务 SLO，再跑压测。不要根据跑出来的数字倒推一个“刚好通过”的标准。

例如，一个非思考模式的内部问答服务可以先约定：

```text
测试负载：脱敏真实输入分布，目标 1 req/s，突发并发 8
成功标准：成功率 >= 99.9%
交互标准：P95 TTFT <= 500 ms
生成标准：P95 TPOT <= 50 ms/token
完成标准：P95 E2E <= 12 s（输出上限 256）
稳定标准：连续 60 分钟无 OOM、进程退出和持续显存增长
质量标准：固定回归集的正确率不得低于基线
```

这些阈值只是格式示例，不是 Qwen3-14B 的通用推荐值。真实标准应来自用户体验、上游超时和机器成本。

### 上线前检查表

- [ ] 模型仓库、revision、Chat Template 与 served model name 已固定；
- [ ] vLLM、PyTorch、Transformers、CUDA、驱动版本已保存；
- [ ] GPU 拓扑和服务启动命令已保存；
- [ ] 思考模式和采样参数已明确；
- [ ] 输入、输出 Token 分布和数据集哈希已保存；
- [ ] 冷启动、预热后、缓存命中与不命中分别测试；
- [ ] 并发扫描覆盖容量拐点，而不是只测并发 10；
- [ ] TTFT、TPOT、ITL、E2E、吞吐和 goodput 口径明确；
- [ ] 保存逐请求明细，而不是只有平均值；
- [ ] 进行短时稳定性测试并观察 GPU、KV Cache、队列与错误指标；
- [ ] 用业务回归集验证性能优化没有损害结果质量。

## 八、回看原始结论，应该怎样改写？

| 原来的判断 | 更可靠的表述 |
| --- | --- |
| “服务稳定，无报错、无超时、无 OOM” | 本次 100 请求全部成功，测试窗口内未观察到错误 |
| “1.21 req/s 属于正常水平” | 本次未完整记录负载，无法和其他部署公平比较 |
| “P99 稳定，Scheduler 没有严重堆积” | 100 个样本不足以排除真实尾延迟，且 P95/P99 可能受舍入影响 |
| “Prefix Cache 是 TTFT 很低的重要原因” | 缺少开关对照与命中率，不能确认因果 |
| “8K 理论并发 8.92，当前并发未到瓶颈” | 8.92 是满 8K 序列的 KV 容量比；短序列并发 10 不矛盾 |
| “3090 无 NVLink 导致 AllReduce 关闭” | 当次日志显示 Custom AllReduce 关闭，原因需结合实际拓扑与日志确认 |
| “36.43 tok/s 中等偏上” | 指标口径未保存，暂不能做跨环境评价 |

## 九、总结

一张性能表最重要的价值不是证明“机器很快”，而是让下一次实验知道该复现什么、该改变什么。

这次历史结果至少给出了一个有用起点：双 RTX 3090、TP=2、8K 服务上限、并发 10 时，100 个请求全部成功，吞吐与平均延迟通过 Little 定律能够相互印证。但它仍缺少版本、请求分布、思考模式、缓存命中和明细数据，所以不能直接推导生产容量。

真正可执行的下一步只有三件事：

1. 固定模型 revision、软件版本、拓扑和完整启动命令；
2. 用固定长度负载扫描并发，再用真实分布验证；
3. 用预先定义的 SLO 判断是否上线，而不是用“正常、优秀”代替证据。

当环境、负载、口径和原始数据都可追溯时，`36.43 tok/s` 才不只是一个漂亮数字，而是一次能指导容量规划的工程实验。

## 参考资料

- [Qwen3-14B 官方模型卡](https://huggingface.co/Qwen/Qwen3-14B)
- [vLLM：Reasoning Outputs](https://docs.vllm.ai/en/latest/features/reasoning_outputs/)
- [vLLM：bench serve CLI](https://docs.vllm.ai/en/latest/cli/bench/serve/)
