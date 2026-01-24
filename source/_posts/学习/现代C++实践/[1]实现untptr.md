---
title: "实现untptr"
date: 2026-01-16 10:32:08
tags:
  - "C++"
  - "智能指针"
  - "移动语义"
  - "RAII"
categories:
  - "学习"
  - "现代C++实践"
---
# 实现untptr

下面把我们这几轮对话内容整理成一份可直接作为“C++ 构造/析构/拷贝/移动”学习笔记的版本，并专门加入 `std::move` 的机制解析与常见误区澄清（结合你写的 `UniquePtr` 语义）。

---

# C++ 对象生命周期与特殊成员函数笔记（构造 / 析构 / 拷贝 / 移动 + std::move）

## 1. 对象生命周期与 RAII

### 1.1 生命周期顺序

对象的一生通常经历：

1. **构造（constructor）**：把对象初始化到“可用且满足类不变量”的状态
2. **使用（member functions）**
3. **析构（destructor）**：对象生命周期结束时清理资源

> 局部对象在**作用域结束**时析构（最常见是离开 `{}` 块）。
> 动态对象（`new`）在 `delete` 时析构；由智能指针管理则在智能指针析构时触发 `delete`。

### 1.2 RAII 核心

**资源获取在构造，资源释放在析构**。
智能指针/资源管理类的价值：把“释放资源”绑定到对象生命周期上，避免泄漏。

---

## 2. 六大特殊成员函数（Special Member Functions）

一个类最关键的 6 个函数：

1. 默认构造 `T()`
2. 析构 `~T()`
3. 拷贝构造 `T(const T&)`
4. 拷贝赋值 `T& operator=(const T&)`
5. 移动构造 `T(T&&)`
6. 移动赋值 `T& operator=(T&&)`

它们决定：对象如何创建、复制、转移、销毁。

---

## 3. 拷贝构造 vs 拷贝赋值：区别与触发场景

### 3.1 拷贝构造（copy constructor）

**用一个对象去初始化另一个“新对象”**。目标对象此时尚未构造完成。

触发示例：

```cpp
T b(a);        // 直接初始化
T b = a;       // 语法像赋值，但本质仍是拷贝构造（拷贝初始化）
void f(T x);   // 传值形参：用实参构造形参（可能被优化/移动）
return x;      // 按值返回：可能触发拷贝构造（或移动/NRVO）
```

函数签名：

```cpp
T(const T& other);
```

### 3.2 拷贝赋值（copy assignment）

**把一个已有对象覆盖成另一个对象的状态**。目标对象已经构造完成，可能还持有资源。

触发示例：

```cpp
T b;
b = a;         // 拷贝赋值：b 已存在，被覆盖
```

函数签名：

```cpp
T& operator=(const T& other);
```

### 3.3 关键差异总结

* 拷贝构造：目标对象“从无到有”，主要是初始化
* 拷贝赋值：目标对象“已存在”，必须处理旧资源、自赋值、异常安全

---

## 4. 移动语义：移动构造/移动赋值的核心

### 4.1 移动（move）的语义

**转移资源所有权**（或资源句柄），而不是复制。移动后源对象进入“可析构、可赋值，但资源被移走”的有效状态（通常置空）。

移动构造：

```cpp
T(T&& other) noexcept;
```

移动赋值：

```cpp
T& operator=(T&& other) noexcept;
```

### 4.2 移动赋值的关键步骤

移动赋值比移动构造更复杂，因为左侧对象已有资源：

典型模式：

1. `if (this != &other)` 自移动保护
2. 释放当前资源（防泄漏）
3. 接管对方资源
4. 把对方置为空状态

---

## 5. std::move 解析（重点）

### 5.1 `std::move` 的本质

`std::move(x)` **不移动任何东西**。它只是一个**类型转换**：

* 把 `x` 从左值转换为右值引用（`T&&`）
* 让重载解析“更倾向”选择移动构造/移动赋值

可以把它理解为：**“允许被偷资源”** 的标记。

### 5.2 发生移动的条件

发生移动的前提是：类型真的提供了可用的移动操作（或编译器生成了它）。

* 如果移动构造/移动赋值存在：`std::move(x)` 会触发移动路径
* 如果移动被 `= delete` 禁掉：`std::move(x)` 要么导致编译错误，要么退化为拷贝（如果拷贝可用且可匹配）

### 5.3 “禁止移动还能用 move 转移所有权吗？”

不能。因为 `std::move` 只是转型，**没有可用移动函数就无法发生“转移所有权”**。

对“唯一所有权类（unique ownership）”来说：

* 允许拷贝会破坏唯一性（两个对象指向同一资源 → double free）
* 禁用拷贝是必须的
* 若再禁用移动，则类型变成“不可转移的唯一所有权”，能保证唯一性，但几乎无法在函数间转交所有权，工程可用性很差

**结论：**

* `UniquePtr` 这类唯一所有权类型：**禁拷贝 + 允移动** 是主流设计
* `std::move` 不能绕过你对移动/拷贝的限制

---

## 6. Rule of 0 / 3 / 5：什么时候需要写这些函数

* **Rule of 0**：类不直接管理资源（只用 STL/智能指针成员） → 尽量不写特殊成员函数
* **Rule of 5**：类直接管理资源（裸指针/句柄） → 通常要系统处理析构、拷贝、移动（以及赋值）

你的 `UniquePtr` 属于典型 Rule of 5：管理裸指针资源，必须手写/控制这些语义。

---

## 7. 示例：`MyString`（手写资源管理类）展示拷贝与移动

目标：拥有一段堆内存 char buffer。

* 拷贝：深拷贝（各自拥有各自 buffer）
* 移动：偷指针（转移 buffer 所有权，源对象置空）

```cpp
#include <cstring>
#include <utility>
#include <cstddef>

class MyString {
public:
    MyString() noexcept : ptr_(nullptr), len_(0) {}

    explicit MyString(const char* s) {
        if (!s) { ptr_ = nullptr; len_ = 0; return; }
        len_ = std::strlen(s);
        ptr_ = new char[len_ + 1];
        std::memcpy(ptr_, s, len_ + 1);
    }

    ~MyString() noexcept { delete[] ptr_; }

    // 拷贝构造：深拷贝
    MyString(const MyString& other) {
        len_ = other.len_;
        if (len_ == 0) { ptr_ = nullptr; return; }
        ptr_ = new char[len_ + 1];
        std::memcpy(ptr_, other.ptr_, len_ + 1);
    }

    // 移动构造：偷资源
    MyString(MyString&& other) noexcept
        : ptr_(std::exchange(other.ptr_, nullptr)),
          len_(std::exchange(other.len_, 0)) {}

    void swap(MyString& rhs) noexcept {
        std::swap(ptr_, rhs.ptr_);
        std::swap(len_, rhs.len_);
    }

    // 拷贝赋值：copy-and-swap（强异常安全）
    MyString& operator=(const MyString& other) {
        MyString tmp(other); // 可能抛异常，但不影响 *this
        tmp.swap(*this);
        return *this;
    }

    // 移动赋值：释放旧资源 + 偷新资源
    MyString& operator=(MyString&& other) noexcept {
        if (this != &other) {
            delete[] ptr_;
            ptr_ = std::exchange(other.ptr_, nullptr);
            len_ = std::exchange(other.len_, 0);
        }
        return *this;
    }

private:
    char* ptr_;
    std::size_t len_;
};
```
```cpp
#pragma once

#include <type_traits>
#include <utility>

template <class _Tp>
struct DefaultDeleter { // 默认使用 delete 释放内存
    void operator()(_Tp *p) const {
        delete p;
    }
};

template <class _Tp>
struct DefaultDeleter<_Tp[]> { // 偏特化
    void operator()(_Tp *p) const {
        delete[] p;
    }
};

template <class _Tp, class _Deleter = DefaultDeleter<_Tp>>
struct UniquePtr {
private:
    _Tp *_M_p;
    [[no_unique_address]] _Deleter _M_deleter;

    template <class _Up, class _UDeleter>
    friend struct UniquePtr;

public:
    using element_type = _Tp;
    using pointer = _Tp *;
    using deleter_type = _Deleter;

    UniquePtr(std::nullptr_t = nullptr) noexcept : _M_p(nullptr) { // 默认构造函数
    }

    explicit UniquePtr(_Tp *p) noexcept : _M_p(p) { // 自定义构造函数
    }

    template <class _Up, class _UDeleter, class = std::enable_if_t<std::is_convertible_v<_Up *, _Tp *>>> // 没有 C++20 的写法
    // template <class _Up, class _UDeleter> requires (std::convertible_to<_Up *, _Tp *>) // 有 C++20 的写法
    UniquePtr(UniquePtr<_Up, _UDeleter> &&__that) noexcept : _M_p(__that._M_p) {  // 从子类型_Up的智能指针转换到_Tp类型的智能指针
        __that._M_p = nullptr;
    }

    ~UniquePtr() noexcept { // 析构函数
        if (_M_p)
            _M_deleter(_M_p);
    }

    UniquePtr(UniquePtr const &__that) = delete; // 拷贝构造函数
    UniquePtr &operator=(UniquePtr const &__that) = delete; // 拷贝赋值函数
    
    UniquePtr(UniquePtr &&__that) noexcept : _M_p(__that._M_p) { // 移动构造函数
        __that._M_p = nullptr;
    }
    
    UniquePtr &operator=(UniquePtr &&__that) noexcept { // 移动赋值函数
        if (this != &__that) [[likely]] {
            if (_M_p)
                _M_deleter(_M_p);
            _M_p = std::exchange(__that._M_p, nullptr);
        }
        return *this;
    }

    void swap(UniquePtr &__that) noexcept { // 交换函数
        std::swap(_M_p, __that._M_p);
    }

    _Tp *get() const noexcept {
        return _M_p;
    }

    _Tp *operator->() const noexcept {
        return _M_p;
    }

    std::add_lvalue_reference_t<_Tp> operator*() const noexcept {
        return *_M_p;
    }

    _Deleter get_deleter() const noexcept {
        return _M_deleter;
    }

    _Tp *release() noexcept {
        _Tp *__p = _M_p;
        _M_p = nullptr;
        return __p;
    }

    void reset(_Tp *__p = nullptr) noexcept {
        if (_M_p)
            _M_deleter(_M_p);
        _M_p = __p;
    }

    explicit operator bool() const noexcept {
        return _M_p != nullptr;
    }

    bool operator==(UniquePtr const &__that) const noexcept {
        return _M_p == __that._M_p;
    }

    bool operator!=(UniquePtr const &__that) const noexcept {
        return _M_p != __that._M_p;
    }

    bool operator<(UniquePtr const &__that) const noexcept {
        return _M_p < __that._M_p;
    }

    bool operator<=(UniquePtr const &__that) const noexcept {
        return _M_p <= __that._M_p;
    }

    bool operator>(UniquePtr const &__that) const noexcept {
        return _M_p > __that._M_p;
    }

    bool operator>=(UniquePtr const &__that) const noexcept {
        return _M_p >= __that._M_p;
    }
};

template <class _Tp, class _Deleter>
struct UniquePtr<_Tp[], _Deleter> : UniquePtr<_Tp, _Deleter> {
    using UniquePtr<_Tp, _Deleter>::UniquePtr;

    std::add_lvalue_reference_t<_Tp> operator[](std::size_t __i) {
        return this->get()[__i];
    }
};

template <class _Tp, class ..._Args, std::enable_if_t<!std::is_unbounded_array_v<_Tp>, int> = 0>
UniquePtr<_Tp> makeUnique(_Args &&...__args) {
    return UniquePtr<_Tp>(new _Tp(std::forward<_Args>(__args)...));
}

template <class _Tp, std::enable_if_t<!std::is_unbounded_array_v<_Tp>, int> = 0>
UniquePtr<_Tp> makeUniqueForOverwrite() {
    return UniquePtr<_Tp>(new _Tp);
}

template <class _Tp, std::enable_if_t<std::is_unbounded_array_v<_Tp>, int> = 0>
UniquePtr<_Tp> makeUnique(std::size_t __len) {
    return UniquePtr<_Tp>(new std::remove_extent_t<_Tp>[__len]());
}

template <class _Tp, std::enable_if_t<std::is_unbounded_array_v<_Tp>, int> = 0>
UniquePtr<_Tp> makeUniqueForOverwrite(std::size_t __len) {
    return UniquePtr<_Tp>(new std::remove_extent_t<_Tp>[__len]);
}

```
触发点记忆：

* `T b(a);` / `T b = a;` → 拷贝构造
* `b = a;` → 拷贝赋值
* `T b(std::move(a));` → 移动构造（若存在）
* `b = std::move(a);` → 移动赋值（若存在）

---

## 8. 结合你的 `UniquePtr`：哪些函数为什么这样写

### 8.1 设计语义：唯一所有权

* 拷贝构造/拷贝赋值：必须禁用（否则 double delete 风险）
* 移动构造/移动赋值：允许，以“转移所有权”方式工作
* 析构：负责释放所拥有资源

### 8.2 移动赋值中 `this != &that`

这不是“通过 &this 移动”，而是：

* `this`：当前对象指针
* `&that`：对方对象地址
* 防止自移动导致逻辑异常（虽少见，但工程上是标准保护）

### 8.3 `std::exchange` 的意义

`_M_p = std::exchange(that._M_p, nullptr)` 一句完成：

* 把 `that._M_p` 旧值转交给我
* 同时把 `that._M_p` 置空，保证 that 析构不会释放同一资源

