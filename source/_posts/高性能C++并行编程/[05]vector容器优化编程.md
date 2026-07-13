---
title: "同样是 `std::vector`，为什么一次构建会多出许多分配和搬移？"
date: 2026-07-13 10:40:20
updated: 2026-07-13 10:40:20
categories:
  - "学习"
  - "高性能 C++ 并行编程"
permalink: /notes/高性能c-并行编程/05-vector容器优化编程/
series: "高性能 C++ 并行编程"
series_order: 5
---

时间：2025/11/22
课程地址：Bilibili - BV1qF411T7sd
课件仓库：`parallel101/course`

下面两段代码最终都得到一百万个元素：

```cpp
std::vector<Record> first;
for (std::size_t i = 0; i < count; ++i) {
    first.emplace_back(make_record(i));
}

std::vector<Record> second;
second.reserve(count);
for (std::size_t i = 0; i < count; ++i) {
    second.emplace_back(make_record(i));
}
```

它们的算法复杂度看起来一样，第二段却可能少掉多次内存分配和大量元素搬移。差异来自 `std::vector` 的容量模型，而不是 `emplace_back` 的语法。

本文从这次“看不见的扩容”出发，讲清 `size`、`capacity`、`reserve`、迭代器失效和并行写入边界。目标不是背 API，而是能根据数据增长方式判断 `vector` 的真实成本。

## 1. `vector` 为什么需要容量这个概念？

`std::vector<T>` 管理一段连续存储。概念上可以理解为三项状态：

```text
vector 对象
├── data ─────> [已构造元素][可用但未构造空间]
├── size              ↑
└── capacity ───────────────────────────────↑
```

- `data()` 指向连续元素区；
- `size()` 是已经构造、可以访问的元素数量；
- `capacity()` 是当前存储最多能容纳的元素数量。

这只是帮助理解的模型，标准没有要求 `vector` 对象内部必须恰好保存三根指针。`vector` 自身也不一定在栈上，它可以是全局对象、成员或动态对象；重要的是元素（除 `vector<bool>` 的特殊情况外）连续存放。

连续存储带来几个直接优势：顺序访问有良好的空间局部性，硬件预取容易发挥作用，随机访问为常数复杂度，并且可以用 `data()` 与接收连续数组的 C API 交互。

连续性也带来约束：存储区后面没有足够空间时，不能原地“接长”，只能换一块更大的内存。

## 2. 一次扩容究竟做了什么？

当 `size() == capacity()` 且继续插入元素时，`vector` 通常需要：

1. 分配一块更大的原始存储；
2. 在新存储中移动或复制已有元素；
3. 销毁旧位置的元素；
4. 释放旧存储；
5. 更新内部指针和容量。

对 `int` 等平凡类型，标准库和编译器通常能高效搬运数据。对持有堆内存、句柄或其他资源的复杂类型，构造每个新元素可能更贵。

### 为什么移动构造的 `noexcept` 很重要？

扩容过程中若搬到一半抛异常，容器要维持规定的异常安全保证。某个类型既可复制、移动又可能抛异常时，`vector` 可能选择复制旧元素，以便失败时仍保留原内容。

```cpp
class Record {
public:
    Record(Record&& other) noexcept;
    Record& operator=(Record&& other) noexcept;
};
```

只有移动确实不会抛异常时才能这样标记。虚假的 `noexcept` 会让异常直接触发 `std::terminate()`。

### 容量每次增长多少？

标准要求连续追加具有摊还常数复杂度，但没有规定容量必须按 1.5 倍或 2 倍增长。不同标准库版本、元素数量和平台可能采用不同策略。因此，不要把观察到的容量序列写进业务逻辑。

所谓摊还 `O(1)`，是说少数昂贵扩容的成本分摊到大量普通尾插后，每次插入的平均成本为常数量级；它不表示每一次 `push_back` 都是常数时间。

## 3. `reserve` 为什么能减少扩容？

如果预先知道最终元素数量，可以一次请求足够容量：

```cpp
std::vector<Record> records;
records.reserve(count);

for (std::size_t i = 0; i < count; ++i) {
    records.emplace_back(make_record(i));
}
```

`reserve(count)` 保证调用成功后 `capacity() >= count`，但不创建任何 `Record`。只要后续元素数量不超过该容量，就不会因为尾插而重新分配。

这通常能减少：

- 分配器调用；
- 已有元素的重复搬移；
- 扩容造成的延迟尖峰；
- 指针、引用和迭代器失效次数。

但 `reserve` 不是越大越好。严重高估会提高峰值内存，占住长期不用的地址空间或实际内存；每插入一个元素前都调用 `reserve(size() + 1)` 还可能破坏实现的几何增长策略，使性能更差。

## 4. 如何观察扩容与搬移？

下面的 C++17 程序用一个计数类型记录移动和复制次数，并记录尾插期间容量改变了多少次。计数只服务于单线程演示，不是生产级性能测量工具。

```cpp
#include <cstddef>
#include <iostream>
#include <string>
#include <utility>
#include <vector>

struct Record {
    static inline std::size_t copies = 0;
    static inline std::size_t moves = 0;

    std::string text;

    explicit Record(std::string value) : text(std::move(value)) {}

    Record(const Record& other) : text(other.text) {
        ++copies;
    }

    Record(Record&& other) noexcept : text(std::move(other.text)) {
        ++moves;
    }

    Record& operator=(const Record&) = default;
    Record& operator=(Record&&) noexcept = default;
};

struct Result {
    std::size_t size;
    std::size_t capacity_changes;
    std::size_t copies;
    std::size_t moves;
};

Result build(std::size_t count, bool prepare_capacity) {
    Record::copies = 0;
    Record::moves = 0;

    std::vector<Record> records;
    if (prepare_capacity) {
        records.reserve(count);
    }

    std::size_t capacity_changes = 0;
    std::size_t previous_capacity = records.capacity();

    for (std::size_t i = 0; i < count; ++i) {
        records.emplace_back("record-" + std::to_string(i));

        if (records.capacity() != previous_capacity) {
            ++capacity_changes;
            previous_capacity = records.capacity();
        }
    }

    return {
        records.size(),
        capacity_changes,
        Record::copies,
        Record::moves
    };
}

void print_result(const char* label, const Result& result) {
    std::cout << label
              << ": size=" << result.size
              << ", capacity changes=" << result.capacity_changes
              << ", copies=" << result.copies
              << ", moves=" << result.moves << '\n';
}

int main() {
    constexpr std::size_t count = 10;

    print_result("without reserve", build(count, false));
    print_result("with reserve", build(count, true));
}
```

编译运行命令：

```bash
clang++ -std=c++17 -O2 -Wall -Wextra -pedantic vector_growth.cpp -o vector_growth
./vector_growth
```

在一种常见的 libc++ 环境中可能看到：

```text
without reserve: size=10, capacity changes=5, copies=0, moves=15
with reserve: size=10, capacity changes=0, copies=0, moves=0
```

第一行的具体数字不是 C++ 标准保证，不同实现可能不同。可以稳定解释的是：第二次构建在循环前已获得至少十个元素的容量，所以循环内不会扩容，也不需要为扩容搬移已有 `Record`。

这里 `emplace_back` 直接在目标位置构造新元素，因此统计到的移动来自扩容搬迁，而不是先创建一个 `Record` 临时对象再放进容器。

## 5. `reserve` 与 `resize` 为什么不能互换？

它们解决的是不同问题：

| 操作 | 改变 `size` | 可能改变 `capacity` | 构造新元素 | 典型用途 |
|---|---:|---:|---:|---|
| `reserve(n)` | 否 | 是 | 否 | 后续追加至多约 `n` 个元素 |
| `resize(n)` | 是 | 是 | 变大时会 | 立即需要 `n` 个可访问元素 |

下面是常见的逻辑错误：

```cpp
std::vector<int> values;
values.resize(count);

for (std::size_t i = 0; i < count; ++i) {
    values.push_back(static_cast<int>(i));
}
// 最终 size 是 2 * count，前半部分还是值初始化元素
```

如果逐个追加，应使用 `reserve` 加 `push_back`；如果要按下标填充，才先 `resize`：

```cpp
std::vector<int> values(count);
for (std::size_t i = 0; i < count; ++i) {
    values[i] = static_cast<int>(i);
}
```

后者在并行计算中尤其常见：主线程先完成元素构造，工作线程再写互不重叠的区间。

## 6. `push_back` 和 `emplace_back` 应该怎样选择？

`push_back` 接收一个已经存在的元素，`emplace_back` 把构造参数转发给元素构造函数：

```cpp
std::vector<Record> records;

Record record("saved");
records.push_back(record);             // 从左值复制
records.push_back(std::move(record));  // 从右值移动
records.emplace_back("in-place");     // 在尾部直接构造
```

`emplace_back` 在需要用多个参数直接构造复杂对象时很自然，但它不是普遍更快：

- 对 `int` 等简单类型，差异通常没有意义；
- 传入一个已经构造好的对象时，`push_back` 更直白；
- `emplace_back` 可能调用本来不打算暴露的显式构造函数；
- 发生扩容时，旧元素照样需要搬移。

选择依据应是构造意图，而不是把所有 `push_back` 机械替换成 `emplace_back`。

## 7. 为什么保存一个元素指针会突然悬空？

扩容会更换整个存储区，所以之前指向元素的指针、引用和迭代器全部失效：

```cpp
std::vector<int> values;
values.push_back(10);

int* first = &values[0];
values.reserve(values.capacity() + 1); // 请求超过当前容量，触发重新分配

// 使用 *first 属于未定义行为，因为 first 已经悬空
```

`reserve` 的请求值大于当前容量时会发生重新分配。这里不能把某次观察到的增长倍率当成契约；判断地址是否失效，应依据操作规则和操作前的容量，而不是猜测实现策略。

即使没有重新分配，在中间 `insert` 或 `erase` 也会移动元素。一般而言，插入点或删除点及其后的迭代器、指针和引用会失效；具体操作的精确规则应查对应标准版本的容器文档。

如果业务需要跨修改长期标识元素，可考虑保存稳定 ID 或索引，并在使用前重新查找。索引在中间插删后同样可能指向不同元素，因此也必须结合修改策略设计。

### `data()` 为空时能不能传给 C API？

空 `vector` 可以调用 `data()`，但返回值不能解引用。与 C API 交互时应同时传指针和长度，并确认该 API 是否允许长度为零时接收空或非空指针：

```cpp
consume_bytes(values.data(), values.size());
```

指针的有效期只持续到下一次可能使其失效的容器操作。

## 8. 中间删除为什么通常是线性成本？

连续存储不能留下“洞”。删除一个元素后，后续元素通常要向前移动：

```text
[A][B][删除 C][D][E]
              ↓ 搬移
[A][B][D][E]
```

批量删除满足条件的元素时，不要循环调用单元素 `erase`，否则可能反复移动同一批后缀。C++20 可以直接使用：

```cpp
std::erase_if(values, [](int value) {
    return value % 2 == 0;
});
```

C++17 使用 erase-remove 惯用法：

```cpp
values.erase(
    std::remove_if(values.begin(), values.end(), predicate),
    values.end()
);
```

`remove_if` 先把保留元素紧凑到前面，返回新的逻辑结尾；`erase` 再真正销毁尾部多余元素并缩短 `size`。

若删除非常频繁，可考虑改变数据模型：标记删除后批量压缩、使用交换尾元素的无序删除，或选择更符合访问模式的容器。节点容器避免大段搬移，却会失去连续性并增加分配和指针追踪成本，并非自动更快。

## 9. 并行写 `vector` 的安全边界在哪里？

多个线程只读取同一个已经构造完成、期间不修改的 `vector`，通常不需要额外同步。只要任何线程执行 `push_back`、`reserve`、`resize`、`erase` 等结构修改，其他线程同时访问容器就可能发生数据竞争或使用失效地址。

多个线程直接向同一个容器 `push_back` 是错误示例：

```cpp
// 错误：size、capacity 和存储区都可能被并发修改
std::vector<float> output;
parallel_for([&](std::size_t i) {
    output.push_back(compute(i));
});
```

结果数量已知时，更稳妥的模式是先确定大小，再分区写入：

```cpp
std::vector<float> output(count);

// 每个线程只写互不重叠的 [begin, end) 区间；
// 所有线程结束前，不再改变 output 的大小和容量。
```

C++ 标准容器允许不同线程修改不同元素，`vector<bool>` 是明确的特殊例外。即便没有数据竞争，相邻线程写落在同一缓存行上仍可能产生伪共享，性能需要结合分块大小和硬件测量。

输出数量未知时，常见做法是每个线程填充自己的局部 `vector`，最后计算总量并合并。相比给共享 `push_back` 加一把全局锁，它通常减少锁竞争，但额外合并成本是否值得仍需测量。

## 10. `clear`、`shrink_to_fit` 与内存释放有什么区别？

`clear()` 销毁所有元素并令 `size()` 变为零，通常保留容量，便于下一轮复用：

```cpp
records.clear();
// records.capacity() 通常仍保持原值
```

`shrink_to_fit()` 请求把容量缩小到接近当前大小，但这是非强制请求，实现可以不执行。它还可能重新分配并搬移元素，使已有地址失效。

若容器会很快再次增长，保留容量通常更高效；若一次峰值后对象长期存活且内存压力明显，可以测量收缩的收益。频繁“清空—收缩—再增长”往往会制造额外分配抖动。

## 11. `vector<bool>` 为什么不像普通 `vector<T>`？

`std::vector<bool>` 是按位压缩的特化，单个元素通常不是独立存储的 `bool` 对象，`operator[]` 返回代理类型而非普通 `bool&`。因此：

- 不能假设能取得元素的 `bool*`；
- 泛型代码中引用类型可能与预期不同；
- 不同线程修改看似不同的位也不享有普通 `vector` 的元素级并发保证。

需要紧凑位图时它可能合适；需要普通字节元素、稳定引用语义或并发分区写时，可根据空间需求考虑 `std::vector<std::uint8_t>`、`std::bitset` 或专用位图库。具体选择要结合内存规模和操作模式。

## 12. 什么时候优先选择 `vector`？

`vector` 通常适合：

- 以顺序遍历和随机访问为主；
- 主要在尾部追加；
- 希望利用连续内存和批量算法；
- 要与接收指针和长度的底层接口交互；
- 可以在并行计算前确定元素数量并分区。

它不太适合：

- 频繁在头部或中间插入、删除大量元素；
- 必须保证元素地址在容器增长后仍稳定；
- 数据规模巨大且每次都严重高估预留容量；
- 需要多个线程同时改变同一容器结构。

不要只凭操作复杂度选择容器。元素大小、遍历比例、分配次数、局部性和实际数据规模都会影响结果；节点容器的常数成本可能远高于一次连续搬移。

## 13. 常见误区如何纠正？

### 误区一：`reserve(n)` 之后已经有 `n` 个元素

不对。它只保证容量，访问 `values[0]` 仍然越界，除非先插入元素或调用 `resize`。

### 误区二：增长倍率固定为两倍

不对。倍率属于实现策略，标准只规定相关复杂度和语义。不要依赖具体容量序列。

### 误区三：`emplace_back` 永远不产生移动

不对。它能避免为新元素显式创建某些临时对象，但扩容时已有元素仍要搬迁，构造参数本身也可能带来复制或移动。

### 误区四：`clear()` 会归还底层内存

通常不会。它主要销毁元素，保留容量本身是为了高效复用。

### 误区五：不同线程写不同下标就一定快

正确性上还要求元素已经构造、没有结构修改，并排除 `vector<bool>`；性能上还可能受到伪共享、负载不均和内存带宽限制。

### 误区六：一次计时就能证明 `reserve` 提速

不对。小数据时差异可能被噪声淹没，复杂元素与平凡元素的搬移成本也不同。应使用 Release 构建、预热、重复测量，并分别记录分配次数、吞吐和延迟分布。

## 14. 总结

回到开头，两段构建代码的差异来自容量是否提前准备好。没有预留时，尾插偶尔需要换一块更大的连续存储，并搬移全部已有元素；合理的 `reserve` 能把这部分工作压缩到循环之前。

最重要的结论是：

1. `size` 表示已构造元素，`capacity` 表示可容纳数量，两者不能混用。
2. 扩容的成本包括分配和元素搬迁，并会使所有元素地址失效。
3. 已知合理上界时使用 `reserve`，需要立即按下标访问时使用 `resize`。
4. `emplace_back` 优化的是新元素构造方式，不会消除扩容成本。
5. 并行写入应先固定大小和容量，再让线程写互不重叠区间。

下一次优化 `vector` 前，先记录元素最终数量、扩容次数和搬移成本。能被观测的数据，比“某个容器一定快”的经验口号更可靠。
