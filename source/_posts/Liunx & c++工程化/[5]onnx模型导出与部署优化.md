---
title: "PyTorch 结果正常，导出 ONNX 后为什么又慢又不准？"
date: 2026-07-13 15:55:45
updated: 2026-07-13 15:55:45
categories:
  - "学习"
  - "Linux 与 C++ 工程化"
permalink: /notes/liunx-c-工程化/5-onnx模型导出与部署优化/
series: "Linux 与 C++ 工程化"
series_order: 5
---

训练完成的 YOLO 模型在 PyTorch 中检测准确，导出 ONNX、接入 C++ 后却出现了两个问题：检测框整体偏移，INT8 文件虽然缩小到原来的四分之一，推理耗时却几乎没变。模型能被 ONNX Runtime 正常加载，`onnx.checker` 也没有报错，那么问题究竟出在哪里？

这两个现象很容易被笼统归因于“ONNX 精度损失”或“Runtime 优化不好”，但 ONNX 导出并不会自动替部署端定义颜色顺序、letterbox、输出字段和 NMS，也不能凭空为目标 CPU/NPU 创造高效 INT8 kernel。问题通常藏在输入输出契约、前后处理复现、Execution Provider（执行提供程序，简称 EP）的图划分、线程配置或性能统计口径中。

本文沿着一条可以逐层证伪的链路展开：先固定模型契约，再用最小模型完成“PyTorch → ONNX checker → ONNX Runtime”数值闭环；随后才进入 C++、图优化、EP、量化和端到端 benchmark。读完后，你应该能判断差异最早出现在哪一层，而不是一上来反复调整置信度阈值。

> ONNX 解决的是模型计算图的可移植性；ONNX Runtime 负责加载、图优化和执行；真正的部署效果取决于输入输出契约、算子支持、Execution Provider、线程策略、内存访问，以及前处理和后处理的端到端成本。

## 1. 部署链路总览

一条比较完整的部署链路通常长这样：

```text
PyTorch 训练模型
    ↓
导出 ONNX
    ↓
校验模型结构、输入输出、数值一致性
    ↓
ONNX Runtime 图优化 / Execution Provider 调度
    ↓
C++ 封装：预处理、推理、后处理、异常处理、计时
    ↓
Linux / Windows / Android 部署
```

这里要先区分几件事：

| 层次 | 主要解决的问题 | 常见工具 |
| --- | --- | --- |
| ONNX | 描述模型计算图，让模型脱离训练框架 | `torch.onnx.export`、Ultralytics export |
| ONNX checker | 检查 ONNX 模型结构是否合法 | `onnx.checker.check_model` |
| ONNX Runtime | 加载模型、图优化、执行推理 | Python / C / C++ API |
| Execution Provider | 把部分或全部节点交给特定硬件执行 | CPU、CUDA、TensorRT、OpenVINO、NNAPI、QNN |
| 业务推理程序 | 复现预处理、解析输出、NMS、跟踪、绘制、计时 | OpenCV、C++、JNI、平台 UI |

部署时最容易犯的错误，是只关心“ONNX 能不能加载”，却没有把“训练时送进模型的 Tensor”和“C++ 侧真正送进模型的 Tensor”对齐。

## 2. 导出前先确定模型契约

ONNX 导出后，必须明确模型的输入输出定义。部署端不是简单地“读取图片后送入模型”，而是要复现验证或推理阶段输入模型的最终 Tensor。

训练阶段的 Mosaic、MixUp、随机裁剪、颜色扰动等数据增强不应该带到部署端；部署端应该复现验证/推理阶段的固定预处理。

建议为每个模型保存一份模型契约，例如：

```json
{
  "input_name": "images",
  "input_shape": [1, 3, 736, 1280],
  "input_dtype": "float32",
  "layout": "NCHW",
  "color_order": "RGB",
  "normalize": "x / 255.0",
  "resize_mode": "letterbox",
  "pad_value": 114,
  "output_name": "output0",
  "output_format": "xyxy_score_class",
  "nms": "outside_onnx"
}
```

部署端至少要确认这些内容：

| 项目 | 常见部署要求 |
| --- | --- |
| 输入尺寸 | 例如 `[1, 3, 736, 1280]` |
| Batch | 实时视频推理通常为 `1` |
| 数据类型 | 常见为 `float32` |
| 数据排列 | 常见为 `NCHW` |
| 图像颜色 | 常见为 `RGB`，但以训练/验证代码为准 |
| 数值范围 | 常见为 `[0, 1]`，即 `/255.0` |
| Resize 方式 | 检测模型常见为 letterbox 保比例缩放 |
| Padding 值 | YOLO 常见为 `114` |
| 输出格式 | 例如 `[x1, y1, x2, y2, score, class_id]` |
| NMS 位置 | 在 ONNX 内，或在 C++ 后处理内 |

### 2.1 BGR / RGB 不是小问题

OpenCV 默认读取图像是 BGR：

```text
cv::imread()
    ↓
BGR 格式
```

但多数 YOLO 推理代码最终送入模型的是 RGB。典型预处理链路是：

```text
OpenCV BGR 图像
    ↓
letterbox
    ↓
BGR → RGB
    ↓
HWC → CHW
    ↓
uint8 → float32
    ↓
除以 255.0
    ↓
[1, 3, H, W]
```

C++ 中常见写法：

```cpp
cv::Mat rgb;
cv::cvtColor(bgr, rgb, cv::COLOR_BGR2RGB);
```

但不要机械地认为“所有模型都必须 BGR 转 RGB”。正确原则是：

> 以训练和验证代码中真正送入模型的 Tensor 为标准。训练侧最终是 RGB，部署侧就用 RGB；训练侧明确使用 BGR，部署侧就不要额外转换。

### 2.2 HWC、CHW、NCHW

OpenCV 图像通常是：

```text
HWC = [height, width, channel]
```

大部分 ONNX 检测模型输入是：

```text
NCHW = [batch, channel, height, width]
```

转换关系是：

```text
HWC
    ↓
CHW
    ↓
增加 batch 维度
    ↓
NCHW
```

如果忘记转换，模型可能不报错，但检测结果通常会完全错误。

### 2.3 Letterbox 与坐标回映射

Letterbox 的作用是：

```text
保持原图宽高比
+ 缩放至目标尺寸
+ 填充边缘
```

设原图大小为：

```text
H0 × W0
```

模型输入大小为：

```text
Hin × Win
```

缩放比例：

```text
r = min(Win / W0, Hin / H0)
```

缩放后尺寸：

```text
W' = round(W0 × r)
H' = round(H0 × r)
```

填充：

```text
pad_x = (Win - W') / 2
pad_y = (Hin - H') / 2
```

模型输出框若位于 letterbox 后图像坐标系，映射回原图时要先减 padding，再除缩放比例：

```text
x_original = (x_model - pad_x) / r
y_original = (y_model - pad_y) / r
```

常见错误是只除以缩放比例，但忘记减去 padding。结果会表现为检测框整体偏移，边缘目标定位异常。

### 2.4 如何建立一个最小的“导出—校验—对比”闭环

先不要用 YOLO 排查导出工具链。检测模型同时包含复杂输出和后处理，失败时很难判断是 exporter、Runtime 还是 NMS。下面先用一个小型分类模型验证基础链路。

示例面向 Python 3.10+、PyTorch 2.6+ 的 `torch.export`-based ONNX exporter，并需要 `onnx`、`onnxruntime` 和 `numpy`。具体可用版本应由项目锁文件固定；PyTorch exporter API 与 Runtime 支持的 opset 都可能演进，需要结合实际版本验证。

```python
import numpy as np
import onnx
import onnxruntime as ort
import torch
from torch import nn

class TinyClassifier(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(3, 4, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.AdaptiveAvgPool2d((1, 1)),
        )
        self.classifier = nn.Linear(4, 2)

    def forward(self, images: torch.Tensor) -> torch.Tensor:
        features = self.features(images).flatten(1)
        return self.classifier(features)

torch.manual_seed(7)
model = TinyClassifier().eval()
example = torch.rand(1, 3, 224, 224, dtype=torch.float32)

# 这里只让 batch 动态；通道和空间尺寸仍属于模型契约。
batch = torch.export.Dim("batch", min=1, max=8)
onnx_program = torch.onnx.export(
    model,
    (example,),
    input_names=["images"],
    output_names=["scores"],
    dynamic_shapes={"images": {0: batch}},
    opset_version=18,
    dynamo=True,
)
onnx_program.save("tiny_classifier.onnx")

# 第一层：格式和图结构校验。
onnx_model = onnx.load("tiny_classifier.onnx")
onnx.checker.check_model(onnx_model, full_check=True)

# 第二层：同一输入在 PyTorch 与 ORT 上比较原始输出。
sample = torch.rand(3, 3, 224, 224, dtype=torch.float32)
with torch.inference_mode():
    expected = model(sample).cpu().numpy()

session = ort.InferenceSession(
    "tiny_classifier.onnx",
    providers=["CPUExecutionProvider"],
)
actual = session.run(
    ["scores"],
    {"images": sample.cpu().numpy()},
)[0]

np.testing.assert_allclose(actual, expected, rtol=1e-4, atol=1e-5)
print("input:", session.get_inputs()[0].shape)
print("output:", actual.shape)
print("PyTorch and ONNX Runtime outputs match")
```

预期输出的具体动态维名称可能随 exporter 版本变化，但应能看到 batch 维不是固定的 `1`，并得到：

```text
output: (3, 2)
PyTorch and ONNX Runtime outputs match
```

这里有四个关键设计：`eval()` 固定 Dropout、BatchNorm 等推理行为；示例输入用于捕获图和约束，不是“随便占个位”；动态 batch 明确限制在 1～8；数值比较发生在原始输出上，还没有混入后处理。

`opset_version=18` 只是这个示例选择的部署契约，不代表永远应该使用 18。正确做法是选择 exporter、目标 ONNX Runtime 和目标 EP 共同支持的 opset，并在升级任一组件后重新验证。

动态维度也不是越多越好。固定输入尺寸通常更容易获得稳定的内存规划和硬件优化；只有业务确实需要多 batch 或多分辨率时，才应把对应维度声明为动态。对于新版 `dynamo=True` exporter，优先使用 `dynamic_shapes`；旧版 exporter 常见的 `dynamic_axes` 语法不要未经版本确认直接混用。

## 3. YOLO 输出不能靠猜

不同 YOLO 版本、不同导出参数、不同后处理策略，ONNX 输出可能完全不同。

常见形式一：

```text
[1, 300, 6]
```

可能表示：

```text
[x1, y1, x2, y2, score, class_id]
```

这种输出通常说明模型图里已经完成了候选框筛选，甚至可能已经包含 NMS。

常见形式二：

```text
[1, 84, 8400]
```

可能表示：

```text
4 个边界框参数
+ 80 个类别分数
× 8400 个候选位置
```

这类输出一般需要在 C++ 中自行完成：

```text
decode
score threshold
class selection
NMS
```

导出时一定要确认 NMS 位置：

```text
nms=False:
    ONNX 输出原始预测
    C++ 执行后处理和 NMS

nms=True:
    ONNX 图可能已经包含 NMS
    C++ 不应重复执行 NMS
```

不要写“通用 YOLO 后处理”。更可靠的说法是：

> 只写适配当前模型输出结构的后处理，并把输出 shape、字段含义、NMS 位置写进模型契约。

## 4. 导出后的三层校验

导出 ONNX 后，不要直接进入 C++ 集成。建议按三层校验推进。

### 4.1 ONNX 结构校验

```python
import onnx

model = onnx.load("model.onnx")
onnx.checker.check_model(model, full_check=True)
```

主要检查：

```text
模型格式是否合法
节点连接是否正确
opset 是否兼容
输入输出定义是否完整
shape 推断是否存在问题
```

注意：结构合法不代表部署结果正确。它只能说明这个 ONNX 文件在格式和图结构上基本可用。

### 4.2 Python ONNX Runtime 校验

先用 Python 加载 ONNX，打印模型元信息并跑一次前向：

```python
import onnxruntime as ort

session = ort.InferenceSession("model.onnx", providers=["CPUExecutionProvider"])

for x in session.get_inputs():
    print("input:", x.name, x.shape, x.type)

for y in session.get_outputs():
    print("output:", y.name, y.shape, y.type)
```

目标是确认：

```text
ONNX 能被 Runtime 正常加载
输入名、输出名、shape、dtype 正确
模型前向推理可以运行
输出结构符合预期
```

### 4.3 Python 与 C++ 数值一致性校验

对同一张固定图片，分别从 Python 和 C++ 保存：

```text
input_tensor.npy
raw_output.npy
detections.json
```

比较顺序应该是：

```text
1. Python input tensor 与 C++ input tensor 是否接近
2. Python raw output 与 C++ raw output 是否接近
3. 最终框坐标、类别、置信度是否接近
```

优先比较输入 Tensor，而不是只看最终检测框。

最终检测结果不同，可能来自很多环节：

```text
BGR/RGB 错误
resize 方式不同
padding 不同
HWC/CHW 错误
归一化错误
输出解析错误
NMS 差异
坐标回映射错误
```

如果输入 Tensor 已经不一致，后面任何模型输出对比都没有意义。

## 5. ONNX Runtime C++ 侧怎么配置

C++ 侧通常从 `Ort::SessionOptions` 开始配置。

```cpp
Ort::SessionOptions options;

options.SetGraphOptimizationLevel(
    GraphOptimizationLevel::ORT_ENABLE_ALL
);

options.SetIntraOpNumThreads(4);
options.SetInterOpNumThreads(1);
```

常见可控制项包括：

```text
图优化等级
单个算子内部并行度
算子图之间的并行策略
Execution Provider
日志等级
profiling
内存分配与 Arena 策略
```

通常建议在 benchmark 中显式设置图优化等级，而不是依赖默认行为。这样不同机器、不同构建、不同 ONNX Runtime 版本之间更容易对比。

图优化等级常见有：

| 级别 | 含义 |
| --- | --- |
| `ORT_DISABLE_ALL` | 关闭图优化 |
| `ORT_ENABLE_BASIC` | 常量折叠、冗余节点消除等基础优化 |
| `ORT_ENABLE_EXTENDED` | Basic + 更复杂的节点融合 |
| `ORT_ENABLE_ALL` | Basic + Extended + Layout Optimization 等更激进优化 |

实践中可以对比：

```text
FP32 + ORT_ENABLE_EXTENDED
FP32 + ORT_ENABLE_ALL
INT8 + ORT_ENABLE_ALL
```

但不要只改一个配置就宣布“优化成功”。每个设置都要放到分段计时和同条件 benchmark 里验证。

## 6. 图优化、kernel 优化、EP 和量化的区别

很多部署讨论会把“图优化”“算子融合”“kernel 优化”“Execution Provider”“量化”混在一起。实际它们解决的问题不同。

### 6.1 图优化

图优化是改写 ONNX 计算图。

例如训练图里常见：

```text
Conv → BatchNorm → ReLU
```

推理阶段 BatchNorm 参数固定后，可以融合成：

```text
Conv' → ReLU
```

收益是：

```text
减少节点数量
减少中间 Tensor
减少内存读写
降低调度开销
```

如果你在图里看不到 BatchNorm，可能是模型导出前已经完成了 BN folding，也可能是图结构不满足融合条件。

### 6.2 算子融合

常见融合包括：

```text
Conv + BatchNorm
Conv + Add
Conv + Relu
MatMul + Add
Gemm + Activation
```

本质是把多个节点合并为一个融合节点，或者让 EP 使用一个融合 kernel 执行。

收益通常来自：

```text
减少中间结果写回内存
减少算子调度
提高缓存利用率
降低访存开销
```

### 6.3 Kernel 优化

ONNX 的 `Conv` 只描述“做什么”，不描述“怎么在当前硬件上高效执行”。

同一个 `Conv`，不同硬件上的底层实现可能是：

```text
CPU AVX2 Conv kernel
CPU AVX-512 / VNNI INT8 kernel
ARM NEON kernel
CUDA kernel
TensorRT kernel
NNAPI kernel
QNN HTP kernel
```

所以一个模型是否快，不只取决于 ONNX 图本身，还取决于当前平台有没有高效 kernel。

### 6.4 Execution Provider

Execution Provider 决定哪些节点交给哪种硬件或推理后端执行。

常见后端：

| 后端 | 典型平台 |
| --- | --- |
| `CPUExecutionProvider` | Linux、Windows、Android |
| `CUDAExecutionProvider` | NVIDIA GPU |
| `TensorRTExecutionProvider` | NVIDIA 高性能推理 |
| `OpenVINOExecutionProvider` | Intel CPU / iGPU |
| `XNNPACK` | Android / ARM CPU |
| `NNAPI` | Android GPU / NPU / DSP |
| `QNN` | Qualcomm Snapdragon GPU / HTP / NPU |
| `DirectML` | Windows GPU |

Runtime 会把 ONNX 图拆成子图：

```text
支持的节点
    ↓
交给 CUDA / TensorRT / NNAPI / QNN 等 EP

不支持的节点
    ↓
回退 CPU
```

如果模型被切得太碎：

```text
CPU
    ↓
GPU/NPU
    ↓
CPU
    ↓
GPU/NPU
```

频繁的数据搬运会抵消硬件加速收益，甚至让速度变慢。

先确认当前安装包真正包含哪些 EP，并显式指定优先级：

```python
import onnxruntime as ort

requested = ["CUDAExecutionProvider", "CPUExecutionProvider"]
available = set(ort.get_available_providers())
missing = [provider for provider in requested if provider not in available]
if missing:
    raise RuntimeError(f"execution providers unavailable: {missing}")

session = ort.InferenceSession("model.onnx", providers=requested)
print("registered providers:", session.get_providers())
```

顺序表示优先级：CUDA 能接管的节点优先交给 CUDA，其余节点可以回退 CPU。但 `session.get_providers()` 只证明 EP 已注册，不能证明整张图都在该设备执行。要确认真实分配，应开启 ONNX Runtime profiling 或详细日志，运行具有代表性的输入，再检查各节点的 provider、子图边界和跨设备复制。

同样，`SetIntraOpNumThreads()` 等 CPU 线程选项主要影响 CPU 执行路径，不应假定 CUDA、TensorRT、QNN 等 EP 会以相同方式响应。每个 EP 的选项和版本支持都要以对应文档与实测为准。

## 7. INT8 为什么可能只变小、不变快

INT8 量化不是简单地把模型文件压缩小，而是尝试把部分浮点计算改为整数计算。

FP32 权重：

```text
w = 0.123456
```

INT8 量化后通常保存：

```text
q: int8 数值
scale: 缩放因子
zero_point: 零点
```

近似恢复：

```text
x_fp32 ≈ scale × (x_int8 - zero_point)
```

卷积量化概念上接近：

```text
X_int8 = Quantize(X_fp32)
W_int8 = Quantize(W_fp32)

Y_int32 = ConvInt8(X_int8, W_int8)

Y_fp32 = Dequantize(Y_int32)
```

重点是：

```text
输入激活可能是 INT8
卷积权重可能是 INT8
累积结果通常使用 INT32
输出可能保留 INT8，也可能反量化回 FP32
```

因此：

```text
模型文件变小
≠ 一定使用 INT8 算子
≠ 一定推理变快
```

### 7.1 Dynamic / Static / QAT

| 方法 | 特点 | 适用场景 |
| --- | --- | --- |
| Dynamic Quantization | 推理时动态计算激活量化参数 | Transformer、RNN 较常见 |
| Static Quantization | 用校准集提前确定激活范围 | CNN、YOLO、检测模型常见 |
| QAT | 训练时模拟量化误差 | PTQ 精度下降明显时 |

YOLO 这类 CNN 检测模型通常优先尝试 Static INT8 Quantization。

校准集要覆盖真实场景：

```text
不同光照
不同天气
不同距离
不同目标密度
小目标
遮挡目标
低对比度目标
```

不要只用少量简单图片做校准，否则可能导致：

```text
小目标 Recall 降低
暗光目标漏检
低置信目标被过滤
类别置信度波动
```

### 7.2 QOperator 与 QDQ

QOperator 是把原始算子替换成明确的量化算子：

```text
Conv
    ↓
QLinearConv
```

QDQ 是在原始算子前后插入量化和反量化节点：

```text
FP32 tensor
    ↓ QuantizeLinear
INT8 tensor
    ↓ DequantizeLinear
FP32 tensor → Conv
    ↓ QuantizeLinear / DequantizeLinear
下一层
```

从标准 ONNX 图表面看，普通 `Conv` 仍位于 Q/DQ 边界之间；支持该模式的 Runtime/EP 会识别这些节点并选择量化 kernel。不能仅凭文件里出现 `QuantizeLinear` 就断言卷积已经在目标硬件上以 INT8 执行。

理想情况下，连续层都能被 INT8 kernel 接住：

```text
INT8 Conv
    ↓
INT8 Activation
    ↓
INT8 Conv
    ↓
少量 DeQuantize
```

不理想的情况是频繁往返：

```text
FP32
    ↓
Quantize
    ↓
INT8 Conv
    ↓
DeQuantize
    ↓
FP32
```

这时量化/反量化、内存访问与数据转换开销可能抵消 INT8 的收益。

### 7.3 INT8 无明显加速的常见原因

| 原因 | 说明 |
| --- | --- |
| 没有高效 INT8 kernel | Runtime 没有用到真正高性能的 INT8 算子实现 |
| 算子量化不完整 | 只有部分 Conv 量化，其他仍是 FP32 |
| Q/DQ 太多 | Quantize 和 DeQuantize 本身有额外开销 |
| 动态量化开销 | 每次推理都要计算激活范围 |
| CPU 指令集不够强 | 不支持高效 INT8 SIMD 指令 |
| `batch=1` | 调度、内存和线程开销占比更大 |
| 模型较小 | 算子计算量不足，INT8 优势不明显 |
| 前后处理占比高 | Resize、NMS、ByteTrack、光流才是瓶颈 |
| 线程过度竞争 | ORT、OpenCV、视频解码同时抢 CPU |
| EP 回退 | 部分节点回退到 CPU，出现跨设备数据搬运 |

INT8 的价值不是“文件变小”，而是：

> 目标平台能否把连续计算子图交给高效 INT8 kernel 执行。

## 8. 性能测试必须分段

不要只看 FPS。FPS 是结果，不是诊断工具。

建议至少拆分：

```text
decode_ms
preprocess_ms
onnx_ms
postprocess_ms
tracking_ms
render_ms
total_ms
```

推荐输出类似：

```text
Frames: 962

Preprocess:
    mean = 8.4 ms
    p50  = 8.0 ms
    p95  = 11.2 ms

ONNX:
    mean = 245.3 ms
    p50  = 240.1 ms
    p95  = 278.6 ms

Postprocess:
    mean = 2.1 ms
    p50  = 2.0 ms
    p95  = 3.7 ms

Tracking:
    mean = 1.6 ms
    p50  = 1.5 ms
    p95  = 2.8 ms

Total:
    mean = 257.4 ms
    FPS = 3.88
```

这样才能判断：

```text
INT8 是否真的减少了模型推理时间
图优化是否有效
线程数是否导致竞争
光流和 ByteTrack 是否成为新瓶颈
视频解码是否占用过高
```

### 8.1 CPU 部署优化顺序

第一阶段，保证正确性：

```text
BGR/RGB 正确
letterbox 正确
padding 正确
HWC → CHW 正确
float32 与 /255 正确
输入 shape 正确
输出结构正确
坐标映射正确
NMS 不重复执行
```

第二阶段，建立 FP32 基线：

```text
同一模型
同一视频
同一线程配置
同一 warmup 次数
同一置信度阈值
同一 NMS 阈值
```

记录：

```text
P50 延迟
P95 延迟
平均 FPS
CPU 利用率
Precision
Recall
F1
```

第三阶段，比较图优化与线程数：

```text
FP32 + ORT_ENABLE_EXTENDED
FP32 + ORT_ENABLE_ALL

intra_op = 2
intra_op = 4
intra_op = 6

推理 worker = 1
推理 worker = 2
```

注意避免线程过度竞争：

```text
推理 worker 数 × intra_op threads
```

不应明显大于机器实际物理核心数。

第四阶段，再测试 Static INT8：

```text
FP32 ONNX
INT8 ONNX
```

不仅比较速度，还要比较：

```text
模型大小
内存占用
ONNX 推理耗时
端到端耗时
Precision
Recall
F1
小目标 Recall
P50 / P95 延迟
```

## 9. 跨平台部署的组织方式

在目标 Runtime/EP 支持相应 opset、算子和数据类型的前提下，同一个 ONNX 文件通常可以复用于：

```text
Linux x86_64
Windows x64
Android arm64-v8a
```

但不同平台需要分别打包 Runtime 库并选择 EP：

```text
Linux:
    app + libonnxruntime.so

Windows:
    app.exe + onnxruntime.dll

Android:
    APK/AAR + libonnxruntime.so + JNI/C++ 核心代码
```

建议复用核心层：

```text
core/
├── ort_runner.cpp
├── preprocess.cpp
├── yolo_postprocess.cpp
├── detector.cpp
├── byte_tracker.cpp
└── optical_flow.cpp
```

平台层单独实现：

```text
platform/
├── linux_main.cpp
├── windows_main.cpp
└── android_jni.cpp
```

原则是：

> 模型逻辑、预处理、后处理、跟踪逻辑尽量跨平台复用；平台差异集中在编译、依赖加载、摄像头输入、UI 和硬件 EP 配置。

## 10. 回到开头：框为什么偏，INT8 为什么不快？

检测框整体偏移时，最先比较的应是 Python 与 C++ 的输入 Tensor、letterbox 参数和原始输出，而不是怀疑 ONNX “改变了模型”。INT8 不加速时，则应确认量化节点是否形成连续子图、目标 EP 是否真正接管、硬件是否有高效整数指令，以及端到端瓶颈是否根本不在模型推理。

结构校验通过只能证明模型图基本合法，模型文件缩小也只能证明参数表示发生了变化。它们都不能替代数值对比、节点分配证据和同条件 benchmark。

遇到任何“优化方法”，先问四个问题：

```text
1. 它减少的是模型大小，还是实际计算量？

2. 它减少的是算子数量，还是内存访问？

3. 当前硬件是否存在对应的高效 kernel？

4. 它优化的是单次 ONNX 推理，还是端到端视频链路？
```

常见优化对比：

| 优化方式 | 模型变小 | ONNX 推理可能变快 | 端到端一定变快 | 精度风险 |
| --- | ---: | ---: | ---: | ---: |
| Conv + BN 融合 | 少量 | 通常会 | 不一定 | 很低 |
| ONNX 简化 | 可能 | 不一定 | 不一定 | 低 |
| Static INT8 | 明显 | 可能 | 不一定 | 中等 |
| FP16 GPU | 明显 | GPU 上可能 | 不一定 | 低到中等 |
| TensorRT | 不一定 | 通常明显 | 仍需测试 | 低到中等 |
| 线程数调整 | 否 | 可能 | 可能 | 无 |
| 光流跳帧 | 否 | 不改变单帧模型速度 | 通常会 | 跟踪风险 |
| ROI 推理 | 否 | 局部推理更快 | 目标少时通常会 | 漏检风险 |

最终可以用下面这条链路检查自己的部署是否可靠：

```text
输入契约一致
    ↓
Python 与 C++ 数值一致
    ↓
输出解析正确
    ↓
分段性能可观测
    ↓
图优化与线程策略可对比
    ↓
INT8 是否真正使用高效 kernel 可验证
    ↓
跨平台结果可复现
```

对于 YOLO + ONNX Runtime + OpenCV + ByteTrack + 光流这类项目，优化优先级建议是：

```text
1. 输入输出契约与数值一致性
2. FP32 基线与分段性能统计
3. ORT 图优化与线程数 benchmark
4. Static INT8 量化与精度回归
5. 查看 INT8 算子、Q/DQ 与 CPU fallback
6. Android XNNPACK / NNAPI / QNN 等平台优化
7. ROI、光流、动态关键帧等系统级加速
```

## 11. 参考资料与延伸阅读

下面这些资料适合作为后续学习和博客补充参考。官方文档用于确认事实，社区文章用于参考工程写法和常见坑位。由于 YOLO 和 ONNX Runtime 更新很快，具体参数和默认行为要以自己安装版本的文档、`yolo export --help`、Netron 图结构和实际输出 shape 为准。

### 官方文档

- [PyTorch ONNX exporter](https://docs.pytorch.org/docs/stable/onnx.html)：了解 `torch.onnx.export`、动态 shape、导出行为和新版 exporter。
- [ONNX checker API](https://onnx.ai/onnx/api/checker.html)：确认 `onnx.checker.check_model` 能检查哪些结构一致性问题。
- [ONNX Runtime Python API](https://onnxruntime.ai/docs/api/python/api_summary.html)：学习如何加载模型、查看输入输出、运行推理。
- [ONNX Runtime Graph Optimizations](https://onnxruntime.ai/docs/performance/model-optimizations/graph-optimizations.html)：理解 Basic、Extended、All 等图优化层次。
- [ONNX Runtime Quantization](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html)：学习 Dynamic、Static、QDQ、QOperator、校准和量化调试。
- [ONNX Runtime Thread Management](https://onnxruntime.ai/docs/performance/tune-performance/threading.html)：理解 intra-op、inter-op、线程池和 CPU 线程配置。
- [ONNX Runtime Execution Providers](https://onnxruntime.ai/docs/execution-providers/)：查看不同硬件后端的支持情况。
- [Ultralytics Export Mode](https://docs.ultralytics.com/modes/export/)：查看 YOLO 导出 ONNX、TensorRT、OpenVINO 等格式的参数。
- [Ultralytics ONNX Integration](https://docs.ultralytics.com/integrations/onnx/)：查看 Ultralytics 模型导出 ONNX 后的部署说明。
- [Netron](https://netron.app/)：可视化 ONNX 图结构，检查输入输出、节点、NMS 是否在图内。

### 实践文章与代码参考

- [Object detection and pose estimation on mobile with YOLOv8](https://onnxruntime.ai/docs/tutorials/mobile/pose-detection.html)：ONNX Runtime 官方移动端 YOLOv8 教程，适合看移动端前后处理和模型打包思路。
- [Real-Time Object Detection with YOLO and ONNX Runtime in C++](https://medium.com/%40taffealexander/object-detection-with-yolo-and-onnx-runtime-in-c-c8bfb964520b)：C++ + ONNX Runtime + YOLO 的实践文章，适合参考项目组织和推理流程。
- [Stitching Non-Maximum Suppression to YOLOv8n ONNX](https://medium.com/%40stephencowchau/stitching-non-max-suppression-nms-to-yolov8n-on-exported-onnx-model-1c625021b22)：讲如何把 NMS 接到 YOLOv8n 导出的 ONNX 图后面，适合理解输出结构和 NMS 位置。
- [Roboflow YOLOv8 ONNX Runtime notebook](https://github.com/roboflow/sagemaker-yolov8/blob/main/notebooks/yolov8_model_inference_with_onnxruntime.ipynb?ref=blog.roboflow.com)：用 ONNX Runtime 跑 YOLOv8 的 notebook，可参考 Python 侧校验流程。
- [Ultralytics YOLOv8 OpenCV DNN C++ discussion](https://github.com/ultralytics/ultralytics/issues/671)：讨论 YOLOv8 ONNX 在 C++/OpenCV DNN 中的前处理和后处理问题，适合看常见踩坑。
- [YOLOv8 network output parsing discussion](https://github.com/ultralytics/ultralytics/issues/721)：围绕 YOLOv8 输出解析的讨论，适合对照“不要假设所有 YOLO 输出都一样”这一点。
