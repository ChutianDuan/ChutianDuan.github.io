---
title: "手工分线程已经能跑，为什么不规则负载仍需要 oneTBB 任务调度？"
date: 2026-07-13 11:14:09
updated: 2026-07-13 11:14:09
categories:
  - "学习"
  - "高性能 C++ 并行编程"
permalink: /notes/高性能c-并行编程/10-tbb并行编程之旅/
series: "高性能 C++ 并行编程"
series_order: 10
---

时间：2025/12/23

把一百万次迭代平均分给四个线程，看起来已经完成并行化：

```cpp
const std::size_t block = count / 4;

// 线程 0 处理 [0, block)
// 线程 1 处理 [block, 2 * block)
// ...
```

如果每次迭代成本相同，这种静态分块可能工作良好。但现实任务常常不均匀：有些图像块全是背景，有些要执行复杂滤波；有些记录很快被过滤，有些要解析大对象。先完成的线程无法自动接手其他线程剩余工作，于是出现“一核忙、三核等”。

oneAPI Threading Building Blocks（oneTBB）提供基于任务的并行算法。程序描述可拆分范围和每块工作，调度器再将任务映射到工作线程，并可通过工作窃取改善负载均衡。它不能让有依赖的循环自动变并行，也不保证一定提速；价值在于把任务切分、调度和线程复用从业务循环中分离出来。

本文使用现代 `oneapi::tbb` 头文件和命名空间。旧项目可能仍写 `<tbb/...>` 与 `tbb::`，兼容情况取决于安装的 oneTBB/TBB 版本，迁移时应以项目锁定版本的文档和构建配置为准。

## 1. “任务”与“线程”有什么区别？

线程是操作系统调度的执行资源，任务是应用层的一份待执行工作。oneTBB 通常维护调度资源，并把大量小于线程生命周期的任务安排到可用线程：

```text
迭代范围 [0, n)
       │ 递归切分
       ├── task A ─┐
       ├── task B ─┼──> 调度器 ──> worker threads
       ├── task C ─┤              空闲线程可接手任务
       └── task D ─┘
```

这意味着代码不应依赖“某个索引固定由某条线程执行”，也不应把任务数量等同于线程数量。一个线程可以依次执行多个任务，一个任务在某次运行中由哪条线程处理属于调度细节。

并发（concurrency）描述多个任务在同一时间段推进的结构；并行（parallelism）强调它们在多个执行资源上同时运行。oneTBB 能表达并行机会，实际同时执行程度仍受机器、并发限制、其他负载和任务粒度影响。

## 2. 哪种循环可以交给 `parallel_for`？

最适合的起点是各次迭代彼此独立：

```cpp
for (std::size_t i = 0; i < input.size(); ++i) {
    output[i] = transform(input[i]);
}
```

若每个任务只读 `input[i]`，只写独立的 `output[i]`，迭代顺序不影响结果，就可以用 `parallel_for` 表达。

下面的循环不能直接照搬：

```cpp
for (std::size_t i = 1; i < values.size(); ++i) {
    values[i] += values[i - 1]; // 当前迭代依赖前一次结果
}
```

它是前缀和，存在循环携带依赖。需要使用 scan 类算法或重新推导并行算法，而不是把外层函数名换成 `parallel_for`。

### `blocked_range` 表达什么？

`oneapi::tbb::blocked_range<T>(begin, end, grain_size)` 表示半开区间 `[begin, end)`，并提供递归切分能力。body 每次收到的是一个子范围，而非一个固定线程专属范围：

```cpp
oneapi::tbb::parallel_for(
    oneapi::tbb::blocked_range<std::size_t>(0, count, 1024),
    [&](const oneapi::tbb::blocked_range<std::size_t>& range) {
        for (std::size_t i = range.begin(); i != range.end(); ++i) {
            output[i] = transform(input[i]);
        }
    });
```

粒度（grain size）控制范围何时不再可分，但不等于“每个任务必然恰好 1024 个元素”。默认自动分区器还会根据调度情况进一步决定切分策略。

## 3. 为什么共享 `sum` 不能放进 `parallel_for`？

这是错误示例：

```cpp
std::uint64_t sum = 0;

oneapi::tbb::parallel_for(
    std::size_t{0}, values.size(),
    [&](std::size_t i) {
        sum += values[i]; // 多个任务并发写 sum，产生数据竞争
    });
```

给每次加法加锁能修复竞态，却会让所有任务争用同一个临界区。归约（reduction）的正确结构是：每个子范围产生局部结果，再按结合操作合并。

```text
range A ──> local A ─┐
range B ──> local B ─┼──> combine ──> final result
range C ──> local C ─┤
range D ──> local D ─┘
```

`parallel_reduce` 需要单位元、子范围累积函数和合并函数。合并操作应满足结合性；不要求交换性，但组合顺序必须符合 API 契约。

浮点加法在有限精度下不严格满足结合律。不同归约树可能产生末位差异，因此不能默认并行浮点和与串行逐项和逐位相同。

## 4. 如何写出一个完整的 oneTBB 变换与归约？

下面先并行把整数乘以二，再用 `parallel_reduce` 求和。整数范围经过控制，结果不溢出，因而适合作为正确性示例。

代码使用 C++17 和现代 oneTBB API：

```cpp
#include <cstddef>
#include <cstdint>
#include <functional>
#include <iostream>
#include <numeric>
#include <vector>

#include <oneapi/tbb/blocked_range.h>
#include <oneapi/tbb/global_control.h>
#include <oneapi/tbb/parallel_for.h>
#include <oneapi/tbb/parallel_reduce.h>

int main() {
    constexpr std::size_t count = 100000;
    std::vector<std::uint32_t> input(count);
    std::vector<std::uint32_t> doubled(count);
    std::iota(input.begin(), input.end(), std::uint32_t{0});

    oneapi::tbb::global_control limit(
        oneapi::tbb::global_control::max_allowed_parallelism,
        4);

    oneapi::tbb::parallel_for(
        oneapi::tbb::blocked_range<std::size_t>(0, count, 1024),
        [&](const oneapi::tbb::blocked_range<std::size_t>& range) {
            for (std::size_t i = range.begin();
                 i != range.end();
                 ++i) {
                doubled[i] = input[i] * 2U;
            }
        });

    const std::uint64_t total = oneapi::tbb::parallel_reduce(
        oneapi::tbb::blocked_range<std::size_t>(
            0, doubled.size(), 1024),
        std::uint64_t{0},
        [&](const oneapi::tbb::blocked_range<std::size_t>& range,
            std::uint64_t local) {
            for (std::size_t i = range.begin();
                 i != range.end();
                 ++i) {
                local += doubled[i];
            }
            return local;
        },
        std::plus<std::uint64_t>{});

    std::cout << "total = " << total << '\n';
    return total == 9999900000ULL ? 0 : 1;
}
```

推荐通过 CMake 查找已安装的 oneTBB，而不是硬编码头文件和库路径：

```cmake
cmake_minimum_required(VERSION 3.16)
project(tbb_transform_reduce LANGUAGES CXX)

find_package(TBB CONFIG REQUIRED)

add_executable(tbb_transform_reduce main.cpp)
target_compile_features(tbb_transform_reduce PRIVATE cxx_std_17)
target_link_libraries(tbb_transform_reduce PRIVATE TBB::tbb)
```

构建命令：

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
./build/tbb_transform_reduce
```

预期输出：

```text
total = 9999900000
```

这些命令要求系统已经安装 oneTBB，并且其 CMake 包可被 `find_package` 找到。当前笔记环境未检测到 oneTBB 头文件，因此本文示例只完成了 API 与类型层面的静态审查，没有声称在当前机器实编译通过。不同包管理器和平台的安装路径不同，应遵循项目既有依赖管理方式，不要混用包管理器或全局安装。

## 5. 这段程序如何避免数据竞争？

`input` 在并行区域开始前完成初始化，任务只读它。`doubled` 已提前确定大小，每次迭代只写唯一的 `doubled[i]`；并行期间没有 `push_back`、`resize` 或其他结构修改。

`parallel_for` 返回意味着该并行算法的任务已完成，随后 `parallel_reduce` 才读取 `doubled`。两个阶段之间没有重叠。

归约 body 的 `local` 是当前子计算的值，不是所有任务共享的引用。调度器可为不同子范围独立累加，再调用 `std::plus` 合并。单位元 `0` 满足整数加法的左单位元要求。

`global_control` 对象在其生命周期内限制 oneTBB 的最大允许并行度。数字 4 是示例配置，不是最佳线程数；它也不意味着创建四条只供这个算法使用的固定线程。

## 6. 为什么任务粒度可能决定成败？

任务太小，调度、切分和调用 body 的成本可能超过实际计算；任务太大，负载不均时其他线程难以及时接手。

| 粒度 | 可能优势 | 可能问题 |
|---|---|---|
| 很小 | 负载均衡机会多 | 调度开销、缓存边界增多 |
| 很大 | 每块开销占比低 | 并行度不足、尾部负载不均 |
| 适中 | 平衡调度与工作量 | 依赖机器和迭代成本 |

先让 body 每次处理一个范围，而不是为每个微小元素提交独立任务。默认 `auto_partitioner` 通常是合理起点。只有 profiler 表明调度或局部性存在问题，再比较 grain size 与分区器。

oneTBB 还提供 `simple_partitioner`、`static_partitioner` 和 `affinity_partitioner` 等策略。静态划分提高某些执行映射的可预测性，却可能降低不规则负载的动态平衡；affinity 策略适合反复运行相似范围、希望提高缓存复用的场景。选择必须通过重复基准验证。

## 7. 二维数据为什么不只是“把索引改成两个”？

`blocked_range2d` 与 `blocked_range3d` 可以表达可切分的多维半开范围，但维度顺序和块形状仍应匹配实际内存布局：

```cpp
oneapi::tbb::parallel_for(
    oneapi::tbb::blocked_range2d<std::size_t>(
        0, rows, row_grain,
        0, cols, col_grain),
    [&](const auto& tile) {
        for (std::size_t row = tile.rows().begin();
             row != tile.rows().end(); ++row) {
            for (std::size_t col = tile.cols().begin();
                 col != tile.cols().end(); ++col) {
                output[row * cols + col] = compute(row, col);
            }
        }
    });
```

行优先数组通常让列作为最内层连续维。块应提供足够工作，同时避免多个任务频繁写同一缓存行。矩阵乘法等有复用的内核还要根据缓存容量选择 tile，不能只依赖默认切分。

## 8. 浮点归约为什么可能每次略有差别？

数学上的加法满足结合律，有限精度浮点加法却可能有：

```text
(a + b) + c ≠ a + (b + c)
```

并行调度形成的归约树可能不同，所以末位舍入也可能不同。若业务只要求误差范围，应使用合适的容差测试；若要求更稳定的归约图，可研究 `parallel_deterministic_reduce`，但它不保证等于串行左折叠结果，也不能消除编译器浮点选项或输入 NaN 等因素。

数值稳定性要求高时，还可考虑更高精度累加、补偿求和、固定分块与固定合并树。代价与精度应由领域需求决定，而不是仅为了逐位相同放弃所有并行机会。

## 9. 复杂统计怎样组织，而不共享可变状态？

需要同时计算 `sum/min/max/count` 时，可以让每个归约 body 保存一份局部统计，并提供 splitting constructor 与 `join`。关键不变量是：

- 分裂出的 body 从正确单位状态开始；
- `operator()` 保留同一 body 此前累计的结果，因为它可能处理多个子范围；
- `join` 能按合法顺序合并两个完整局部结果；
- 只读输入可共享，局部状态不能无同步共用。

简单标量可用 `parallel_reduce` 的函数式重载。复杂 reducer 才值得定义结构体，不必为每个求和都制造样板类。

`combinable<T>` 和 `enumerable_thread_specific<T>` 也能维护调度线程的本地状态，最后合并。但 oneTBB 任务可能在不同线程执行，不能把“线程本地”误认为“一个逻辑任务永久绑定一个槽位”。若算法本质是归约，`parallel_reduce` 通常更直接地表达依赖。

## 10. `task_group` 与 `parallel_invoke` 适合什么问题？

当工作不是一个索引范围，而是少量独立任务，可以使用：

```cpp
oneapi::tbb::parallel_invoke(
    [&] { build_left_index(); },
    [&] { build_right_index(); });
```

任务必须能安全并发，并且粒度足够大。把交互式 `std::cin` 与计算任务并行并不是良好示例：终端 I/O 可能阻塞调度资源，多个任务并发输出也会交错。

`task_group` 适合动态提交一组任务并等待。异常通常会传播到等待并触发任务组取消尝试，但取消是协作性的，已经运行的任务不一定立即停止。任务仍必须保证资源和部分结果在异常路径上一致。

对大量阻塞 I/O，面向计算任务设计的调度器未必是最佳模型。应采用异步 I/O、专用 I/O 执行资源或限制阻塞任务数量，避免占满计算 worker。

## 11. `task_arena` 与 `global_control` 有什么区别？

`global_control(max_allowed_parallelism, n)` 在对象生命周期内影响进程中相关 oneTBB 调度的全局并行度上限，适合避免库默认占用过多执行资源。

`task_arena` 表示一个任务可共享执行的区域，并限制同时参与该区域的并发程度：

```cpp
oneapi::tbb::task_arena arena(4);

arena.execute([&] {
    oneapi::tbb::parallel_for(
        std::size_t{0}, count,
        [&](std::size_t i) { process(i); });
});
```

arena 不是“拥有四条固定专属线程的线程池”。调用线程可能进入 arena 执行任务，worker 也由调度器管理。嵌套并行时，oneTBB 通常尝试组合任务而不是为每层机械创建一批线程，但同时混用 OpenMP、其他线程池和 oneTBB 仍可能造成过度订阅。

`this_task_arena::isolate` 用于限制调用线程在隔离区域内处理哪些任务，解决特定嵌套或外部调用干扰；它不是默认性能优化开关。只有明确理解任务交互问题时才使用。

## 12. 并发容器能否替代良好数据划分？

`concurrent_vector` 支持某些并发增长操作，但它的存储组织和迭代器语义不能简单当作严格连续的 `std::vector`。并发容器让操作具备特定线程安全保证，不会自动消除分配、缓存争用和结果顺序不确定性。

若输出数量已知，预先 `resize` 普通 `std::vector`，让每个任务写独立下标，通常更直接。输出数量未知时，线程本地缓冲后批量合并也可能优于所有任务争用一次并发 `push_back`。选择要依据 API 契约与测量，而不是只看容器名字中有 `concurrent`。

## 13. 流水线并行何时比 `parallel_for` 更自然？

读取、解析、计算、写出这类阶段式流程不一定适合一个索引循环。`parallel_pipeline` 允许阶段具有 serial-in-order、serial-out-of-order 或 parallel 模式，并用最大活动 token 数限制在途项目数量。

```text
串行读取 ──> 并行计算 ──> 串行有序写出
                ↑
          最多 N 个在途 token
```

token 上限提供基本背压，避免输入无限领先于下游。但资源所有权、I/O 错误、取消和输出顺序仍需设计。简单的一次数组变换不要为了“流水线化”增加这些复杂度。

## 14. 为什么 oneTBB 并行版本可能更慢？

常见原因包括：

- 输入太小，调度成本大于计算；
- 单次迭代太轻，任务粒度过细；
- 算法受内存带宽限制，多核很快达到上限；
- 多任务写相邻缓存行，出现伪共享；
- 临界区或共享原子仍将工作串行化；
- 同时使用多个并行运行时，线程过度订阅；
- 不规则划分导致缓存局部性变差。

性能测试应使用 Release 构建，先验证串行与并行结果，再对代表性数据重复测量不同并行度和粒度。不要把首次调用的调度器初始化成本与稳定状态混为一谈，也不要只记录最好一次。

## 15. 常见误区如何纠正？

### 误区一：`parallel_for` 会为每个迭代创建线程

不对。它将范围组织成任务，由调度资源执行。任务、范围块和线程不是一一对应关系。

### 误区二：body 会固定在同一线程

不对。任务调度和工作窃取允许不同线程执行不同子任务。不要依赖线程 ID 决定逻辑正确性。

### 误区三：共享累加器换成原子就等价于 `parallel_reduce`

正确性可能得到改善，性能却仍受单一缓存行争用。归约通过局部累计减少共享更新，更符合算法结构。

### 误区四：grain size 就是固定任务大小

不准确。它决定 range 的可分割阈值，实际切分还受分区器和调度影响。

### 误区五：`parallel_deterministic_reduce` 等于串行结果

不对。它提供确定的归约结构，但浮点结果仍取决于该结构、编译选项和数值特征，不必等于从左到右串行累加。

### 误区六：限制 arena 为四就拥有四条专属线程

不对。arena 限制参与执行的并发程度，线程属于调度实现资源，不应按固定线程池理解。

## 16. 什么时候应该使用 oneTBB？

oneTBB 适合：

- 已有 C++ 工程需要可组合的 CPU 任务并行；
- 循环可以表达为独立范围、归约或扫描；
- 单次工作量足以覆盖调度成本；
- 不规则负载需要动态平衡；
- 需要控制并发区域、流水线或并发容器，并愿意引入库依赖。

以下情况未必需要：

- 很小或本来就很快的循环；
- 强循环依赖且尚未推导并行算法；
- 主要瓶颈是阻塞 I/O；
- 项目已有统一任务运行时，继续叠加会过度订阅；
- 部署环境不能可靠提供并维护 oneTBB。

## 17. 总结

回到开头，手工按线程平均划分只平均了迭代数量，没有平均真实工作量。oneTBB 的核心价值是把工作描述成可拆分任务，让调度器在执行资源之间动态安排。

需要记住五点：

1. 任务不是线程，程序不应依赖任务与固定线程绑定。
2. `parallel_for` 要求迭代可安全并发，归约应使用局部累计与合并。
3. 范围粒度在调度开销、负载均衡和缓存局部性之间取舍。
4. `task_arena` 与 `global_control` 控制并发边界，不是创建专属线程池。
5. 并行 API 只提供机会；正确性、数值语义和真实提速都必须单独验证。

实践中先写出经过测试的串行版本，再标出独立迭代、归约变量和任务成本。只有这些边界清楚，调度器才能帮忙，而不是把一个竞态更快地运行出来。

## 参考资料

- [oneTBB 官方 `parallel_for` 指南](https://uxlfoundation.github.io/oneTBB/main/tbb_userguide/parallel_for_os.html)
- [oneTBB 官方 `parallel_reduce` 规范](https://uxlfoundation.github.io/oneTBB/main/specification/source/algorithms/functions/parallel_reduce_func.html)
- [oneTBB 官方 `task_arena` 规范](https://uxlfoundation.github.io/oneTBB/main/specification/source/task_scheduler/task_arena/task_arena_cls.html)
- [oneTBB 官方 `parallel_pipeline` 规范](https://uxlfoundation.github.io/oneTBB/main/specification/source/algorithms/functions/parallel_pipeline_func.html)
- [oneTBB 官方仓库](https://github.com/uxlfoundation/oneTBB)
