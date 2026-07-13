---
title: "模型明明加载成功，推理结果为什么还是错的？从 ONNX 契约到双后端部署"
date: 2026-07-13 16:22:02
updated: 2026-07-13 16:22:02
categories:
  - "学习"
  - "Linux 与 C++ 工程化"
permalink: /notes/liunx-c-工程化/11-onnx模型加载/
series: "Linux 与 C++ 工程化"
series_order: 11
---

部署视觉模型时，最容易让人放松警惕的一行日志是：

```text
model loaded successfully
```

程序没有抛异常，`session.Run()` 也返回了张量，但检测框全部挤在图像左上角；把 ONNX Runtime 换成 OpenVINO 后，输出又和 Python 相差很大。此时继续调线程数、打开 FP16，通常只会让错误跑得更快。

问题在于，**模型可加载只证明运行时能解析计算图，不证明输入名称、形状、数据类型、内存布局、预处理和后处理都满足模型契约**。本文用一个可独立生成的小模型跑通 C++ 最小闭环，再把同一套检查方法扩展到 ONNX Runtime 与 OpenVINO 的真实部署、性能调优和结果对齐。

文中的 C++ 接口以 ONNX Runtime 1.26 和 OpenVINO 2026.2 为参照。其他版本的 API、可用设备及系统要求可能不同，需要结合实际安装版本验证；尤其是 OpenVINO 2026 已停止支持 macOS x86，CPU 插件最低要求也发生了变化。

## 1. “加载成功”究竟证明了什么？

ONNX（Open Neural Network Exchange）是模型交换格式，不是执行引擎。真正执行计算图的是推理运行时：ONNX Runtime 通过执行提供程序（Execution Provider，EP）把节点分配给 CPU、CUDA、TensorRT 等后端；OpenVINO 则会把模型编译到 Intel CPU、GPU、NPU 或 `AUTO` 选择的设备。

一次完整推理实际包含下面这条链路：

```text
PyTorch / 其他训练框架
    ↓
导出 ONNX
    ↓
检查模型契约
    ↓
选择推理后端
    ├── ONNX Runtime：跨平台、后端可切换
    └── OpenVINO：Intel CPU / GPU / NPU 上重点优化
    ↓
预处理 → 创建输入张量 → 执行计算图 → 解释输出 → 后处理
```

“加载成功”通常只覆盖到“运行时能读取模型并创建会话/编译模型”。后面任何一个箭头出错，都可能得到类型正确、数值却毫无意义的输出。更麻烦的是，这类错误往往不会崩溃。

ONNX Runtime 和 OpenVINO 的核心区别：

| 项 | ONNX Runtime | OpenVINO |
| --- | --- | --- |
| 定位 | 通用 ONNX 推理运行时 | Intel 推理优化和部署工具链 |
| 输入模型 | 主要是 `.onnx`，也支持 ORT format | 可直接读 `.onnx`，也可读 OpenVINO IR `.xml/.bin` |
| 加载入口 | `Ort::Session` | `ov::Core::read_model` + `compile_model` |
| 执行后端 | CPU、CUDA、TensorRT、OpenVINO EP、DirectML 等 | CPU、GPU、NPU、AUTO 等 |
| 优化时机 | 创建 `Session` 时做图优化和 EP 划分 | `compile_model` 时做设备相关编译和优化 |
| 启动成本 | 通常较轻，取决于优化级别和 EP | 编译阶段可能更重，但可用 cache 缓解 |
| 适合场景 | 希望保持 ONNX、跨平台部署、后端灵活切换 | Intel 平台上追求 CPU/GPU/NPU 推理性能 |

先用下面的选择作为起点，而不是结论：

| 场景 | 更适合 |
| --- | --- |
| 只想跨平台跑 ONNX | ONNX Runtime |
| Windows / Linux / macOS 都要部署 | ONNX Runtime |
| 需要 CUDA / TensorRT | ONNX Runtime + 对应 Execution Provider |
| Intel CPU 上 batch=1 视频检测 | OpenVINO 值得优先测试 |
| Intel GPU / NPU | OpenVINO |
| 希望同一个 ONNX 文件对比不同后端 | 两者都直接加载同一个 ONNX，再统一输入与计时口径 |

最终仍要用目标机器、目标模型和真实输入做数值与性能验证。某个后端在一台 CPU 上更快，不能推出它在另一代 CPU、不同 batch 或不同模型上仍然更快。

## 2. 为什么输入 shape 对了，结果仍可能完全错误？

假设模型输入形状是 `[1, 3, 640, 640]`，下面两段缓冲区都有 `1 × 3 × 640 × 640` 个 `float`：

```text
NCHW: RRR... GGG... BBB...
NHWC: RGBRGBRGBRGB...
```

元素总数相同，运行时不会因为布局错误而拒绝推理，但卷积看到的像素含义已经变了。类似地，OpenCV 默认读取 BGR，而不少训练流程使用 RGB；忘记除以 `255` 也不会改变 shape，却会把数值尺度放大 255 倍。

因此，部署前必须把“模型契约”当成接口文档，而不是只记一个输入尺寸。

至少要确认：

| 项 | 例子 | 说明 |
| --- | --- | --- |
| 输入名 | `images` | C++ 推理时可能需要按名字传入 |
| 输入形状 | `[1, 3, 640, 640]` | NCHW 还是 NHWC 必须确认 |
| 输入类型 | `float32` | 常见视觉模型是 FP32 |
| 图像颜色 | RGB / BGR | OpenCV 默认 BGR，训练代码常用 RGB |
| 数值范围 | `0~1` / `-1~1` | 是否除以 255，是否减均值除方差 |
| resize 方式 | resize / letterbox | 检测框回映射依赖这个信息 |
| 输出形状 | `[1, 84, 8400]` / `[1, 300, 6]` | 决定后处理怎么写 |
| NMS 位置 | 模型内 / C++ 外部 | YOLO 导出时经常不同 |

还要确认动态维度的含义。ONNX 元数据中可能出现 `-1`，也可能是带名称的符号维度；它表示该维度要到运行时才能确定，并不意味着可以传入任意值。模型中的算子、位置编码或后处理仍可能限制合法范围。

建议加载模型后先打印输入输出：

```text
input name: images
input shape: [1, 3, 640, 640]
input type: float32
output name: output0
output shape: [1, 84, 8400]
```

## 3. 如何构造一个真正可复现的最小闭环？

直接把示例写死为 `best.onnx`，读者并没有这个文件，也不知道它的输入契约。这里先生成一个只有两个算子的模型：

```text
输入 X[1,4] → Mul(2) → Add(1) → 输出 Y[1,4]
```

输入 `[1, 2, 3, 4]` 时，预期输出必须是 `[3, 5, 7, 9]`。它没有图像预处理和复杂后处理，因此非常适合验证模型路径、名称、shape、数据类型、动态库和 C++ API 是否正确。

### 3.1 生成测试模型

运行环境：Python 3.10+，需要安装在项目虚拟环境中的 `onnx`。不要为了这个示例修改全局 Python 环境。

```python
# make_demo_model.py
import onnx
from onnx import TensorProto, checker, helper

x = helper.make_tensor_value_info("X", TensorProto.FLOAT, [1, 4])
y = helper.make_tensor_value_info("Y", TensorProto.FLOAT, [1, 4])

scale = helper.make_tensor("scale", TensorProto.FLOAT, [1], [2.0])
bias = helper.make_tensor("bias", TensorProto.FLOAT, [1], [1.0])

graph = helper.make_graph(
    [
        helper.make_node("Mul", ["X", "scale"], ["scaled"]),
        helper.make_node("Add", ["scaled", "bias"], ["Y"]),
    ],
    "linear_demo",
    [x],
    [y],
    [scale, bias],
)

model = helper.make_model(
    graph,
    producer_name="blog-demo",
    opset_imports=[helper.make_opsetid("", 18)],
)
checker.check_model(model)
onnx.save(model, "demo.onnx")
print("saved demo.onnx")
```

```bash
python make_demo_model.py
```

`checker.check_model` 检查模型是否符合 ONNX 规范，但它仍不验证模型是否满足业务准确率，也不保证某个特定后端支持所有算子。模型来自不可信来源时，还要在隔离环境中检查资源消耗，不能把格式校验等同于安全审计。

如果旧版运行时报告“不支持 IR version 或 opset”，应让导出工具、ONNX opset 和运行时版本形成经过验证的组合，而不是随意改写模型元数据中的版本号。版本号描述的是模型实际使用的规范，手工调小并不会自动把新算子转换成旧语义。

### 3.2 用 ONNX Runtime C++ 校验契约并执行

ONNX Runtime 的加载核心是创建一个 `Ort::Session`：

```text
Ort::Env
    ↓
Ort::SessionOptions
    ↓
设置图优化、线程数、Execution Provider
    ↓
Ort::Session(env, model_path, session_options)
```

```cpp
#include <array>
#include <cstddef>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
#include <onnxruntime_cxx_api.h>

int main() {
    try {
        Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "contract_demo");
        Ort::SessionOptions options;
        options.SetGraphOptimizationLevel(
            GraphOptimizationLevel::ORT_ENABLE_ALL
        );

        // ORT_TSTR 同时兼容 Windows 的宽字符路径和 POSIX 字符路径。
        Ort::Session session(env, ORT_TSTR("demo.onnx"), options);
        if (session.GetInputCount() != 1 || session.GetOutputCount() != 1) {
            throw std::runtime_error("expected exactly one input and one output");
        }

        Ort::AllocatorWithDefaultOptions allocator;
        auto input_name_holder = session.GetInputNameAllocated(0, allocator);
        auto output_name_holder = session.GetOutputNameAllocated(0, allocator);
        const std::string input_name{input_name_holder.get()};
        const std::string output_name{output_name_holder.get()};

        const auto input_info = session.GetInputTypeInfo(0)
                                    .GetTensorTypeAndShapeInfo();
        const auto model_shape = input_info.GetShape();
        const std::vector<int64_t> expected_shape{1, 4};

        if (input_info.GetElementType() !=
            ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT) {
            throw std::runtime_error("input must be float32");
        }
        if (model_shape != expected_shape) {
            throw std::runtime_error("unexpected input shape");
        }

        std::array<float, 4> input_data{1.0f, 2.0f, 3.0f, 4.0f};
        std::array<int64_t, 2> input_shape{1, 4};
        auto memory_info = Ort::MemoryInfo::CreateCpu(
            OrtArenaAllocator,
            OrtMemTypeDefault
        );
        auto input_tensor = Ort::Value::CreateTensor<float>(
            memory_info,
            input_data.data(),
            input_data.size(),
            input_shape.data(),
            input_shape.size()
        );

        const char* input_names[] = {input_name.c_str()};
        const char* output_names[] = {output_name.c_str()};
        auto outputs = session.Run(
            Ort::RunOptions{nullptr},
            input_names,
            &input_tensor,
            1,
            output_names,
            1
        );

        if (outputs.size() != 1 || !outputs[0].IsTensor()) {
            throw std::runtime_error("expected one tensor output");
        }
        const auto output_info = outputs[0].GetTensorTypeAndShapeInfo();
        if (output_info.GetElementType() !=
                ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT ||
            output_info.GetShape() != expected_shape) {
            throw std::runtime_error("unexpected output contract");
        }

        const float* output = outputs[0].GetTensorData<float>();
        std::cout << input_name << " -> " << output_name << ":";
        for (std::size_t i = 0; i < output_info.GetElementCount(); ++i) {
            std::cout << ' ' << output[i];
        }
        std::cout << '\n';
        return 0;
    } catch (const Ort::Exception& error) {
        std::cerr << "ONNX Runtime error: " << error.what() << '\n';
    } catch (const std::exception& error) {
        std::cerr << "contract error: " << error.what() << '\n';
    }
    return 1;
}
```

假设 ONNX Runtime 解压在 `$ORT_ROOT`，Linux/macOS 可按实际目录编译：

```bash
clang++ -std=c++17 -O2 -Wall -Wextra \
  -I"$ORT_ROOT/include" onnx_contract_demo.cpp \
  -L"$ORT_ROOT/lib" -Wl,-rpath,"$ORT_ROOT/lib" \
  -lonnxruntime -o onnx_contract_demo
./onnx_contract_demo
```

预期输出：

```text
X -> Y: 3 5 7 9
```

如果链接器找不到 `libonnxruntime`，先检查下载包的架构是否和编译目标一致；如果程序启动时找不到动态库，检查 rpath 和实际库目录。Windows 需要使用对应的 `.lib/.dll` 与编译器配置，不能直接照搬这条 POSIX 命令。

### 3.3 这段代码真正保护了什么？

`Ort::Env` 持有运行时环境，生命周期必须长于 `Ort::Session`；多个 session 通常可以共享一个 `Env`。`SessionOptions` 只在创建 session 时生效，所以图优化、线程数和 EP 都必须在构造 `Session` 之前配置。

名称持有器由 ONNX Runtime 分配。示例立即把名称复制进 `std::string`，避免后续代码错误保存已经失效的裸指针。随后先验证输入数量、`float32` 类型和 `[1,4]` shape，最后才创建张量。真正修复“加载成功但输入错误”的不是 `Run()`，而是 **在 `Run()` 之前把运行时元数据与应用预期逐项比对**。

对动态 shape，不能直接拿模型中的 `-1` 创建张量。应用应根据本次请求构造全为正数的实际 shape，并检查元素个数是否等于缓冲区长度。真实视觉模型还要把颜色顺序、归一化参数、resize/letterbox 规则和输出语义纳入同一份契约。

## 4. ONNX Runtime 的优化为什么不能修复错误输入？

### 4.1 图优化：等价改写，不是精度转换

ONNX Runtime 创建 `Session` 时会做图优化。图优化不是量化，它不会把 FP32 模型自动变成 INT8，而是对计算图做等价改写。

常见优化级别：

| 级别 | 含义 | 典型优化 |
| --- | --- | --- |
| `ORT_DISABLE_ALL` | 关闭优化 | 调试数值问题时可用 |
| `ORT_ENABLE_BASIC` | 基础优化 | 常量折叠、删除 Identity/Dropout、简单算子融合 |
| `ORT_ENABLE_EXTENDED` | 基础 + 扩展优化 | 更多算子融合，通常和 EP 支持有关 |
| `ORT_ENABLE_ALL` | 开启全部优化 | 包含 layout 类优化，通常追求性能时使用 |

常见写法：

```cpp
Ort::SessionOptions options;
options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
```

虽然官方文档说明默认会启用优化，但工程里建议显式写出，便于阅读和排查。

### 4.2 线程数：更多不等于更快

CPU 推理经常要调线程数，不是线程越多越快。

```cpp
Ort::SessionOptions options;

// 单个算子内部的并行度，例如 Conv / MatMul 内部并行。
options.SetIntraOpNumThreads(4);

// 多个算子之间的并行度；只在并行图执行模式下生效。
options.SetExecutionMode(ExecutionMode::ORT_PARALLEL);
options.SetInterOpNumThreads(1);
```

建议测试组合：

| 场景 | 起步配置 |
| --- | --- |
| 单路实时视频，batch=1 | 先测试默认值，再小范围测试 `intra=1/2/4/...` |
| 多路视频，每路一个 session | 每个 session 少给线程，避免互相抢 |
| 图中有独立分支且启用 `ORT_PARALLEL` | 再对比 `inter=1/2/4` |

性能测试时要分开统计：

```text
preprocess time
inference time
postprocess time
end-to-end time
```

只看 `session.Run()` 会忽略预处理、NMS、绘制和数据拷贝。

默认的顺序执行模式（`ORT_SEQUENTIAL`）不会使用 inter-op 线程池，只设置 `SetInterOpNumThreads` 不会产生预期效果。并行图执行也不是必然更快：多数 CNN 算子内部已经并行，额外并发可能带来调度和缓存竞争。线程配置必须结合物理核心、进程内 session 数量以及请求并发度实测。

### 4.3 Execution Provider：警惕“静默回退”

Execution Provider，简称 EP，决定节点交给哪个后端执行。

常见 EP：

| EP | 适用硬件 | 说明 |
| --- | --- | --- |
| CPU EP | 通用 CPU | 默认可用，跨平台最稳 |
| CUDA EP | NVIDIA GPU | 通用 GPU 推理 |
| TensorRT EP | NVIDIA GPU | 编译成本更高，性能可能更好 |
| OpenVINO EP | Intel CPU/GPU/NPU | 在 ORT 里调用 OpenVINO 后端 |
| DirectML EP | Windows GPU | Windows 生态常见 |

CPU EP 不需要额外 append。其他 EP 需要安装带对应 EP 的 ONNX Runtime，并在创建 session 前配置。

伪代码结构：

```cpp
Ort::SessionOptions options;
options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);

// CUDA / TensorRT / OpenVINO EP 的具体 API 和 ORT 版本、构建方式有关。
// 原则是：先 append EP，再创建 Ort::Session。

Ort::Session session(env, model_path, options);
```

选择 EP 的经验：

- 先用 CPU EP 跑通输入输出和数值。
- 再切 CUDA / TensorRT / OpenVINO 等加速后端。
- EP 按优先级选择可执行子图；保留 CPU EP 作为后备时，部分节点可能回退到 CPU。程序能跑不代表整个模型都在 GPU 上。
- 每切一次 EP，都查看运行时日志或 profiling，并重新对比输出数值和性能。
- 不要只看平均耗时，至少看 p50、p95、p99。

### 4.4 离线优化模型：为什么不能随意跨环境复制？

如果不想每次启动都重复做一部分图优化，可以让 ONNX Runtime 创建 session 时把优化后的模型保存出来。

```cpp
Ort::SessionOptions options;
options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
options.SetOptimizedModelFilePath(ORT_TSTR("best.ort_optimized.onnx"));

Ort::Session session(env, ORT_TSTR("best.onnx"), options);
```

注意：

- 不要覆盖原始 `best.onnx`。
- 扩展和布局优化可能与 EP、硬件及 ORT 版本相关；不要未经验证就把优化产物复制到另一套环境。
- 排查问题时保留原始模型，方便对比。
- 如果使用 TensorRT 等会编译 engine 的 EP，还要单独考虑该 EP 自己的 cache。

### 4.5 Python 侧如何快速检查？

Python 适合先建立黄金输出，再和 C++ 对齐：

```python
import onnx
import numpy as np
import onnxruntime as ort

model = onnx.load("demo.onnx")
onnx.checker.check_model(model)

requested_provider = "CPUExecutionProvider"
if requested_provider not in ort.get_available_providers():
    raise RuntimeError(f"provider unavailable: {requested_provider}")

session = ort.InferenceSession(
    "demo.onnx",
    providers=[requested_provider],
)
for item in session.get_inputs():
    print("input:", item.name, item.type, item.shape)
for item in session.get_outputs():
    print("output:", item.name, item.type, item.shape)
print("active providers:", session.get_providers())

x = np.array([[1, 2, 3, 4]], dtype=np.float32)
y = session.run(["Y"], {"X": x})[0]
np.testing.assert_allclose(y, [[3, 5, 7, 9]], rtol=0, atol=1e-6)
print(y)
```

`get_available_providers()` 反映当前安装包真正包含的 EP。仅仅在配置里写了 CUDA 并不能证明 CUDA EP 已安装或成功接管节点；还要检查 session 的活动 provider、日志与 profiling。

需要研究离线图优化时，可以另存优化产物：

```python
import onnxruntime as ort

options = ort.SessionOptions()
options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
options.optimized_model_filepath = "best.ort_optimized.onnx"

session = ort.InferenceSession(
    "best.onnx",
    sess_options=options,
    providers=["CPUExecutionProvider"],
)
```

不要让生成优化模型的步骤覆盖正确性测试。应先对原始模型建立黄金输出，再验证优化模型在约定容差内保持一致。

## 5. 如何用 OpenVINO 跑同一份模型？

OpenVINO 的核心流程：

```text
ov::Core
    ↓
read_model 读取 ONNX / IR
    ↓
可选：reshape 成静态输入
    ↓
compile_model 编译到 CPU / GPU / NPU / AUTO
    ↓
create_infer_request
    ↓
set_tensor + infer + get_output_tensor
```

OpenVINO 的关键点是 `compile_model`。模型不是读进来就直接跑，而是要编译成目标设备上的可执行图。这个阶段会做图变换、算子选择、低精度相关优化、内存规划等。

本文示例以 OpenVINO 2026.2 为参照。该系列的 CPU 插件要求 AVX2，且不再支持 macOS x86；GPU/NPU 是否可用还取决于具体硬件与驱动。部署到旧机器之前必须先核对对应版本的系统要求，不能只看代码能否编译。

### 5.1 C++ 直接加载 ONNX

```cpp
#include <array>
#include <cstddef>
#include <iostream>
#include <stdexcept>
#include <openvino/openvino.hpp>

int main() {
    try {
        ov::Core core;
        core.set_property(ov::cache_dir("./ov_cache"));

        auto model = core.read_model("demo.onnx");
        if (model->inputs().size() != 1 || model->outputs().size() != 1) {
            throw std::runtime_error("expected one input and one output");
        }

        auto compiled_model = core.compile_model(
            model,
            "CPU",
            ov::hint::performance_mode(ov::hint::PerformanceMode::LATENCY)
        );
        const ov::Shape expected_shape{1, 4};
        if (compiled_model.input().get_element_type() != ov::element::f32 ||
            compiled_model.input().get_shape() != expected_shape) {
            throw std::runtime_error("unexpected input contract");
        }

        std::array<float, 4> input_data{1.0f, 2.0f, 3.0f, 4.0f};
        ov::Tensor input_tensor(
            ov::element::f32,
            expected_shape,
            input_data.data()
        );

        auto request = compiled_model.create_infer_request();
        request.set_input_tensor(input_tensor);
        request.infer();  // 同步调用；返回时本次推理已经完成。

        const ov::Tensor output = request.get_output_tensor();
        if (output.get_element_type() != ov::element::f32 ||
            output.get_shape() != expected_shape) {
            throw std::runtime_error("unexpected output contract");
        }

        const float* values = output.data<const float>();
        std::cout << compiled_model.input().get_any_name() << " -> "
                  << compiled_model.output().get_any_name() << ':';
        for (std::size_t i = 0; i < output.get_size(); ++i) {
            std::cout << ' ' << values[i];
        }
        std::cout << '\n';
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "OpenVINO error: " << error.what() << '\n';
        return 1;
    }
}
```

最小 `CMakeLists.txt`：

```cmake
cmake_minimum_required(VERSION 3.16)
project(openvino_contract_demo LANGUAGES CXX)

find_package(OpenVINO REQUIRED COMPONENTS Runtime)

add_executable(openvino_contract_demo openvino_contract_demo.cpp)
target_compile_features(openvino_contract_demo PRIVATE cxx_std_17)
target_link_libraries(openvino_contract_demo PRIVATE openvino::runtime)
```

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j2
./build/openvino_contract_demo
```

预期输出同样是 `X -> Y: 3 5 7 9`。如果 `find_package` 失败，应按 OpenVINO 安装方式设置其提供的环境或 `OpenVINO_DIR`，不要把某台机器上的绝对路径写进项目。

### 5.2 `read_model`、`compile_model` 和 `infer` 分别做了什么？

`read_model` 把 ONNX 或 IR 读取为与设备无关的 `ov::Model`，此时适合检查端口、调整 shape 或嵌入预后处理。`compile_model` 才会针对 `CPU`、`GPU`、`NPU` 或 `AUTO` 做设备相关编译，并返回 `ov::CompiledModel`。`create_infer_request` 创建一次执行所需的状态，`infer()` 是阻塞调用；需要并发时，应使用多个 infer request 或异步 API，而不是让多个线程无保护地共享一个 request。

示例中的 `ov::Tensor` 直接引用 `input_data` 的外部内存，没有复制。因此数组必须一直存活到同步 `infer()` 返回；改为异步推理后，它必须存活到请求完成。若希望张量自己持有内存，可以先按类型和 shape 构造张量，再把数据复制进去。

也可以用 `core.compile_model("demo.onnx", "CPU")` 直接从路径编译。只有在需要 `reshape` 或其他模型级变换时才必须显式调用 `read_model`；两种路径都应通过实测判断启动时间和缓存效果，不要仅凭调用形式推断性能。

### 5.3 Python 直接加载 ONNX

Python 侧可以快速验证 OpenVINO 是否能加载同一个 ONNX：

```python
import numpy as np
import openvino as ov

core = ov.Core()
core.set_property({"CACHE_DIR": "./ov_cache"})

model = core.read_model("demo.onnx")

compiled_model = core.compile_model(model, "CPU")
infer_request = compiled_model.create_infer_request()

input_data = np.array([[1, 2, 3, 4]], dtype=np.float32)
result = infer_request.infer({compiled_model.input(0): input_data})

output = result[compiled_model.output(0)]
np.testing.assert_allclose(output, [[3, 5, 7, 9]], rtol=0, atol=1e-6)
print(output)
```

这段 Python 代码不仅打印 shape，还用明确的容差断言数值。工程回归测试也应如此：比较完整输出或稳定摘要，而不是只验证“没有抛异常”。

## 6. OpenVINO 的编译与优化发生在哪里？

OpenVINO 的优化主要发生在这些位置：

```text
ONNX / IR
    ↓
read_model
    ↓
模型级变换：形状推导、常量折叠、算子融合
    ↓
compile_model
    ↓
设备级优化：CPU/GPU/NPU kernel 选择、精度策略、线程/stream、内存规划
    ↓
infer_request
```

### 6.1 ONNX 直接加载 vs 转 OpenVINO IR

OpenVINO 可以直接读取 ONNX：

```cpp
auto model = core.read_model("best.onnx");
auto compiled_model = core.compile_model(model, "CPU");
```

也可以先离线转换成 OpenVINO IR：

```text
best.xml
best.bin
```

两种方式的区别：

| 方式 | 优点 | 缺点 |
| --- | --- | --- |
| 直接加载 ONNX | 简单，方便和 ONNX Runtime 对比同一个模型 | 首次加载可能包含转换和编译成本 |
| 离线转 IR | 启动更稳定，部署依赖更少，方便 FP16 权重压缩 | 多一个转换步骤，需要管理 `.xml/.bin` |

如果只是 benchmark ONNX Runtime 和 OpenVINO，同一个 `best.onnx` 都直接加载，比较更干净。

如果是正式部署，建议测试：

```text
best.onnx 直接加载
best.xml / best.bin 加载
开启 cache
不开启 cache
```

### 6.2 Python 转 OpenVINO IR

```python
from pathlib import Path
import openvino as ov

model_path = Path("best.onnx")
output_path = Path("best_openvino.xml")

model = ov.convert_model(str(model_path))

# compress_to_fp16=True 会把权重压缩到 FP16，通常可减少模型体积。
# 如果要严格保留 FP32 权重，可设置 compress_to_fp16=False。
ov.save_model(model, str(output_path), compress_to_fp16=True)
```

生成文件：

```text
best_openvino.xml
best_openvino.bin
```

C++ 加载 IR：

```cpp
ov::Core core;
auto model = core.read_model("best_openvino.xml");
auto compiled_model = core.compile_model(model, "CPU");
```

这里的 `compress_to_fp16=True` 主要压缩可压缩的浮点权重，不等于强制所有算子都以 FP16 计算。最终执行精度由设备能力、插件策略和编译属性共同决定，仍要用目标硬件检查精度与耗时。

### 6.3 固定输入形状

动态 shape 更灵活，但固定 shape 往往更利于推理优化。

如果实际部署一直是 `1x3x640x640`：

```cpp
auto model = core.read_model("best.onnx");
model->reshape(ov::Shape{1, 3, 640, 640});
auto compiled_model = core.compile_model(model, "CPU");
```

Python：

```python
model = core.read_model("best.onnx")
model.reshape([1, 3, 640, 640])
compiled_model = core.compile_model(model, "CPU")
```

经验：

- 实时视频检测通常 batch 固定为 1。
- 输入分辨率固定时，不要保留无意义的动态维度。
- 如果确实需要多分辨率，先测试动态 shape 的首次推理和后续推理耗时。

### 6.4 性能提示：LATENCY 和 THROUGHPUT

OpenVINO 推荐优先使用高层 performance hint，而不是一上来手动调很多底层参数。

低延迟模式：

```cpp
auto compiled_model = core.compile_model(
    model,
    "CPU",
    ov::hint::performance_mode(ov::hint::PerformanceMode::LATENCY)
);
```

高吞吐模式：

```cpp
auto compiled_model = core.compile_model(
    model,
    "CPU",
    ov::hint::performance_mode(ov::hint::PerformanceMode::THROUGHPUT)
);
```

区别：

| 模式 | 目标 | 适合 |
| --- | --- | --- |
| `LATENCY` | 单次请求尽快返回 | 摄像头实时检测、交互式应用 |
| `THROUGHPUT` | 单位时间处理更多请求 | 多路视频、批处理、服务端推理 |

注意：

- `THROUGHPUT` 可能增加加载时间和内存使用。
- 单路视频不一定适合 `THROUGHPUT`。
- 多路视频可以测试多个 infer request 或异步推理。

### 6.5 模型编译缓存

OpenVINO 的 `compile_model` 可能比较耗时，特别是 GPU/NPU 或复杂模型。可以启用模型 cache：

```cpp
ov::Core core;
core.set_property(ov::cache_dir("./ov_cache"));

auto compiled_model = core.compile_model("best.onnx", "CPU");
```

效果：

```text
第一次启动：
    读取模型 → 编译模型 → 写入 cache → 推理

第二次启动：
    命中 cache → 跳过部分耗时编译步骤 → 更快进入推理
```

注意：

- cache 目录要可读写。
- 模型文件、OpenVINO 版本、设备、编译参数变化后，缓存可能失效。
- 不要把 cache 当作原始模型的替代品。

### 6.6 精度优化

OpenVINO 的常见精度路径：

| 精度 | 说明 |
| --- | --- |
| FP32 | 最稳，便于对齐原始模型 |
| FP16 / BF16 | 常用于减少带宽和提升吞吐，是否加速取决于硬件 |
| INT8 | 需要量化和校准，性能收益依赖模型结构和硬件支持 |

示例：保存 IR 时压缩权重到 FP16：

```python
import openvino as ov

model = ov.convert_model("best.onnx")
ov.save_model(model, "best_fp16.xml", compress_to_fp16=True)
```

示例：CPU 编译时给推理精度提示：

```cpp
auto compiled_model = core.compile_model(
    model,
    "CPU",
    ov::hint::inference_precision(ov::element::bf16)
);
```

精度优化原则：

- 先用 FP32 跑通并对齐结果。
- 再尝试 FP16 / BF16 / INT8。
- 每次改精度都要做准确率和数值对比。
- 模型变小不等于一定变快，尤其是 INT8，如果硬件 kernel 不匹配，可能只省体积不省时间。

### 6.7 用 benchmark_app 做基准测试

OpenVINO 自带 `benchmark_app`，适合先测纯模型推理性能。

低延迟：

```bash
benchmark_app -m best.onnx -d CPU -hint latency -shape "[1,3,640,640]"
```

高吞吐：

```bash
benchmark_app -m best.onnx -d CPU -hint throughput -shape "[1,3,640,640]"
```

测试 IR：

```bash
benchmark_app -m best_openvino.xml -d CPU -hint latency
```

但要记住：

```text
benchmark_app 测的是模型推理为主
真实程序还包括：
    解码
    resize / letterbox
    BGR/RGB 转换
    HWC/NCHW 转换
    NMS
    绘制
    视频读写
```

所以正式报告里应该同时给：

```text
model inference latency
end-to-end latency
FPS
p50 / p95 / p99
```

## 7. 从最小示例走向工程封装

如果一个 C++ 项目里同时支持 ONNX Runtime 和 OpenVINO，可以抽象成同一个推理接口，但不要为了抽象牺牲可读性。

配置示例：

```yaml
model_path: ./deploy/best.onnx
model_backend: openvino
openvino_device: CPU
input_width: 640
input_height: 640
```

后端选择逻辑：

```cpp
if (config.model_backend == "onnxruntime") {
    loadOnnxRuntime(config);
} else if (config.model_backend == "openvino") {
    loadOpenVINO(config);
} else {
    throw std::runtime_error("unsupported model backend");
}
```

ONNX Runtime 加载：

```cpp
void loadOnnxRuntime(const Config& config) {
    session_options_.SetGraphOptimizationLevel(
        GraphOptimizationLevel::ORT_ENABLE_ALL
    );
    session_options_.SetIntraOpNumThreads(config.num_threads);

    const std::filesystem::path model_path{config.model_path};
    ort_session_ = std::make_unique<Ort::Session>(
        ort_env_,
        model_path.c_str(),
        session_options_
    );
}
```

这里使用 `std::filesystem::path`，使 `.c_str()` 在 Windows 上提供宽字符路径、在 POSIX 平台提供窄字符路径。完整源文件需要包含 `<filesystem>`。如果项目只支持明确的平台，也可以使用该平台对应的 `ORTCHAR_T` 路径，但不要用强制类型转换掩盖编码问题。

OpenVINO 加载：

```cpp
void loadOpenVINO(const Config& config) {
    ov_core_.set_property(ov::cache_dir(config.openvino_cache_dir));

    auto model = ov_core_.read_model(config.model_path);
    model->reshape(ov::Shape{1, 3, config.input_height, config.input_width});

    ov_compiled_model_ = ov_core_.compile_model(
        model,
        config.openvino_device,
        ov::hint::performance_mode(ov::hint::PerformanceMode::LATENCY)
    );

    ov_infer_request_ = ov_compiled_model_.create_infer_request();
}
```

统一推理时，两边都接收同一种预处理结果：

```cpp
struct ModelInput {
    std::vector<float> values;
    std::array<int64_t, 4> shape;  // {1, 3, H, W}
};
```

统一结构只是建立了共同入口，还必须在入口处验证 `values.size()` 是否等于 shape 各维乘积，并让两个后端读取同一块已经完成预处理的缓冲区。这样才有机会保证：

```text
同一张图
同一套预处理
同一个 ONNX 模型
分别送入 ONNX Runtime / OpenVINO
再比较输出和耗时
```

服务端还要区分“已编译模型”和“单次请求状态”。OpenVINO 的 `InferRequest` 保存输入、输出和执行状态，并发请求不应无保护地共享上面那个 `ov_infer_request_`；应按并发度创建 request 池或使用异步队列。ONNX Runtime 侧也要避免多个请求共享可变输入/输出缓冲区。先把并发模型说明白，再决定 session、request 和张量分别由谁持有。

## 8. 一组 Benchmark 结果应该怎样解读？

原笔记保留了下面一组同一 `best.onnx` 在 ONNX Runtime 和 OpenVINO CPU 后端上的测量结果。由于没有同时记录 CPU 型号、运行时版本、线程配置、样本数、预热次数和系统负载，它只能示范“怎样读一张性能表”，不能作为可复现的后端性能结论。正式报告必须把这些环境信息与原始样本一起保存。

| 指标 | ONNX Runtime | OpenVINO | OpenVINO 相对变化 |
| --- | ---: | ---: | ---: |
| 视频整体 FPS | 3.123 | 5.181 | 1.659x |
| 总处理耗时 | 9606.156 ms | 5799.160 ms | 降低 39.6% |
| 模型推理总耗时 | 8915.298 ms | 4750.263 ms | 1.877x |
| 模型推理 p50 | 297.331 ms | 157.688 ms | 1.886x |
| 模型推理 p95 | 331.805 ms | 225.667 ms | 1.470x |
| 模型推理 p99 | 346.464 ms | 261.163 ms | 1.327x |
| 端到端 p50 | 315.151 ms | 183.540 ms | 1.717x |

解读：

- 在这一次历史测量中，OpenVINO 更快，模型推理 p50 接近 1.9 倍提升；结论只适用于当时未完整记录的环境。
- p95 / p99 的相对提升小于 p50，只能说明两组延迟分布并非等比例缩放。没有逐请求时间线和计时边界，不能进一步断言原因。
- 总处理耗时下降 39.6%，但没有达到模型推理 1.877 倍的完整收益，说明端到端里还有预处理、后处理和视频读写成本。
- 如果继续优化，应该先看耗时拆分，而不是只继续换后端。

下一步可测试：

```text
1. OpenVINO ONNX 直接加载 + cache
2. OpenVINO IR 加载 + cache
3. LATENCY / THROUGHPUT 两种 hint
4. 固定线程数 vs 默认线程数
5. FP32 / FP16 / BF16 / INT8 精度路径
```

## 9. 常见误区与排查方法

### 9.1 ONNX Runtime 能加载，OpenVINO 加载失败

可能原因：

- ONNX 里有 OpenVINO 暂不支持或支持不完整的算子。
- 动态 shape 太复杂。
- 导出 ONNX 的 opset 版本不合适。
- 模型里包含自定义算子。

处理顺序：

```text
1. 用 onnx.checker 检查模型
2. 固定输入 shape 后再试
3. 用 OpenVINO Python 先 convert_model
4. 查看失败算子
5. 必要时重新导出 ONNX，降低或调整 opset
```

### 9.2 推理结果不一致

优先检查：

```text
BGR / RGB
NCHW / NHWC
是否除以 255
是否减均值除方差
letterbox padding 是否一致
输出是否已经包含 NMS
score 阈值和 NMS 阈值是否一致
```

对齐方法：

```text
同一张图片
保存预处理后的 input tensor
Python ORT 跑一次
C++ ORT 跑一次
OpenVINO 跑一次
逐层或至少逐输出比较 max abs diff
```

### 9.3 模型变小了但没有变快

常见于 FP16 / INT8：

- 权重变小只代表磁盘和内存占用下降。
- 是否加速取决于硬件是否有对应快速 kernel。
- INT8 如果量化节点和后端 kernel 不匹配，可能出现反量化开销。
- batch=1 小模型有时瓶颈不在计算，而在内存访问、预处理或后处理。

### 9.4 OpenVINO 首次启动慢

这是正常现象，原因是 `compile_model` 做了设备相关编译。

优化方式：

```cpp
ov::Core core;
core.set_property(ov::cache_dir("./ov_cache"));
auto compiled_model = core.compile_model("best.onnx", "CPU");
```

也可以离线转 IR：

```python
import openvino as ov

model = ov.convert_model("best.onnx")
ov.save_model(model, "best_openvino.xml", compress_to_fp16=True)
```

## 10. 什么时候该用哪个后端？

ONNX Runtime 更适合跨平台、需要 CUDA/TensorRT/DirectML 等多种硬件后端，或希望尽量保留统一 ONNX 部署入口的项目。OpenVINO 更适合明确部署在受支持的 Intel 平台，并愿意针对 CPU、GPU、NPU 的编译、缓存和性能提示做验证的项目。

如果模型只在训练框架里离线运行，或团队尚未固定预处理与输出契约，过早引入多个推理后端只会扩大排查面。先用一个后端建立“同一输入得到同一输出”的黄金样例，再增加第二个后端做性能比较。

## 11. 上线前检查清单

加载阶段：

- [ ] 模型路径正确，文件没有被误覆盖。
- [ ] 打印并记录输入输出 name、shape、dtype。
- [ ] 动态 shape 已按部署场景固定或正确处理。
- [ ] ONNX Runtime 显式设置图优化级别。
- [ ] CPU 线程数经过小范围测试。
- [ ] OpenVINO 明确指定设备，例如 `CPU`、`GPU`、`NPU` 或 `AUTO`。
- [ ] OpenVINO 根据场景设置 `LATENCY` 或 `THROUGHPUT`。
- [ ] OpenVINO 正式部署时启用 cache。

数值阶段：

- [ ] 同一张图片在 Python 和 C++ 侧预处理结果一致。
- [ ] ONNX Runtime 和 OpenVINO 输出数值在可接受范围内。
- [ ] 后处理、阈值、NMS 和坐标回映射一致。

性能阶段：

- [ ] 单独统计预处理、推理、后处理、端到端耗时。
- [ ] 至少报告 p50、p95、p99，而不是只看平均值。
- [ ] benchmark_app 结果和真实程序结果分开看。
- [ ] 不同后端使用同一输入、同一模型和同一测试口径。

## 12. 总结：先证明结果正确，再证明它足够快

回到开头，模型加载成功却输出错误，通常不是“模型玄学”，而是应用和模型对输入输出的理解不一致。最可靠的处理方式不是立即换后端，而是把问题拆开：

1. 用可预测的小模型验证运行时、链接和张量 API。
2. 从运行时读取 name、shape、dtype，并与应用契约显式比对。
3. 固定同一份预处理张量，逐一比较 Python、C++ 和不同后端的输出误差。
4. 正确性对齐后，再分别测预处理、推理、后处理与端到端尾延迟。
5. 图优化、FP16、INT8、线程和缓存都是性能工具，不能替代契约校验。

可以直接落地的一条建议是：为每个上线模型保存一份固定输入张量、预期输出摘要和允许误差，把它加入部署侧回归测试。这样升级 ONNX Runtime、OpenVINO、驱动或模型时，不必等到业务结果异常才发现契约已经漂移。

## 13. 参考资料

- ONNX Runtime C++ API: https://onnxruntime.ai/docs/get-started/with-cpp.html
- ONNX Runtime Graph Optimizations: https://onnxruntime.ai/docs/performance/model-optimizations/graph-optimizations.html
- ONNX Runtime Execution Providers: https://onnxruntime.ai/docs/execution-providers/
- OpenVINO 2026 Release Notes: https://docs.openvino.ai/2026/about-openvino/release-notes-openvino.html
- OpenVINO C++ Runtime API: https://docs.openvino.ai/2026/api/c_cpp_api/group__ov__runtime__cpp__api.html
- OpenVINO Performance Hints: https://docs.openvino.ai/2026/openvino-workflow/running-inference/optimize-inference/high-level-performance-hints.html
- OpenVINO Model Caching: https://docs.openvino.ai/2026/openvino-workflow/running-inference/optimize-inference/optimizing-latency/model-caching-overview.html
- Convert to OpenVINO IR: https://docs.openvino.ai/2026/openvino-workflow/model-preparation/convert-model-to-ir.html
