---
title: "NUMA 与多路 CPU 访存"
date: 2026-05-08 14:23:23
updated: 2026-05-08 14:23:23
categories:
  - "学习"
  - "高性能C++并行编程"
permalink: /notes/高性能c-并行编程/17-numa与多路cpu访存/
---

# NUMA 与多路 CPU 访存

时间：2026/05/08

> 关键词：NUMA、socket、本地内存、远端内存、first touch、线程亲和性、内存带宽、cache coherence
> 核心目标：理解多路 CPU 机器上“内存离哪个核更近”，以及怎样避免并行程序被远端访存拖慢。

---

## 1. NUMA 是什么

NUMA 是 Non-Uniform Memory Access。
意思是：

> CPU 访问不同位置的内存，成本不一定一样。

在单路桌面机器上，可以先粗略认为 CPU 访问内存的距离差异不明显。
但在多路服务器上，每个 CPU socket 往往连接着自己附近的一组内存通道。

如果线程运行在 socket 0，却频繁访问 socket 1 附近的内存，就会发生远端访存。
远端访存通常有更高延迟，也会消耗 socket 之间互连带宽。

---

## 2. UMA 和 NUMA 的直觉差异

UMA：

```text
所有核心访问内存成本近似一样
```

NUMA：

```text
核心访问本地内存更快
核心访问远端内存更慢
```

一个很粗略的模型：

```text
socket 0 ---- local memory 0
   |
 interconnect
   |
socket 1 ---- local memory 1
```

线程、数据、内存页的位置都开始影响性能。

---

## 3. 为什么高性能 C++ 要关心 NUMA

很多并行程序在单 socket 内扩展很好，但跨 socket 后突然变差：

```text
1 线程：  1x
8 线程：  7x
16 线程： 12x
32 线程： 13x
```

可能原因不是线程库不好，而是：

* 远端内存访问增加
* socket 间互连带宽被打满
* 跨 socket 共享数据导致 cache line 来回迁移
* 锁或原子变量集中在一个 NUMA node
* 内存初始化在一个线程完成，页面都落在一个 node

NUMA 问题常常不是小数据问题，而是大数据、高吞吐、多线程问题。

---

## 4. first touch 原则

很多操作系统采用 first touch 策略：

> 内存页第一次被哪个 CPU 附近的线程写入，就倾向于分配到那个 NUMA node。

坏模式：

```cpp
std::vector<double> a(n);

// 单线程初始化
for (std::size_t i = 0; i < n; ++i) {
    a[i] = 0.0;
}

// 后面多线程处理
parallel_work(a);
```

如果初始化线程在 socket 0 上运行，大量页面可能被放到 socket 0。
后续 socket 1 上的线程访问自己负责的数据时，也可能是在远端读写。

更好的模式：

```cpp
std::vector<double> a(n);

// 让将来负责这段数据的线程先触摸这段数据
parallel_for_chunks(n, [&](std::size_t begin, std::size_t end) {
    for (std::size_t i = begin; i < end; ++i) {
        a[i] = 0.0;
    }
});

parallel_for_chunks(n, [&](std::size_t begin, std::size_t end) {
    for (std::size_t i = begin; i < end; ++i) {
        a[i] = compute(i);
    }
});
```

核心思想：

> 谁负责处理某段数据，最好也由谁先初始化那段数据。

---

## 5. NUMA 下最重要的数据划分方式

最常见的好模式是静态分区：

```text
socket 0/thread group 0 处理 a[0, mid)
socket 1/thread group 1 处理 a[mid, n)
```

每个分区尽量满足：

* 本线程组初始化
* 本线程组主要读写
* 本线程组局部归约
* 最后只合并小结果

坏模式通常是：

```text
所有线程随机访问整个大数组
所有线程写一个共享队列
所有线程更新同一个全局计数器
所有 socket 频繁读写同一批对象
```

这些模式会把本地访问变成远端访问，把局部缓存变成跨 socket 通信。

---

## 6. 跨 socket 共享 cache line 的成本

已有的 false sharing 在 NUMA 上会更痛。

例如每个线程写自己的计数器：

```cpp
std::vector<std::uint64_t> counters(num_threads);

// 每个线程写 counters[tid]
```

如果多个计数器落在同一 cache line，cache line 会在核心之间迁移。
如果这些核心跨 socket，迁移成本更高。

更好的做法：

```cpp
struct alignas(64) Counter {
    std::uint64_t value = 0;
};

std::vector<Counter> counters(num_threads);
```

这不能解决所有 NUMA 问题，但能避免最典型的 false sharing。

---

## 7. 局部归约优于全局原子

坏模式：

```cpp
std::atomic<double> global_sum{0.0};

parallel_for(..., [&] {
    global_sum.fetch_add(value);
});
```

即使类型支持原子加，这也往往很慢。
所有线程都争一个位置，cache line 会在核心和 socket 之间来回迁移。

更好的模式：

```cpp
std::vector<double> partial(num_threads, 0.0);

parallel_for_threads([&](int tid, std::size_t begin, std::size_t end) {
    double local = 0.0;
    for (std::size_t i = begin; i < end; ++i) {
        local += work(i);
    }
    partial[tid] = local;
});

double sum = 0.0;
for (double x : partial) {
    sum += x;
}
```

NUMA 机器上还可以再进一步：

```text
线程本地归约
socket 本地归约
全局最终归约
```

---

## 8. 线程亲和性是什么

线程亲和性是把线程尽量固定在某些 CPU core 上运行。

如果线程一直搬家，会带来：

* cache 热数据失效
* first touch 布局和执行位置不匹配
* benchmark 波动更大

亲和性不是所有程序都要手动设置。
但在多路 CPU、高吞吐、低延迟系统里，它很常见。

常见工具或 API：

* `numactl`
* `taskset`
* `pthread_setaffinity_np`
* `sched_setaffinity`
* hwloc
* TBB `task_arena` 和 affinity 相关机制

注意：

* 绑定过死可能影响系统调度
* 容器和虚拟机环境里 CPU 拓扑可能被隐藏
* benchmark 环境和生产环境要区分

---

## 9. 用 numactl 观察和控制

Linux 上常用：

```bash
numactl --hardware
```

查看 NUMA node、CPU 和内存分布。

只在某个 node 上运行：

```bash
numactl --cpunodebind=0 --membind=0 ./app
```

交错分配内存：

```bash
numactl --interleave=all ./app
```

这些命令适合做实验：

* 绑定同一 node
* 故意绑定远端内存
* 交错分配
* 比较不同策略的带宽和延迟

如果不同策略差异很大，说明程序对 NUMA 很敏感。

---

## 10. 常用观察工具

### 10.1 lscpu

```bash
lscpu
```

可以看：

* socket 数
* core 数
* thread 数
* NUMA node

### 10.2 numastat

```bash
numastat
numastat -p <pid>
```

可以观察进程内存分布和远端访问线索。

### 10.3 hwloc

```bash
lstopo
```

可以看更完整的硬件拓扑：

* NUMA node
* socket
* core
* cache 层级
* PCIe 设备

### 10.4 perf c2c

`perf c2c` 可以帮助分析 cache line 争用。
它对定位 false sharing 和跨核 cache line 迁移很有用。

---

## 11. NUMA 和内存分配器

内存分配器也会影响 NUMA。

关注点：

* 分配发生在哪个线程
* 初始化发生在哪个线程
* 对象之后主要由哪个线程使用
* 是否有全局 allocator 锁
* 是否使用线程本地 cache

工程里常见策略：

1. 每个线程或每个 socket 使用本地 arena
2. 避免一个线程分配、另一个 socket 大量使用
3. 大数组并行初始化
4. 热对象不要在 socket 间频繁转移所有权

这和 `std::pmr`、内存池、线程本地缓存都能接起来。

---

## 12. NUMA 和任务调度

任务调度器喜欢负载均衡。
NUMA 喜欢数据本地性。

这两者有时会冲突。

例如 work stealing 可以让空闲线程偷任务，提高 CPU 利用率。
但如果偷来的任务访问远端 node 的大数据，可能导致远端访存增加。

工程上常见折中：

* 大任务先按 NUMA node 分区
* node 内部再做 work stealing
* 小结果最后跨 node 合并
* 对内存带宽型任务减少跨 node 迁移

TBB 这类调度器已经做了很多局部性优化，但仍需要你给出合理的数据划分和任务粒度。

---

## 13. 哪些程序最容易受 NUMA 影响

高风险场景：

* 大数组扫描
* 稀疏矩阵
* 图算法
* 数据库 / KV 存储
* 大规模仿真
* 日志/网络包批处理
* 高频共享队列
* 多线程内存分配密集程序

低风险场景：

* 数据很小
* 主要瓶颈是 I/O
* 单 socket 内运行
* 线程数不高
* 工作集大多在 cache 中

判断标准很朴素：

> 如果程序已经被内存带宽或 cache coherence 限制，NUMA 很可能重要。

---

## 14. 一个简单的 NUMA 排查流程

1. 确认机器拓扑
   `lscpu`、`numactl --hardware`、`lstopo`

2. 测单线程和多线程扩展性
   看跨 socket 后是否突然变差。

3. 测不同绑定策略
   同 node、跨 node、interleave。

4. 检查内存初始化
   是否单线程 first touch。

5. 检查共享写
   是否有全局原子、锁、队列、计数器。

6. 改成分区处理
   本地初始化、本地计算、本地归约。

7. 复测
   看吞吐、延迟和波动是否改善。

---

## 15. 常见误区

### 15.1 “多线程慢就是锁的问题”

不一定。
跨 socket 远端访存和 cache line 迁移也会让程序很慢。

### 15.2 “内存分配在哪里不重要”

在 NUMA 上很重要。
分配和 first touch 可能决定页面位置。

### 15.3 “线程越均匀越好”

计算量均匀还不够。
数据位置也要尽量匹配。

### 15.4 “interleave 一定最好”

不一定。
交错分配能平摊带宽，但也可能破坏本地性。

### 15.5 “NUMA 只和服务器有关”

主要出现在多路服务器，但任何有明显内存拓扑差异的系统都值得留意。
只是普通桌面小程序通常不需要先处理它。

---

## 16. 一页总结

NUMA 的核心理解链：

1. 不同 CPU 到不同内存的距离可能不同
2. first touch 会影响页面放在哪里
3. 线程位置和数据位置不匹配会导致远端访存
4. 跨 socket 共享 cache line 很贵
5. 本地分区、本地初始化、本地归约通常是第一解
6. 绑定和工具只是验证手段，数据布局才是长期方案

一句话：

> NUMA 优化的核心不是“绑核”，而是让计算尽量发生在数据旁边。

---

## 17. 建议继续补充的相关主题

和本篇衔接最紧密的内容：

1. Linux `numactl` / `numastat` 实战
2. hwloc 拓扑建模
3. TBB task arena 与 NUMA-aware 调度
4. 多 socket 上的内存带宽 benchmark
5. 数据库和图计算中的 NUMA 分区设计

---

## 18. 参考资料

1. hwloc
   <https://www.open-mpi.org/projects/hwloc/>

2. Linux numactl
   <https://github.com/numactl/numactl>

3. Intel Optimization Manual
   <https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html>
