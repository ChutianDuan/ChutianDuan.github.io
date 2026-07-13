---
title: "Load 已经 24，CPU 为什么还有空闲？建立 Linux 性能排查的证据链"
date: 2026-07-13 15:43:57
updated: 2026-07-13 15:43:57
categories:
  - "学习"
  - "Linux 与 C++ 工程化"
permalink: /notes/liunx-c-工程化/3-liunx性能优化笔记/
series: "Linux 与 C++ 工程化"
series_order: 3
---

凌晨告警响起：一台 16 核服务器的 Load Average 升到 24，接口 P99 延迟翻了几倍。第一反应通常是“CPU 不够，赶紧扩容”，可 `top` 却显示 CPU 仍有大量空闲。重启服务后指标暂时恢复，几个小时后问题再次出现。

这个现场至少留下了三个问题：Load 统计的究竟是什么？服务是在抢 CPU，还是在等待磁盘、网络存储或内存回收？即使找到了一个高指标，又怎样证明它是根因而不是结果？

性能分析最容易陷入两个误区：一是看到某个指标高就立即下结论，二是记住了很多命令，真正出问题时却不知道下一条命令为什么要运行。本文不打算罗列所有 Linux 性能工具，而是围绕一条可验证的主线展开：

> **先确认业务现象，再判断哪类资源出现压力；从系统定位到进程、线程，最后落到函数、系统调用或具体文件和连接。**

CPU、内存、磁盘和网络不是互相独立的。内存回收可能带来磁盘 I/O，网络小包可能推高软中断，磁盘等待又可能让平均负载上升。真正有效的分析，依靠的是指标之间的关联，而不是某一张孤立的截图。

文中的 `/proc`、PSI、cgroup、`perf`、`strace` 等接口和工具面向 Linux，不能直接照搬到 macOS 或 Windows。命令输出还会随内核、发行版、procps、sysstat 与 cgroup 版本略有差异；生产排查时应先确认环境，并与同一机器的正常基线比较。当前整理环境是 macOS，因此 Linux 专属命令只依据内核和工具文档核对，没有在本机伪造运行结果。

---

## 一、面对“Load 24”，为什么不能先猜 CPU 不够？

### 1. 先描述问题，不要急着猜原因

先把问题说清楚：

- 业务表现是什么：响应变慢、吞吐下降、请求超时、错误率升高，还是进程被杀？
- 问题从什么时候开始：持续发生、周期性发生，还是偶发尖峰？
- 影响范围有多大：单个请求、单个进程、容器、某台机器，还是整个集群？
- 最近发生了什么变化：代码发布、配置修改、流量增长、数据量增长、依赖异常或宿主机迁移？

性能优化最终服务于业务指标。CPU 从 80% 降到 60%，不一定代表优化成功；如果延迟、吞吐和错误率没有改善，这个变化可能没有实际价值。

### 2. 用 USE 思路缩小范围

对 CPU、内存、磁盘、网卡等系统资源，可以先从三个角度检查：

| 维度 | 含义 | 示例 |
| --- | --- | --- |
| Utilization | 资源使用了多少 | CPU 使用率、网卡带宽使用率、磁盘忙碌时间 |
| Saturation | 是否出现排队和等待 | CPU 运行队列、磁盘请求队列、Socket 队列 |
| Errors | 是否发生错误 | OOM、磁盘错误、网络丢包、TCP 重传 |

一个资源使用率不高，也可能已经出现延迟问题；一个资源使用率很高，也不一定已经饱和。因此，使用率、排队和错误应放在一起看。

### 3. 按层次向下定位

```text
业务现象：延迟、吞吐、错误率
  ↓
系统资源：CPU、内存、文件系统、磁盘、网络
  ↓
进程：哪个进程消耗资源或持续等待
  ↓
线程：哪个线程异常
  ↓
行为：热点函数、系统调用、内存分配、文件、Socket
```

如果一开始就对某个进程运行 `perf` 或 `strace`，很可能花了不少时间，却分析错了方向。

### 4. 关注趋势，而不是单个瞬时值

- 使用相同采样间隔对比不同工具，实时排查通常从 `1s` 开始。
- 连续观察多组数据，区分持续瓶颈和瞬时尖峰。
- 建立正常时的基线，异常值应与正常业务时段比较。
- `vmstat`、`iostat` 等工具的第一组数据可能是开机以来的平均值，实时分析时重点看后续采样。
- `/proc` 中很多数据是累计值，应间隔采样并比较增长速度。

### 5. 从低开销工具开始

推荐顺序：

```text
系统概览
  → 进程和线程
  → perf / strace / tcpdump / eBPF
```

`perf`、`strace`、抓包和动态追踪都会带来额外开销。生产环境中应限制目标、采样时间和输出量，先保存现场，再考虑重启或修改参数。

### 6. 压力指标 PSI

较新的 Linux 内核提供 Pressure Stall Information，用来描述任务因为 CPU、内存或 I/O 资源不足而停顿的时间：

```bash
cat /proc/pressure/cpu
cat /proc/pressure/memory
cat /proc/pressure/io
```

- `some`：至少有部分任务因资源不足而停顿。
- `full`：所有非空闲任务都同时停顿。系统级 CPU `full` 没有可解释的实际含义；部分较新内核为了接口兼容会报告为 0，CPU 压力主要看 `some`。
- `avg10/avg60/avg300`：最近 10、60、300 秒的压力比例。

PSI 不直接告诉你根因，但很适合回答一个问题：**资源压力是否已经真实影响任务运行。**

如果 `/proc/pressure/` 不存在，需要检查内核版本、`CONFIG_PSI` 配置以及启动参数；不能把“文件不存在”解释为系统没有资源压力。

---

## 二、CPU 问题分析

CPU 问题不只是“使用率过高”。运行队列过长、上下文切换频繁、单核打满、软中断异常、虚拟机被宿主机抢占 CPU，都会让业务变慢。

排查 CPU 时，先回答三个问题：

1. CPU 时间主要消耗在哪里？
2. 是谁在消耗，还是谁在等待？
3. 最终是哪段代码或哪类内核行为导致的？

### 2.1 先读懂平均负载

`uptime` 和 `top` 中的三个 Load Average，分别表示过去 1、5、15 分钟的平均活跃任务数。

活跃任务包括：

- `R`：正在 CPU 上运行，或正在运行队列中等待 CPU。
- `D`：不可中断睡眠，通常正在等待磁盘、NFS 或其他内核 I/O。

```bash
uptime
nproc
lscpu
```

分析时先与逻辑 CPU 数比较：

- Load 接近 CPU 数：系统基本没有额外调度余量。
- Load 持续高于 CPU 数：运行队列或不可中断任务正在积压。
- 1 分钟值明显高于 15 分钟值：负载近期快速上升。
- 1 分钟值明显低于 15 分钟值：负载正在回落。

> Load 高不等于 CPU 使用率高。大量 `D` 状态任务同样会抬高负载。

### 2.2 CPU 时间告诉我们该往哪里查

| 指标 | 含义 | 异常时优先排查 |
| --- | --- | --- |
| `%us` / `%usr` | 用户态 CPU 时间 | 应用计算、死循环、低效算法、序列化 |
| `%nice` | 低优先级用户态时间 | 设置过 nice 的计算任务 |
| `%sy` / `%system` | 内核态 CPU 时间 | 系统调用、上下文切换、内核线程 |
| `%wa` / `%iowait` | CPU 空闲但存在未完成 I/O 的时间 | 磁盘、网络存储、Swap |
| `%hi` / `%irq` | 硬中断时间 | 网卡、存储设备、中断分布 |
| `%si` / `%soft` | 软中断时间 | 网络收发、定时器等软中断 |
| `%st` / `%steal` | 被虚拟化宿主机抢占的时间 | 宿主机超卖和资源竞争 |
| `%id` / `%idle` | 空闲时间 | 持续接近 0 表示 CPU 接近饱和 |

这里有三个容易忽略的细节：

- 多核机器上，多线程进程的 `%CPU` 可以超过 `100%`。
- 整体 CPU 不高，不代表没有单核瓶颈；要检查每个 CPU 核心。
- `iowait` 是 CPU 时间统计，不是磁盘利用率，仍需结合磁盘延迟和队列判断。

### 2.3 运行队列和上下文切换

`vmstat` 是 CPU 初筛时非常好用的工具：

```bash
vmstat 1 10
```

重点看：

```text
r b | in cs | us sy id wa st
```

| 指标 | 含义 | 常见判断 |
| --- | --- | --- |
| `r` | 正在运行和等待 CPU 的任务数 | 持续大于 CPU 数，说明 CPU 竞争明显 |
| `b` | 不可中断睡眠任务数 | 持续升高通常应转入 I/O 分析 |
| `in` | 每秒中断次数 | 突增时检查设备和网络 |
| `cs` | 每秒上下文切换次数 | 结合 `sy`、线程数和业务基线判断 |

上下文切换分为两类：

- 自愿切换：进程等待 I/O、锁、条件变量等资源，主动让出 CPU。
- 非自愿切换：时间片耗尽或被更高优先级任务抢占。

```bash
pidstat -w -p <PID> 1 5
pidstat -w -t -p <PID> 1 5
```

| 指标 | 含义 |
| --- | --- |
| `cswch/s` | 每秒自愿上下文切换 |
| `nvcswch/s` | 每秒非自愿上下文切换 |

- `cswch/s` 高：检查 I/O 等待、锁竞争、条件变量和频繁唤醒。
- `nvcswch/s` 高：检查线程数、运行队列和 CPU 争抢。

上下文切换没有适用于所有机器的固定阈值，必须与正常基线、吞吐和 CPU 时间一起分析。

### 2.4 CPU 常用工具

#### `top`：先看全局，再找进程

```bash
top
```

常用交互：

- `1`：展开每个 CPU。
- `P`：按 CPU 使用率排序。
- `H`：显示线程。
- `M`：按内存排序。

重点观察：

- Load Average 和任务状态。
- `%us`、`%sy`、`%wa`、`%si`、`%st`。
- 是否只有某个 CPU 核心打满。
- 高 CPU 进程是否处于 `R`、`D` 或 `Z` 状态。

#### `mpstat`：检查单核热点和 CPU 时间分布

```bash
mpstat -P ALL 1 5
```

它适合发现 CPU 使用是否均衡，以及用户态、内核态、I/O 等待、中断或 steal 是否集中在少数核心。

#### `pidstat`：定位进程和线程

```bash
# 所有进程
pidstat -u 1 5

# 指定进程
pidstat -u -p <PID> 1 5

# 查看指定进程的线程
pidstat -u -t -p <PID> 1 5
```

重点看：

- `%usr`：进程用户态 CPU。
- `%system`：进程内核态 CPU。
- `%wait`：任务等待 CPU 调度的时间。

#### `ps` 和 `pstree`：补充进程状态与父子关系

```bash
ps -eo pid,ppid,tid,psr,stat,pcpu,pmem,comm --sort=-pcpu | head
pstree -ap <PID>
```

- `psr`：线程当前或最近运行的 CPU。
- `stat`：重点关注 `R`、`D`、`Z`。
- `pstree`：适合发现频繁创建的子进程和外部命令。

### 2.5 从进程继续定位到函数

找到高 CPU 进程后，下一步不是立即“优化代码”，而是先确认热点到底在哪里。

实时查看热点：

```bash
perf top -p <PID>
```

采样调用栈：

```bash
perf record -F 99 -g -p <PID> -- sleep 15
perf report
```

分析时重点看：

- 热点位于应用、动态库还是内核。
- 哪个函数占用最多采样。
- 调用链上是谁反复调用热点函数。

如果大量显示未知符号，应检查：

- 二进制和动态库是否缺少符号。
- 调试构建是否包含 `-g`。
- 调用栈不完整时是否缺少 frame pointer 或 DWARF 支持。

系统态 CPU 较高时，还可以短时间检查系统调用：

```bash
strace -c -p <PID>
```

重点看是否存在高频或持续失败的 `futex`、`read`、`write`、`poll` 等调用。`strace` 会影响目标进程，生产环境中应谨慎使用。

### 2.6 按现象选择 CPU 排查路径

#### 用户态 CPU 高

```text
top 找进程
  → pidstat 找线程
  → perf 找热点函数和调用链
```

常见原因：死循环、复杂计算、忙轮询、低效算法、流量增长。

#### 系统态 CPU 高

```text
pidstat 查看进程内核态 CPU 和上下文切换
  → strace 查看高频系统调用
  → perf 查看用户态与内核态调用链
```

常见原因：高频系统调用、锁竞争、频繁调度、内存回收和内核线程繁忙。

#### Load 高，但 CPU 使用率不高

重点检查：

```bash
vmstat 1 10
ps -eo pid,stat,wchan:32,comm | awk '$2 ~ /^D/'
```

如果 `b` 和 `D` 状态任务增多，问题通常在磁盘、NFS、块设备或其他内核资源等待。

#### 软中断或硬中断高

```bash
cat /proc/interrupts
cat /proc/softirqs
```

如果 `NET_RX`、`NET_TX` 增长很快，应继续检查网络 PPS、丢包、小包和异常流量。还要观察中断是否过度集中在某个 CPU。

#### 普通工具找不到高 CPU 进程

可能是：

- 短生命周期进程创建后迅速退出。
- 应用持续崩溃和重启。
- 父进程频繁执行外部命令。
- CPU 消耗在软中断或内核线程。

```bash
pstree -ap
perf record -F 99 -a -g -- sleep 15
perf report
```

环境支持 eBPF/BCC 时，可以使用 `execsnoop` 捕获短时进程。

#### 容器 CPU 使用率不高，但请求变慢

容器可能被 CPU 配额限流。cgroup v2 可以检查：

```bash
cat /sys/fs/cgroup/cpu.stat
```

重点关注 `nr_throttled` 和 `throttled_usec` 是否持续增长。此时宿主机 CPU 可能仍有空闲，但容器已经用完自己的配额。容器运行时和 cgroup namespace 会影响实际挂载路径，应先从 `/proc/self/cgroup` 与挂载信息确认当前进程所属 cgroup，不要假定所有环境都把目标文件暴露在同一路径。

### 2.7 CPU 常见误区

- Load 高就是 CPU 高：错误，`D` 状态任务也会提高 Load。
- 整体 CPU 不高就没有问题：错误，可能只有单核打满。
- 进程 CPU 不会超过 100%：错误，多线程进程可以占用多个核心。
- 上下文切换高就一定异常：错误，应与业务基线和有效吞吐一起判断。
- iowait 高就等于磁盘 100%：错误，必须继续检查设备延迟和队列。
- 调低进程优先级就解决了问题：通常只是缓解竞争，没有消除根因。

---

## 三、内存问题分析

Linux 会主动使用空闲内存做缓存。因此，内存分析最重要的一步，是先区分“内存被有效利用”和“系统已经出现内存压力”。

排查内存时应依次回答：

1. 系统是否真的缺内存？
2. 内存主要去了哪里？
3. 是合理工作集、缓存、泄漏、碎片，还是内核内存？
4. 是否已经触发回收、Swap 或 OOM？

### 3.1 先理解虚拟内存和物理内存

进程访问的是虚拟地址空间，内核通过页表映射到物理内存。进程申请虚拟内存后，物理页通常在首次访问、触发缺页异常时才真正分配。

进程用户空间主要包括：

- 代码段和只读数据。
- 数据段：全局变量和静态变量。
- 堆：`malloc()`、`new` 等动态分配。
- 文件映射区：动态库、共享内存和 `mmap()` 文件。
- 栈：局部变量和函数调用上下文。

内存紧张时，Linux 通常依次尝试：

1. 回收页缓存和可回收 Slab。
2. 将不活跃匿名页换出到 Swap。
3. 内存仍然不足时触发 OOM。

### 3.2 系统内存指标

```bash
free -h
free -w -h
```

| 指标 | 含义 |
| --- | --- |
| `total` | 物理内存总量 |
| `used` | 已使用内存，计算方式会随工具版本略有差异 |
| `free` | 完全空闲的物理内存 |
| `shared` | 共享内存，主要包括 tmpfs |
| `buff/cache` | Buffer、页缓存和部分可回收 Slab |
| `available` | 不发生明显 Swap 时，新进程可使用的估算内存 |

判断内存是否紧张时，优先看 `available`，不要只盯着 `free`。`free` 很低但 `available` 充足，通常只是 Linux 充分利用了内存做缓存。

更详细的组成可以查看：

```bash
cat /proc/meminfo
```

重点字段：

- `MemAvailable`
- `Cached`、`Buffers`
- `AnonPages`、`Mapped`、`Shmem`
- `Slab`、`SReclaimable`、`SUnreclaim`
- `Dirty`、`Writeback`
- `PageTables`
- `SwapTotal`、`SwapFree`

### 3.3 进程内存指标

| 指标 | 含义 | 注意事项 |
| --- | --- | --- |
| `VIRT` / `VSZ` | 虚拟地址空间 | 大不等于实际占用物理内存多 |
| `RES` / `RSS` | 常驻物理内存 | 包含共享页，进程间可能重复统计 |
| `SHR` | 可能共享的常驻页面 | 不代表所有页面都真正被共享 |
| `PSS` | 共享页按进程数均摊后的物理内存 | 统计多进程总占用时更准确 |
| `USS` | 进程独占的物理内存 | 进程退出后可立即释放的主要部分 |
| `VmSwap` | 进程换出到 Swap 的内存 | 可从 `/proc/<PID>/status` 查看 |

先找高内存进程：

```bash
top
ps -eo pid,ppid,stat,rss,vsz,pmem,comm --sort=-rss | head
```

再查看指定进程：

```bash
pidstat -r -p <PID> 1 10
pmap -x <PID>
cat /proc/<PID>/status
cat /proc/<PID>/smaps_rollup
```

`smaps_rollup` 能快速给出 PSS、匿名页、文件页和私有页等汇总，比直接阅读完整 `smaps` 更方便。

### 3.4 缺页异常

缺页异常分为：

- 次缺页 `minor fault`：不需要磁盘 I/O，例如分配新的匿名页或复用页缓存。
- 主缺页 `major fault`：需要从文件或 Swap 读取页面，开销明显更大。

```bash
pidstat -r 1 10
sar -B 1 5
```

重点关注：

- `minflt/s`：每秒次缺页。
- `majflt/s`：每秒主缺页。

主缺页持续升高时，需要检查可用内存、Swap 活动、工作集大小和文件读取模式。

### 3.5 Page Cache、Buffer 和 Slab

- Page Cache：缓存文件数据。
- Buffer：缓存块设备相关数据。
- Slab：缓存内核对象。
- `SReclaimable`：可回收 Slab。
- `SUnreclaim`：不可回收 Slab。

当进程 RSS 都不高，但系统可用内存持续下降时，应检查 Slab：

```bash
slabtop
```

常见增长对象包括 dentry、inode、网络对象和文件系统对象。如果 `SUnreclaim` 持续增长，需要进一步检查内核模块、驱动、容器和网络行为。

`buff/cache` 很高时，先看 `available`：

- `available` 充足且无 Swap 活动：通常是正常缓存。
- `available` 持续下降，并伴随回收、主缺页或 Swap：缓存已经开始参与内存竞争。

### 3.6 Swap：看活动，不要只看占用

```bash
vmstat 1 10
sar -W 1 5
```

| 指标 | 含义 |
| --- | --- |
| `swpd` | 已使用的 Swap |
| `si` | 每秒从 Swap 换入内存 |
| `so` | 每秒将内存换出到 Swap |

`swpd` 不为 0，但 `si/so` 长期为 0，不一定存在当前性能问题，可能只是历史上换出的冷页仍留在 Swap。

如果 `si/so`、主缺页和磁盘延迟同时升高，说明系统正在活跃换页，应用延迟通常会明显恶化。

查找使用 Swap 的进程：

```bash
grep -H '^VmSwap:' /proc/[0-9]*/status 2>/dev/null
```

### 3.7 如何判断内存泄漏

典型泄漏表现是：

- 在相似负载下，进程 RSS 长期单调增长。
- 请求结束或任务完成后，内存仍不回落。
- 未释放分配的数量和总字节数持续增长。

排查路径：

```text
free/vmstat 确认系统趋势
  → pidstat/top 找到增长进程
  → pmap/smaps_rollup 确认增长区域
  → 内存分析工具定位分配调用栈
```

环境支持 BCC 时，可以追踪未释放分配：

```bash
/usr/share/bcc/tools/memleak -p <PID>
```

C/C++ 程序在测试环境还可以使用：

- AddressSanitizer：检查越界、Use After Free 和泄漏。
- LeakSanitizer：检测泄漏。
- Valgrind Memcheck：运行开销较大，但适合离线定位。
- Heap profiler：分析分配热点和堆增长。

需要注意，RSS 不下降不一定是泄漏，也可能是：

- `malloc` 分配器缓存了已释放内存。
- 内存碎片导致页面无法归还内核。
- 应用缓存、对象池或队列没有上限。
- Page Cache 或文件映射增长。

### 3.8 OOM 与容器内存限制

查看系统 OOM 日志：

```bash
dmesg -T | grep -Ei 'out of memory|oom|killed process'
journalctl -k | grep -Ei 'out of memory|oom|killed process'
```

确认：

- 是整机 OOM 还是 cgroup OOM。
- 哪个进程被杀。
- 当时的内存、Swap 和进程占用。
- 容器内存上限是否过小。

进程的 OOM 倾向：

```bash
cat /proc/<PID>/oom_score
cat /proc/<PID>/oom_score_adj
```

cgroup v2 中可以检查：

```bash
cat /sys/fs/cgroup/memory.current
cat /sys/fs/cgroup/memory.max
cat /sys/fs/cgroup/memory.events
```

`memory.events` 中的 `oom`、`oom_kill` 持续增长，说明容器或 cgroup 已经触发内存限制。

不要只通过降低 `oom_score_adj` 掩盖泄漏，否则可能导致其他进程被杀，甚至让整机失去响应。

### 3.9 内存快速排查路径

```bash
free -h
vmstat 1 10
cat /proc/pressure/memory
cat /proc/meminfo
pidstat -r 1 5
```

按内存去向继续分析：

```text
进程 RSS 高
  → pmap / smaps_rollup
  → 泄漏、无界缓存、线程栈、匿名 mmap

buff/cache 高
  → 看 available 和回收压力
  → 分析文件访问和缓存来源

Slab 高
  → slabtop
  → dentry、inode、网络对象、内核模块

Swap 活跃
  → 找高内存进程
  → 同时检查磁盘延迟和主缺页

进程占用不高但系统内存不足
  → Page Cache、Slab、tmpfs、HugePages、PageTables
```

### 3.10 内存常见误区

- `free` 很低就是内存不足：错误，应优先看 `available`。
- `VIRT` 很大就是泄漏：错误，虚拟地址不等于物理内存。
- 把所有进程 RSS 相加就是总内存：错误，共享页会重复统计。
- Swap 已使用就一定很慢：错误，关键看当前 `si/so` 和主缺页。
- RSS 不下降就是没有调用 `free()`：错误，分配器缓存和碎片也会造成这种现象。
- 缓存占内存应该立即清理：错误，缓存通常在提高性能，并可在压力下回收。
- `drop_caches` 是常规优化手段：错误，它会破坏缓存，只适合受控测试。
- OOM 只会在整机内存耗尽时发生：错误，cgroup 达到内存上限也会触发 OOM。

---

## 四、文件系统与磁盘 I/O 分析

文件系统和磁盘经常被混为一谈，但它们处在不同层次：

```text
应用程序
  → read/write/fsync 等系统调用
  → VFS 和具体文件系统
  → Page Cache
  → 通用块层与 I/O 调度
  → 设备驱动
  → 本地磁盘或网络存储
```

文件系统负责组织文件、目录和元数据；块设备负责真正持久化数据。分析 I/O 问题时，要先分清是容量、文件系统缓存、应用读写方式，还是底层设备出现瓶颈。

### 4.1 文件系统中几个重要概念

- inode：保存文件类型、权限、大小、时间和数据块位置等元数据。
- dentry：保存文件名和目录层级关系，主要存在于内存缓存中。
- Page Cache：缓存文件内容，减少直接访问慢速磁盘。
- VFS：为 ext4、XFS、NFS、OverlayFS 等文件系统提供统一接口。

文件数据空间充足，不代表文件系统一定还能创建新文件。inode 数量耗尽时，即使磁盘仍有剩余空间，也会出现 `No space left on device`。

### 4.2 I/O 模式会直接影响性能

常见分类：

- 缓冲 I/O 与非缓冲 I/O：是否使用语言或标准库缓冲。
- Buffered I/O 与 Direct I/O：是否经过操作系统 Page Cache。
- 阻塞 I/O 与非阻塞 I/O：当前线程是否因等待而停住。
- 同步 I/O 与异步 I/O：提交后是否需要等待整个操作完成。

数据库常使用 Direct I/O 自己管理缓存；日志和事务系统常关注 `fsync()` 延迟；普通文件读取通常受益于 Page Cache。脱离具体访问模式讨论“磁盘快不快”，结论很容易失真。

### 4.3 先检查容量、inode 和挂载关系

```bash
df -h
df -i
findmnt
lsblk -f
```

- `df -h`：文件系统容量。
- `df -i`：inode 使用率。
- `findmnt`：挂载点、设备和文件系统类型。
- `lsblk -f`：块设备、文件系统和挂载关系。

查找大目录：

```bash
du -xhd1 <目录> | sort -h
```

`-x` 可以限制在当前文件系统内，避免跨挂载点统计。

### 4.4 `df` 和 `du` 为什么可能不一致

常见原因：

1. 文件已经被删除，但仍被进程打开。
2. 目录下存在其他挂载点，统计范围不同。
3. 文件系统元数据、预留空间或快照占用。
4. 容器 OverlayFS 让宿主机和容器看到的层次不同。

检查“已删除但仍被占用”的文件：

```bash
lsof +L1
```

只要进程仍持有文件描述符，文件占用的磁盘空间就不会释放。通常应让应用重新打开日志文件或安全重启对应进程，而不是盲目删除更多文件。

### 4.5 磁盘 I/O 的关键指标

磁盘性能不能只看 `%util`。至少要同时观察 IOPS、吞吐、延迟、队列和请求大小。

| 指标 | 含义 | 关注点 |
| --- | --- | --- |
| `r/s`、`w/s` | 每秒读写请求数，即 IOPS | 随机小 I/O 场景尤其重要 |
| `rkB/s`、`wkB/s` | 每秒读写吞吐量 | 顺序大块 I/O 场景更重要 |
| `r_await`、`w_await` | 读写平均完成时间 | 包含排队和设备处理时间 |
| `aqu-sz` | 平均 I/O 队列长度 | 持续增长说明请求正在积压 |
| `rareq-sz`、`wareq-sz` | 平均读写请求大小 | 用来区分小随机 I/O 和大块 I/O |
| `%util` | 设备处理 I/O 的忙碌时间比例 | 需结合设备类型和队列解释 |

不要机械套用“`%util` 超过某个值就是瓶颈”：

- 单队列机械盘上，接近 100% 往往表示设备持续忙碌。
- NVMe、RAID、云盘和多队列设备能并行处理请求，`%util` 的解释更复杂。
- 即使 `%util` 不高，单次同步写或网络存储延迟也可能已经影响业务。

真正关键的是：**设备延迟和队列是否明显高于正常基线，业务是否正在等待这些 I/O。**

### 4.6 `iostat`：确认设备是否存在瓶颈

```bash
iostat -xz 1 10
```

分析顺序：

1. 看 `r_await`、`w_await` 是否升高。
2. 看 `aqu-sz` 是否积压。
3. 看 IOPS、吞吐和请求大小，判断负载类型。
4. 再结合 `%util` 和设备基准判断是否饱和。

不同 sysstat 版本的字段名可能略有差异，必要时使用：

```bash
man iostat
```

### 4.7 从设备定位到进程

```bash
pidstat -d 1 10
iotop
```

`pidstat -d` 常见指标：

- `kB_rd/s`：进程每秒读取量。
- `kB_wr/s`：进程每秒写入量。
- `kB_ccwr/s`：被取消的写入量。
- `iodelay`：块 I/O 和换页等待时间。

`iotop` 适合按实时读写量和 I/O 等待排序，快速找出最活跃的进程或线程。

如果设备很忙但看不到明显用户进程，还要考虑：

- Page Cache 正在异步回写。
- Swap 或内存回收。
- 文件系统日志和内核线程。
- RAID、LVM、设备映射或网络存储。
- 短生命周期进程。

### 4.8 从进程定位到文件和系统调用

查看进程打开的文件：

```bash
lsof -p <PID>
```

查看文件系统调用汇总：

```bash
strace -c -p <PID>
```

短时间跟踪文件操作：

```bash
strace -tt -T -e trace=openat,read,write,fsync,fdatasync -p <PID>
```

- `-tt`：显示精确时间。
- `-T`：显示系统调用耗时。
- `-e trace=...`：只跟踪相关调用，降低输出量。

如果普通 `strace` 无法捕获短时操作，环境支持 eBPF/BCC 时可以使用：

- `opensnoop`：追踪打开文件。
- `filetop`：按文件统计读写。
- `biolatency`：统计块设备延迟分布。
- `biosnoop`：追踪单次块 I/O。

### 4.9 文件系统缓存和写回

写入普通文件时，数据往往先进入 Page Cache，并被标记为 Dirty，随后由内核异步写回磁盘。

```bash
grep -E 'Dirty|Writeback|Cached|SReclaimable' /proc/meminfo
```

如果 `Dirty` 持续增长、`Writeback` 活跃并伴随磁盘延迟升高，说明写入速度可能超过设备持续处理能力。此时应用最初可能感觉写入很快，等脏页达到阈值后才突然出现明显阻塞。

同步写场景中，`fsync()` 或 `fdatasync()` 的延迟更能直接反映持久化成本。数据库和日志系统的性能问题，常常不是平均吞吐不足，而是同步写尾延迟过高。

### 4.10 I/O 常见问题的排查路径

#### 磁盘空间不足

```text
df -h 确认文件系统
  → du 找大目录和大文件
  → lsof +L1 检查已删除但仍打开的文件
  → 检查日志、临时文件、快照和容器层
```

#### inode 耗尽

```text
df -i
  → 定位大量小文件目录
  → 检查日志切分、缓存文件、临时文件和任务输出
```

#### iowait 高、进程处于 `D` 状态

```text
vmstat 确认 b/wa
  → iostat 确认设备延迟和队列
  → pidstat/iotop 找进程
  → lsof/strace 找文件和系统调用
```

#### 磁盘延迟高

需要区分：

- 请求量是否超过设备能力。
- 是大量随机小 I/O，还是大块顺序 I/O。
- 写延迟是否远高于读延迟。
- 队列是在应用、文件系统、块层还是远端存储中形成。
- 是否同时发生内存回收或 Swap。

#### I/O 高，但找不到业务进程

重点检查：

```bash
vmstat 1 10
grep -E 'Dirty|Writeback|Swap' /proc/meminfo
ps -eo pid,ppid,stat,wchan:32,comm | grep -E 'flush|jbd|kworker|kswapd'
```

可能是异步写回、文件系统日志、Swap、内核线程或设备层任务。

#### 设备错误或文件系统突然只读

性能下降不一定只是负载过高，也可能是设备超时、链路重置或文件系统检测到错误：

```bash
dmesg -T | grep -Ei 'I/O error|blk_update|nvme|reset|ext4|xfs|read-only'
journalctl -k | grep -Ei 'I/O error|nvme|reset|ext4|xfs|read-only'
```

如果日志中出现介质错误、设备重置、文件系统错误或重新挂载为只读，应优先保护数据并检查磁盘、控制器、云盘和宿主机状态。这类问题不能只靠调 I/O 参数解决。

### 4.11 I/O 常见误区

- `df` 有空间就一定能创建文件：错误，inode 也可能耗尽。
- `du` 统计小于 `df` 就是工具错误：错误，可能存在已删除但仍打开的文件。
- `%util` 100% 就一定无法再处理请求：错误，多队列设备需要结合延迟和队列判断。
- IOPS 越高越好：错误，必须结合请求大小、读写模式和延迟。
- 平均延迟正常就没有问题：错误，业务可能受 P99 同步写尾延迟影响。
- iowait 高就是 CPU 不够：错误，它通常提示应转入存储或 Swap 分析。
- 清理 Page Cache 能优化磁盘：通常错误，缓存正是用来减少磁盘访问的。

---

## 五、网络问题分析

网络问题最难的地方，是数据会经过很多层：

```text
应用协议：HTTP、DNS、RPC
  → Socket
  → TCP / UDP
  → IP 与路由
  → qdisc、网卡驱动和 Ring Buffer
  → 网卡、交换机、路由器
  → 对端协议栈和应用
```

因此，“请求慢”不一定是网络；“ping 正常”也不代表应用连接、TLS、DNS 和服务端处理都正常。

排查网络时，建议依次回答：

1. 配置和路由是否正确？
2. 网卡是否有错误、丢包或队列积压？
3. TCP/UDP 协议栈是否出现重传、连接失败或队列溢出？
4. 问题发生在 DNS、建连、传输，还是应用处理阶段？
5. 抓包看到的真实收发过程是什么？

### 5.1 网络性能的关键指标

| 指标 | 含义 | 常见用途 |
| --- | --- | --- |
| 带宽 | 链路理论最大传输速率 | 判断链路上限 |
| 吞吐量 | 单位时间成功传输的数据量 | 判断实际使用率 |
| PPS | 每秒处理的网络包数 | 分析小包和转发压力 |
| RTT | 数据包往返延迟 | 判断链路延迟 |
| 并发连接数 | 当前 TCP/UDP Socket 数量 | 分析连接压力 |
| 丢包率 | 未成功送达的数据包比例 | 定位链路、队列或主机丢包 |
| 重传率 | TCP 重发数据的比例 | 判断拥塞、丢包和超时 |
| 错误率 | 网卡或协议栈错误 | 定位硬件、驱动和协议问题 |
| Socket 队列 | 未处理或未确认的数据 | 判断应用或网络侧积压 |

同样的吞吐量下，小包的 PPS 更高，会消耗更多中断、协议栈和 CPU 资源。因此网络分析必须同时看字节数和包数。

### 5.2 先检查网卡、地址和路由

```bash
ip -br addr
ip -s link
ip route
ip neigh
```

重点确认：

- 网卡是否为 `UP`、`LOWER_UP`。
- IP、掩码、默认路由是否正确。
- MTU 是否与物理网络、VPN、VXLAN 或容器网络匹配。
- RX/TX 的 `errors`、`dropped`、`overruns` 是否持续增长。
- ARP/邻居表是否出现 `FAILED`、`INCOMPLETE`。

网卡速率、双工和驱动信息：

```bash
ethtool <网卡>
ethtool -S <网卡>
```

`ethtool -S` 中的统计字段由驱动定义，名称并不统一，但可以帮助定位 Ring Buffer、CRC、队列和硬件丢包。

### 5.3 吞吐量、PPS 和网卡错误

```bash
sar -n DEV 1 10
sar -n EDEV 1 10
```

`sar -n DEV` 重点看：

- `rxpck/s`、`txpck/s`：接收和发送 PPS。
- `rxkB/s`、`txkB/s`：接收和发送吞吐量。
- `%ifutil`：接口使用率，前提是工具能正确获得链路速率。

`sar -n EDEV` 用于查看接口错误和丢包。

如果吞吐量不高但 PPS 很高，通常意味着大量小包。此时可能出现：

- `%soft` 和 `ksoftirqd` CPU 升高。
- 网卡接收队列或协议栈处理不及时。
- SYN Flood、扫描、短连接风暴或高频 RPC。

### 5.4 Socket 和 TCP 连接状态

```bash
ss -s
ss -lntp
ss -ntp
```

已建立连接中：

- `Recv-Q`：应用尚未读取的数据。
- `Send-Q`：已发送但尚未被对端确认的数据。

如果 `Recv-Q` 持续积压，通常说明应用消费不及时；如果 `Send-Q` 持续积压，可能是对端处理慢、链路拥塞、丢包或发送缓冲受限。

监听 Socket 中，队列表示等待应用 `accept()` 的连接情况和队列上限。监听队列溢出时，客户端可能出现连接超时或拒绝。

统计 TCP 状态：

```bash
ss -ant | awk 'NR>1 {count[$1]++} END {for (state in count) print state, count[state]}'
```

常见状态提示：

- 大量 `SYN-RECV`：握手未完成，可能是客户端异常、丢包或 SYN Flood。
- 大量 `TIME-WAIT`：短连接较多，应先检查连接复用和客户端行为。
- 大量 `CLOSE-WAIT`：本端应用收到对端关闭后，没有及时关闭 Socket。
- 大量 `ESTAB`：不一定异常，要与连接基线、内存和文件描述符一起判断。

高并发连接还要检查文件描述符和客户端临时端口：

```bash
cat /proc/<PID>/limits | grep 'open files'
ls /proc/<PID>/fd | wc -l
cat /proc/sys/net/ipv4/ip_local_port_range
```

- 文件描述符耗尽时，应用可能报 `Too many open files`，无法继续接受连接。
- 客户端大量创建到同一目标的短连接时，可能耗尽本地临时端口。
- 解决方向通常是连接复用、及时关闭 Socket、合理设置连接池和资源上限，而不是只扩大内核参数。

### 5.5 TCP 重传和协议栈错误

```bash
sar -n TCP,ETCP 1 10
nstat -az
netstat -s
```

重点关注：

- TCP 主动和被动建连。
- 连接失败和 Reset。
- 重传分段。
- Listen 队列溢出。
- IP、TCP、UDP 丢包和错误。

这些指标很多是累计值，不能只看绝对数字。应观察故障期间的增长速度，并与请求量比较。

TCP 重传升高常见原因：

- 网络链路丢包或拥塞。
- 对端处理慢，ACK 返回不及时。
- 主机软中断或接收队列处理不过来。
- MTU 或路径 MTU 问题。
- 防火墙、负载均衡和中间设备异常。

### 5.6 连通性、路由和延迟

```bash
ping -c 5 <IP>
traceroute <IP>
mtr -rwzc 20 <IP>
```

- `ping`：测试 ICMP 连通性和 RTT。
- `traceroute`：查看路径中的路由跳点。
- `mtr`：连续观察各跳延迟和丢包。

需要注意：

- 对端或中间设备可能限制 ICMP，ping 不通不一定代表 TCP 服务不可用。
- 某一中间跳不回复 ICMP，不等于该跳真的丢弃业务流量。
- ping 正常只说明 ICMP 基本正常，不代表 DNS、TCP、TLS 和应用响应正常。

测试端口：

```bash
nc -vz <主机> <端口>
```

### 5.7 不要漏掉 DNS

“使用 IP 很快，使用域名很慢”时，应优先检查 DNS：

```bash
dig <域名>
dig +trace <域名>
resolvectl query <域名>
```

重点看：

- DNS 服务器响应时间。
- 是否存在超时和重试。
- `/etc/resolv.conf` 中的服务器与搜索域。
- IPv4、IPv6 查询和 fallback 行为。
- 应用是否每次请求都重新解析，缺少缓存。

许多网络工具默认会反向解析 IP 和端口名，导致命令本身变慢。排查时通常使用 `-n` 或 `-nn` 禁止名称解析。

### 5.8 把应用延迟拆开

HTTP 请求慢时，可以拆分 DNS、TCP、TLS、首字节和总耗时：

```bash
curl -o /dev/null -sS \
  -w 'dns=%{time_namelookup}\nconnect=%{time_connect}\ntls=%{time_appconnect}\nstarttransfer=%{time_starttransfer}\ntotal=%{time_total}\n' \
  https://example.com/
```

判断思路：

- `time_namelookup` 高：DNS。
- `time_connect` 高：TCP 建连、链路丢包或服务端监听队列。
- `time_appconnect` 高：TLS 握手。
- `time_starttransfer` 高：服务端处理或上游依赖。
- `time_total` 高但前几项正常：响应体传输慢或吞吐不足。

这一步能避免把应用处理慢误判为网络慢。

### 5.9 抓包：确认网络中真实发生了什么

当统计指标只能告诉你“有问题”，但无法解释原因时，可以使用 `tcpdump`。

```bash
# 指定网卡、主机和端口，不做名称解析
tcpdump -i <网卡> -nn host <IP> and port <端口>

# 只看 SYN、FIN、RST
tcpdump -i <网卡> -nn 'tcp[tcpflags] & (tcp-syn|tcp-fin|tcp-rst) != 0'

# 保存为 pcap，交给 Wireshark 分析
tcpdump -i <网卡> -nn -s 0 -w capture.pcap host <IP>
```

抓包时应尽量限制：

- 网卡。
- 主机和端口。
- 报文数量或采样时间。
- 保存文件大小。

通过抓包可以确认：

- 三次握手在哪一步超时。
- 是否存在重复 ACK、重传、乱序或 Reset。
- DNS 查询是否超时。
- 请求已经到达服务端，但应用迟迟没有响应。
- MTU、分片或中间设备是否异常。

高 PPS 生产环境不要无过滤地长时间抓包，否则抓包本身就可能增加 CPU、磁盘和丢包压力。

### 5.10 软中断与网络小包

网络包接收后，大部分协议栈工作在软中断中完成。出现以下组合时，应重点检查网络小包：

- `top` 或 `mpstat` 中 `%si` 高。
- `ksoftirqd/<CPU>` CPU 高。
- `/proc/softirqs` 中 `NET_RX` 快速增长。
- `sar -n DEV` 显示 PPS 高，但吞吐量并不高。

```bash
cat /proc/softirqs
mpstat -P ALL 1 5
sar -n DEV 1 10
```

还应检查中断是否集中在少数 CPU，以及网卡多队列、RSS/RPS 等配置是否与 CPU 分布匹配。参数调整应建立在确认瓶颈之后，不应一看到软中断高就直接修改内核配置。

### 5.11 网络快速排查路径

#### 服务完全不可达

```text
ip addr/link 确认网卡和地址
  → ip route 确认路由
  → ping/nc 检查主机和端口
  → ss -lntp 确认服务监听
  → 检查防火墙、负载均衡和安全组
```

#### 请求延迟高

```text
curl 拆分 DNS/TCP/TLS/TTFB
  → ping/mtr 检查链路
  → ss 检查 Socket 队列
  → sar/nstat 检查重传和丢包
  → tcpdump 确认真实收发时序
```

#### 吞吐量上不去

需要同时检查：

- 网卡链路速率和实际吞吐。
- TCP 重传、窗口和 RTT。
- 单连接还是多连接测试。
- CPU、软中断和内存是否成为瓶颈。
- 对端、负载均衡和中间链路限制。
- 应用自身是否生成数据不够快。

基准测试可以使用 `iperf3`，但测试结果只代表对应协议和测试模型，不能直接代替真实业务性能。

#### 丢包或重传高

```text
ip -s link / ethtool -S 定位网卡和驱动层
  → sar -n EDEV / nstat 定位协议栈
  → mtr 判断链路
  → tcpdump 确认报文和方向
```

#### 连接数高或队列溢出

检查：

- 各 TCP 状态数量。
- 监听队列和应用 `accept()` 速度。
- 文件描述符上限。
- 短连接是否缺少连接池和 Keep-Alive。
- 应用事件模型、线程数和单连接内存。

### 5.12 网络常见误区

- ping 正常就代表网络正常：错误，它只覆盖 ICMP 和基本 RTT。
- 吞吐量低就是带宽不足：错误，也可能是丢包、窗口、CPU 或应用限制。
- TIME_WAIT 多就应该立即调内核参数：错误，应先检查短连接和连接复用。
- Recv-Q 高就是对端慢：通常相反，它更可能表示本端应用读取不及时。
- Send-Q 高就是本端发送太快：还可能是对端处理慢、链路丢包或拥塞。
- 抓包能看到重传就一定是发送端网络故障：重传可能由链路、接收端或中间设备引起。
- 一上来修改 TCP 缓冲区和 backlog：错误，应先确认真正的瓶颈和队列位置。

---

## 六、典型案例：从现象一步步走到根因

下面的案例重点不在具体数值，而在排查顺序。示例中的输出经过简化，实际环境应与正常基线、机器配置和业务负载对比。

### 案例 1：接口延迟升高，单个进程 CPU 接近 100%

#### 现象

某个接口发布后，P99 延迟从几十毫秒升到数百毫秒。机器没有明显 I/O 和内存压力，但应用进程 CPU 持续升高。

#### 第一步：确认 CPU 时间花在哪里

```bash
top
mpstat -P ALL 1 5
```

观察到：

- `%us` 很高，`%sy`、`%wa` 不高。
- 某个应用进程 CPU 使用率最高。
- 只有一个 CPU 核心接近 100%，其他核心仍有空闲。

这说明问题主要发生在应用用户态，并且很可能只有一个线程成为热点。

#### 第二步：定位热点线程

```bash
pidstat -u -t -p <PID> 1 5
```

假设结果显示某个 TID 长时间占用一个 CPU。可以把十进制线程 ID 转为十六进制，便于与部分调试工具中的线程编号对应：

```bash
printf '%x\n' <TID>
```

#### 第三步：定位热点函数

```bash
perf record -F 99 -g -p <PID> -- sleep 15
perf report
```

调用栈显示，大部分 CPU 时间都消耗在某个解析、压缩、正则匹配或数据转换函数中。

#### 根因

新版本在请求路径中重复执行了高成本计算，例如：

- 对同一份数据反复解析或序列化。
- 在循环中重复编译正则表达式。
- 本可以复用的计算结果没有缓存。
- 单线程任务无法利用多核。

#### 修复与验证

- 移除重复计算，把不变结果移出循环。
- 复用解析结果或已经编译的对象。
- 优化算法复杂度，而不是只增加机器。
- 如果任务可以安全并行，再考虑拆分工作。

修复后应同时验证：

```text
接口 P99 延迟下降
  + 请求吞吐恢复
  + 热点函数采样比例下降
  + 单核不再持续打满
```

> 仅看到 CPU 使用率下降还不够。如果吞吐也下降了，可能只是少处理了请求。

---

### 案例 2：Load 很高，但 CPU 使用率并不高

#### 现象

系统 Load Average 持续高于 CPU 数，但 `top` 中 `%us + %sy` 不高，应用请求却明显变慢。

#### 第一步：区分运行队列和不可中断任务

```bash
vmstat 1 10
```

示意：

```text
r  b   us sy id wa
1  12   8  4 28 60
```

- `r` 不高，说明等待 CPU 的任务不多。
- `b` 和 `%wa` 很高，说明大量任务正在等待 I/O。

继续查看 `D` 状态进程：

```bash
ps -eo pid,ppid,stat,wchan:32,comm | awk '$3 ~ /^D/'
```

#### 第二步：确认底层设备是否积压

```bash
iostat -xz 1 10
```

重点发现：

- `r_await` 或 `w_await` 明显升高。
- `aqu-sz` 持续积压。
- 某块设备的请求量突然增加。

#### 第三步：找出 I/O 来源

```bash
pidstat -d 1 10
iotop
```

结果发现备份、日志归档或批处理进程正在进行大量随机读写，与在线服务共用同一块磁盘。

#### 根因

Load 升高并不是因为 CPU 不够，而是大量任务进入 `D` 状态。后台任务耗尽磁盘处理能力，在线请求也被迫等待。

#### 修复与验证

- 将批处理安排到低峰期。
- 将在线数据、日志和备份拆分到不同设备。
- 对后台任务设置合理的 I/O 优先级和速率限制。
- 优化随机 I/O，合并小请求。

验证时观察：

- `b` 和 `%wa` 是否下降。
- 磁盘 `await`、队列是否恢复。
- Load 是否随 `D` 状态任务减少而回落。
- 在线请求延迟是否恢复。

---

### 案例 3：进程 RSS 持续增长，最终触发 OOM

#### 现象

服务刚启动时占用 500 MB，运行数小时后增长到数 GB，重启后又恢复。随着运行时间增加，系统开始 Swap，最后进程被 OOM Killer 终止。

#### 第一步：确认是持续增长，而不是单次高峰

```bash
free -h
vmstat 5
pidstat -r -p <PID> 5
```

观察到：

- `available` 持续下降。
- 目标进程 RSS 持续增长。
- 后期出现 `si/so` 和主缺页。

#### 第二步：判断增长的内存类型

```bash
pmap -x <PID>
cat /proc/<PID>/smaps_rollup
```

如果 `RssAnon`、`Private_Dirty` 持续增长，通常说明增长主要来自堆或匿名映射，而不是文件缓存。

#### 第三步：定位分配调用栈

环境支持 BCC 时：

```bash
/usr/share/bcc/tools/memleak -p <PID>
```

C/C++ 测试环境中也可以重新构建并运行：

```bash
g++ -fsanitize=address,leak -fno-omit-frame-pointer -g app.cpp -o app
```

最终发现某个错误处理分支分配内存后提前返回，没有执行释放；或者某个缓存、队列只增加不淘汰。

#### 根因

常见根因有两类：

1. 所有权错误：`malloc/new` 后遗漏 `free/delete`，异常路径没有释放。
2. 逻辑上的“泄漏”：对象仍然可达，但缓存、Map、队列没有容量和过期策略。

第二类不会被所有泄漏检测器识别，但同样会耗尽内存。

#### 修复与验证

C++ 中优先使用 RAII：

- 使用 `std::vector`、`std::string` 等容器管理内存。
- 使用 `std::unique_ptr` 表达唯一所有权。
- 避免裸 owning pointer。
- 给缓存和队列设置容量、TTL 和淘汰策略。

验证时应在稳定负载下运行足够长时间，观察：

- RSS 是否进入稳定区间。
- `available` 是否不再持续下降。
- `memleak` 或 Sanitizer 是否不再报告增长调用栈。
- 是否不再发生 Swap 和 OOM。

---

### 案例 4：`df` 显示磁盘已满，`du` 却找不到大文件

#### 现象

```bash
df -h /var
du -xhd1 /var | sort -h
```

`df` 显示 `/var` 已使用 95%，但 `du` 汇总的可见文件远小于已用空间。

#### 第一步：排除 inode 和挂载点问题

```bash
df -i /var
findmnt /var
```

inode 没有耗尽，统计的也是同一个文件系统。

#### 第二步：查找已删除但仍被占用的文件

```bash
lsof +L1
```

示意：

```text
COMMAND  PID  FD  TYPE  SIZE/OFF  NLINK  NAME
app     2310  7w  REG      20G       0  /var/log/app.log (deleted)
```

日志文件虽然已经从目录中删除，但应用仍持有打开的文件描述符，所以磁盘块没有释放。

#### 根因

日志轮转或人工清理直接删除了正在写入的日志，应用没有重新打开文件。`du` 只能统计目录树中可见的文件，而 `df` 统计文件系统真实占用。

#### 修复与验证

- 优先让应用重新打开日志文件，例如发送应用支持的 reopen 信号。
- 如果应用不支持重新打开日志，再安排安全重启。
- 为 `logrotate` 配置正确的 `postrotate` 行为。
- 不要默认使用 `copytruncate`；复制与截断之间可能丢失少量日志。

处理后重新检查：

```bash
lsof +L1
df -h /var
```

> 不要直接操作 `/proc/<PID>/fd/<FD>` 截断生产文件，除非已经确认文件类型、应用行为和数据风险。

---

### 案例 5：应用吞吐不高，但磁盘写延迟很高

#### 现象

业务请求量不大，CPU 和内存也有余量，但每个请求偶尔会卡住几十到几百毫秒。`iostat` 显示写延迟明显升高。

#### 第一步：确认写延迟和队列

```bash
iostat -xz 1 10
```

观察到：

- `w_await` 明显高于正常基线。
- `aqu-sz` 周期性升高。
- 写吞吐量并不大。

吞吐量不高但延迟高，说明问题不一定是“写得太多”，也可能是每次写都要求同步持久化。

#### 第二步：定位写入进程

```bash
pidstat -d 1 10
```

找到应用进程后，短时间查看写相关系统调用：

```bash
strace -tt -T -e trace=write,fsync,fdatasync -p <PID>
```

结果发现应用每处理一个请求，就执行一次：

```text
write(...)
fsync(...)
```

而单次 `fsync()` 经常耗时数十毫秒。

#### 根因

应用把每条日志、事件或业务记录都单独同步写入磁盘。请求路径必须等待数据真正持久化，因此吞吐量不高也会被单次同步写延迟限制。

#### 修复与验证

在不破坏数据一致性要求的前提下：

- 合并多个写请求，再批量执行 `fsync()`。
- 把非关键日志改为异步写入，并控制队列上限。
- 降低无用的 debug 日志量。
- 将日志与数据库数据拆分到不同设备。
- 对必须同步持久化的数据，评估更低延迟的存储。

修复后不仅要看平均延迟，还要比较：

- 请求 P95/P99。
- `fsync()` 延迟分布。
- 磁盘 `w_await` 和队列。
- 异步队列是否会在故障时丢数据或无限增长。

---

### 案例 6：使用 IP 访问正常，使用域名却时快时慢

#### 现象

直接访问服务 IP 很快，但使用域名时偶尔需要几秒，应用日志中还出现连接超时。

#### 第一步：拆分请求耗时

```bash
curl -o /dev/null -sS \
  -w 'dns=%{time_namelookup}\nconnect=%{time_connect}\ntls=%{time_appconnect}\nstarttransfer=%{time_starttransfer}\ntotal=%{time_total}\n' \
  https://example.com/
```

结果显示 `time_namelookup` 偶尔达到数秒，而 TCP 建连和服务端首字节时间正常。

#### 第二步：直接测试 DNS

```bash
dig example.com
cat /etc/resolv.conf
```

多次测试发现，第一个 DNS 服务器不可达或响应很慢，等待超时后才回退到第二个 DNS 服务器。

继续确认网络路径：

```bash
dig @<DNS服务器IP> example.com
ping -c 3 <DNS服务器IP>
```

#### 根因

主 DNS 配置错误、网络不通或服务不稳定。每次命中该服务器时，都要等待超时和重试，所以表现为“时快时慢”。

#### 修复与验证

- 修复 DNS 服务器或网络路径。
- 移除无效的 DNS 地址。
- 为应用使用合理的 DNS 缓存和过期策略。
- 检查搜索域是否导致额外查询。
- 不要长期通过写死 `/etc/hosts` 掩盖动态服务发现问题。

验证时同时检查：

- `dig` 响应时间和失败率。
- `curl` 的 DNS 阶段耗时。
- 应用解析超时和请求错误率。

---

### 案例 7：高并发时连接超时，但 CPU 和带宽都没满

#### 现象

低流量下服务正常，高并发时客户端出现连接超时。服务器 CPU、内存和网卡带宽仍有余量。

#### 第一步：检查监听队列

```bash
ss -lntp 'sport = :8080'
```

示意：

```text
State   Recv-Q  Send-Q  Local Address:Port
LISTEN  511     512     0.0.0.0:8080
```

监听 Socket 的 `Recv-Q` 已接近队列上限，说明已经完成握手、等待应用 `accept()` 的连接正在积压。

#### 第二步：检查队列溢出计数

```bash
nstat -az | grep -E 'ListenOverflows|ListenDrops'
```

连续观察发现 `TcpExtListenOverflows`、`TcpExtListenDrops` 持续增长。

#### 第三步：继续追问应用为什么没有及时 accept

```bash
pidstat -u -w -t -p <PID> 1 5
strace -c -p <PID>
```

结果可能发现：

- 工作线程全部阻塞在数据库或下游 RPC。
- 单线程事件循环执行了耗时计算。
- 进程频繁发生长时间 GC 或锁等待。
- 应用的连接处理模型无法承受当前并发。

#### 根因

连接超时看似是网络问题，实际根因是应用没有及时接受和处理新连接。监听队列只是最先暴露出积压的位置。

#### 修复与验证

- 先解决阻塞应用线程的数据库、锁、计算或下游依赖问题。
- 为下游调用设置超时、并发限制和失败策略。
- 优化事件模型或合理增加工作线程。
- 确认应用处理能力后，再评估 backlog 上限。

只扩大 backlog 通常只能延后失败，并不能提高应用实际处理能力。

验证时观察：

- `ListenOverflows`、`ListenDrops` 是否停止增长。
- 监听 `Recv-Q` 是否快速回落。
- TCP 建连耗时和客户端超时率是否下降。
- 应用吞吐是否真正提高。

---

### 案例复盘模板

每次真实故障处理后，可以按下面的模板记录：

```text
1. 业务现象：
2. 发生时间和影响范围：
3. 正常基线：
4. 第一组异常指标：
5. 排除过的假设：
6. 系统 → 进程 → 行为的证据链：
7. 最终根因：
8. 临时止损措施：
9. 长期修复：
10. 优化前后指标：
11. 如何提前监控和告警：
```

案例最有价值的部分，不是最后执行了哪条命令，而是为什么根据当前证据选择了下一步。

---

## 七、把 CPU、内存、I/O 和网络关联起来

性能问题常常跨越多个资源：

| 现象组合 | 可能方向 |
| --- | --- |
| Load 高、CPU 不高、`b` 高 | 磁盘、NFS、Swap 或其他 `D` 状态等待 |
| `%sy` 高、缺页高 | 频繁内存分配、回收或映射 |
| `%wa` 高、`si` 高 | Swap 换入导致磁盘等待 |
| RSS 持续增长、磁盘写入增加 | 无界缓存、持久化队列或日志积压 |
| `%si` 高、PPS 高、吞吐不高 | 网络小包或异常流量 |
| Send-Q 高、TCP 重传高 | 对端处理慢、拥塞或链路丢包 |
| OOM 前整机卡顿 | 内存回收、Swap 和 I/O 抖动 |
| 磁盘很忙但进程 I/O 不高 | Page Cache 写回、Swap、内核线程 |
| 容器延迟高但宿主机资源空闲 | cgroup CPU throttling 或内存限制 |

所以，排查时不要把资源割裂。一个指标异常时，应继续问：**它是根因，还是另一个瓶颈造成的结果？**

---

## 八、现场排查最小命令集

下面这组命令不是要每次全部执行，而是用于快速保存现场。根据现象选择对应部分即可。

### CPU

```bash
uptime
nproc
top
vmstat 1 10
mpstat -P ALL 1 5
pidstat -u -w 1 5
cat /proc/pressure/cpu
```

### 内存

```bash
free -h
vmstat 1 10
pidstat -r 1 5
ps -eo pid,ppid,stat,rss,vsz,pmem,comm --sort=-rss | head
cat /proc/meminfo
cat /proc/pressure/memory
```

### 文件系统与磁盘

```bash
df -h
df -i
findmnt
iostat -xz 1 10
pidstat -d 1 5
lsof +L1
cat /proc/pressure/io
```

### 网络

```bash
ip -br addr
ip -s link
ip route
ss -s
ss -lntp
sar -n DEV,EDEV,TCP,ETCP 1 5
nstat -az
```

### 定位到进程后

```bash
pidstat -u -r -d -w -p <PID> 1 5
pmap -x <PID>
cat /proc/<PID>/status
cat /proc/<PID>/smaps_rollup
lsof -p <PID>
```

然后再根据证据选择 `perf`、`strace`、`tcpdump`、eBPF、ASan 或 Valgrind。不要无目的地把所有工具跑一遍。

---

## 九、最后总结：比命令更重要的是证据链

一次完整的性能分析，应该能讲清楚下面这条证据链：

```text
业务为什么慢
  → 哪个系统资源出现压力
  → 哪个进程或线程造成压力
  → 具体在执行或等待什么
  → 为什么会产生这些行为
  → 修改后业务指标是否真正改善
```

真正值得沉淀的不是“某次用了哪些命令”，而是：

- 当时观察到了什么现象。
- 哪些指标互相印证。
- 哪些假设被排除。
- 根因位于哪一层。
- 优化前后的延迟、吞吐、错误率和资源消耗发生了什么变化。

当这条链路足够完整时，性能优化就不再是靠经验猜问题，而会变成一个可以重复、验证和复盘的工程过程。
