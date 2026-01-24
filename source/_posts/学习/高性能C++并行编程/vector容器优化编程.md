---
title: "vector容器优化编程"
date: 2025-11-22 15:30:58
tags:
  - "C++"
  - "性能优化"
  - "STL"
categories:
  - "学习"
  - "高性能C++并行编程"
thumbnail: /img/covers/cover9.jpg
---
# vector 容器优化编程笔记

时间：2025/11/22
课程地址：Bilibili – BV1qF411T7sd
课件仓库：parallel101/course（GitHub）

---

## 一、基础知识

### 1. 分配器（Allocator）

| 方法                      | 功能                    |
| ----------------------- | --------------------- |
| `allocate(n)`           | 分配 n 个 T 的原始内存（未构造对象） |
| `deallocate(p, n)`      | 释放之前分配的内存             |
| `construct(p, args...)` | 在 p 指向的位置调用 T 的构造函数   |
| `destroy(p)`            | 调用 p 指向对象的析构函数        |

vector 在扩容时会：

allocator.allocate() 申请更大内存

allocator.construct() 搬移原有元素

allocator.destroy() 销毁旧元素

allocator.deallocate() 释放旧内存

### 2. 迭代器（Iterator）

提供一个统一的、类似指针的访问接口

迭代器 ≈ 指针的一般化版本

vector 的迭代器本质就是指针（随机访问）

list 的迭代器是包装了节点的对象（链式结构）

map/set 的迭代器包装了树节点（红黑树结构）

所有迭代器都必须重载以下操作符：

*it 返回元素

it->member 访问结构体字段

++it / --it 移动位置

it == other 判断是否到达末尾

| 容器      | 迭代器类型      | 是否连续内存 |
| ------- | ---------- | ------ |
| vector  | 随机访问（指针）   | 是      |
| array   | 随机访问（指针）   | 是      |
| deque   | 随机访问（复杂对象） | 否      |
| list    | 双向迭代器      | 否      |
| set/map | 双向迭代器（红黑树） | 否      |


### 3. 仿函数（Functor）

仿函数也称“函数对象”（Function Object），本质是一个重载了 `operator()` 的类实例。
它既能像函数一样被调用，也能作为对象携带状态，因此常用于需要将“可调用对象”作为参数传入的场景中。

编写仿函数的基本方式：
创建一个类 → 实现内部逻辑 → 重载 `operator()`。
这样可以避免大量使用全局变量，同时便于逻辑复用，使代码更易维护和管理。

---

## 二、vector 容器

`std::vector` 是一种动态数组，其元素存储在堆上，支持自动扩容。

常用操作说明：

```cpp
vector<int> a(4)
```

1. **size()**
   `a.size()` 返回当前长度（元素个数）。

2. **operator[]**
   `a[x]` 等价于 `*(a.begin() + x)`。
   需要注意：为了性能 **不会做越界检查**，越界可能导致未定义行为（包括程序崩溃）。

3. **at()**
   `a.at(x)` 与 `a[x]` 功能一致，但会进行边界检查（异常处理），可靠性更高但性能略低。

4. **resize(n)**
   修改 vector 的逻辑长度为 n：

   * n 变大：扩容位置填充默认值（int 为 0）
   * n 变小：截断，但多余空间不会立即释放，仅修改 size，不改 capacity

5. **resize(n, val)**
   扩容部分使用 `val` 填充。

6. **clear()**
   `a.clear()` 等价于 `a.resize(0)`；清空元素但不释放已分配内存。

7. **push_back(x)**
   在末尾添加一个元素。
   等价于：`a.resize(a.size()+1, x)`。

8. **pop_back()**
   删除末尾元素（不返回值）。
   等价于：`a.resize(a.size()-1)`。

9. **back()**
   返回最后一个元素 `a[a.size()-1]`。

10. **front()**
    等价于 `a[0]`。

11. **data()**
    返回底层数组的首地址，即 `&a[0]`。
    通常需搭配 `size()` 使用，方便与 C 风格接口交互。
    **注意：扩容后 data() 可能失效，因为底层地址可能改变。**

12. **capacity()**
    返回当前实际分配的容量（不等于 size）。

13. **shrink_to_fit()**
    请求释放多余内存，使 capacity 接近 size（但不保证一定有效）。

---

## 三、迭代器

迭代器本质上类似指针，但通过重载运算符实现对不同容器的统一访问方式。
可以理解为：**“为容器设计的通用指针行为适配层”**，从而兼容 C 语言的指针风格遍历。

---

## 四、补充知识

### 1. 栈与堆

#### Vector **对象本身**的存储位置

若直接作为局部变量声明：

```cpp
std::vector<int> vec;
```

`vec` 变量本身存储在 **栈** 上，包括：

* size
* capacity
* data 指针

#### Vector **元素**的存储位置

元素总是在 **堆** 上，因为 vector 需要支持动态扩容。

示意结构：

```
栈内存
    vector 对象本体
    ├── size
    ├── capacity
    └── data 指针（指向堆）

堆内存
    元素1
    元素2
    ……
```

---

## 五、参考资料

1. *仿函数详解*
   [https://www.cnblogs.com/helloylh/p/17209709.html](https://www.cnblogs.com/helloylh/p/17209709.html)

2. *Vector 对象到底在堆上还是栈上？*
   [https://www.51cto.com/article/814126.html](https://www.51cto.com/article/814126.html)
