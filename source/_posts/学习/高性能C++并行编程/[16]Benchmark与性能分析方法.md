---
title: "Benchmark 与性能分析方法"
date: 2026-05-08 14:18:16
updated: 2026-05-08 14:18:16
categories:
  - "学习"
  - "高性能C++并行编程"
permalink: /notes/高性能c-并行编程/16-benchmark与性能分析方法/
---

# Benchmark 与性能分析方法

时间：2026/05/08

> 关键词：benchmark、profiling、火焰图、硬件计数器、统计、吞吐、延迟、Google Benchmark
> 核心目标：建立“先测量、再定位、再优化、再验证”的性能工程闭环。

---

## 1. 为什么需要单独学性能测量

高性能编程里最危险的一句话是：

> 我感觉这样应该更快。

现代 CPU、编译器、缓存、线程调度都很复杂。
很多优化会出现反直觉结果：

* 少了一次拷贝，但破坏了连续访问
* 减少了锁，但引入 false sharing
* 手写 SIMD，但寄存器压力变大
* 多开线程，但调度和内存带宽抵消了收益
* `-O3` 比 `-O2` 慢

所以性能优化必须依赖测量。

---

## 2. Benchmark、Profiling、Tracing 的区别

### 2.1 Benchmark

Benchmark 回答：

> 这个操作到底有多快？

常见输出：

* 每次调用耗时
* 每秒吞吐量
* 带宽 GB/s
* cycles / element
* 不同输入规模下的曲线

### 2.2 Profiling

Profiling 回答：

> 时间花在哪里？

常见输出：

* 哪些函数占 CPU 时间最多
* 哪些调用链最热
* cache miss、branch miss、锁等待等指标

### 2.3 Tracing

Tracing 回答：

> 一段时间线上发生了什么？

适合观察：

* 线程之间何时等待
* I/O 与计算是否重叠
* GPU kernel 和 memcpy 是否并发
* 请求链路中的长尾延迟

三者关系：

```text
benchmark 判断变快还是变慢
profiling 找到该改哪里
tracing 解释并发系统为什么卡住
```

---

## 3. 一个最小手写计时器

小实验可以先用 `steady_clock`：

```cpp
#include <chrono>
#include <iostream>
#include <vector>

int main() {
    std::vector<float> a(1 << 24, 1.0f);
    std::vector<float> b(1 << 24, 2.0f);

    auto t0 = std::chrono::steady_clock::now();

    float sum = 0.0f;
    for (std::size_t i = 0; i < a.size(); ++i) {
        sum += a[i] * b[i];
    }

    auto t1 = std::chrono::steady_clock::now();
    std::chrono::duration<double, std::milli> ms = t1 - t0;

    std::cout << "sum=" << sum << ", cost=" << ms.count() << " ms\n";
}
```

这里故意输出 `sum`，避免编译器发现结果没用而删掉整个循环。

手写计时适合：

* 粗看数量级
* 验证大改动
* 测一段完整业务流程

不适合：

* 纳秒级函数
* 很短的循环
* 需要稳定统计的微基准

---

## 4. 手写 benchmark 的常见陷阱

### 4.1 Debug 构建

Debug 构建的结果通常没有性能意义。
要测优化后的构建：

```bash
cmake -DCMAKE_BUILD_TYPE=Release ..
```

或直接：

```bash
clang++ -O3 -DNDEBUG main.cpp
```

### 4.2 死代码消除

如果结果没有被使用，编译器可能直接删掉计算。

坏例子：

```cpp
for (int i = 0; i < n; ++i) {
    x += i;
}
```

如果 `x` 最终无用，循环可能消失。

### 4.3 常量折叠

如果输入全是编译期常量，编译器可能提前算好结果。

### 4.4 只跑一次

第一次运行可能包含：

* 缺页
* cache 冷启动
* 动态链接开销
* 内存分配初始化
* CPU 频率尚未稳定

### 4.5 输入规模太小

小数据可能完全在 L1 cache 里，大数据可能受内存带宽限制。
只测一个规模很容易得出片面结论。

### 4.6 把 I/O 算进热循环

`std::cout`、日志、文件读写通常会淹没真正的计算成本。

---

## 5. 更推荐的微基准：Google Benchmark

微基准建议用成熟框架。
Google Benchmark 会处理很多基础工作：

* 多轮运行
* 自动调整迭代次数
* 防止常见优化误删
* 参数化输入规模
* 输出统计指标

典型写法：

```cpp
#include <benchmark/benchmark.h>
#include <vector>

static void BM_sum(benchmark::State& state) {
    const std::size_t n = static_cast<std::size_t>(state.range(0));
    std::vector<float> a(n, 1.0f);

    for (auto _ : state) {
        float sum = 0.0f;
        for (float x : a) {
            sum += x;
        }
        benchmark::DoNotOptimize(sum);
    }

    state.SetItemsProcessed(state.iterations() * static_cast<long long>(n));
}

BENCHMARK(BM_sum)->Range(1 << 10, 1 << 26);

BENCHMARK_MAIN();
```

如果 benchmark 里包含写内存，可以用：

```cpp
benchmark::ClobberMemory();
```

它提示编译器：不要假设内存状态没有被外部观察。

---

## 6. 应该看哪些指标

不同任务要看不同指标。

### 6.1 延迟

单次操作要多久。
适合：

* RPC 请求
* 交互式操作
* 单帧渲染
* 实时控制

### 6.2 吞吐

单位时间处理多少工作。
适合：

* 批处理
* 编解码
* 数据转换
* 大规模数值计算

### 6.3 带宽

常用于访存密集代码：

```text
GB/s = 读写总字节数 / 时间
```

例如：

```cpp
c[i] = a[i] + b[i];
```

每个 `float` 元素大约：

* 读 `a[i]`：4 字节
* 读 `b[i]`：4 字节
* 写 `c[i]`：4 字节

理论上至少 12 字节/元素。

### 6.4 cycles / element

适合比较热循环：

```text
cycles_per_element = CPU_cycles / element_count
```

它比单纯毫秒更接近机器成本。

### 6.5 并行加速比

```text
speedup = T1 / Tp
efficiency = speedup / p
```

如果 8 线程只快 2 倍，要继续问：

* 是锁争用？
* 是内存带宽？
* 是任务太小？
* 是 false sharing？
* 是负载不均？

---

## 7. Profiling 的基本流程

一个稳定流程：

1. 用 benchmark 或业务指标确认问题存在
2. 用 profiler 找热点
3. 根据热点提出假设
4. 改一处
5. 重新 benchmark
6. 记录结果

不要一上来重构一大片。
性能优化要像做实验：每次只改变一个主要变量。

---

## 8. 常用 profiling 工具

### 8.1 Linux

常见工具：

* `perf`
* `gprof`
* Valgrind / Callgrind
* Intel VTune
* flamegraph 工具链

`perf` 基本用法：

```bash
perf stat ./app
perf record -g ./app
perf report
```

看硬件计数器：

```bash
perf stat -e cycles,instructions,cache-misses,branches,branch-misses ./app
```

### 8.2 macOS

常见工具：

* Instruments
* Xcode profiling
* `sample`
* `time`

粗看一个进程：

```bash
sample <pid> 5
```

### 8.3 Windows

常见工具：

* Visual Studio Profiler
* Windows Performance Analyzer
* Intel VTune

### 8.4 GPU

CUDA 常见工具：

* Nsight Systems：看 CPU/GPU 时间线、stream、memcpy、kernel 重叠
* Nsight Compute：看单个 kernel 的 occupancy、访存、warp、指令指标

---

## 9. 火焰图怎么看

火焰图常见规则：

* 横向宽度表示采样占比
* 纵向表示调用栈深度
* 顶部通常是最终执行的函数

看火焰图时不要只找最高的一根。
真正重要的是宽：

```text
越宽，说明越多采样落在这条调用链里。
```

常见判断：

* 宽而浅：可能是某个热循环本身重
* 宽而深：可能是抽象层/调用链成本
* 多处同类热点：可能要改数据布局或整体算法
* 锁相关函数很宽：可能是争用
* allocator 很宽：可能是频繁分配

---

## 10. 硬件计数器的第一批指标

### 10.1 IPC

```text
IPC = instructions / cycles
```

IPC 低可能意味着：

* cache miss 多
* 分支预测差
* 依赖链长
* 指令等待资源

但 IPC 不是越高越好。
有些内存带宽型代码 IPC 天然不高。

### 10.2 cache miss

cache miss 高时，要回到访存优化：

* 顺序访问
* blocking
* SoA
* 减少指针追逐
* 降低工作集大小

### 10.3 branch miss

branch miss 高时，考虑：

* 分组处理
* 降低热循环分支
* 用查表或 mask
* 把少见路径挪出去

### 10.4 context switch

上下文切换多时，考虑：

* 线程数是否太多
* 是否频繁阻塞唤醒
* 是否锁竞争严重
* 是否把短任务切得过碎

---

## 11. 并行 benchmark 的特殊坑

### 11.1 线程池预热

第一次提交任务可能包含线程创建成本。
测吞吐时通常要先预热。

### 11.2 任务粒度

并行框架不是免费午餐。
任务太小会被调度开销吃掉收益。

### 11.3 false sharing

每个线程写自己的变量也可能慢。
如果这些变量落在同一 cache line，就会互相抢缓存行所有权。

### 11.4 内存带宽上限

很多 `O(n)` 数组操作扩展到一定线程数后就不再加速。
不是线程库失效，而是内存带宽被打满。

### 11.5 负载不均

平均每个线程分到一样多元素，不代表工作量一样。
例如图算法、稀疏矩阵、变长字符串处理都容易负载不均。

### 11.6 绑定 CPU 和 NUMA

多路 CPU 机器上，线程和内存放错位置会让结果非常不稳定。
这时要结合 NUMA 工具和线程亲和性分析。

---

## 12. 优化前先保证正确性

性能优化会放大未定义行为。
建议先跑基础检查：

```bash
clang++ -fsanitize=address,undefined -g main.cpp
clang++ -fsanitize=thread -g main.cpp
```

常见 sanitizer：

* AddressSanitizer：越界、use-after-free
* UndefinedBehaviorSanitizer：未定义行为
* ThreadSanitizer：数据竞争

如果代码本身有 UB，benchmark 结果可能完全没有意义。

---

## 13. Microbenchmark 和真实场景的关系

微基准适合回答：

* 这个循环的上限在哪里？
* 数据布局 A 和 B 哪个更好？
* SIMD 是否生效？
* 线程数扩展性如何？

但真实系统还包含：

* I/O
* 内存分配
* 调度
* cache 污染
* 多模块交互
* 异常路径

所以要同时保留：

1. microbenchmark：定位局部性能
2. macrobenchmark：验证真实收益
3. regression benchmark：防止后续退化

---

## 14. 一个推荐优化工作流

可以按这个顺序走：

1. 明确性能目标
   例如一帧低于 16ms，或吞吐达到 5GB/s。

2. 建立可重复 benchmark
   固定输入、构建类型、运行环境。

3. 找热点
   用 profiler，而不是猜。

4. 判断瓶颈类型
   算术、访存、分支、锁、分配、I/O、调度。

5. 小步修改
   每次只改一个主要假设。

6. 复测并记录
   保存命令、机器、编译器、输入规模、结果。

7. 回归保护
   把关键 benchmark 纳入日常检查。

---

## 15. 结果记录建议

性能结论最好包含：

* 日期
* 机器型号
* CPU/GPU
* 编译器版本
* 编译选项
* 输入规模
* 线程数
* benchmark 命令
* 旧结果和新结果
* 波动范围

不要只写：

```text
优化后快了很多
```

更好的记录：

```text
n=2^26, clang 17, -O3 -march=native
old: 12.4 ms median
new:  7.1 ms median
speedup: 1.75x
note: memory bandwidth from 64 GB/s to 112 GB/s
```

---

## 16. 常见误区

### 16.1 “一次运行快就是快”

不够。
要看多次运行、波动范围和输入规模。

### 16.2 “微基准快，真实系统就一定快”

不一定。
真实系统可能被 I/O、分配、锁、调度或数据转换主导。

### 16.3 “profiler 显示哪里热就直接重写哪里”

先判断热点是否可优化。
有些热点是算法本质，有些热点只是被调用次数多。

### 16.4 “CPU 使用率高就是好事”

CPU 忙不代表有效工作多。
忙等、自旋、cache miss、锁争用都可能让 CPU 看起来很忙。

### 16.5 “所有 benchmark 都要追求纳秒”

不需要。
用户关心的是端到端延迟或吞吐时，宏基准更重要。

---

## 17. 一页总结

性能工程最重要的是闭环：

1. 先建立可重复测量
2. 用 profiler 找热点
3. 根据数据提出假设
4. 小步修改
5. 复测验证
6. 记录结果和环境

一句话：

> 没有测量的优化只是猜测，没有复测的优化只是愿望。

---

## 18. 建议继续补充的相关主题

和本篇衔接最紧密的内容：

1. Google Benchmark 深入用法
2. Linux `perf` 与硬件计数器
3. 火焰图生成和解读
4. Nsight Systems / Nsight Compute
5. 性能回归测试与 CI 集成

---

## 19. 参考资料

1. Google Benchmark
   <https://github.com/google/benchmark>

2. Brendan Gregg: Flame Graphs
   <https://www.brendangregg.com/flamegraphs.html>

3. Linux perf wiki
   <https://perf.wiki.kernel.org/>

4. LLVM Sanitizers
   <https://clang.llvm.org/docs/index.html>
