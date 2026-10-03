---
title: "把循环搬到 GPU 就会更快吗？从向量加法讲清 CUDA 的真实成本"
date: 2026-07-13 11:19:18
updated: 2026-07-13 11:19:18
categories:
  - "学习"
  - "高性能 C++ 并行编程"
permalink: /notes/高性能c-并行编程/11-cuda开启的gpu编程/
series: "高性能 C++ 并行编程"
series_order: 11
---

时间：2025/12/26

CPU 上的一段循环很容易改写成 CUDA kernel：

```cuda
__global__ void add(const float* a, const float* b, float* c, int n) {
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        c[i] = a[i] + b[i];
    }
}
```

但只有这几行远远不够。输入通常先在主机内存中，需要传到设备；kernel launch 对 CPU 通常是异步的，错误可能延迟到同步点才出现；数据量太小时，传输与启动开销甚至比计算更贵。

GPU 擅长的是“大量相似、彼此独立且计算密度足够高”的工作，不是任何带 `for` 的代码。本文从完整向量加法出发，把线程索引、显存生命周期、错误检查、同步和性能测量串成一条可执行路径，再讨论共享内存、原子与 streams 在什么条件下才有价值。

> 本文使用 NVIDIA CUDA C++。代码需要受支持的 NVIDIA GPU、驱动和 CUDA Toolkit；当前笔记所在的 macOS 环境没有检测到 `nvcc`，因此示例无法在本机编译运行，不能把静态审查当作实机验证。

## 1. 一次 GPU 计算究竟经过哪些阶段？

经典离散显存流程不是“调用一个函数”，而是一条数据管线：

```text
CPU 初始化输入
      │
      ├── H2D：主机 → 设备
      │
      ├── launch kernel（CPU 提交，GPU 执行）
      │
      ├── synchronize / dependency
      │
      └── D2H：设备 → 主机
              ↓
          CPU 校验结果
```

总耗时近似由传输、启动、排队、计算、同步和结果处理共同组成。若 kernel 只做一次加法，算术强度很低，往往更接近内存带宽问题。只有输入已经常驻 GPU、连续执行多个内核，或数据规模足以摊薄固定成本时，GPU 才更可能展示优势。

因此，比较 CPU 与 GPU 时至少要明确两种口径：

| 口径 | 包含内容 | 适合回答的问题 |
|---|---|---|
| kernel-only | 设备端 kernel 时间 | 内核实现是否高效 |
| end-to-end | 分配、H2D、kernel、D2H、同步 | 整个功能是否值得上 GPU |

只报告 kernel-only 时间，却让真实应用每次都来回传数据，会高估端到端收益。

## 2. CUDA 如何把工作映射到线程？

CUDA 启动配置由 grid（网格）和 block（线程块）组成。kernel 内可使用：

- `threadIdx.{x,y,z}`：线程在线程块中的坐标；
- `blockIdx.{x,y,z}`：线程块在网格中的坐标；
- `blockDim.{x,y,z}`：线程块各维大小；
- `gridDim.{x,y,z}`：网格各维块数。

一维数组最常见的全局索引是：

```cuda
const std::size_t index =
    static_cast<std::size_t>(blockIdx.x) * blockDim.x + threadIdx.x;
```

kernel 启动语法为：

```cuda
kernel<<<grid, block, dynamic_shared_bytes, stream>>>(arguments...);
```

省略后两个配置时使用零字节动态共享内存和默认流。block 大小受设备限制，选择 128、256 等常见值只是起点，不是跨 kernel 的最佳常量；寄存器、共享内存、占用率和访存模式都会影响结果。

### 为什么常用 grid-stride loop？

让一个线程按整个网格的总线程数继续处理后续元素，可覆盖任意数据规模，并允许 grid 大小独立于 `n`：

```cuda
for (std::size_t i = global_index;
     i < count;
     i += static_cast<std::size_t>(blockDim.x) * gridDim.x) {
    output[i] = input[i];
}
```

这不是自动优化保证。grid 太小会并行度不足，太大可能增加调度开销；仍要根据设备属性和 profiler 调整。

## 3. 如何写出一个完整、可检查的向量加法？

下面的 `.cu` 文件使用 C++17。`DeviceBuffer` 用 RAII 管理 `cudaMalloc`/`cudaFree`，避免异常路径漏掉设备内存；错误检查函数把 CUDA 状态转换为带调用位置的 C++ 异常。

```cuda
#include <cuda_runtime.h>

#include <cstddef>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

void check_cuda(
    cudaError_t status,
    const char* expression,
    const char* file,
    int line) {
    if (status != cudaSuccess) {
        throw std::runtime_error(
            std::string(file) + ":" + std::to_string(line) +
            " " + expression + ": " + cudaGetErrorString(status));
    }
}

#define CUDA_CHECK(expression) \
    check_cuda((expression), #expression, __FILE__, __LINE__)

template <class T>
class DeviceBuffer {
public:
    explicit DeviceBuffer(std::size_t count) : count_(count) {
        CUDA_CHECK(cudaMalloc(
            reinterpret_cast<void**>(&data_),
            count_ * sizeof(T)));
    }

    ~DeviceBuffer() {
        if (data_ != nullptr) {
            cudaFree(data_);
        }
    }

    DeviceBuffer(const DeviceBuffer&) = delete;
    DeviceBuffer& operator=(const DeviceBuffer&) = delete;

    T* data() noexcept { return data_; }
    const T* data() const noexcept { return data_; }
    std::size_t bytes() const noexcept { return count_ * sizeof(T); }

private:
    T* data_ = nullptr;
    std::size_t count_ = 0;
};

__global__ void vector_add(
    const float* left,
    const float* right,
    float* output,
    std::size_t count) {
    const std::size_t start =
        static_cast<std::size_t>(blockIdx.x) * blockDim.x +
        threadIdx.x;
    const std::size_t stride =
        static_cast<std::size_t>(blockDim.x) * gridDim.x;

    for (std::size_t i = start; i < count; i += stride) {
        output[i] = left[i] + right[i];
    }
}

int main() {
    try {
        constexpr std::size_t count = 1U << 20;
        std::vector<float> left(count);
        std::vector<float> right(count, 2.0F);
        std::vector<float> output(count);

        for (std::size_t i = 0; i < count; ++i) {
            left[i] = static_cast<float>(i) * 0.5F;
        }

        DeviceBuffer<float> device_left(count);
        DeviceBuffer<float> device_right(count);
        DeviceBuffer<float> device_output(count);

        CUDA_CHECK(cudaMemcpy(
            device_left.data(), left.data(), device_left.bytes(),
            cudaMemcpyHostToDevice));
        CUDA_CHECK(cudaMemcpy(
            device_right.data(), right.data(), device_right.bytes(),
            cudaMemcpyHostToDevice));

        constexpr unsigned threads_per_block = 256;
        const unsigned blocks = static_cast<unsigned>(
            (count + threads_per_block - 1) / threads_per_block);

        vector_add<<<blocks, threads_per_block>>>(
            device_left.data(),
            device_right.data(),
            device_output.data(),
            count);

        CUDA_CHECK(cudaGetLastError());
        CUDA_CHECK(cudaDeviceSynchronize());

        CUDA_CHECK(cudaMemcpy(
            output.data(), device_output.data(), device_output.bytes(),
            cudaMemcpyDeviceToHost));

        for (std::size_t i = 0; i < count; ++i) {
            const float expected = left[i] + right[i];
            if (output[i] != expected) {
                throw std::runtime_error(
                    "result mismatch at index " + std::to_string(i));
            }
        }

        std::cout << std::setprecision(10)
                  << "output[0] = " << output.front() << '\n'
                  << "output[last] = " << output.back() << '\n';
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
```

预期输出：

```text
output[0] = 2
output[last] = 524289.5
```

最后一个值为 `(2^20 - 1) × 0.5 + 2 = 524289.5`。示例输入都是该范围内可精确表示的二进制半整数，因此逐项使用相等比较成立；一般浮点算法应根据数值误差要求使用绝对误差、相对误差或 ULP 等合适标准，不能照搬这里的精确比较。

## 4. 怎样用 CMake 构建，而不锁死 GPU 架构？

最小 CMake 配置不需要为单个 `.cu` 文件开启 separable compilation：

```cmake
cmake_minimum_required(VERSION 3.24)
project(cuda_vector_add LANGUAGES CXX CUDA)

add_executable(cuda_vector_add main.cu)
set_target_properties(cuda_vector_add PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    CUDA_STANDARD 17
    CUDA_STANDARD_REQUIRED ON
)
```

在构建机就是运行目标、且 CMake 能检测其 NVIDIA GPU 时，可使用 `native`：

```bash
cmake -S . -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CUDA_ARCHITECTURES=native
cmake --build build --config Release
./build/cuda_vector_add
```

`native` 需要 CMake 3.24 及以上。交叉编译或需要发布到多代 GPU 时，应由项目明确列出目标计算能力，而不是复制示例中的某个数字。CMake 的 `CUDA_ARCHITECTURES` 属性自 3.18 引入，默认值会随编译器和版本变化，官方建议显式覆盖。

只有设备函数跨翻译单元调用、需要 device link 等场景才设置 `CUDA_SEPARABLE_COMPILATION ON`。实验性编译选项如 extended lambda 也应按实际代码需要添加，不要作为所有 CUDA 项目的默认模板。

## 5. 为什么 kernel 启动后要检查两次错误？

CUDA kernel launch 对主机线程通常是异步的。下面两步检查不同阶段：

```cuda
vector_add<<<blocks, threads>>>(...);
CUDA_CHECK(cudaGetLastError());      // 检查启动配置等即时错误
CUDA_CHECK(cudaDeviceSynchronize()); // 等待执行，并暴露异步执行错误
```

只调用 `cudaGetLastError()` 不能证明 kernel 已经成功执行完。非法设备内存访问等问题可能直到流、事件或设备同步时才报告。

反过来，在每个生产 kernel 后都调用 `cudaDeviceSynchronize()` 会把异步流水完全串行化。示例这样做是为了形成清楚的错误边界；真实程序通常通过同一流内顺序、事件或更晚的必要同步建立依赖，并在合适边界检查错误。

`cudaMemcpy` 的同步细节会受源/目标内存类型与 API 影响。不要仅凭函数名猜测；本文主例在 kernel 后显式同步，再执行阻塞式设备到主机复制，语义最直接。

## 6. 为什么连续索引对 GPU 同样重要？

GPU 以线程束（warp）为重要执行与调度单位，邻近线程执行同一条指令。若相邻线程读取相邻地址，硬件更容易把访问合并成较少的内存事务，即合并访存（coalesced access）。

主例中线程 `i` 读取 `left[i]`、`right[i]` 并写 `output[i]`，访问模式连续。若改成随机索引：

```cuda
output[i] = left[index[i]] + right[index[i]];
```

内存事务利用率和缓存行为可能恶化。具体合并规则、事务粒度和缓存结构依计算能力而异，应通过 Nsight Compute 的指标验证。

### 分支为什么会让同一线程束变慢？

同一 warp 中线程走不同控制路径时，硬件可能分批执行各路径并屏蔽不参与的线程，这称为分支分歧（branch divergence）。边界判断通常只影响尾部少量线程，代价有限；数据相关且高度分散的复杂分支更值得关注。

SIMT 不是“所有线程在每个周期永远锁步”的完整硬件描述，独立线程调度等细节会随架构发展。编写同步代码时必须遵守 CUDA 内存模型和同步原语契约，不能依赖隐式 warp 同步假设。

## 7. 统一内存能否消除数据迁移成本？

`cudaMallocManaged` 提供 CPU 与 GPU 都可寻址的托管分配，简化显式 `cudaMemcpy`：

```cuda
float* values = nullptr;
CUDA_CHECK(cudaMallocManaged(&values, bytes));
```

它简化的是编程模型，不是让传输消失。页面仍可能按需迁移，首次访问产生缺页和不可预测延迟；访问模式不当时，数据还可能在 CPU 与 GPU 间来回迁移。

`cudaMemPrefetchAsync` 和访问建议可帮助表达预期驻留位置，但可用性与效果取决于设备、驱动、互连和访问模式。CPU 在 GPU 工作期间访问 managed memory 的合法性也有平台与并发规则，使用前要查目标版本官方文档并建立流同步。

对教学原型或复杂共享数据结构，统一内存能降低开发成本；对稳定高吞吐管线，显式控制驻留有时更可预测。两者都应测端到端性能。

## 8. streams 为什么不会自动实现重叠？

CUDA stream 是有序工作队列。同一流中的拷贝和 kernel 按入队依赖顺序执行；不同流表达潜在并发，但是否真正重叠取决于 GPU 能力、资源占用和内存条件。

典型批处理管线是：

```text
stream 0: H2D(batch 0) → kernel(batch 0) → D2H(batch 0)
stream 1: H2D(batch 1) → kernel(batch 1) → D2H(batch 1)
```

要让涉及主机内存的异步拷贝真正具备重叠机会，主机缓冲通常需要页锁定（pinned/page-locked），例如通过 `cudaMallocHost` 分配。普通 pageable 内存传给 `cudaMemcpyAsync` 可能仍能得到正确结果，却退化成不能按预期重叠的行为。

pinned 内存是有限系统资源，过量使用会影响操作系统分页和整体性能。它必须用 `cudaFreeHost` 释放，并应通过 RAII 包装。

默认流还有 legacy default stream 与 per-thread default stream 等语义差异，会影响与其他流的隐式同步。项目必须明确编译和运行配置，不应把“stream 0 永远只与自己有序”当成通用假设。

## 9. 共享内存为什么既快又容易写错？

共享内存（shared memory）位于线程块作用域，适合让同一块线程复用数据。矩阵分块、卷积 tile 和块内归约是常见场景：

```cuda
extern __shared__ float tile[];

tile[threadIdx.x] = input[index];
__syncthreads();

// 现在块内线程可以读取彼此写入的 tile 元素
```

`__syncthreads()` 是块级屏障。参与该线程块的线程必须以符合契约的方式到达屏障；把它放在只有部分线程进入的分支中，可能导致挂起或未定义行为。

共享内存容量有限，并可能出现 bank conflict。用得太多还会减少一个多处理器上可同时驻留的线程块数量。若数据只使用一次，先搬进共享内存可能只是增加一次复制和同步，并不会更快。

块内归约常先在共享内存或 warp 原语中合并，再由每块少量线程更新全局结果，避免每个输入元素都执行全局原子。但归约实现还要正确处理非二次幂块大小、越界元素、浮点顺序和同步范围。

## 10. 原子操作为什么可能把上千线程重新串起来？

最朴素的求和让每个线程执行：

```cuda
atomicAdd(global_sum, value);
```

这能避免普通写入竞态，但所有线程争用同一地址，吞吐可能受序列化和缓存/内存系统限制。更常见的层次化策略是：

1. 每线程处理多个元素；
2. warp 内归约；
3. block 内归约；
4. 每个 block 只进行一次或少量全局更新。

不同数据类型的原子操作支持范围依计算能力和 CUDA 版本而异。自写 CAS 循环还要考虑浮点 NaN、ABA 类状态、重试和内存序，不能只复制一个代码片段。

如果已有 CUB、Thrust 或其他项目依赖中的成熟归约算法，应优先复用并测量，而不是从头维护复杂并行原语。

## 11. 如何测量 GPU 时间而不混淆异步行为？

主机 `std::chrono` 包围 kernel launch，往往只测到提交时间。测同一设备时间线上的工作，可使用 CUDA event：

```cuda
cudaEvent_t begin = nullptr;
cudaEvent_t end = nullptr;
CUDA_CHECK(cudaEventCreate(&begin));
CUDA_CHECK(cudaEventCreate(&end));

CUDA_CHECK(cudaEventRecord(begin, stream));
kernel<<<grid, block, 0, stream>>>(arguments...);
CUDA_CHECK(cudaGetLastError());
CUDA_CHECK(cudaEventRecord(end, stream));
CUDA_CHECK(cudaEventSynchronize(end));

float milliseconds = 0.0F;
CUDA_CHECK(cudaEventElapsedTime(&milliseconds, begin, end));

CUDA_CHECK(cudaEventDestroy(end));
CUDA_CHECK(cudaEventDestroy(begin));
```

event 测的是两个事件在 CUDA 时间线上的间隔，不自动包含事件之外的主机初始化或全部传输。正式基准应预热、重复多轮、校验结果，并同时报告 kernel-only 与 end-to-end 时间。

Nsight Systems 适合观察 CPU、拷贝、kernel 和 streams 时间线；Nsight Compute 用于分析单 kernel 的占用率、访存、分支和指令指标。优化前先用工具确认瓶颈，避免把 block 大小当作随机调参游戏。

## 12. GPU 代码的资源所有权怎样设计？

主例中的 `DeviceBuffer` 禁止复制，避免同一设备指针被释放两次。生产封装通常还应支持 `noexcept` 移动、检查尺寸乘法溢出，并明确关联的 device/context。

析构函数不能抛异常。`cudaFree` 失败时，简单忽略会隐藏错误，抛出又可能在栈展开期间终止程序；常见做法是提供显式 `close/reset` 返回错误，并让析构只做尽力清理或记录。

流、事件和 pinned 内存也应使用 RAII。释放前必须理解 API 的异步生命周期：主机缓冲、设备缓冲和 kernel 参数引用的数据，在相关 stream 工作完成前都不能失效。

设备端并不支持完整主机 C++ 运行环境。异常、动态分配、标准库组件、递归和虚调用的支持与成本受编译器、CUDA 版本和目标架构约束；host/device 共用函数需要在两条编译路径上分别验证。

## 13. 常见误区如何纠正？

### 误区一：线程数等于数组长度就是最佳配置

不对。grid-stride loop 可让线程复用，最佳 block/grid 取决于资源占用和工作量。使用 occupancy API 与 profiler 验证。

### 误区二：`cudaGetLastError()` 成功说明 kernel 已完成

不对。它能发现启动阶段错误，异步执行错误通常要到同步边界才传播。

### 误区三：Unified Memory 不再发生传输

不对。运行时和驱动仍要保证数据在访问位置可用，可能发生迁移、缺页或远程访问。

### 误区四：用了多个 stream 就一定重叠

不对。不同流只是表达并发机会；设备能力、资源占用、默认流语义与主机内存类型都会影响实际执行。

### 误区五：共享内存一定比全局内存快

不完整。只有产生足够复用并覆盖搬运与同步成本时才可能获益，还要避免容量和 bank conflict 问题。

### 误区六：GPU 核心多，所以小任务也会快

不对。启动、传输和同步是固定成本，低并行度或小输入常由 CPU 更高效完成。

## 14. 什么时候应该考虑 CUDA？

CUDA 适合：

- 大规模数据并行，迭代相对独立；
- 矩阵、图像、仿真、机器学习等已有 GPU 友好算法；
- 数据能在设备侧停留并经过多个处理阶段；
- 计算量足以覆盖启动与传输；
- 部署环境明确拥有受支持的 NVIDIA GPU 与工具链。

以下情况要谨慎：

- 输入很小或调用频率低；
- 强串行依赖、复杂指针追逐或高度分歧；
- 每次只做少量运算却来回传输大量数据；
- 需要支持没有 NVIDIA GPU 的部署环境；
- 团队缺少 CUDA 构建、调试与性能分析能力。

## 15. 总结

回到开头，把循环体写成 `__global__` 只是最小的一步。一个正确 CUDA 程序还必须管理数据位置、kernel 异步执行、错误边界和设备资源生命周期；一个更快的 CUDA 程序还要让这些固定成本被足够并行工作摊薄。

最重要的结论是：

1. 端到端成本包含 H2D、kernel、同步与 D2H，不能只看 kernel 时间。
2. 连续线程访问连续地址，有利于合并访存；分支和随机访问会削弱吞吐。
3. launch 后要区分即时错误与异步执行错误，并在正确边界同步。
4. streams、共享内存和原子操作都有严格适用条件，不是自动加速开关。
5. GPU 优化必须针对具体 CUDA 版本、计算能力和真实数据使用 profiler 验证。

实践时先画出数据生命周期：它何时从 CPU 到 GPU、在设备上复用几次、何时返回，以及每一步由哪个 stream 保证顺序。如果数据只为一次很小的加法往返，答案往往是先留在 CPU。

## 参考资料

- [NVIDIA CUDA Programming Guide](https://docs.nvidia.com/cuda/cuda-programming-guide/index.html)
- [NVIDIA CUDA 异步执行与 streams](https://docs.nvidia.com/cuda/cuda-programming-guide/02-basics/asynchronous-execution.html)
- [NVIDIA CUDA Unified Memory](https://docs.nvidia.com/cuda/cuda-programming-guide/04-special-topics/unified-memory.html)
- [CMake `CUDA_ARCHITECTURES` 属性](https://cmake.org/cmake/help/latest/prop_tgt/CUDA_ARCHITECTURES.html)
