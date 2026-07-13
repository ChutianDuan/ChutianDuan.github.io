---
title: "Qwen 版本越新就越适合你吗？从 Qwen2.5 到 Qwen3.7 的选型方法"
date: 2026-07-13 18:39:55
updated: 2026-07-13 18:39:55
categories:
  - "学习"
  - "AI 模型开发"
  - "知识点学习"
  - "大模型部署"
permalink: /notes/ai模型开发/知识点学习/大模型部署/qwen模型演进/
series: "AI 模型开发"
---

看到 `Qwen2.5`、`Qwen3`、`Qwen3.5`、`Qwen3.6` 和 `Qwen3.7`，最自然的问题是：“最新、最大的那个是不是最好？”

这个问法把几件不同的事混到了一起：

- 云 API 和 open-weight 模型不是同一条发布线；
- dense 与 MoE 的总参数、激活参数和显存需求含义不同；
- 文本、视觉、音频、embedding、coder 是不同产品族；
- stable alias、日期快照和 preview 的变更风险不同；
- 1M 上下文是能力上限，不代表每次请求都应该塞满。

本文不做简单的“新版本宣传册”，而是解释每一代改变了什么，以及怎样根据任务、交付方式、硬件、延迟和生命周期选模型。

> 信息快照：2026-07-13。模型目录变化很快，正式选型前应重新核对官方模型卡、API 目录、价格、区域和生命周期。

## 一、先纠正“最新 Qwen 只有一个”的误区

截至本文快照，至少应分成两条主线：

### 云 API 主线

Alibaba Cloud Model Studio 在 2026-07-10 更新的官方目录中，将：

- `qwen3.7-max`：当前更强调最高能力；
- `qwen3.7-plus`：当前更强调能力与成本平衡；
- `qwen3.6-flash`：更轻量、低成本；

列为推荐模型。目录同时把 `qwen3.6-plus` 和 `qwen3.6-max-preview` 放进 legacy 区域。

这意味着原来“Qwen3.6-Plus 是最新 API 旗舰”的说法已经过期。

### Open-weight 通用模型主线

Qwen 官方 Hugging Face 集合和 GitHub 仓库列出的 Qwen3.6 open models 是：

- `Qwen3.6-27B`：dense；
- `Qwen3.6-35B-A3B`：MoE，名称中的 A3B 表示约 3B 激活参数；
- 两者另有官方 FP8 变体。

它们都是 image-text-to-text / 原生多模态方向，官方模型卡给出的原生上下文为 262,144 token，并提供扩展到更长上下文的方法。

因此，“API 最新”是 Qwen3.7，而“当前通用开源权重主线”仍是 Qwen3.6。不能把 API 名称直接当成可下载 checkpoint。

## 二、Qwen2.5 为什么仍然值得理解

Qwen2.5 于 2024-09-19 发布，是一代成熟、尺寸覆盖广的开源模型系列。通用文本模型包含 0.5B、1.5B、3B、7B、14B、32B 和 72B 等尺寸，并形成了 Coder、Math、VL、Omni 等专项分支。

这一代的重要价值不是某个排行榜数字，而是把工程常用能力做成了较完整的产品族：

- 中英文和多语言文本能力；
- 指令跟随与较稳定的结构化输出；
- 代码、数学等专项 checkpoint；
- 从端侧小模型到多卡大模型的尺寸梯度；
- 广泛的 Transformers、vLLM、llama.cpp 等生态支持。

### Qwen2.5 的“稳定”不等于无条件更好

它更适合以下情形：

- 现有服务已经完成充分验证，不值得只为版本号迁移；
- 任务是成熟的纯文本问答、抽取或 RAG；
- 硬件只能承载较小尺寸；
- 依赖某个专项 Coder/Math/VL checkpoint；
- 新模型的推理框架、量化或硬件支持尚未验证。

但不同 Qwen2.5 checkpoint 的上下文、许可、chat template 和推荐推理参数并不完全相同。不能把“Qwen2.5 支持 128K”当成每一个模型、每一种本地配置都自动成立；必须查看具体模型卡。

## 三、Qwen3 改变的核心：推理预算与 Agent 能力

Qwen3 于 2025-04-29 发布，包含 dense 和 MoE 多种尺寸。官方重点包括：

- thinking 与 non-thinking 的混合模式；
- 更强的推理、代码和工具使用；
- 100+ 语言和方言；
- dense 与 MoE 并行的尺寸路线；
- 面向 Agent 和 MCP/工具调用的能力增强。

### Hybrid Thinking 为什么重要

简单抽取若也进行长时间推理，会增加成本和延迟；复杂数学、代码调试若完全不思考，又可能降低质量。混合模式让应用按请求控制推理预算：

```text
格式转换、分类、简单问答 -> non-thinking / 低 reasoning effort
复杂规划、代码调试、数学 -> thinking / 更高 reasoning effort
```

这把模型选择从“固定快或固定强”扩展为“同一模型按请求分配计算”。不过 thinking token 同样消耗时间和费用，且不同 API/本地框架的开关、reasoning parser 与返回字段可能不同。

### Qwen3-2507 为什么要单独记

Qwen3 后来又发布 2507 更新，将 Instruct 与 Thinking 变体进一步区分，并增强长上下文、工具和推理能力。模型名中的日期后缀不是装饰，它对应可复现的 checkpoint 行为。

如果生产环境只写浮动 alias，模型升级后输出可能改变；如果使用固定 checkpoint，则要自行规划升级与安全修复。

## 四、Qwen3.5 改变的核心：原生多模态 Agent

Qwen3.5 于 2026-02 发布，官方定位从文本推理进一步走向 native multimodal agents。首批大模型包含 `397B-A17B`，之后扩展出 `122B-A10B`、`35B-A3B`、27B 和更小尺寸。

这一代的重要变化包括：

- 文本与视觉不再只是两个互不相干的产品入口；
- MoE 继续用较少激活参数提供更大模型容量；
- hybrid attention / linear attention 等架构更关注长上下文效率；
- 工具调用、规划、视觉理解和多步执行被放进同一 Agent 方向。

“原生多模态”仍不等于所有任务都比专项模型好。例如 OCR、ASR、图像生成、embedding 和 reranking 仍可能有更适合的 Qwen 专项系列。应按输入输出模态选择，而不是把通用多模态模型当作全能替代品。

## 五、Qwen3.6 改变的核心：把多模态 Agent 推向真实开发任务

Qwen3.6 云端 Plus 于 2026-04 发布，随后开源 35B-A3B 和 27B。官方将重点放在：

- agentic coding 与仓库级任务；
- 多模态感知和推理；
- 工具调用与长链路执行；
- 开发者反馈下的稳定性和真实可用性。

### 两个 open model 怎么区别

| 模型 | 架构 | 名称表达的参数 | 主要部署含义 |
| --- | --- | --- | --- |
| `Qwen3.6-27B` | Dense | 约 27B 全部参与每次前向 | 结构直观，计算和内存容易理解 |
| `Qwen3.6-35B-A3B` | MoE | 约 35B 总参数、约 3B 激活参数 | 每 token 计算较省，但仍要存总权重 |

### A3B 为什么不等于“3B 模型显存”

MoE 每个 token 只路由到部分 expert，所以激活参数影响计算量；部署时通常仍需加载全部或绝大多数 expert 权重，因此权重内存更接近总参数量。

可以粗略记成：

```text
总参数 -> 权重存储与加载压力
激活参数 -> 每 token 的主要计算压力
expert 通信 -> 多卡 MoE 的额外性能变量
```

只看到 A3B 就按普通 3B dense 模型准备显存，通常会在加载阶段失败。

### 27B dense 也不一定比 35B-A3B 慢

MoE 需要路由、expert kernel 和可能的跨卡通信。不同硬件与 engine 的支持差异很大，真实吞吐取决于 batch、量化、并行和 kernel。必须在目标硬件上压测 TTFT、ITL、tokens/s 和显存。

## 六、Qwen3.7 当前代表什么

截至 2026-07-13，官方 Model Studio 文档推荐：

- `qwen3.7-max`：更强推理和最高能力方向；
- `qwen3.7-plus`：聊天、内容、总结、文档和 coding tool 的均衡选择；

二者在官方目录中均列出 1M context、thinking、function calling、built-in tools、structured output 和 batch calling 支持。

但这里描述的是云服务产品能力，不意味着：

- 存在同名 open-weight checkpoint；
- 1M token 请求成本低或延迟可接受；
- 每个区域、价格和 API 形态完全一致；
- 浮动 alias 永远保持同一模型行为。

云 API 选型还要核对区域可用性、数据处理条款、限流、价格、模型快照和弃用计划。

## 七、Dense、MoE、API 三类成本不能只看参数名

### Dense open-weight

权重内存与参数量近似线性，所有层/参数参与计算，部署行为较直观。小尺寸 dense 往往更适合单机、端侧或框架支持有限的环境。

### MoE open-weight

总参数很大但每 token 只激活部分 expert。计算/能力比可能更好，但仍有总权重、expert 路由、显存布局和多卡通信成本。

### 云 API

不需要管理 GPU 与 checkpoint，却要承担按 token/请求计费、网络延迟、限流、区域、数据合规和供应方升级风险。

所以比较成本时至少统一：

```text
输入/输出 token 分布
thinking token
并发与延迟 SLO
GPU 利用率与副本数
工程维护成本
API 单价与缓存折扣
```

只比较“3B active”和“每百万 token 价格”都可能得到错误结论。

## 八、1M 上下文为什么不是“把整个仓库塞进去”

最大 context 是 token 总预算，通常还要容纳：

- system prompt；
- 工具定义；
- 用户输入；
- 历史对话；
- 图片/视频等多模态 token；
- thinking/reasoning；
- 最终输出。

长上下文会增加 prefill 时间、KV Cache、费用和噪声。模型“接得住”不代表能稳定找到每个细节。

处理大仓库或长文档时，仍应比较：

- 检索后只注入相关内容；
- 分层摘要与索引；
- prefix cache；
- 1M 全量输入。

选型指标应包含长上下文中的目标证据召回、TTFT、总成本和答案引用，而不只是是否超过上下文上限。

## 九、可运行的约束式选型示例

下面的 Python 3.10+ 代码用 2026-07-13 快照演示“按约束过滤”，不是自动替你决定最强模型。目录中的能力字段来自当时官方 Model Studio 与 Qwen open model 页面，未来应更新数据而不是改筛选逻辑。

```python
from __future__ import annotations

from dataclasses import dataclass

@dataclass(frozen=True)
class ModelOption:
    model_id: str
    delivery: str
    architecture: str
    context_tokens: int
    features: frozenset[str]
    total_parameters_billion: float | None = None
    active_parameters_billion: float | None = None

CATALOG = (
    ModelOption(
        "qwen3.7-max",
        "api",
        "managed",
        1_000_000,
        frozenset({"thinking", "tools", "built_in_tools", "structured"}),
    ),
    ModelOption(
        "qwen3.7-plus",
        "api",
        "managed",
        1_000_000,
        frozenset({"thinking", "tools", "built_in_tools", "structured"}),
    ),
    ModelOption(
        "Qwen/Qwen3.6-27B",
        "open_weight",
        "dense",
        262_144,
        frozenset({"thinking", "tools", "vision", "structured"}),
        total_parameters_billion=27,
        active_parameters_billion=27,
    ),
    ModelOption(
        "Qwen/Qwen3.6-35B-A3B",
        "open_weight",
        "moe",
        262_144,
        frozenset({"thinking", "tools", "vision", "structured"}),
        total_parameters_billion=35,
        active_parameters_billion=3,
    ),
)

def select_models(
    *,
    delivery: str,
    required_features: set[str],
    minimum_context: int,
    maximum_total_parameters: float | None = None,
) -> list[ModelOption]:
    matches = []
    for option in CATALOG:
        if option.delivery != delivery:
            continue
        if not required_features <= option.features:
            continue
        if option.context_tokens < minimum_context:
            continue
        if (
            maximum_total_parameters is not None
            and option.total_parameters_billion is not None
            and option.total_parameters_billion > maximum_total_parameters
        ):
            continue
        matches.append(option)
    return matches

local_candidates = select_models(
    delivery="open_weight",
    required_features={"vision", "tools"},
    minimum_context=128_000,
    maximum_total_parameters=30,
)
api_candidates = select_models(
    delivery="api",
    required_features={"tools", "structured"},
    minimum_context=500_000,
)

assert [model.model_id for model in local_candidates] == [
    "Qwen/Qwen3.6-27B"
]
assert {model.model_id for model in api_candidates} == {
    "qwen3.7-max",
    "qwen3.7-plus",
}

print("local:", [model.model_id for model in local_candidates])
print("api:", [model.model_id for model in api_candidates])
```

筛选结果只是候选集。下一步仍要用自己的任务集比较质量、成本和延迟。比如 `maximum_total_parameters=30` 只是模型规模约束，不等于 27B 一定能装入现有显卡；dtype、视觉编码器、KV Cache 和引擎开销都要计算。

## 十、open-weight 本地部署要看具体模型卡

以 Qwen3.6 open model 为例，官方模型卡在本文快照时推荐较新的 serving framework，并为 reasoning、tool call、MTP 和 text-only 模式给出不同参数。不能只运行：

```bash
vllm serve Qwen/Qwen3.6-35B-A3B
```

就默认工具调用、thinking 解析和多模态都正确。

例如只做文本服务时，官方模型卡提供 `--language-model-only` 以跳过视觉编码器和相关 profiling；reasoning 和 tool call 还需要匹配 parser。下面是一个**缩短上下文、便于先验证资源**的示意命令，不是所有硬件通用配方：

```bash
vllm serve Qwen/Qwen3.6-35B-A3B \
  --port 8000 \
  --tensor-parallel-size 4 \
  --max-model-len 8192 \
  --reasoning-parser qwen3 \
  --language-model-only
```

运行前应按模型卡创建隔离环境、核对 vLLM 版本和 GPU 数量；不要在系统环境全局安装。若需要工具调用，再按当前模型卡加入 auto tool choice 与对应 parser，并用真实 schema 做回归测试。

### 为什么不建议一开始就开 262K 或 1M

最大上下文会影响 KV Cache 规划和可承载并发。先用业务实际 P95 长度跑通质量与吞吐，再逐步扩容，比一开始追求模型上限更稳妥。Qwen3.6 模型卡也明确提示 OOM 时降低 context window。

## 十一、云 API alias 与固定快照怎么选

### 浮动 alias

例如 `qwen3.7-plus`，供应方可能持续升级。好处是自动获得改进，风险是输出格式、工具选择、拒答和成本特征可能变化。

### 日期快照

若官方提供带日期的 model ID，行为更容易复现。适合强回归、合规或对格式稳定性要求高的系统，但需要主动迁移。

无论哪种方式，生产调用都应保存：

```text
请求中的 model ID
响应返回的模型/版本信息（若有）
system prompt 与工具 schema 版本
thinking/reasoning 配置
采样参数
区域与 API 版本
```

浮动 alias 升级前最好经过影子流量和固定评估集，而不是把供应方更新直接暴露给全部用户。

## 十二、不要用官方 benchmark 替代业务评测

代际博客中的 benchmark 可以帮助理解能力方向，却未必使用相同：

- prompt；
- thinking budget；
- 工具环境；
- 上下文长度；
- 采样参数；
- 评测 harness；
- API 与 checkpoint。

跨代对比时尤其容易把“模型更强”与“评测设置不同”混在一起。

自己的评估至少覆盖：

| 维度 | 示例指标 |
| --- | --- |
| 任务质量 | 正确率、pass@k、人工偏好、引用准确率 |
| 工具调用 | schema 合法率、选工具正确率、参数正确率 |
| Agent | 任务完成率、步骤数、失败恢复、总 token |
| 长上下文 | 目标证据命中、位置敏感、TTFT、成本 |
| 多模态 | OCR、图表、截图理解、视觉幻觉 |
| 服务 | TTFT、ITL、吞吐、显存、错误率 |
| 稳定性 | JSON 合法率、重复循环、超时、跨版本回归 |

模型选择不是一次性排行榜，而是质量—延迟—成本的 Pareto 比较。

## 十三、按场景怎样建立第一批候选

### 成熟纯文本 RAG

先保留已验证的 Qwen2.5 基线，再加入能承载的 Qwen3/Qwen3.6 或当前 API 模型做 A/B。不要因为新模型支持视觉就强制迁移全部链路。

### 云端 coding / Agent

按当前官方目录从 `qwen3.7-plus` 建均衡基线，复杂推理再比较 `qwen3.7-max`。同时记录 thinking token、工具调用成功率和整任务成本。

### 私有化多模态 Agent

比较 Qwen3.6-27B 与 35B-A3B；先确认 engine 对视觉、reasoning、tool parser 和 MoE kernel 的支持，再测目标硬件。

### 单机或端侧

较小的 Qwen2.5/Qwen3/Qwen3.5 checkpoint 可能更现实。模型能下载不代表能达到可用 tokens/s，应先算权重、KV 和量化支持。

### 专项 embedding、rerank、ASR、TTS 或图像生成

选择对应 Qwen 专项系列，不要使用通用 chat 模型硬做所有任务。输入输出接口、loss 和部署引擎都不同。

## 十四、常见误区

### “Qwen3.7 比 Qwen3.6 新，所以本地就用 3.7”

API 发布不代表存在同名 open weights。先确认交付形态。

### “A3B 只需要 3B 模型的显存”

激活参数主要描述每 token 计算，不代表总权重只剩 3B。

### “上下文 1M，所以不用 RAG”

长上下文仍有 prefill、KV、价格、噪声和证据定位问题。

### “支持 function calling 就能做好 Agent”

还要测工具选择、参数、权限、重试、状态管理和长任务恢复。

### “JSON 输出更强，所以永远不会格式错”

应使用结构化输出能力、schema 校验和重试，而不是只靠 prompt。

### “官方 benchmark 第一，所以我的任务也第一”

业务分布、语言、工具、硬件和成本约束不同，必须保留自己的基线。

## 十五、一个不追版本号的选型流程

1. 写清输入模态、输出形式、工具、上下文和数据边界；
2. 决定 API、open-weight 或两者都评估；
3. 按显存和延迟排除不可能部署的模型；
4. 固定模型 ID、版本、prompt 和 thinking 配置；
5. 用同一业务集测质量、工具、长上下文和安全；
6. 用真实长度与并发测 TTFT、ITL、吞吐和成本；
7. 选择满足 SLO 的最小/最低成本候选，而非盲选最大；
8. 对浮动 API alias 做影子流量和回归；
9. 保留旧模型、旧索引和 prompt 的回滚路径；
10. 定期刷新官方目录，但只有收益明确才迁移。

## 官方资料

- [Alibaba Cloud Model Studio：当前模型目录](https://www.alibabacloud.com/help/en/model-studio/text-generation-model)
- [Qwen3.6 官方 GitHub 仓库](https://github.com/QwenLM/Qwen3.6)
- [Qwen3.6 官方 Hugging Face 集合](https://huggingface.co/collections/Qwen/qwen36)
- [Qwen3.6-27B 模型卡](https://huggingface.co/Qwen/Qwen3.6-27B)
- [Qwen3.6-35B-A3B 模型卡](https://huggingface.co/Qwen/Qwen3.6-35B-A3B)
- [Qwen3：Think Deeper, Act Faster](https://qwenlm.github.io/blog/qwen3/)
- [Qwen2.5：A Party of Foundation Models](https://qwenlm.github.io/blog/qwen2.5/)

## 总结

Qwen 的演进可以概括为：Qwen2.5 把通用与专项模型做得成熟，Qwen3 引入可切换的推理预算并强化 Agent，Qwen3.5 转向原生多模态 Agent，Qwen3.6 把 coding 与真实执行能力推进到开源模型，而 Qwen3.7 在本文快照时代表最新云 API 主线。

真正的选型关键不是背住这个时间线，而是始终区分：API 还是权重、dense 还是 MoE、总参数还是激活参数、原生上下文还是扩展上下文、浮动 alias 还是固定快照。

一句话记住：

> 先用交付方式和资源约束筛掉不能用的模型，再用自己的任务和 SLO 选出最合适的，而不是把“最新”当作答案。
