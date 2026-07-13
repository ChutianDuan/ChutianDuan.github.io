---
title: "线程已经绑核，为什么访问内存仍然很慢？从首次触页理解 NUMA"
date: 2026-07-13 13:55:20
updated: 2026-07-13 13:55:20
categories:
  - "学习"
  - "高性能 C++ 并行编程"
permalink: /notes/高性能c-并行编程/17-numa与多路cpu访存/
series: "高性能 C++ 并行编程"
series_order: 17
---

一段数组扫描程序在单个 CPU 插槽（socket）内扩展得很好：1 个线程处理需要 80 ms，8 个线程只需 12 ms。我们继续把线程数增加到 16，并把另一半线程放到第二个插槽，结果却只降到 10 ms，吞吐几乎不再增长。

第一反应往往是“线程调度有问题”，于是把线程固定到各自核心。结果仍然没有明显改善。

真正的问题可能发生得更早：数组由主线程统一初始化，绝大多数物理页落在主线程所在的 NUMA node。第二个插槽上的线程虽然没有迁移，却一直穿过插槽互连访问远端内存。**线程位置稳定了，但线程和数据仍然没有对齐。**

本文将围绕这个反直觉现象，讲清 NUMA（Non-Uniform Memory Access，非一致内存访问）、Linux 的本地分配与首次触页、线程亲和性、分区归约和跨插槽缓存一致性。最后会给出一个 Linux 专用的完整 C++17 示例，用相同计算对比“单线程首次写入”和“工作线程分区首次写入”。

## 1. 我们遇到了什么问题？

先看一种很自然的写法：主线程创建并初始化数组，然后多个线程各处理一段。

```cpp
// 存在 NUMA 隐患的写法
std::vector<double> values(element_count, 0.0);

// 后续才启动分布在不同 NUMA node 上的工作线程
parallel_for_chunks(values, [](double& value) {
    value = compute(value);
});
```

在普通桌面程序、小工作集或单 NUMA node 环境中，这样写完全合理。但在多路服务器上，主线程对整个数组的初始化可能让大量页面在同一个 node 上获得物理内存。其他 node 上的线程随后访问这些页面，就会产生远端访存。

更容易忽略的一点是：

```cpp
std::vector<double> values(element_count);
```

这也不是“只申请地址，尚未初始化元素”。`std::vector` 的这个构造函数会对 `double` 元素进行值初始化，通常需要写入零。也就是说，等到我们再执行一次所谓的“并行首次初始化”时，页面很可能早已被构造 `vector` 的线程触碰过。

问题因此不只是“后面由谁计算”，而是三个位置是否匹配：

```text
线程在哪个 CPU 上运行
          |
          v
该 CPU 属于哪个 NUMA node
          |
          v
线程访问的物理页位于哪个 node
```

只控制第一项，不代表第三项会自动正确。

## 2. NUMA 为什么让同一地址拥有不同成本？

NUMA 的直观含义是：**处理器访问不同物理内存区域的延迟和可用带宽不一定相同。**

在典型的双插槽服务器中，每个插槽连接自己的内存通道，同时通过片间互连与另一个插槽通信：

```text
            本地访问                         本地访问
CPU / node 0 ---------- memory node 0   memory node 1 ---------- CPU / node 1
      |                        \           /                         |
      +------------------------- interconnect ----------------------+
                         跨 node 的远端访问
```

node 0 上的线程访问 memory node 0，通常拥有较低延迟和较高可用带宽；它访问 memory node 1 时，请求需要经过互连，成本通常更高，也会占用有限的互连带宽。

这里要避免把三个概念强行画等号：

- socket 是物理处理器封装；
- NUMA node 是一组具有相近内存访问特性的 CPU 与内存；
- CPU 是操作系统用于调度的逻辑处理器编号。

很多双路服务器确实表现为“每个 socket 一个或多个 NUMA node”，但具体映射由硬件、固件和系统配置决定。一个 socket 可以被划分成多个 node，也可能存在没有本地内存的 node。因此，不能用猜测代替拓扑查询。

### 2.1 远端访问为什么会破坏扩展性？

假设一个数组求和主要受内存带宽限制。增加同一 node 内的线程，可以逐步使用该 node 的内存通道；当线程扩展到另一个 node 时，如果数据仍全部位于 node 0，新线程并没有获得 node 1 的本地内存带宽，反而共同争用 node 0 和片间互连。

于是可能出现这样的曲线：

```text
1 thread   1.0x
8 threads  6.8x    <- node 0 内扩展良好
16 threads 8.1x    <- 跨 node 后收益骤降
32 threads 8.4x    <- 更多线程只增加争用
```

这条曲线不能单独证明 NUMA 是原因，但它提供了排查信号。还需要通过 CPU/内存绑定实验、页面分布和硬件指标验证。

## 3. “首次触页”到底发生了什么？

### 3.1 申请虚拟地址不等于立即获得所有物理页

大块堆内存通常先获得一段虚拟地址。对匿名内存而言，物理页常在进程第一次真正访问相应页面并发生缺页异常（page fault）时才分配。

在没有更具体策略、cpuset 限制或内存压力干扰时，Linux 默认倾向从造成页面分配的 CPU 所在 node 获取本地内存。工程里常把这种结果概括为 first touch（首次触页）：

```text
申请虚拟地址
     |
     | 尚未逐页写入
     v
线程在 node 1 第一次写某一页
     |
     v
Linux 按当时有效的内存策略，优先从本地 node 1 分配物理页
```

“谁先写，页面就永远在哪”只是便于理解的近似说法，不是语言标准保证。更准确地说，页面位置由**缺页发生时的 Linux 内存策略、执行 CPU、允许 node 集合和可用内存**共同决定。

以下因素都会改变结果：

- `numactl`、`set_mempolicy()` 或 `mbind()` 设置了显式策略；
- cgroup/cpuset 限制了进程可用的 CPU 或内存 node；
- 本地 node 内存不足，允许回退到其他 node；
- Linux 自动 NUMA balancing 后续迁移了热页或任务；
- 映射类型、透明大页和虚拟化环境改变了页面行为。

而且，改变策略通常只影响之后分配的页面。已经 fault 并获得物理页的范围不会仅因后来设置新策略就自动重新分配；迁移已有页面需要额外机制。

### 3.2 为什么“先 `vector`，再并行清零”可能无效？

下面两步看似实现了并行 first touch：

```cpp
std::vector<double> values(element_count);  // 已经值初始化元素
parallel_fill(values, 0.0);                 // 很可能不是首次写入
```

第一行已经要求元素成为 `0.0`，实现需要写入数组。第二行只是再次访问已经分配的页面，并不会自动让页面跟随工作线程搬家。

若确实要演示“保留地址后由工作线程首次写入”，可以立即用 RAII 接管一个未对标量元素做值初始化的数组：

```cpp
std::unique_ptr<double[]> values(new double[element_count]);
```

这里刻意没有写成 `new double[element_count]()`；末尾括号会对元素进行值初始化。所有元素必须在读取前由工作线程完整写入，否则读取未初始化值会产生未定义行为。真实工程也可以使用 `mmap`、NUMA 分配 API 或分 node 内存池获得更明确的策略，但不要为了 first touch 随意放弃资源安全。

## 4. 如何写出一个最小可运行的 NUMA 实验？

下面的程序提供两种模式：

- `serial`：主线程固定到第一个 CPU，并写入整个数组；
- `parallel`：两个工作线程固定到不同 CPU，各自首次写入并负责一半数组。

之后，两种模式都让相同的两个工作线程并行求和，并输出求和阶段耗时。程序用于观察页面布局对计算的影响，不用于宣称某台机器必然获得固定加速比。

### 4.1 运行限制

- 语言标准：C++17；
- 平台：Linux；
- 需要 glibc/pthreads 提供的非标准接口 `pthread_setaffinity_np`；
- 机器应至少有两个可用 NUMA node；
- CPU 编号必须根据当前机器和容器允许集合选择；
- 当前笔记所在的 macOS 环境不能直接编译或验证该 Linux 专用示例。

将代码保存为 `numa_first_touch.cpp`：

```cpp
#define _GNU_SOURCE

#include <pthread.h>
#include <sched.h>

#include <array>
#include <chrono>
#include <cstddef>
#include <exception>
#include <iomanip>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <system_error>
#include <thread>

void pin_current_thread(int cpu) {
    if (cpu < 0 || cpu >= CPU_SETSIZE) {
        throw std::out_of_range("CPU id is outside cpu_set_t capacity");
    }

    cpu_set_t mask;
    CPU_ZERO(&mask);
    CPU_SET(cpu, &mask);

    const int error =
        pthread_setaffinity_np(pthread_self(), sizeof(mask), &mask);
    if (error != 0) {
        throw std::system_error(error, std::generic_category(),
                                "pthread_setaffinity_np");
    }
}

template <class Function>
void run_on_two_cpus(int cpu0,
                     int cpu1,
                     std::size_t element_count,
                     const Function& function) {
    std::array<std::exception_ptr, 2> errors{};
    const std::size_t middle = element_count / 2;

    std::thread first([&] {
        try {
            pin_current_thread(cpu0);
            function(0, 0, middle);
        } catch (...) {
            errors[0] = std::current_exception();
        }
    });

    std::thread second([&] {
        try {
            pin_current_thread(cpu1);
            function(1, middle, element_count);
        } catch (...) {
            errors[1] = std::current_exception();
        }
    });

    first.join();
    second.join();

    for (const auto& error : errors) {
        if (error) {
            std::rethrow_exception(error);
        }
    }
}

struct alignas(64) PartialSum {
    double value = 0.0;
};

int main(int argc, char* argv[]) {
    if (argc != 4) {
        std::cerr << "usage: " << argv[0]
                  << " <serial|parallel> <cpu0> <cpu1>\n";
        return 1;
    }

    const std::string mode = argv[1];
    constexpr std::size_t element_count = std::size_t{1} << 24; // 128 MiB

    if (mode != "serial" && mode != "parallel") {
        std::cerr << "mode must be serial or parallel\n";
        return 1;
    }

    try {
        const int cpu0 = std::stoi(argv[2]);
        const int cpu1 = std::stoi(argv[3]);

        // 没有 ()：double 元素尚未值初始化；unique_ptr 负责最终释放。
        std::unique_ptr<double[]> values(new double[element_count]);

        if (mode == "serial") {
            pin_current_thread(cpu0);
            for (std::size_t i = 0; i < element_count; ++i) {
                values[i] = 1.0;
            }
        } else {
            run_on_two_cpus(cpu0, cpu1, element_count,
                            [&](int, std::size_t begin, std::size_t end) {
                for (std::size_t i = begin; i < end; ++i) {
                    values[i] = 1.0;
                }
            });
        }

        std::array<PartialSum, 2> partial{};
        const auto begin_time = std::chrono::steady_clock::now();

        run_on_two_cpus(cpu0, cpu1, element_count,
                        [&](int worker, std::size_t begin, std::size_t end) {
            double local = 0.0;
            for (std::size_t i = begin; i < end; ++i) {
                local += values[i];
            }
            partial[static_cast<std::size_t>(worker)].value = local;
        });

        const auto end_time = std::chrono::steady_clock::now();
        const double sum = partial[0].value + partial[1].value;
        const std::chrono::duration<double, std::milli> elapsed =
            end_time - begin_time;

        std::cout << std::fixed << std::setprecision(3)
                  << "mode=" << mode
                  << ", sum=" << sum
                  << ", elapsed=" << elapsed.count() << " ms\n";
    } catch (const std::exception& error) {
        std::cerr << "error: " << error.what() << '\n';
        return 1;
    }
}
```

先查看拓扑，不要照抄 CPU 编号：

```bash
lscpu -e=CPU,NODE,SOCKET,CORE
numactl --hardware
```

假设查询结果表明 CPU 0 属于 node 0、CPU 16 属于 node 1，可以在 Linux 上编译并分别运行：

```bash
clang++ -std=c++17 -O2 -DNDEBUG -Wall -Wextra -pthread \
  numa_first_touch.cpp -o numa_first_touch

./numa_first_touch serial 0 16
./numa_first_touch parallel 0 16
```

输出形式如下，时间需要以目标机器实测为准：

```text
mode=serial, sum=16777216.000, elapsed=<本机结果> ms
mode=parallel, sum=16777216.000, elapsed=<本机结果> ms
```

两个模式的 `sum` 都应为 `16777216.000`。不要只各运行一次就下结论；应交替顺序、重复运行，记录中位数和波动，并确认 CPU 频率、透明大页、自动 NUMA balancing、系统负载和内存策略一致。

128 MiB 对某些机器仍不足以稳定暴露差异，对另一些受限环境又可能过大。可调整 `element_count`，但要同时记录工作集大小，避免比较不同实验。

## 5. 这段代码真正控制了哪些变量？

### 5.1 数据所有权与初始化状态

`std::unique_ptr<double[]>` 独占数组并在退出时自动执行 `delete[]`，因此没有裸 owning pointer 泄漏问题。数组最初处于未初始化状态，但 `serial` 和 `parallel` 两条路径都会在求和前写完全部元素。

如果删掉任何一段初始化，求和就可能读取不确定值；对某些类型和表达式，这会进一步导致未定义行为。first touch 不是跳过初始化的理由，而是改变**谁完成必要初始化**。

### 5.2 线程位置

`pthread_setaffinity_np` 把每个工作线程的亲和性掩码设为一个 CPU。它是名称带 `_np` 的 GNU/Linux 非可移植扩展，不属于 ISO C++ 或 POSIX 标准接口。

即使调用成功，实际允许集合仍可能受到 cpuset、容器或作业调度器限制。若指定的 CPU 不在当前进程允许集合中，程序会报告错误，而不是悄悄把失败实验当成有效数据。

### 5.3 页面首次写入者

`parallel` 模式把数组分成两个连续区间，由之后负责读取该区间的线程先写。这实现了最基本的数据本地性原则：

> 谁长期负责一段大数据，尽量也由谁在目标 CPU 上首次写入那段数据。

连续分区还减少了线程交错访问同一页面的机会。分界处可能共享一个物理页，但相对 128 MiB 工作集通常可以忽略；严苛实验可进一步按页边界对齐。

### 5.4 局部归约

每个线程先在寄存器中的 `local` 完成求和，只在结束时写一次自己的 `PartialSum`。最终由主线程合并两个小结果：

```text
node 0: 本地扫描 -> partial[0] --+
                                  +-> final sum
node 1: 本地扫描 -> partial[1] --+
```

`alignas(64)` 用于降低两个部分和共享常见 64 字节缓存行的风险，但缓存行大小与对齐需求仍应在目标架构确认。这里每个线程只写一次，即使不填充，影响也可能很小；它主要展示“线程本地累积，最后合并”的设计。

## 6. 绑核为什么仍然不是 NUMA 优化的终点？

线程亲和性只解决“计算在哪里执行”。如果大数组已经在远端 node，绑核甚至会稳定地重复远端访问。长期有效的设计通常还要处理数据布局、所有权和任务调度。

### 6.1 静态分区：让大数据少跨 node 移动

适合规则数组的基本模式是：

```text
node 0 线程组：初始化并处理 [0, middle)
node 1 线程组：初始化并处理 [middle, end)
每个 node 内部完成局部归约
最后只跨 node 合并少量结果
```

图算法、稀疏矩阵和变长记录的“元素数相等”不一定等于工作量相等。此时要同时平衡计算量与数据位置，而不是机械地一分为二。

### 6.2 work stealing：负载均衡可能牺牲数据本地性

任务窃取（work stealing）让空闲线程从繁忙线程队列拿任务，能缓解负载不均。但如果偷来的任务携带对另一个 node 大块数据的访问，CPU 利用率提高的同时，远端流量也会增加。

常见折中是先按 node 建立粗粒度分区，在 node 内进行更积极的任务窃取；只有负载明显失衡时才跨 node 窃取。是否值得这样做必须由真实工作负载验证。

### 6.3 内存分配器：分配线程、触页线程和使用线程都重要

分配器可能拥有线程本地缓存或 arena，但“从哪个 arena 返回虚拟地址”与“物理页最终在哪个 node”不是同一件事。需要同时问：

- 哪个线程申请地址？
- 哪个线程首次写入页面？
- 之后哪个线程长期访问对象？
- 对象是否频繁跨 node 转移所有权？

对大量小对象，页面已经被 allocator 的旧使用模式触碰，简单 first touch 不一定可控。每 node arena、分区对象池或明确的 NUMA API可能更合适，但应在确认分配和远端访问是热点后再引入。

### 6.4 伪共享：每个线程写不同变量也可能跨插槽争用

缓存一致性以缓存行（cache line）为粒度。两个线程即使写不同计数器，只要计数器位于同一缓存行，写权限就可能在核心之间反复转移；跨插槽时成本通常更高。

```cpp
// 存在伪共享风险
std::vector<std::uint64_t> counters(thread_count);
// thread i repeatedly writes counters[i]
```

常见修正是让频繁写入的线程私有状态分离缓存行，并减少写入频率。单纯增加对齐不能解决多个线程争用同一个逻辑变量，也不能修复随机访问导致的大量远端读取。

### 6.5 全局原子：一个地址会成为跨 node 汇合点

让所有线程对同一个全局计数器频繁执行原子读改写，会让包含它的缓存行在核心间争夺所有权。NUMA 环境放大了这种通信成本。

更好的方向通常不是寻找“更快的原子内存序”，而是改变算法：线程本地累积、node 本地合并、最后全局合并。只有必须即时发布的共享状态才值得承受全局同步成本。

## 7. 如何证明问题确实来自 NUMA？

### 7.1 先观察真实拓扑

Linux 上可从这些工具开始：

```bash
lscpu
numactl --hardware
lstopo
```

`lstopo` 来自 hwloc，需要目标系统已经安装相应工具；本文不要求为示例新增依赖。容器、虚拟机和批处理系统可能只暴露部分 CPU/node，看到的拓扑应以进程实际允许集合为准。

### 7.2 做对照实验，而不是只看一个计数器

可以比较几组受控场景：

| 场景 | CPU 位置 | 内存位置/策略 | 想回答的问题 |
| --- | --- | --- | --- |
| 本地绑定 | node 0 | node 0 | 单 node 基线是多少？ |
| 远端绑定 | node 1 | node 0 | 远端访问惩罚有多大？ |
| 分区首次触页 | node 0 + 1 | 各自本地页 | 能否同时利用两侧带宽？ |
| 交错分配 | node 0 + 1 | page 级交错 | 带宽平摊是否优于局部性？ |

`numactl` 可用于建立部分对照：

```bash
numactl --show
numactl --cpunodebind=0 --membind=0 ./app
numactl --cpunodebind=1 --membind=0 ./app
numactl --interleave=all ./app
```

这些命令中的 node 编号必须来自本机查询。`--membind` 是严格 node 集合，内存不足时可能失败；`--localalloc` 是优先本地、必要时允许回退；`--interleave` 按策略在多个 node 间分布页面。三者不是同义选项。

交错分配能让多个内存控制器共同提供带宽，适合所有线程均匀扫描整个只读大数组的某些场景；它也可能让原本可完全本地处理的分区变成一部分远端访问，因此并非默认最优策略。

### 7.3 检查进程页面分布

可以在另一个终端观察运行中的进程：

```bash
numastat -p <PID>
sed -n '1,80p' /proc/<PID>/numa_maps
```

`numastat` 中的 hit/miss 或 other-node 统计需要结合当前 memory policy 解释；它们不是“缓存命中率”。短程序结束太快时，应使用真实服务或增加受控工作量，而不是为了观察方便把休眠时间计入 Benchmark。

### 7.4 查看缓存行争用与硬件事件

Linux `perf c2c` 可辅助定位缓存行争用和伪共享；内存控制器、互连流量和远端访问事件则与 CPU 型号密切相关。事件名称和语义需要查目标处理器的性能监控文档，不能把一台机器的 `perf -e` 列表直接复制到另一台机器。

最后仍要回到扩展性曲线：单 node、跨 node、不同线程数、不同数据规模分别如何变化。工具证据与 Benchmark 结果互相印证，才能形成可信结论。

## 8. 常见误区

### 8.1 误区：NUMA node 就是 CPU socket

两者经常相关，但不保证一一对应。正确做法是查询 CPU、node、socket、缓存和内存的实际拓扑，并记录容器或 cpuset 限制。

### 8.2 误区：只要并行清零，就一定完成了并行 first touch

如果容器构造、分配器或先前逻辑已经写过页面，清零并不是首次触页。`std::vector<double>(n)` 的值初始化就是典型例子。应审查从申请地址到首次读写的完整生命周期。

### 8.3 误区：线程绑核后，数据会自动跟过去

线程亲和性不等于页面迁移。已分配页面的位置受原策略影响；自动 NUMA balancing 是否迁移、何时迁移也不能作为所有应用的即时保证。需要重新布局、使用内存策略或显式迁移，并通过测量验证。

### 8.4 误区：`--interleave=all` 一定能获得最高带宽

交错策略可能平摊内存通道，也可能制造稳定的远端访问。所有线程共同读取全局数据与每个 node 独占分区，需要的策略不同。

### 8.5 误区：线程数平均，负载就均衡

线程拿到相同元素数，不代表计算量相同；计算量相同，也不代表访存位置合理。NUMA 调度需要同时考虑工作量和数据本地性。

### 8.6 误区：多线程变慢一定是锁竞争

锁只是跨核通信的一种来源。远端页面、共享写缓存行、全局原子、内存带宽饱和和任务迁移都可能造成相似表象。先分类证据，再修改代码。

## 9. 什么时候值得专门优化 NUMA？

NUMA 优化最值得关注的场景包括：多路服务器上的大数组扫描、数据库与 KV 存储、图计算、稀疏矩阵、大规模仿真、网络包批处理，以及频繁分配或共享队列密集的服务。这些任务的工作集通常远大于缓存，并且容易受到内存带宽或缓存一致性限制。

以下情况通常不应把 NUMA 放在优化清单首位：程序只使用单个 node、数据大多驻留缓存、线程数很少、主要瓶颈是磁盘或网络 I/O，或者端到端性能尚未证明受内存系统限制。

即使机器存在多个 node，也不要为了“NUMA-aware”先引入复杂调度器。先验证跨 node 扩展拐点，再从连续分区、并行首次写入和局部归约这些低复杂度措施开始。

## 10. 总结

回到开头的问题：线程已经绑核，内存访问为什么仍然慢？因为亲和性只决定线程在哪里运行，并不自动改变已经分配的物理页位置，也不消除跨 node 的共享写。

1. NUMA 的关键不是地址是否相同，而是执行 CPU 与物理页之间的拓扑距离。
2. Linux 默认本地分配常在页面实际 fault 时生效；首次触页是一种有条件的工程规律，不是 C++ 标准保证。
3. `std::vector<double>(n)` 已经值初始化元素，不能先用它触页，再期待一次并行清零重新放置页面。
4. 最基础的优化模式是数据分区、本地首次写入、本地计算、本地归约，最后只合并小结果。
5. 绑核、`numactl` 和硬件计数器是建立与验证实验的工具，真正长期有效的是线程、任务和数据所有权的一致性。

可以直接用于实践的建议是：**当程序跨 socket 后扩展性突然变差时，先画出“哪个线程在哪个 node、首次写了哪些页、长期访问哪段数据”，再做同 node、远端内存和分区 first-touch 三组对照实验。**

## 参考资料

- [Linux 内核：NUMA Memory Policy](https://www.kernel.org/doc/html/latest/admin-guide/mm/numa_memory_policy.html)
- [Linux 内核：NUMA policy hit/miss statistics](https://docs.kernel.org/admin-guide/numastat.html)
- [numactl(8)](https://man7.org/linux/man-pages/man8/numactl.8.html)
- [pthread_setaffinity_np(3)](https://man7.org/linux/man-pages/man3/pthread_setaffinity_np.3.html)
- [hwloc](https://www.open-mpi.org/projects/hwloc/)
