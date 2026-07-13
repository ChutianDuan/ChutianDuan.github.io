---
title: "对象都正确析构了，为什么临时分配仍会拖慢请求？用 `std::pmr` 管住内存来源"
date: 2026-07-13 11:27:11
updated: 2026-07-13 11:27:11
categories:
  - "学习"
  - "高性能 C++ 并行编程"
permalink: /notes/高性能c-并行编程/13-std-pmr与内存池/
series: "高性能 C++ 并行编程"
series_order: 13
---

时间：2026/05/04

一个请求处理函数可能只构造几十个短命字符串和数组。代码没有泄漏，离开函数后也全部析构，却在高并发下出现延迟抖动：

```cpp
std::vector<std::string> fields;
for (const Token& token : request.tokens()) {
    fields.push_back(normalize(token));
}
```

这里可能同时发生 `vector` 扩容和字符串缓冲分配。每次操作都很小，但通用堆分配器要服务任意大小、任意生命周期和多线程，频繁调用仍可能带来元数据、同步、碎片与缓存局部性成本。

`std::pmr`（polymorphic memory resource，多态内存资源）允许标准容器保持相近接口，同时把“从哪里分配”交给外部资源。它最适合一批对象共享明确生命周期的场景，不是把类型名前加上 `pmr::` 就自动变快。

本文会用可观测的上游分配次数说明 arena 如何工作，再讲清资源生命周期、嵌套容器、池资源与多线程边界。

## 1. 先减少分配，还是先换分配器？

换内存资源之前，先检查是否在制造不必要的工作：

- 已知元素数量却没有 `reserve`；
- 用许多堆对象表达本可连续存放的数据；
- 在热循环里重复构造相同临时对象；
- 复制本可移动或借用的数据；
- 算法复杂度或 I/O 才是真正瓶颈。

`reserve` 与 `pmr` 解决不同层次的问题：

```text
reserve：减少 vector 需要申请新连续区的次数
pmr：决定每次申请从哪个 memory_resource 获得
```

即使容器使用 arena，扩容仍会分配更大存储、移动旧元素并使地址失效。能估计最终数量时，两者通常一起使用。

## 2. `std::pmr` 怎样把分配策略移出容器类型？

传统 allocator 是容器类型的一部分：

```cpp
std::vector<int, CustomAllocator<int>> values;
```

换 allocator 会得到另一种 `vector` 类型。`std::pmr::vector<T>` 则固定使用 `std::pmr::polymorphic_allocator<T>`，allocator 内部保存一个 `memory_resource*`，在运行时转发请求：

```text
pmr::vector<T>
      │
polymorphic_allocator<T>
      │ 持有非拥有指针
memory_resource
      ├── monotonic_buffer_resource
      ├── unsynchronized_pool_resource
      ├── synchronized_pool_resource
      └── 自定义资源
```

`memory_resource` 的公开 `allocate/deallocate/is_equal` 最终调用派生类的虚函数：

```cpp
do_allocate(bytes, alignment)
do_deallocate(pointer, bytes, alignment)
do_is_equal(other)
```

这种运行时多态让相同 `pmr::vector<int>` 类型可接不同资源。虚调用不是零成本，但通常应与完整分配路径一起测量；真正收益往往来自批量回收、复用或避免进入通用堆，而不是省一条指令。

## 3. `monotonic_buffer_resource` 为什么适合请求级临时数据？

单调资源（monotonic resource）像一支只向前写的笔：每次分配从当前块继续切出空间，单个 `deallocate` 通常不回收；`release()` 或资源析构时统一归还所有上游块。

```text
initial buffer
[object A][padding][object B][vector storage][free ...]
                                           ↑
                                      当前位置只前进
```

它适合：

- 一次请求的解析树和临时字符串；
- 一帧或一个批次的 scratch 数据；
- 一次搜索、编译或图构建过程；
- 对象大致一起创建、一起销毁的阶段。

若对象会在一个长期资源中不断创建和单独删除，单调资源不会因对象析构立即复用其空间，内存可能持续增长。这时应改变生命周期边界，或考虑池资源。

## 4. 如何观察初始缓冲区是否真的避免了上游分配？

下面定义一个计数资源，包装默认堆资源并记录分配次数。相同的三条长字符串分别使用 4096 字节和 64 字节初始缓冲：前者足以容纳，后者必然向上游申请。

代码使用 C++17 标准库，不依赖第三方组件：

```cpp
#include <array>
#include <cstddef>
#include <iostream>
#include <memory_resource>
#include <string_view>
#include <vector>

class CountingResource final : public std::pmr::memory_resource {
public:
    explicit CountingResource(std::pmr::memory_resource* upstream)
        : upstream_(upstream) {}

    std::size_t allocations() const noexcept {
        return allocations_;
    }

private:
    void* do_allocate(
        std::size_t bytes,
        std::size_t alignment) override {
        ++allocations_;
        return upstream_->allocate(bytes, alignment);
    }

    void do_deallocate(
        void* pointer,
        std::size_t bytes,
        std::size_t alignment) override {
        upstream_->deallocate(pointer, bytes, alignment);
    }

    bool do_is_equal(
        const std::pmr::memory_resource& other) const noexcept override {
        return this == &other;
    }

    std::pmr::memory_resource* upstream_;
    std::size_t allocations_ = 0;
};

struct Result {
    std::size_t items = 0;
    bool used_upstream = false;
};

template <std::size_t BufferSize>
Result build_messages() {
    std::array<std::byte, BufferSize> buffer{};
    CountingResource upstream(std::pmr::new_delete_resource());
    std::pmr::monotonic_buffer_resource arena(
        buffer.data(), buffer.size(), &upstream);

    std::size_t items = 0;
    {
        std::pmr::vector<std::pmr::string> messages(&arena);
        messages.reserve(3);
        constexpr std::string_view text =
            "a message long enough to require dynamic string storage";

        messages.emplace_back(text.begin(), text.end());
        messages.emplace_back(text.begin(), text.end());
        messages.emplace_back(text.begin(), text.end());
        items = messages.size();
    }

    arena.release();
    return {items, upstream.allocations() != 0};
}

int main() {
    const Result large = build_messages<4096>();
    const Result small = build_messages<64>();

    std::cout << std::boolalpha
              << "large: items=" << large.items
              << ", used upstream=" << large.used_upstream << '\n'
              << "small: items=" << small.items
              << ", used upstream=" << small.used_upstream << '\n';
}
```

编译运行：

```bash
clang++ -std=c++17 -O2 -Wall -Wextra -pedantic pmr_arena.cpp -o pmr_arena
./pmr_arena
```

预期输出：

```text
large: items=3, used upstream=false
small: items=3, used upstream=true
```

具体上游申请的块大小和次数属于标准库实现策略，所以示例只判断是否发生回退，不依赖精确数字。4096 字节远大于三条消息和外层数组所需空间；64 字节不足以容纳全部动态存储。

## 5. 这段代码中的资源由谁拥有？

对象声明顺序决定析构顺序：

```text
buffer
upstream
arena
messages（内层作用域）

析构顺序反向：messages → arena → upstream → buffer
```

`pmr::vector` 只保存资源指针，不拥有 `arena`。必须先销毁所有使用 arena 的容器和对象，再调用 `arena.release()` 或销毁 arena。主例用内层作用域保证 `messages` 先析构。

若在 `messages` 仍存活时调用 `release()`，其元素与内部存储立即失效；随后访问甚至析构这个容器都可能使用无效内存。`release()` 不是类似垃圾回收的安全清空按钮。

`arena` 的初始缓冲也必须覆盖其使用期。这里缓冲数组比 arena 先声明、后析构，因此安全。

## 6. 初始缓冲用完后会发生什么？

`monotonic_buffer_resource` 默认向上游资源申请新块。若没有显式指定，上游通常是当前默认资源；这意味着“使用了栈缓冲”不等于“保证不触碰堆”。

想把容量预算变成可测试约束，可以使用 `null_memory_resource()`：

```cpp
std::pmr::monotonic_buffer_resource arena(
    buffer.data(),
    buffer.size(),
    std::pmr::null_memory_resource());
```

初始缓冲不足时分配失败并抛出 `std::bad_alloc`。它适合测试实时路径是否偷偷回退到堆，也适合有明确失败策略的固定预算系统。

生产代码必须处理容量不足：返回错误、降级、拆批或允许上游扩展。仅仅把上游设为空而没有捕获异常，会把延迟问题变成进程错误。

## 7. 为什么外层使用 PMR 还不够？

下面只有外层数组存储来自 arena：

```cpp
std::pmr::vector<std::string> names(&arena);
```

元素是普通 `std::string`，字符串自己的动态缓冲仍使用其 allocator。若希望两层都使用 PMR，应写：

```cpp
std::pmr::vector<std::pmr::string> names(&arena);
names.emplace_back("a sufficiently long name");
```

allocator-aware 构造会把外层资源传给适配的 PMR 元素。但短字符串可能使用小字符串优化（SSO）而不分配，SSO 容量不是标准保证；测试内存来源时应使用足够长的内容或直接统计资源调用。

更深的嵌套结构也要逐层检查 allocator-aware 类型。把普通业务对象放进 `pmr::vector`，不会自动重写该对象内部的普通容器。

## 8. 为什么 `pmr::vector` 仍需要 `reserve`？

arena 让分配快，并不改变 `vector` 必须连续存储的规则：

```cpp
std::pmr::vector<Record> records(&arena);
records.reserve(expected_count);
```

未预留时，vector 可能依次申请多个更大区间。旧区间上的元素会被移动和销毁，但单调资源不会复用旧存储，直到整个 arena 释放。因此增长过程中留下的旧数组空间尤其容易成为阶段内浪费。

合理 `reserve` 同时减少元素搬迁和 arena 消耗。过度高估仍会占用不必要内存，所以应根据数据分布选择预算，而不是固定预留最大理论值。

## 9. pool resource 与 monotonic resource 怎样选择？

标准库提供两种池资源：

| 资源 | 回收模型 | 线程模型 | 常见场景 |
|---|---|---|---|
| `monotonic_buffer_resource` | 整体释放，单次 deallocate 不回收 | 资源对象不提供共享同步保证 | 阶段性 scratch 数据 |
| `unsynchronized_pool_resource` | 按大小类别缓存并复用块 | 不同步 | 单线程/线程局部小对象反复分配 |
| `synchronized_pool_resource` | 类似池化并带内部同步 | 可共享 | 确实需要多线程共用一个池 |

池资源会把未满足的请求交给上游，并可通过 `pool_options` 调整某些策略。具体大小类别、块增长和性能属于实现细节。

“可被多线程共享”不表示共享池一定快。所有线程集中分配仍可能发生锁和缓存争用。线程局部 `unsynchronized_pool_resource` 往往减少争用，但从该资源分配的对象不能在资源销毁后跨线程继续存活。

## 10. PMR 容器跨资源移动时会发生什么？

两个 `pmr::vector<T>` 类型相同，不代表它们的资源相同：

```cpp
std::pmr::vector<int> left(&request_arena);
std::pmr::vector<int> right(&long_lived_pool);
```

复制、移动赋值、交换或返回容器时，不能只根据普通 `std::vector` 的直觉假设底层指针总能直接转移。allocator 相等性、具体操作和标准要求会决定是否需要逐元素移动或是否允许交换。

更重要的是语义：不能让长期对象继续指向请求级 arena。跨生命周期边界时，显式把数据复制/移动构造到目标资源，并用测试确认分配位置：

```cpp
std::pmr::vector<int> persistent(
    temporary.begin(), temporary.end(), &long_lived_pool);
```

不要从函数返回一个绑定局部资源的容器：

```cpp
std::pmr::vector<int> bad() {
    std::pmr::monotonic_buffer_resource arena;
    std::pmr::vector<int> values(&arena);
    return values; // 返回对象中的资源指针即将悬空
}
```

## 11. 如何用类型结构保证正确析构顺序？

把资源和使用者放在同一拥有对象中时，资源必须先声明：

```cpp
struct RequestScratch {
    std::pmr::monotonic_buffer_resource arena;
    std::pmr::vector<std::pmr::string> fields;

    RequestScratch()
        : arena(4096), fields(&arena) {}
};
```

成员按声明的反序析构，因此 `fields` 先销毁，`arena` 后销毁。初始化列表的书写顺序不能改变实际构造顺序；若把成员声明反过来，会在 arena 构造前尝试使用它，且销毁顺序也错误。

需要移动这种聚合对象时要格外谨慎：容器保存的资源地址不能因外层对象移动而变成悬空。最简单安全策略往往是禁止移动，或让资源具有稳定独立地址，而不是为方便返回值随意生成默认移动操作。

## 12. 多线程应共享一个资源吗？

`unsynchronized_pool_resource` 和 `monotonic_buffer_resource` 不应被多个线程无同步并发调用。常见设计是：

```text
worker 0 → local arena 0 ┐
worker 1 → local arena 1 ├─> 阶段结束后合并到长期资源
worker 2 → local arena 2 ┘
```

这不仅避免数据竞争，也减少共享分配器争用。合并阶段必须明确复制到哪个资源，不能把含有局部资源指针的容器直接送出线程生命周期。

确实需要多线程共同分配时可使用 `synchronized_pool_resource` 或外部同步，但要测量锁竞争。另一种选择是项目已有的成熟并发 allocator；不要在 PMR 之上再自制未经验证的无锁池。

## 13. 如何判断 PMR 是否真的改善性能？

先用 profiler 或分配追踪确认热路径确实包含大量分配。然后在相同输入下比较：

- 分配/释放调用次数；
- 分配总字节与峰值驻留；
- 请求中位数与尾延迟；
- CPU 时间和锁等待；
- 缓存行为与整体吞吐。

使用 Release 构建、预热并重复测量。默认堆本身可能有线程缓存，小数据上 PMR 差异可能很小；arena 也可能因预算过大提高峰值内存。

计数 `memory_resource` 是很好的回归测试工具：不仅测“快了多少”，还可以断言某条实时路径没有上游分配。但自定义资源的计数更新若用于多线程，必须同步，否则测试工具本身会产生数据竞争。

## 14. 常见误区如何纠正？

### 误区一：用了初始 buffer 就绝不会访问堆

不对。空间不足时默认向上游申请。需要硬限制时显式使用 `null_memory_resource` 并处理 `bad_alloc`。

### 误区二：对象析构会把空间立即还给 monotonic arena

不对。对象析构仍会运行，但单次 deallocate 通常不回收空间；资源整体 release 才重置。

### 误区三：外层 `pmr::vector` 会让所有内部对象自动走同一池

不对。内部类型也必须支持对应 allocator 传播，例如使用 `pmr::string`。

### 误区四：`release()` 可以在任何时候清理无用内存

不对。它使该资源此前分配的存储全部失效，必须保证所有相关对象已销毁且不再访问。

### 误区五：PMR 能代替 `reserve`

不对。容器扩容与元素搬迁规则不变，单调资源甚至会保留旧数组占用直到整体释放。

### 误区六：内存池一定比默认堆快

不对。收益取决于分配模式、线程争用、对象生命周期和标准库实现。没有测量就不应引入额外生命周期复杂度。

## 15. 什么时候值得使用 `std::pmr`？

适合考虑 PMR 的场景包括：

- profiler 显示短命对象分配占比明显；
- 一次请求、一帧或一批任务具有天然整体生命周期；
- 需要把多组 allocator-aware 容器绑定到同一资源；
- 要通过 `null_memory_resource` 验证固定内存预算；
- 小对象反复分配释放，适合池化复用。

以下情况通常先不要用：

- 数据量很小，分配不是热点；
- 一个 `reserve` 或更紧凑的数据布局已经解决问题；
- 对象跨越复杂所有权和线程边界，资源寿命难以说明；
- 算法、I/O、锁或网络才是主要瓶颈。

## 16. 总结

回到开头，正确析构只解决“最终会释放”，没有减少处理过程中进入通用堆的次数。`std::pmr` 允许一批同寿命对象从 arena 或 pool 分配，并在清晰边界统一回收。

最重要的结论是：

1. `pmr` 控制内存来源，`reserve` 控制容器增长，两者不能互相替代。
2. `monotonic_buffer_resource` 适合整体生命周期，单个对象销毁通常不回收其空间。
3. 容器只借用 `memory_resource`，资源和初始缓冲必须活得更久。
4. 嵌套结构要逐层使用 allocator-aware 类型，外层 PMR 不会渗透进普通成员。
5. 线程局部资源可减少争用，但跨线程、跨阶段时必须迁移到正确长期资源。

实践中先为临时数据画一条生命周期线：谁创建资源、哪些对象从中分配、何时全部销毁、是否允许上游回退。如果这四件事能写成一个简单作用域，PMR 才真正适合这个问题。
