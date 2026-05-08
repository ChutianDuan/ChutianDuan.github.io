---
title: "RAII 与智能指针笔记"
date: 2026-04-09 10:24:12
updated: 2026-04-09 10:24:12
categories:
  - "学习"
  - "高性能C++并行编程"
permalink: /notes/高性能c-并行编程/02-raii与智能指针/
---

# RAII 与智能指针笔记

时间：2026/04/09

> 关键词：RAII、资源生命周期、异常安全、`unique_ptr`、`shared_ptr`、`weak_ptr`、自定义 deleter、锁管理
> 核心目标：把“资源一定会被释放”这件事交给对象生命周期，而不是交给人脑记忆。

---

## 1. RAII 是什么

RAII 全称：

> Resource Acquisition Is Initialization
> 资源获取即初始化

核心思想：

* 在对象构造时获取资源
* 在对象析构时释放资源

这样做的价值非常直接：

* 不容易忘记释放
* 遇到异常时也能自动回收
* 生命周期更清晰
* 接口更容易组合

这里的“资源”不只指内存，还包括：

* 动态内存
* 文件句柄
* socket
* 数据库连接
* 互斥锁
* 线程句柄
* GPU/系统资源

---

## 2. 为什么 RAII 在 C++ 里特别重要

C++ 有确定性析构：

```cpp
void f() {
    MyObj obj;
    // 离开作用域时 obj 一定析构
}
```

这意味着“资源释放”可以天然绑定到作用域结束。

相比手工写：

```cpp
open();
// ...
close();
```

RAII 更稳，因为它不依赖你记得在每一条返回路径都调用 `close()`。

---

## 3. 没有 RAII 时最容易出什么问题

### 3.1 多返回路径漏释放

```cpp
FILE* fp = fopen("data.txt", "r");
if (!fp) return;

if (bad_input()) {
    return; // 忘了 fclose(fp)
}

fclose(fp);
```

### 3.2 异常打断控制流

```cpp
void f() {
    int* p = new int[100];
    g(); // 这里如果抛异常，delete[] 可能永远执行不到
    delete[] p;
}
```

### 3.3 锁没有释放

```cpp
mtx.lock();
do_work(); // 中途 return/throw 都可能导致锁没解开
mtx.unlock();
```

这些问题都可以通过 RAII 化简。

---

## 4. 最小 RAII 示例

```cpp
#include <cstdio>

class FileGuard {
public:
    explicit FileGuard(const char* path)
        : fp_(std::fopen(path, "r")) {}

    ~FileGuard() {
        if (fp_) std::fclose(fp_);
    }

    FILE* get() const { return fp_; }

    FileGuard(const FileGuard&) = delete;
    FileGuard& operator=(const FileGuard&) = delete;

private:
    FILE* fp_ = nullptr;
};
```

要点：

* 构造函数负责获取资源
* 析构函数负责释放资源
* 禁止拷贝，避免多个对象同时认为自己拥有同一资源

---

## 5. 智能指针就是 RAII 的标准化实践

最常见的智能指针有三类：

* `std::unique_ptr`
* `std::shared_ptr`
* `std::weak_ptr`

它们的本质都是：

* 用对象包装裸指针
* 把释放逻辑放进析构函数

---

## 6. `std::unique_ptr`：独占所有权

### 6.1 基本语义

一个资源在任意时刻只能有一个拥有者。

```cpp
#include <memory>

auto p = std::make_unique<int>(42);
```

特点：

* 不可拷贝
* 可以移动
* 开销小
* 语义最清晰

### 6.2 为什么优先推荐 `make_unique`

```cpp
auto p = std::make_unique<std::string>("hello");
```

相比手写：

```cpp
std::unique_ptr<std::string> p(new std::string("hello"));
```

更推荐 `make_unique`，因为：

* 更简洁
* 更不容易写出异常安全漏洞
* 类型推导更清楚

### 6.3 移动所有权

```cpp
std::unique_ptr<int> p1 = std::make_unique<int>(7);
std::unique_ptr<int> p2 = std::move(p1);
```

移动后：

* `p2` 接管资源
* `p1` 变为空

### 6.4 作为参数怎么传

常见几种风格：

```cpp
void use(const std::unique_ptr<Foo>& p); // 只观察，不接管
void take(std::unique_ptr<Foo> p);       // 接管所有权
void view(Foo* p);                       // 只观察底层对象
void ref(Foo& x);                        // 保证对象存在
```

经验上：

* 要表达“接管所有权”，就按值接收 `unique_ptr`
* 只观察对象，不一定非要把参数写成智能指针类型

---

## 7. `std::shared_ptr`：共享所有权

### 7.1 基本语义

```cpp
#include <memory>

auto p1 = std::make_shared<int>(42);
auto p2 = p1;
```

此时：

* `p1` 和 `p2` 共同拥有同一个对象
* 内部通过引用计数决定何时释放

### 7.2 什么时候用 `shared_ptr`

只有在“确实存在共享拥有关系”时才使用。

典型场景：

* 对象要被多个异步任务共同持有
* 图结构/对象系统中需要共享生命周期
* 回调系统中对象可能跨作用域存活

### 7.3 成本是什么

`shared_ptr` 比 `unique_ptr` 重得多，因为它通常涉及：

* 控制块
* 原子引用计数
* 更复杂的生命周期管理

所以不要把它当默认选择。

---

## 8. `std::weak_ptr`：打破循环引用

### 8.1 为什么需要它

如果两个 `shared_ptr` 互相持有，就会形成循环，导致引用计数永远不归零。

```cpp
struct B;

struct A {
    std::shared_ptr<B> b;
};

struct B {
    std::shared_ptr<A> a;
};
```

这会泄漏。

### 8.2 正确思路

把“非拥有关系”的那一侧改成 `weak_ptr`：

```cpp
struct B;

struct A {
    std::shared_ptr<B> b;
};

struct B {
    std::weak_ptr<A> a;
};
```

### 8.3 使用方式

```cpp
if (auto sp = weak.lock()) {
    // 对象还活着
}
```

`weak_ptr` 的语义是：

* 我知道这个对象可能存在
* 但我不参与拥有

---

## 9. 自定义 deleter

有些资源不是 `delete` 释放的，例如：

* `FILE*` 要 `fclose`
* `malloc` 对应 `free`
* socket / GPU handle / 句柄各有自己的释放函数

这时可以给智能指针指定自定义删除器。

```cpp
#include <cstdio>
#include <memory>

using FilePtr = std::unique_ptr<FILE, int(*)(FILE*)>;

FilePtr open_file(const char* path) {
    return FilePtr(std::fopen(path, "r"), std::fclose);
}
```

这样离开作用域时就会自动 `fclose`。

---

## 10. `make_shared` 与 `shared_ptr(new T)`

### 10.1 为什么通常优先 `make_shared`

```cpp
auto p = std::make_shared<MyType>(args...);
```

优点通常包括：

* 代码更简洁
* 常见实现里对象和控制块可一次分配
* 异常安全更直接

### 10.2 什么时候不能用 `make_shared`

比如你需要：

* 自定义 deleter
* 控制对象与控制块分离
* 与某些特殊分配策略配合

这时才考虑直接构造 `shared_ptr`。

---

## 11. RAII 不只用于内存

### 11.1 互斥锁

错误写法：

```cpp
mtx.lock();
work();
mtx.unlock();
```

推荐写法：

```cpp
std::lock_guard<std::mutex> lk(mtx);
work();
```

`lock_guard` 就是典型 RAII：

* 构造时加锁
* 析构时解锁

### 11.2 更灵活的 `unique_lock`

当你需要：

* 延迟加锁
* 手动 `unlock`
* 配合条件变量

就用 `std::unique_lock`。

### 11.3 多锁场景

可以使用：

```cpp
std::scoped_lock lk(m1, m2);
```

它也是 RAII，且能帮你规避一部分死锁风险。

---

## 12. 线程也应该 RAII 化

### 12.1 `std::thread` 的问题

`std::thread` 如果在析构前既没有 `join()` 也没有 `detach()`，程序会 `std::terminate`。

所以线程句柄本身也需要生命周期管理。

### 12.2 一个简单的 join guard

```cpp
#include <thread>

class JoiningThread {
public:
    explicit JoiningThread(std::thread t) : t_(std::move(t)) {}

    ~JoiningThread() {
        if (t_.joinable()) t_.join();
    }

    JoiningThread(const JoiningThread&) = delete;
    JoiningThread& operator=(const JoiningThread&) = delete;

private:
    std::thread t_;
};
```

这也是典型 RAII：

* 构造时接管线程对象
* 析构时确保 `join`

如果是 C++20，可以直接优先考虑 `std::jthread`。

---

## 13. 异常安全为什么和 RAII 绑定得这么紧

RAII 最强的地方不是“少写一行 `delete`”，而是它天然支持异常安全。

看这段代码：

```cpp
void f() {
    auto p = std::make_unique<BigObject>();
    std::lock_guard<std::mutex> lk(mtx);
    g(); // 这里如果抛异常
}
```

即使 `g()` 抛异常：

* `lk` 会析构并解锁
* `p` 会析构并释放对象

这就是现代 C++ 推荐“资源对象化”的原因。

---

## 14. 所有权设计比选哪种智能指针更重要

高质量 C++ 代码首先要明确：

* 谁拥有对象
* 谁只观察对象
* 谁负责释放对象

一个常见的经验顺序是：

1. 默认用对象值语义
2. 必须动态分配时，优先 `unique_ptr`
3. 只有确实共享拥有时才用 `shared_ptr`
4. 非拥有关系用裸指针、引用、`weak_ptr`、`std::span`

也就是说，智能指针不是“越多越高级”，而是要表达清晰语义。

---

## 15. 常见误区

### 15.1 裸指针不等于拥有权

```cpp
Foo* p = get();
```

单看这一行，没人知道：

* 你是不是要 `delete p`
* 这个对象是不是别人管理的

所以裸指针更适合表达“观察”，不适合表达“拥有”。

### 15.2 到处滥用 `shared_ptr`

很多代码用 `shared_ptr` 只是为了“省心”，结果带来：

* 生命周期更复杂
* 隐式共享关系
* 性能开销
* 循环引用问题

### 15.3 从 `unique_ptr` 里随手 `get()` 再乱传

```cpp
auto p = std::make_unique<Foo>();
take_raw(p.get());
```

这本身不一定错，但要非常清楚：

* `get()` 只拿观察指针
* 不会转移所有权
* 不能让对方 `delete`

### 15.4 `shared_from_this()` 误用

如果对象不是由 `shared_ptr` 管理，直接 `shared_from_this()` 会出问题。
这类场景要配合 `std::enable_shared_from_this` 正确使用。

### 15.5 智能指针不是性能万能解

它们解决的是：

* 资源释放正确性
* 生命周期表达

而不是自动让程序变快。
在极热路径里，真正重要的还是：

* 数据布局
* 分配次数
* 缓存局部性

---

## 16. 和并发编程的关系

RAII 在并发里尤其重要，因为并发代码最怕“中途退出时资源没收干净”。

最常见的 RAII 对象：

* `std::lock_guard`
* `std::unique_lock`
* `std::scoped_lock`
* 线程 join guard

并发里的基本原则可以记成一句：

> 锁、线程、句柄这类资源，不要靠手动成对调用管理，优先对象化。

---

## 17. 一页总结

RAII 的本质不是某个库技巧，而是一种设计原则：

* 资源由对象接管
* 生命周期由作用域决定
* 释放在析构中自动完成

智能指针则是这条原则在内存管理上的标准化实现：

* `unique_ptr`：独占所有权，默认首选
* `shared_ptr`：共享所有权，按需使用
* `weak_ptr`：非拥有观察，打破循环

如果只记三条经验：

1. 能不用动态分配就不用
2. 动态分配优先 `unique_ptr`
3. 共享拥有关系才用 `shared_ptr`

---

## 18. 建议继续补充的相关主题

和本篇衔接最紧密的内容：

1. 左右值、移动语义与 `std::move`
2. 自定义 allocator 与内存池
3. `enable_shared_from_this`
4. `scope_exit` / defer 风格工具
5. Rule of Five 与异常安全保证

---

## 19. 参考资料

1. cppreference: RAII
   <https://en.cppreference.com/w/cpp/language/raii>

2. cppreference: `std::unique_ptr`
   <https://en.cppreference.com/w/cpp/memory/unique_ptr>

3. cppreference: `std::shared_ptr`
   <https://en.cppreference.com/w/cpp/memory/shared_ptr>

4. cppreference: `std::weak_ptr`
   <https://en.cppreference.com/w/cpp/memory/weak_ptr>
