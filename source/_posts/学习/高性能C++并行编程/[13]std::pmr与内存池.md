---
title: "std::pmr 与内存池"
date: 2026-05-04 14:43:49
updated: 2026-05-04 14:43:49
categories:
  - "学习"
  - "高性能C++并行编程"
permalink: /notes/高性能c-并行编程/13-std-pmr与内存池/
---

# std::pmr 与内存池

时间：2026/05/04

> 关键词：`std::pmr`、内存池、`memory_resource`、`monotonic_buffer_resource`、`pool_resource`、分配开销、局部性
> 核心目标：理解如何把 STL 容器的内存来源换成更适合高性能场景的资源。

---

## 1. 为什么内存分配会影响性能

很多 C++ 程序的慢，不一定慢在计算本身，而是慢在频繁分配：

* 每次 `new/delete` 都可能进入通用堆分配器
* 小对象分配容易带来额外元数据和碎片
* 分配释放可能涉及锁或线程缓存
* 分散的堆对象会降低缓存命中率

例如：

```cpp
std::vector<std::string> names;

for (int i = 0; i < n; ++i) {
    names.push_back(make_name(i));
}
```

这里至少可能有两类分配：

* `vector` 自己扩容
* `string` 内容超过小字符串优化时单独分配

高性能场景里常见思路是：

* 已知规模时先 `reserve`
* 减少对象数量和间接访问
* 把一批生命周期相同的对象放进同一个内存资源

`std::pmr` 就是标准库提供的这类工具。

---

## 2. 传统 allocator 的问题

普通容器的 allocator 是模板参数：

```cpp
std::vector<int, MyAllocator<int>> v;
```

这意味着：

* 分配策略参与类型
* 换 allocator 后容器类型也变了
* 状态型 allocator 写起来容易复杂

比如：

```cpp
std::vector<int> a;
std::vector<int, MyAllocator<int>> b;
```

`a` 和 `b` 是两个不同类型。
如果大量接口都暴露这种类型，工程复杂度会很快上升。

---

## 3. `std::pmr` 的核心想法

`pmr` 全称是：

> polymorphic memory resource

它把“从哪里分配内存”抽象成一个运行时对象：

```cpp
std::pmr::memory_resource*
```

常见组件：

| 组件 | 作用 |
| --- | --- |
| `std::pmr::memory_resource` | 内存资源基类 |
| `std::pmr::polymorphic_allocator<T>` | 把资源接到标准容器 allocator 接口上 |
| `std::pmr::vector<T>` | 使用 `polymorphic_allocator` 的 vector 别名 |
| `std::pmr::string` | 使用 pmr allocator 的 string 别名 |
| `std::pmr::monotonic_buffer_resource` | 适合批量分配、整体释放 |
| `std::pmr::unsynchronized_pool_resource` | 非线程同步的池资源 |
| `std::pmr::synchronized_pool_resource` | 带同步的池资源 |

所以 `pmr` 的重点不是“换一个容器”，而是：

> 容器接口基本不变，但内存来源可以由外部资源控制。

---

## 4. 第一个 `pmr::vector` 例子

```cpp
#include <array>
#include <cstddef>
#include <iostream>
#include <memory_resource>
#include <vector>

int main() {
    std::array<std::byte, 1024> buffer{};
    std::pmr::monotonic_buffer_resource pool{
        buffer.data(),
        buffer.size()
    };

    std::pmr::vector<int> xs{&pool};

    for (int i = 0; i < 10; ++i) {
        xs.push_back(i);
    }

    for (int x : xs) {
        std::cout << x << '\n';
    }
}
```

这里的关键是：

* `buffer` 是一块预先准备好的内存
* `pool` 从这块 buffer 中切内存
* `xs` 的元素存储区优先来自 `pool`
* 如果 buffer 不够，默认会继续向上游资源申请

默认上游资源通常是：

```cpp
std::pmr::get_default_resource()
```

它最终一般还是会走普通堆分配。

---

## 5. `memory_resource` 是真正的分配策略

`memory_resource` 的核心接口可以粗略理解为：

```cpp
class memory_resource {
public:
    void* allocate(std::size_t bytes, std::size_t alignment);
    void deallocate(void* p, std::size_t bytes, std::size_t alignment);
    bool is_equal(const memory_resource& other) const noexcept;
};
```

实际标准接口底层是虚函数：

```cpp
virtual void* do_allocate(std::size_t bytes, std::size_t alignment) = 0;
virtual void do_deallocate(void* p, std::size_t bytes, std::size_t alignment) = 0;
virtual bool do_is_equal(const memory_resource& other) const noexcept = 0;
```

这说明：

* `pmr` 本身用了运行时多态
* 容器不用知道具体资源类型
* 换资源时不必改变容器类型

这里的虚调用通常不是主要瓶颈，因为一次分配本身就比一次普通函数调用贵得多。
真正要关注的是能不能减少分配次数、改善局部性、避免堆碎片。

---

## 6. `polymorphic_allocator` 做了什么

`std::pmr::vector<T>` 大致等价于：

```cpp
std::vector<T, std::pmr::polymorphic_allocator<T>>
```

`polymorphic_allocator<T>` 内部保存一个：

```cpp
std::pmr::memory_resource*
```

当容器需要分配内存时，它会把请求转发给这个资源。

所以可以这样理解：

```text
pmr::vector<int>
    -> polymorphic_allocator<int>
        -> memory_resource
            -> 具体内存池 / arena / 堆
```

这和手写 allocator 的区别是：

* allocator 类型固定
* 资源对象可在运行期替换
* 更适合在工程里传递容器和资源

---

## 7. `monotonic_buffer_resource`：线性增长的 arena

`monotonic_buffer_resource` 的行为很像 arena：

* 每次分配只向前移动当前位置
* 单个 `deallocate` 通常不真正回收
* 整个资源析构或 `release()` 时统一释放

适合：

* 一次请求中的临时对象
* 一帧游戏逻辑中的临时数据
* 一次解析、构图、搜索过程
* 生命周期高度一致的一批对象

例子：

```cpp
#include <memory_resource>
#include <string>
#include <vector>

struct RequestContext {
    std::pmr::monotonic_buffer_resource scratch;
    std::pmr::vector<std::pmr::string> words;

    RequestContext()
        : scratch(4096),
          words(&scratch) {}
};
```

这类资源的好处是：

* 分配路径短
* 几乎没有单个对象释放成本
* 同一批数据更可能靠近

但代价也很明确：

* 单个对象释放不一定还给池
* 长生命周期资源里容易堆积无用内存
* 必须保证容器不比资源活得更久

---

## 8. `pmr::string` 和嵌套容器

`pmr` 容器最容易忽略的一点是：

> 外层容器用 pmr，不代表内层对象自动都用同一个资源。

例如：

```cpp
std::pmr::vector<std::string> names{&pool};
```

这里：

* `vector` 的数组存储用 `pool`
* 但每个 `std::string` 自己的动态内存仍然用默认分配器

如果想让字符串内容也走同一个资源，应该用：

```cpp
std::pmr::vector<std::pmr::string> names{&pool};
```

更完整的例子：

```cpp
#include <memory_resource>
#include <string>
#include <vector>

int main() {
    std::pmr::monotonic_buffer_resource pool{4096};

    std::pmr::vector<std::pmr::string> names{&pool};
    names.emplace_back("alpha");
    names.emplace_back("beta");
}
```

这里 `vector` 的 allocator 会参与构造元素，所以新放入的 `pmr::string` 也会使用同一个资源。
如果你在外面单独创建 `pmr::string`，就要显式把资源传给它：

```cpp
std::pmr::string name{"alpha", &pool};
```

---

## 9. pool resource：复用固定大小块

`monotonic_buffer_resource` 偏向“只涨不退”。
如果你的场景里有大量同尺寸或近似尺寸的小对象反复分配释放，可以考虑 pool resource。

标准库提供两类：

| 资源 | 特点 |
| --- | --- |
| `std::pmr::unsynchronized_pool_resource` | 不做内部同步，适合单线程或外部已同步 |
| `std::pmr::synchronized_pool_resource` | 内部带同步，可被多线程共享 |

例子：

```cpp
#include <memory_resource>
#include <vector>

int main() {
    std::pmr::unsynchronized_pool_resource pool;
    std::pmr::vector<int> xs{&pool};

    for (int i = 0; i < 1000; ++i) {
        xs.push_back(i);
    }
}
```

选择时可以粗略记：

* 批量构建、整体释放：优先 `monotonic_buffer_resource`
* 小对象反复分配释放：考虑 `unsynchronized_pool_resource`
* 多线程共享同一个资源：才考虑 `synchronized_pool_resource`

在高性能代码里，更常见的方式是：

* 每个线程一个无锁资源
* 避免多个线程抢同一个 pool

---

## 10. 资源生命周期是第一安全边界

`pmr` 容器通常只保存：

```cpp
memory_resource*
```

所以资源必须比使用它的容器活得更久。

错误示意：

```cpp
#include <memory_resource>
#include <vector>

std::pmr::vector<int> bad() {
    std::pmr::monotonic_buffer_resource pool{1024};
    std::pmr::vector<int> xs{&pool};
    xs.push_back(1);
    return xs; // 错：返回后 xs 指向已经销毁的 pool
}
```

更安全的做法是把资源和容器放在同一个拥有者里，并保证资源先声明：

```cpp
#include <memory_resource>
#include <vector>

struct WorkBuffer {
    std::pmr::monotonic_buffer_resource pool;
    std::pmr::vector<int> data;

    WorkBuffer()
        : pool(4096),
          data(&pool) {}
};
```

成员析构顺序和声明顺序相反：

* `data` 先析构
* `pool` 后析构

这正好满足“容器先死，资源后死”。

---

## 11. 上游资源与禁止堆回退

默认情况下，`monotonic_buffer_resource` 初始 buffer 不够时，会向上游资源继续申请。

有时你希望测试或实时系统里明确禁止堆分配，可以用：

```cpp
std::pmr::null_memory_resource()
```

例子：

```cpp
#include <array>
#include <cstddef>
#include <memory_resource>
#include <vector>

int main() {
    std::array<std::byte, 128> buffer{};

    std::pmr::monotonic_buffer_resource pool{
        buffer.data(),
        buffer.size(),
        std::pmr::null_memory_resource()
    };

    std::pmr::vector<int> xs{&pool};
    xs.reserve(16);
}
```

如果超出这块 buffer，分配会失败并抛出 `std::bad_alloc`。
这很适合用来发现“以为没有堆分配，实际还有”的路径。

---

## 12. 和 `reserve` 的关系

`pmr` 不是 `reserve` 的替代品。

即使用了内存池，`vector` 扩容时仍然可能：

* 分配新连续内存
* 移动旧元素
* 让旧指针、引用、迭代器失效

所以：

```cpp
std::pmr::vector<int> xs{&pool};
xs.reserve(n);
```

依然是非常重要的优化。

可以把两者关系理解成：

* `reserve` 减少容器扩容次数
* `pmr` 降低每次分配的成本，并控制内存来源

---

## 13. 多线程使用建议

内存池和并行编程放在一起时，最容易踩的是共享资源争用。

常见策略：

1. 每个线程一个 `unsynchronized_pool_resource`
2. 每个任务一个 `monotonic_buffer_resource`
3. 合并结果时再转移到长期存储

尽量避免：

* 所有线程共享一个同步 pool
* 临时对象跨线程持有另一个线程的资源
* 在线程结束后继续使用线程局部资源里的对象

简单记忆：

> `pmr` 优化的是分配路径，但共享同一个资源仍然可能把并行程序重新串行化。

---

## 14. 什么时候值得用 `std::pmr`

比较值得考虑：

* profiler 显示分配占比明显
* 临时对象数量很多
* 对象生命周期天然成批
* 需要把一组容器绑定到同一片内存
* 想限制某段代码不能偷偷走堆分配

暂时不必急着用：

* 数据量很小
* 算法复杂度才是主要瓶颈
* 容器已经提前 `reserve`
* 没有明确的生命周期边界

高性能优化的一般顺序仍然是：

1. 选对算法
2. 选对数据布局
3. 减少不必要的对象和拷贝
4. 再考虑 allocator / `pmr` 这类内存来源优化

---

## 15. 常见坑

### 15.1 资源比容器先析构

这是 `pmr` 里最危险的问题。
容器内部只是保存资源指针，不拥有资源。

### 15.2 外层用了 pmr，内层没用

`std::pmr::vector<std::string>` 只解决外层数组分配，字符串内容仍可能走默认堆。
需要时应使用 `std::pmr::string`。

### 15.3 把 `monotonic_buffer_resource` 当成通用释放器

它适合整体释放，不适合频繁单独归还对象。

### 15.4 以为内存池一定更快

不测量就下结论很危险。
如果瓶颈在算法、锁、缓存 miss 或 I/O，换 allocator 可能几乎没有收益。

### 15.5 多线程共享同一个 pool

共享资源可能引入锁争用。
很多并行场景中，线程本地资源更自然。

---

## 16. 一页总结

`std::pmr` 最值得记住的是：

1. 它把容器的内存来源抽象成运行时 `memory_resource`
2. `pmr::vector<T>` 本质上是使用 `polymorphic_allocator<T>` 的标准容器
3. `monotonic_buffer_resource` 适合批量分配、整体释放
4. pool resource 适合小对象复用，但要注意线程同步成本
5. 资源生命周期必须覆盖所有使用它的容器

如果只记一句：

> `std::pmr` 不是魔法加速器，而是让你把“一批对象从哪里分配、什么时候一起释放”这件事说清楚。

---

## 17. 参考资料

1. cppreference: memory resource
   <https://en.cppreference.com/w/cpp/memory/memory_resource>

2. cppreference: polymorphic allocator
   <https://en.cppreference.com/w/cpp/memory/polymorphic_allocator>

3. cppreference: monotonic buffer resource
   <https://en.cppreference.com/w/cpp/memory/monotonic_buffer_resource>

4. cppreference: pool resources
   <https://en.cppreference.com/w/cpp/memory/synchronized_pool_resource>
