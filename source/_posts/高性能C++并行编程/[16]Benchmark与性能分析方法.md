---
title: "优化后快了 30%，为什么这个 Benchmark 可能什么也没证明？"
date: 2026-07-13 13:48:22
updated: 2026-07-13 13:48:22
categories:
  - "学习"
  - "高性能 C++ 并行编程"
permalink: /notes/高性能c-并行编程/16-benchmark与性能分析方法/
series: "高性能 C++ 并行编程"
series_order: 16
---

一次性能优化完成后，我们很容易写出这样的测试：

```cpp
const auto begin = std::chrono::high_resolution_clock::now();
do_work();
const auto end = std::chrono::high_resolution_clock::now();

std::cout << "cost = "
          << std::chrono::duration<double, std::milli>(end - begin).count()
          << " ms\n";
```

旧版本耗时 10 ms，新版本耗时 7 ms，于是提交说明里写下“性能提升 30%”。但第二天同事在另一台机器上复测，新版本不仅没有更快，甚至还慢了 5%。

问题可能不在优化代码，而在测量本身：测试的是 Debug 构建，第一次运行包含缺页和动态链接开销，输入刚好能放进缓存，编译器删除了没有被观察的计算，或者 3 ms 的差异只是系统调度造成的波动。

本文要解决的不是“如何调用一个计时 API”，而是更重要的问题：**怎样让一项性能结论经得起复测？**我们会从一个有隐患的单次计时出发，建立“提出问题、稳定测量、定位热点、修改代码、重新验证”的性能工程闭环。

## 1. 我们遇到了什么问题？

假设服务里有一段整数求和代码。为了判断优化是否生效，我们直接运行一次并计时：

```cpp
// 存在隐患的写法：单次结果不足以支撑性能结论
auto begin = std::chrono::steady_clock::now();
const auto result = sum(values);
auto end = std::chrono::steady_clock::now();

std::cout << "result=" << result << ", cost="
          << std::chrono::duration<double, std::micro>(end - begin).count()
          << " us\n";
```

这段代码能运行，也确实测到了一段时间，但它留下了几个没有回答的问题：

- 这是 Release 构建还是 Debug 构建？
- 这一次运行是冷缓存还是热缓存？
- 运行前是否刚好发生了缺页、CPU 降频或线程抢占？
- 输入规模是否代表真实业务？
- `sum` 的结果是否经过正确性校验？
- 7 ms 与 10 ms 是稳定差异，还是两个随机样本？

Benchmark（基准测试）不是“在代码前后各放一个时钟”这么简单。它本质上是一项受控实验：先明确要回答的问题，再尽可能固定无关变量，最后用重复测量和统计结果支撑结论。

### 1.1 先写下要回答的问题

“这段代码快不快”过于模糊。可验证的问题应该更具体，例如：

> 在同一台机器、同一编译器和 Release 选项下，对 4 Mi 个 `std::uint32_t` 的热缓存顺序求和，修改后的中位延迟是否至少降低 10%，且结果保持正确？

这句话明确了：

1. 比较对象：修改前与修改后；
2. 工作负载：4 Mi 个整数的顺序求和；
3. 缓存条件：热缓存；
4. 观察指标：中位延迟；
5. 验收门槛：至少降低 10%；
6. 前置条件：结果正确。

没有这些边界，“快 30%”只是一个缺少上下文的数字。

## 2. 为什么直觉上的计时会出问题？

### 2.1 Debug 构建测到的常常是调试便利性

未优化构建可能保留大量临时对象、栈读写和函数调用。它适合调试，却通常不能代表交付程序的性能。比较生产性能时，至少应使用与生产一致或接近的优化构建：

```bash
clang++ -std=c++17 -O2 -DNDEBUG -Wall -Wextra benchmark.cpp -o benchmark
```

`-O2`、`-O3`、链接时优化（LTO）和 `-march=native` 都可能改变生成代码。它们并非越激进越快，也不能混在一次比较中随意切换。尤其是 `-march=native` 会针对当前 CPU 生成指令，产物不一定能在较老 CPU 上运行。

### 2.2 没有使用结果，工作可能被整个删除

优化器只需要保留 C++ 抽象机中可观察的行为。如果一项计算的结果既不输出，也不影响后续状态，它可能被判定为无用：

```cpp
// 错误示例：result 没有被观察，循环可能被优化掉
std::uint64_t result = 0;
for (std::uint32_t value : values) {
    result += value;
}
```

仅仅把变量声明为 `volatile` 不是通用解决方案。它会改变每次访问的语义，测到的可能变成 volatile 读写成本，而不是原算法。更合理的做法是让结果在计时区间外参与校验或输出。成熟微基准框架还会提供专门的“阻止优化”接口。

### 2.3 输入过于固定，编译器可能提前算完

如果输入和计算都能在编译期确定，常量折叠（constant folding）可能把整个过程替换成一个常量。真实 Benchmark 应使用运行期构造的输入，并确认反汇编或优化报告中仍然存在待测代码。

这并不意味着输入必须随机。完全随机的输入难以复现，还可能把随机数生成成本混入测试。更常见的做法是：**使用确定性规则在计时区间外生成输入**。

### 2.4 第一次和后续运行测到的不是同一种状态

首次执行可能包含：

- 代码和数据页首次映射引起的缺页；
- 动态链接或惰性符号绑定；
- 内存分配器初始化；
- 指令缓存、数据缓存尚未预热；
- 线程池尚未创建；
- CPU 频率与温度状态不同。

因此，“先预热几次再测”并不是固定仪式，而是在选择实验条件。如果线上请求主要命中热数据，热缓存测试有意义；如果程序是一次性命令行工具，冷启动成本反而不能被预热掩盖。

### 2.5 单次运行没有波动信息

把一次测量看作一张照片：它可能刚好拍到线程被抢占的一瞬间。重复测量得到的是一小段录像，才能看出常态和异常值。

对容易出现长尾的耗时数据，中位数通常比平均数更稳健；P95、P99 能反映尾延迟；最小值有时接近“干扰最少时的机器能力”，但不能代表用户通常会经历的时间。

| 指标 | 能回答的问题 | 使用时要注意什么 |
| --- | --- | --- |
| 最小值 | 干扰较少时能有多快 | 容易掩盖常态与长尾 |
| 平均值 | 总耗时如何分摊 | 容易被少量极端值拉动 |
| 中位数 | 典型一次运行多快 | 不展示尾部风险 |
| P95 / P99 | 慢请求有多慢 | 样本太少时没有意义 |
| 标准差 / 离散程度 | 测量是否稳定 | 不能替代原始分布与环境记录 |

## 3. Benchmark、Profiling 和 Tracing 各回答什么？

性能工作里常见三类工具。它们互相配合，但不能互相替代。

| 方法 | 核心问题 | 常见输出 | 典型用途 |
| --- | --- | --- | --- |
| Benchmark | 一项操作到底多快？ | 延迟、吞吐、带宽、加速比 | 比较两个实现，防止性能回退 |
| Profiling（性能剖析） | 时间主要花在哪里？ | 热点函数、调用栈、硬件事件 | 决定应该优化哪一处 |
| Tracing（事件追踪） | 一段时间内各组件如何交互？ | 时间线、等待、调度、I/O 事件 | 分析并发、异步和端到端长尾 |

可以把它们串成一个闭环：

```text
业务目标或 Benchmark 发现变慢
              |
              v
Profiler 定位热点与瓶颈类型
              |
              v
提出假设，只修改一个主要变量
              |
              v
Benchmark 复测局部和端到端结果
              |
              v
记录环境、结果，并建立回归保护
```

Profiler 显示一个函数占 60% CPU 时间，并不等于“重写它就一定能提升 60%”。这 60% 可能是算法不可避免的工作，也可能只是它被调用得最多。热点是调查入口，不是优化结论。

## 4. 如何写出一个最小但可信的 Benchmark？

下面的完整示例比较两种顺序求和写法。文章的目的不是证明哪一种一定更快——优化器很可能为它们生成近似甚至相同的机器码——而是展示一个最小测量应具备哪些要素。

### 4.1 运行条件

- 语言标准：C++17；
- 第三方依赖：无；
- 构建模式：`-O2 -DNDEBUG`；
- 输入：4 Mi 个运行期生成的 `std::uint32_t`；
- 测量条件：先预热，再进行 11 次热缓存测量；
- 输出：校验和、最小值、中位数和最大值。

将以下代码保存为 `benchmark.cpp`：

```cpp
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <numeric>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using Values = std::vector<std::uint32_t>;
using SumFunction = std::uint64_t (*)(const Values&);

std::uint64_t sum_index_loop(const Values& values) {
    std::uint64_t result = 0;
    for (std::size_t i = 0; i < values.size(); ++i) {
        result += values[i];
    }
    return result;
}

std::uint64_t sum_accumulate(const Values& values) {
    return std::accumulate(values.begin(), values.end(), std::uint64_t{0});
}

struct Report {
    std::string name;
    std::uint64_t checksum;
    double minimum_ms;
    double median_ms;
    double maximum_ms;
};

Report measure(std::string name,
               SumFunction function,
               const Values& values,
               std::uint64_t expected) {
    constexpr int warmup_count = 2;
    constexpr int sample_count = 11;

    std::uint64_t checksum = 0;
    for (int i = 0; i < warmup_count; ++i) {
        checksum ^= function(values);
    }

    std::vector<double> samples;
    samples.reserve(sample_count);

    for (int i = 0; i < sample_count; ++i) {
        const auto begin = std::chrono::steady_clock::now();
        const std::uint64_t result = function(values);
        const auto end = std::chrono::steady_clock::now();

        if (result != expected) {
            throw std::runtime_error(name + " produced a wrong result");
        }

        checksum += result;
        const std::chrono::duration<double, std::milli> elapsed = end - begin;
        samples.push_back(elapsed.count());
    }

    std::sort(samples.begin(), samples.end());
    return Report{
        std::move(name),
        checksum,
        samples.front(),
        samples[samples.size() / 2],
        samples.back()
    };
}

void print_report(const Report& report) {
    std::cout << std::fixed << std::setprecision(3)
              << report.name
              << ": checksum=" << report.checksum
              << ", min=" << report.minimum_ms << " ms"
              << ", median=" << report.median_ms << " ms"
              << ", max=" << report.maximum_ms << " ms\n";
}

int main() {
    constexpr std::size_t element_count = std::size_t{1} << 22;

    Values values;
    values.reserve(element_count);

    std::uint64_t expected = 0;
    for (std::size_t i = 0; i < element_count; ++i) {
        const auto value = static_cast<std::uint32_t>(i % 251);
        values.push_back(value);
        expected += value;
    }

    try {
        print_report(measure("index loop", sum_index_loop, values, expected));
        print_report(measure("accumulate", sum_accumulate, values, expected));
    } catch (const std::exception& error) {
        std::cerr << "benchmark failed: " << error.what() << '\n';
        return 1;
    }
}
```

编译并运行：

```bash
clang++ -std=c++17 -O2 -DNDEBUG -Wall -Wextra benchmark.cpp -o benchmark
./benchmark
```

输出形式如下，具体时间取决于 CPU、编译器、系统负载和温度，不能照抄为性能结论：

```text
index loop: checksum=5767086831, min=<本机结果> ms, median=<本机结果> ms, max=<本机结果> ms
accumulate: checksum=5767086831, min=<本机结果> ms, median=<本机结果> ms, max=<本机结果> ms
```

两项校验和应该相同。若两种写法时间接近，这很正常：在当前编译器、选项和目标架构下，它们可能被优化为近似的循环。要确认原因，需要结合反汇编或编译器优化报告，而不是凭源代码外观猜测。

## 5. 这段代码如何避免常见测量错误？

### 5.1 输入构造不属于待测区间

`values` 在计时前完成分配和填充，因此结果表示“对现有数组求和”的成本，不包含内存分配和输入生成。

这不是唯一正确的边界。如果真实需求是“读取、解析并求和一批数据”，就应该另建端到端 Benchmark，把这些步骤纳入测量。测量边界必须由业务问题决定。

### 5.2 预期结果来自独立的数据生成过程

代码在填充数组时同步计算 `expected`，然后用它校验每个待测实现。若仅用实现 A 的输出验证实现 B，两者可能共享同一个错误。

正确性校验放在每次计时结束之后。这样既不会把异常构造等开销算入正常路径，又能避免用错误结果换取“更快”的假优化。

### 5.3 `steady_clock` 适合测量时间间隔

`std::chrono::steady_clock` 保证时间点不会倒退，适合计算持续时间。系统日历时间可能因网络校时或人工修改而跳变，不适合这种用途。

`high_resolution_clock` 只是实现提供的“最高精度时钟”别名，不保证单调；具体指向哪个时钟需要结合标准库实现验证。测间隔时明确选择 `steady_clock` 更能表达意图。

### 5.4 预热明确了“热状态”假设

两次预热让代码和数据先被访问。预热结果通过 `checksum` 参与后续可观察状态，避免调用被轻易视为无用；两次相同结果进行异或后归零，所以最终输出只包含 11 个正式样本的结果和。

注意，这个示例依次测量两个实现，第二个实现可能享受更有利的缓存或频率状态。严谨的对比应轮换或随机化候选执行顺序，或者分进程多轮运行，以减小顺序偏差。

### 5.5 中位数不是“统计学护身符”

11 个样本足以演示方法，却不足以支撑所有工程结论。尤其在比较只有 1%～2% 的差异时，应增加样本、观察完整分布，跨进程或跨机器重复，并根据噪声大小评估置信区间。

还有一个常见问题：待测代码太短，时钟调用和调度噪声会占很大比例。此时可以让框架自动增加迭代次数，或在一次计时中批量执行多个操作，再除以操作数。但必须防止编译器把重复计算合并或移出循环。

## 6. 从“测到差异”走向“解释差异”

Benchmark 告诉我们差异存在，Profiler 才帮助判断差异来自哪里。

### 6.1 先选择与目标相符的指标

| 指标 | 适合的场景 | 典型单位 |
| --- | --- | --- |
| 延迟 | RPC、交互操作、单帧渲染、实时任务 | ms / request、ms / frame |
| 吞吐 | 批处理、编解码、数据转换 | items/s、requests/s |
| 带宽 | 大数组读写、内存复制 | GB/s |
| cycles / element | 稳定热循环、跨频率解释机器成本 | cycles/element |
| 加速比 | 串行与并行实现比较 | `T1 / Tp` |

例如 `c[i] = a[i] + b[i]` 对每个 `float` 至少读取 8 字节、写入 4 字节，可以用处理字节数除以时间估算有效带宽。但写分配、缓存层级、非临时存储等会改变实际总线流量，所以“12 字节/元素”只是算法层面的下界，不等同于硬件计数器看到的全部流量。

### 6.2 采样剖析先找“宽”的调用栈

采样 Profiler 周期性记录程序计数器和调用栈，干扰通常比逐函数插桩小。火焰图中：

- 横向宽度表示采样占比，而不是时间轴；
- 纵向表示调用栈深度；
- 越宽的栈，越值得先调查；
- 颜色通常没有统一的性能含义，要看生成工具约定。

如果 allocator 相关栈很宽，问题可能是频繁分配；锁和调度函数很宽，可能存在争用；计算循环很宽，则要继续判断是指令吞吐、分支、缓存还是内存带宽限制。

### 6.3 硬件计数器用于验证瓶颈假设

第一批常见指标包括：

- cycles 与 instructions：可以计算 IPC（instructions per cycle）；
- cache miss：观察缓存未命中，但要区分缓存层级和事件定义；
- branches 与 branch misses：观察分支预测情况；
- context switches：辅助判断阻塞、线程过多或调度干扰。

IPC 低不自动等于代码差。访存受限程序可能长时间等待数据，IPC 天然偏低；高 IPC 也不证明算法高效，因为程序可能只是高效执行了更多不必要的指令。计数器必须与算法、反汇编和运行平台一起解释。

### 6.4 平台工具不同，工作流相同

- Linux 常用 `perf stat`、`perf record`、`perf report`，也可使用 Intel VTune；
- macOS 常用 Instruments、Xcode 的性能工具和 `sample`；
- Windows 常用 Visual Studio Profiler、Windows Performance Analyzer 和 VTune；
- CUDA 程序可用 Nsight Systems 看 CPU/GPU 时间线，用 Nsight Compute 分析单个 kernel。

例如 Linux 上可以从以下命令开始：

```bash
perf stat ./benchmark
perf record -g ./benchmark
perf report
```

`perf` 的可用事件名、权限要求和统计方式受 Linux 内核、CPU 型号与系统配置影响；这些命令不能直接用于 macOS 或 Windows，具体指标需要结合目标环境验证。

## 7. 工程中的 Benchmark 还要控制什么？

### 7.1 微基准与宏基准要回答不同问题

Microbenchmark（微基准）隔离一个函数或热循环，适合比较数据布局、SIMD、分支和容器操作；Macrobenchmark（宏基准）覆盖完整业务流程，能观察 I/O、分配、调度和模块交互。

局部循环快 50%，如果只占端到端耗时的 2%，整体收益上限也很小。反过来，微基准没有变快，端到端性能也可能因减少数据转换或等待而改善。因此，重要优化通常要同时通过局部和端到端验证。

### 7.2 并行 Benchmark 多了几类变量

并行程序尤其要记录：

- 线程数和线程池是否预热；
- 每个任务的粒度；
- 负载是否均衡；
- 是否存在锁争用或伪共享（false sharing）；
- 内存带宽是否已经饱和；
- 线程亲和性、NUMA 放置和系统拓扑。

8 个线程只快 2 倍，不足以说明线程库“性能差”。数组遍历可能已经耗尽内存带宽，也可能任务太小、调度成本过高。并行效率可以写为：

```text
speedup   = T1 / Tp
efficiency = speedup / p
```

但公式只描述结果，不解释原因。原因仍需通过时间线、硬件事件和扩展性曲线判断。

### 7.3 不要一边排错一边测性能

AddressSanitizer、UndefinedBehaviorSanitizer 和 ThreadSanitizer 很适合在优化前发现越界、未定义行为和数据竞争，但插桩会显著改变时间与内存行为。

正确流程是分开构建：

```bash
# 正确性检查构建，不用它报告最终性能
clang++ -std=c++17 -O1 -g -fsanitize=address,undefined app.cpp -o app_san

# 性能测量构建
clang++ -std=c++17 -O2 -DNDEBUG app.cpp -o app_bench
```

ThreadSanitizer 通常需要单独构建，而且并非所有平台和运行时都完整支持。具体可用性需要结合当前 Clang、操作系统和目标架构验证。

### 7.4 记录环境，才能复现实验

一条可复核的性能记录至少应包含：

```text
date:       2026-07-13
machine:    <机器与 CPU 型号>
compiler:   <编译器及版本>
flags:      -std=c++17 -O2 -DNDEBUG
input:      4 Mi uint32_t, deterministic pattern
threads:    1
condition:  warm-cache, 11 samples
baseline:   <中位数与波动范围>
candidate:  <中位数与波动范围>
```

还应保留代码提交、Benchmark 命令和原始输出。只有“优化后快了很多”的记录，无法区分代码收益、环境变化和测量误差。

### 7.5 用成熟框架处理严肃微基准

手写计时器适合教学、粗看数量级和测量完整流程。纳秒级操作、自动迭代、参数化规模、复杂统计和稳定的防优化机制，更适合使用 Google Benchmark 等成熟框架。

框架能减少重复劳动，却不会替你决定测试边界。即使使用框架，仍可能把输入构造放错位置、选择失真的数据规模，或从微基准错误外推到真实系统。

## 8. 常见误区

### 8.1 误区：一次运行更快，就证明优化有效

一次运行没有分布信息，也无法识别抢占、降频等异常。正确理解是：固定环境后重复测量，报告中位数和波动，并在差异接近噪声时收集更多证据。

### 8.2 误区：只要输出结果，就绝不会被优化器干预

输出最终值能阻止整项计算被删除，但编译器仍可内联、向量化、常量传播或合并等价工作。这些优化本来就是 Release 程序的一部分。若需要确认究竟测到了什么，应检查生成的汇编或编译器优化报告。

### 8.3 误区：微基准胜出，真实系统一定胜出

微基准通常拥有整洁的输入、稳定缓存和隔离环境。真实系统还包含 I/O、内存分配、锁、调度和跨模块转换。正确做法是用微基准解释局部机制，再用宏基准验证用户能感知的收益。

### 8.4 误区：CPU 使用率高，说明硬件利用得好

忙等、锁争用、错误预测和缓存未命中都可能让 CPU 看起来很忙。真正应关注的是单位时间完成了多少有效工作，以及延迟、吞吐和资源消耗是否符合目标。

### 8.5 误区：Profiler 最热的函数必须直接重写

热点可能是必要工作，也可能只是上游算法让它被调用太多次。先问“为什么调用这么多”“能否减少总工作量”，往往比微调函数内部更有效。

### 8.6 误区：`-O3` 一定比 `-O2` 快

更激进的内联和向量化可能增大代码体积、寄存器压力或缓存压力。编译选项本身也应作为受控变量，在目标机器和真实输入上测量。

## 9. 什么时候应该使用哪种测量？

适合写微基准的情况包括：比较两个容器操作、验证数据布局、观察输入规模曲线、判断 SIMD 是否生效，以及寻找并行任务的合适粒度。

如果问题是启动速度、一次完整请求、应用首帧或批处理总耗时，应优先建立宏基准。若问题表现为线程偶发停顿、异步任务没有重叠或 GPU 空闲，则时间线追踪比孤立计时更合适。若还不知道时间花在哪里，先采样剖析，而不是凭直觉重构。

无论选择哪种方法，都不应在存在未定义行为、数据竞争或错误结果时讨论性能。更快地产生错误答案没有工程价值。

## 10. 总结

开头那句“优化后快了 30%”是否可信，取决于它背后的证据，而不是小数点有几位。

1. Benchmark 是受控实验：先明确工作负载、指标、环境和验收门槛，再开始计时。
2. 使用 Release 构建、运行期输入、正确性校验、预热和重复样本，避免最常见的失真来源。
3. Benchmark 判断是否变快，Profiling 定位时间花在哪里，Tracing 解释并发系统在何时等待。
4. 微基准解释局部机制，宏基准验证真实收益；任何一方都不能单独代表完整系统。
5. 性能优化必须形成“测量—定位—假设—修改—复测—记录”的闭环。

最实用的一条建议是：**下一次提交性能优化时，不只写“快了多少”，同时附上可复现命令、输入规模、构建选项、样本分布和正确性校验。**这样得到的才是工程结论，而不是一次幸运的计时。

## 参考资料

- [Google Benchmark](https://github.com/google/benchmark)
- [Brendan Gregg：Flame Graphs](https://www.brendangregg.com/flamegraphs.html)
- [Linux perf Wiki](https://perf.wiki.kernel.org/)
- [Clang Sanitizer 文档](https://clang.llvm.org/docs/index.html)
