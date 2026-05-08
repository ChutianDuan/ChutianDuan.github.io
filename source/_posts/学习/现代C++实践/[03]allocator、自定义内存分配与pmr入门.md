---
title: "allocator、自定义内存分配与 pmr 入门"
date: 2026-05-08 14:36:46
updated: 2026-05-08 14:36:46
categories:
  - "学习"
  - "现代C++实践"
permalink: /notes/现代c-实践/03-allocator-自定义内存分配与pmr入门/
---

# allocator、自定义内存分配与 pmr 入门

时间：2026/04/09

> 关键词：`std::allocator`、`allocator_traits`、分配与构造分离、状态型分配器、`std::pmr`
> 核心目标：理解 STL 容器如何管理内存，以及什么时候值得定制分配器。

---

## 1. 为什么 allocator 存在

容器不仅要“放元素”，还要处理：

* 申请原始内存
* 在内存上构造对象
* 销毁对象
* 释放内存

标准库把这层职责抽象成 allocator。

---

## 2. `std::allocator` 的核心职责

可以粗略理解成四步：

1. `allocate(n)`：分配能容纳 `n` 个对象的原始内存
2. `construct(...)`：在指定位置构造对象
3. `destroy(...)`：调用析构
4. `deallocate(...)`：释放内存

现代实现中更常通过：

* `std::allocator_traits`

来统一调度这些接口。

---

## 3. 为什么“分配”和“构造”是两件事

因为拿到一块内存，不等于对象已经存在。

```cpp
T* p = alloc.allocate(4); // 只有内存
std::construct_at(p, value); // 这里对象才真正构造
```

这也是容器能高效管理未初始化存储区的基础。

---

## 4. 一个最小自定义分配器骨架

```cpp
#include <memory>

template <class T>
struct MyAllocator {
    using value_type = T;

    MyAllocator() = default;

    template <class U>
    MyAllocator(const MyAllocator<U>&) {}

    T* allocate(std::size_t n) {
        return static_cast<T*>(::operator new(n * sizeof(T)));
    }

    void deallocate(T* p, std::size_t) {
        ::operator delete(p);
    }
};
```

配合容器使用：

```cpp
std::vector<int, MyAllocator<int>> v;
```

---

## 5. 什么时候值得自定义 allocator

不是所有项目都需要。

更常见的适用场景：

* 频繁小对象分配
* 想用内存池减少碎片
* 想把对象放到特定区域
* 需要统计分配行为
* 游戏/服务端有帧级或 arena 分配需求

如果只是普通业务代码，标准分配器通常已经够用。

---

## 6. 状态型分配器

有些分配器不仅有类型，还有内部状态，例如：

* 指向某个内存池
* 指向某个 arena

这类分配器要特别注意：

* 拷贝行为
* 容器复制/移动时状态如何传播

这也是 `allocator_traits` 很重要的原因之一。

---

## 7. `std::pmr`：现代 C++ 更实用的内存资源抽象

C++17 提供了 `std::pmr`：

* polymorphic memory resource

它把“分配策略”从模板参数层搬到了运行时资源对象层。

最常见组件：

* `std::pmr::memory_resource`
* `std::pmr::polymorphic_allocator`
* `std::pmr::vector`
* `std::pmr::monotonic_buffer_resource`

这通常比手写 allocator 模板更实用。

---

## 8. `monotonic_buffer_resource` 的直觉

这种资源很适合：

* 批量分配
* 很少单独释放
* 整体回收

例如一次请求、一次帧更新、一次解析过程。

好处：

* 分配快
* 局部性好

代价：

* 单个对象通常不能灵活归还给池

---

## 9. 和容器性能的关系

allocator 影响的通常不是接口语义，而是：

* 分配次数
* 分配成本
* 碎片
* 局部性

但要注意：

* allocator 优化通常排在算法和数据布局之后
* 不要在没有证据前，把 allocator 当成首要瓶颈

---

## 10. 常见误区

### 10.1 把 allocator 当成“所有性能问题的解药”

很多性能问题其实更可能出在：

* 数据布局
* 扩容策略
* 锁争用
* 随机访问

### 10.2 只会写 `allocate/deallocate`，却不理解对象构造时机

allocator 真正重要的是：

* 内存和对象是分开的

### 10.3 在没有统一资源模型时滥用自定义 allocator

结果容易让代码复杂度大幅上升。

---

## 11. 参考实例：用 pmr 做一次请求内存池

假设一次请求里要临时创建很多字符串和数组，请求结束后统一释放。
这时 `monotonic_buffer_resource` 很适合。

```cpp
#include <array>
#include <cstddef>
#include <iostream>
#include <memory_resource>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

struct RequestData {
    std::pmr::vector<std::pmr::string> headers;

    explicit RequestData(std::pmr::memory_resource* mr)
        : headers(mr) {}

    void add_header(std::string_view key, std::string_view value) {
        std::pmr::string line{headers.get_allocator().resource()};
        line.append(key);
        line.append(": ");
        line.append(value);
        headers.push_back(std::move(line));
    }
};

void handle_request() {
    std::array<std::byte, 4096> buffer{};
    std::pmr::monotonic_buffer_resource arena{
        buffer.data(),
        buffer.size()
    };

    RequestData req{&arena};
    req.add_header("Host", "example.com");
    req.add_header("User-Agent", "demo-client");

    for (const auto& h : req.headers) {
        std::cout << h << "\n";
    }

    // handle_request 返回时，arena 整体释放本次请求的临时内存。
}
```

这种模式适合：

* 请求级临时对象
* 一帧游戏逻辑里的临时容器
* 解析器中短生命周期 token

不适合：

* 单个对象需要频繁独立释放
* 容器或字符串要活得比 arena 更久

---

## 12. 一页总结

allocator 这篇最值得记住的是：

1. 容器管理的是“原始内存 + 对象构造/销毁”
2. allocator 负责内存来源
3. `allocator_traits` 是现代实现的核心适配层
4. 真正工程里，`std::pmr` 往往比手写 allocator 更实用

如果只记一句：

> allocator 优化通常是进阶优化，前提是你已经把算法、数据布局和容器选择做对了。
