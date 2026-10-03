---
title: "没有内存泄漏，程序为什么仍被分配拖慢？从 allocator 到 `std::pmr`"
date: 2026-07-13 09:16:45
updated: 2026-07-13 09:16:45
categories:
  - "学习"
  - "现代 C++ 实践"
permalink: /notes/现代c-实践/03-allocator-自定义内存分配与pmr入门/
series: "现代 C++ 实践"
series_order: 3
---

时间：2026/04/09

设想一个 HTTP 服务：每个请求都要解析几十个请求头、临时字符串和 token。所有对象都由标准容器管理，没有内存泄漏，但压测时仍能看到大量时间消耗在内存分配与释放上。

直觉上的做法可能是立刻手写一个 STL allocator。问题是，分配器接口涉及对象生命周期、容器传播规则和对齐要求；一个“能编译”的实现未必适合工程使用。更重要的是，真正需要的往往不是一种新的容器类型，而是让同一批临时对象从一块请求级内存中分配，并在请求结束时整体回收。

本文从这个场景出发，解释原始存储与对象的区别、allocator 在容器中的职责，以及怎样用 C++17 的多态内存资源（polymorphic memory resource，`std::pmr`）实现一个边界清楚的请求级 arena。

---

## 1. 容器已经自动管理内存，为什么还要关心分配？

`std::vector<T>` 不只是保存一个指针。扩容时，它通常需要完成一组相互独立的动作：

```text
申请更大的原始存储
        ↓
在新存储中移动或复制元素
        ↓
销毁旧存储中的元素
        ↓
释放旧的原始存储
```

频繁创建小容器或不断扩容时，通用堆分配器需要维护元数据、处理不同大小的请求，并兼顾多线程。单次开销可能很小，但如果一条热路径执行数十万次，累积成本和内存碎片就可能进入性能分析结果。

这并不意味着 allocator 是默认优化方向。以下问题通常应更早检查：

- 能否减少对象数量或分配次数？
- `vector::reserve` 能否避免反复扩容？
- 数据布局是否造成缓存浪费？
- 算法复杂度、锁争用或 I/O 是否才是瓶颈？

只有基准测试或 profiler 指向分配成本时，定制内存来源才有足够理由。

## 2. 拿到内存为什么不等于对象已经存在？

C++ 中的存储（storage）与对象（object）是两个层次。下面只申请了能容纳一个 `Widget` 的原始存储，`Widget` 的生命周期尚未开始：

```cpp
void* storage = ::operator new(sizeof(Widget));
```

在适当对齐的存储上构造对象后，才可以把它当成 `Widget` 使用：

```cpp
Widget* widget = std::construct_at(
    static_cast<Widget*>(storage), 42);
```

结束时也有两个对应步骤：先析构对象，再释放存储。

```cpp
std::destroy_at(widget);
::operator delete(storage);
```

完整的 C++20 演示如下：

```cpp
#include <iostream>
#include <memory>
#include <new>

struct Widget {
    explicit Widget(int value) : value(value) {
        std::cout << "construct " << value << '\n';
    }

    ~Widget() {
        std::cout << "destroy " << value << '\n';
    }

    int value;
};

int main() {
    void* storage = ::operator new(sizeof(Widget));
    Widget* widget = nullptr;

    try {
        widget = std::construct_at(static_cast<Widget*>(storage), 42);
        std::cout << widget->value << '\n';
        std::destroy_at(widget);
        ::operator delete(storage);
    } catch (...) {
        ::operator delete(storage);
        throw;
    }
}
```

编译运行：

```bash
clang++ -std=c++20 -O2 -Wall -Wextra -pedantic lifetime.cpp -o lifetime
./lifetime
```

预期输出：

```text
construct 42
42
destroy 42
```

标准容器替我们组织了这些步骤。allocator 的核心关注点是“存储从哪里来、怎样归还”，容器则负责决定何时构造、移动和销毁元素。

## 3. allocator 在 STL 容器中扮演什么角色？

可以把 allocator 看成容器与内存来源之间的协议。一个最小教学骨架如下：

```cpp
#include <cstddef>
#include <limits>
#include <new>

template <class T>
struct SimpleAllocator {
    using value_type = T;

    SimpleAllocator() noexcept = default;

    template <class U>
    SimpleAllocator(const SimpleAllocator<U>&) noexcept {}

    [[nodiscard]] T* allocate(std::size_t count) {
        if (count > std::numeric_limits<std::size_t>::max() / sizeof(T)) {
            throw std::bad_array_new_length();
        }
        return static_cast<T*>(::operator new(count * sizeof(T)));
    }

    void deallocate(T* pointer, std::size_t) noexcept {
        ::operator delete(pointer);
    }
};
```

它可以作为容器模板参数：

```cpp
std::vector<int, SimpleAllocator<int>> values;
```

现代标准库通过 `std::allocator_traits` 统一访问 allocator 的类型和操作，并为一部分可选成员提供默认行为。容器不应直接假设所有 allocator 都拥有相同的附加接口。

上面的代码只适合帮助理解接口，不是一个内存池，也不会比默认分配器更快。真正的状态型 allocator 还要处理容器复制、移动、交换时资源状态是否传播，以及不同 allocator 分配的存储能否互相释放。除非要实现基础设施库，否则这些规则会让“简单优化”迅速变复杂。

## 4. 为什么 `std::pmr` 更适合运行时选择内存策略？

传统 allocator 是容器类型的一部分：

```cpp
std::vector<int, PoolAllocator<int>> values;
```

换一种 allocator，容器类型也跟着改变。C++17 的 `std::pmr` 把策略拆成运行时的 `memory_resource` 对象：

```cpp
std::pmr::vector<int> values{resource};
```

`std::pmr::vector<int>` 使用 `polymorphic_allocator<int>`，它内部指向一个 `memory_resource`。因此，同一种容器类型可以连接不同资源：通用堆、单调递增 arena、池资源，或自定义统计资源。

常用组件的分工如下：

| 组件 | 作用 |
| --- | --- |
| `std::pmr::memory_resource` | 运行时内存资源接口 |
| `std::pmr::polymorphic_allocator<T>` | 把资源接入 allocator 模型 |
| `std::pmr::vector`、`string` 等 | 使用多态 allocator 的容器别名 |
| `std::pmr::monotonic_buffer_resource` | 只向前分配、适合整体回收的 arena |
| `std::pmr::unsynchronized_pool_resource` | 面向多次小块分配和回收的非线程安全池 |

`pmr` 的“polymorphic”指内存资源在运行时多态，不代表容器元素采用面向对象多态。

## 5. 怎样实现一个请求级内存 arena？

请求解析具有很典型的生命周期：处理中产生许多临时对象，请求结束后它们可以一起消失。`monotonic_buffer_resource` 正适合这种“批量分配、整体释放”的模式。

下面是一个完整的 C++17 示例：

```cpp
#include <array>
#include <cstddef>
#include <iostream>
#include <memory_resource>
#include <string_view>
#include <utility>

class RequestData {
public:
    explicit RequestData(std::pmr::memory_resource* resource)
        : headers_(resource) {}

    void add_header(std::string_view key, std::string_view value) {
        std::pmr::string line{headers_.get_allocator().resource()};
        line.reserve(key.size() + 2 + value.size());
        line.append(key);
        line.append(": ");
        line.append(value);
        headers_.push_back(std::move(line));
    }

    void print() const {
        for (const auto& header : headers_) {
            std::cout << header << '\n';
        }
    }

private:
    std::pmr::vector<std::pmr::string> headers_;
};

int main() {
    std::array<std::byte, 4096> local_buffer{};
    std::pmr::monotonic_buffer_resource arena{
        local_buffer.data(), local_buffer.size()};

    RequestData request{&arena};
    request.add_header("Host", "example.com");
    request.add_header("User-Agent", "demo-client");
    request.print();
}
```

编译运行：

```bash
clang++ -std=c++17 -O2 -Wall -Wextra -pedantic request.cpp -o request
./request
```

预期输出：

```text
Host: example.com
User-Agent: demo-client
```

执行过程中，`headers_` 的动态存储以及较长字符串需要的存储都向 `arena` 申请。`local_buffer` 足够时，分配直接来自栈上的这块数组；空间不够时，`monotonic_buffer_resource` 默认会向上游资源继续申请，所以“提供了 4096 字节数组”并不等于使用量被硬性限制为 4096 字节。

## 6. 为什么叫 monotonic，它怎样释放内存？

单调递增资源通常通过移动当前指针来分配：

```text
起点                                  终点
│ header 1 │ header 2 │ token │ 空闲区域 │
                              ↑
                         下一次分配位置
```

对单个块调用 `deallocate` 通常不会让这段空间立即重新可用；资源在调用 `release()` 或析构时统一归还所管理的内存。这省掉了逐块回收所需的管理工作，也可能改善局部性。

但“整体释放存储”不等于可以跳过对象析构。容器和元素如果拥有非内存资源，仍应正常结束生命周期。示例中声明顺序非常重要：

```cpp
std::pmr::monotonic_buffer_resource arena;
RequestData request{&arena};
```

局部对象按声明的逆序析构，因此 `request` 会先销毁，`arena` 后销毁。如果资源先结束，而依赖它的容器仍继续执行析构、扩容或赋值，就会访问失效的 `memory_resource`。

## 7. 这种优化什么时候合适？

`monotonic_buffer_resource` 适合对象具有共同生命周期的场景：

- 单次 HTTP/RPC 请求中的解析结果；
- 一帧游戏逻辑使用的临时集合；
- 编译器或解析器一次处理产生的 token、节点；
- 完成一项批处理任务后整体丢弃的数据。

它不适合以下情况：

- 长生命周期对象与短生命周期对象混在同一资源中；
- 需要持续地单独删除对象并复用空间；
- 容器会逃逸到 arena 生命周期之外；
- 多个线程无同步地共享同一个非线程安全资源。

需要反复回收相近大小的小块时，可以评估 `unsynchronized_pool_resource` 或 `synchronized_pool_resource`。选择前仍应使用贴近真实负载的基准测试，而不是仅根据类型名字判断。

## 8. 工程中最容易出现哪些误区？

### 误区一：换成 `pmr` 就一定更快

如果程序的主要成本在算法、缓存未命中、锁或 I/O，替换 allocator 不会解决根因。即使分配是热点，资源类型、对象大小分布和生命周期也会影响结果。

### 误区二：arena 销毁前不用析构对象

arena 负责存储，不负责替对象关闭文件、释放锁或执行其他业务析构。应让对象正常析构，只是底层的逐块 `deallocate` 对单调资源通常不做实际回收。

### 误区三：栈缓冲区会禁止后续堆分配

默认上游资源是 `std::pmr::get_default_resource()`。初始缓冲区用完后仍可能从堆申请。如果需要固定容量并在耗尽时报错，可把 `std::pmr::null_memory_resource()` 作为上游资源，但必须处理 `std::bad_alloc`。

### 误区四：`pmr` 容器可以安全离开资源作用域

容器只保存资源指针，不拥有资源。容器及其使用该资源分配的元素必须在资源仍然有效时完成所有操作并析构。

### 误区五：只比较一次运行时间就下结论

内存分配受优化级别、输入规模、系统负载和分配器实现影响。性能测试应使用 Release 构建，进行预热和重复测量，并固定数据规模；还要验证优化前后的行为完全一致。

## 9. 总结

开头的请求解析变慢，不应该直接导向“手写 allocator”。更可靠的分析路径是：先证明分配确实是热点，再确认对象是否具有可以统一管理的生命周期，最后选择与生命周期匹配的内存资源。

1. 原始存储的分配与对象的构造是两件事；
2. allocator 决定容器从哪里取得存储，容器负责元素生命周期；
3. 自定义 allocator 的传播和状态规则复杂，教学骨架不等于生产实现；
4. `std::pmr` 让同一种容器在运行时连接不同内存资源；
5. `monotonic_buffer_resource` 适合批量分配、整体回收，但依赖对象绝不能比资源活得更久。

实际优化时，先用 profiler 找到分配热点，再为一批生命周期一致的临时对象建立局部 arena。allocator 应该是测量后的针对性工具，而不是看到性能问题时的第一反应。
