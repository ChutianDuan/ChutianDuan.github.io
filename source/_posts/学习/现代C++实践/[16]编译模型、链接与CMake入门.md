---
title: "编译模型、链接与 CMake 入门"
date: 2026-05-04 14:48:32
updated: 2026-05-04 14:48:32
categories:
  - "学习"
  - "现代C++实践"
permalink: /notes/现代c-实践/16-编译模型-链接与cmake入门/
---

# 编译模型、链接与 CMake 入门

时间：2026/05/04

> 关键词：头文件、源文件、声明、定义、链接、ODR、静态库、动态库、CMake、target
> 核心目标：理解 C++ 工程从源码到可执行文件的大致流程，避免头文件乱放、重复定义和 CMake 全局变量式写法。

---

## 1. 为什么现代 C++ 也必须懂编译模型

很多 C++ 工程问题表面上是“编译报错”，本质上是：

* 声明和定义混乱
* 头文件包含关系失控
* 重复定义违反 ODR
* 链接阶段找不到符号
* CMake 里 include path 和 link library 没有按 target 管理

懂编译模型的价值是：

* 知道错误发生在预处理、编译还是链接
* 知道哪些内容该放头文件，哪些该放 `.cpp`
* 知道库和可执行文件怎么组织

---

## 2. 从源码到程序的几个阶段

一个 C++ 文件大致经历：

1. 预处理：展开 `#include`、宏、条件编译
2. 编译：把翻译单元编译成目标文件
3. 汇编：生成机器码形式的 `.o` / `.obj`
4. 链接：把多个目标文件和库合成可执行文件或库

可以粗略理解成：

```text
main.cpp + include 的头文件
    -> 一个翻译单元
    -> main.o

foo.cpp + include 的头文件
    -> 一个翻译单元
    -> foo.o

main.o + foo.o + libraries
    -> app
```

头文件本身通常不会单独编译。
它是被各个 `.cpp` 包含后，成为不同翻译单元的一部分。

---

## 3. 声明和定义

声明告诉编译器：

> 有这个名字，它的类型长这样。

```cpp
int add(int a, int b); // 函数声明
```

定义真正提供实体：

```cpp
int add(int a, int b) {
    return a + b;
}
```

变量也一样：

```cpp
extern int global_count; // 声明
int global_count = 0;    // 定义
```

常见组织方式：

```text
include/math.hpp   -> 声明
src/math.cpp       -> 定义
src/main.cpp       -> 使用
```

---

## 4. 头文件里应该放什么

通常适合放头文件：

* 类声明
* 函数声明
* 模板定义
* `inline` 函数定义
* `constexpr` 小函数
* 常量声明或 `inline constexpr` 变量

通常不适合放头文件：

* 普通全局变量定义
* 非 `inline` 普通函数定义
* 大量不必要的实现细节
* 会导致编译依赖爆炸的重型 include

错误例子：

```cpp
// bad.hpp
int counter = 0; // 被多个 cpp include 后会重复定义
```

更合适：

```cpp
// counter.hpp
extern int counter;

// counter.cpp
int counter = 0;
```

C++17 起，如果确实想在头文件定义全局常量，可以用：

```cpp
inline constexpr int max_retry = 3;
```

---

## 5. ODR：一个定义规则

ODR 是：

> One Definition Rule

粗略说：

* 一个具有外部链接的实体，在整个程序里通常只能有一个定义
* 类、模板、`inline` 函数可以出现在多个翻译单元，但定义必须一致

典型 ODR 问题：

```cpp
// util.hpp
int twice(int x) {
    return x * 2;
}
```

如果这个头文件被多个 `.cpp` 包含，就可能链接时报重复定义。

修正：

```cpp
// util.hpp
inline int twice(int x) {
    return x * 2;
}
```

或者：

```cpp
// util.hpp
int twice(int x);

// util.cpp
int twice(int x) {
    return x * 2;
}
```

---

## 6. 为什么模板通常写在头文件

模板不是普通函数。
编译器需要在使用点看到模板定义，才能根据具体类型实例化代码。

```cpp
template <class T>
T max_value(T a, T b) {
    return a < b ? b : a;
}
```

如果只把模板声明放头文件、定义放 `.cpp`，其他翻译单元通常没法实例化它。

所以模板库常见形态是：

* 大量实现放在头文件
* 或者放在 `.ipp` / `.inl` 后再被头文件 include

---

## 7. 链接错误怎么读

常见链接错误：

### 7.1 undefined reference / undefined symbol

意思是：

* 编译器看到了声明
* 链接器找不到定义

常见原因：

* `.cpp` 没加入构建
* 忘记链接某个库
* 函数签名声明和定义不一致
* 模板定义不可见

### 7.2 duplicate symbol / multiple definition

意思是：

* 同一个外部符号有多个定义

常见原因：

* 普通函数定义写进头文件但没加 `inline`
* 全局变量定义写进头文件
* 同一个 `.cpp` 被错误地编进多个目标

---

## 8. 静态库和动态库

静态库：

* Linux/macOS 常见 `.a`
* Windows 常见 `.lib`
* 链接时把需要的目标代码合进最终产物

动态库：

* Linux `.so`
* macOS `.dylib`
* Windows `.dll`
* 程序运行时加载库代码

工程实践里要关心：

* 头文件提供编译期声明
* 库文件提供链接期或运行期实现
* ABI 边界要谨慎暴露 STL 类型、异常、内存分配策略

---

## 9. CMake 的核心是 target

现代 CMake 不建议把所有配置堆进全局变量。
更推荐围绕 target 写：

```cmake
cmake_minimum_required(VERSION 3.20)
project(demo LANGUAGES CXX)

add_library(core
    src/math.cpp
)

target_include_directories(core
    PUBLIC
        include
)

target_compile_features(core
    PUBLIC
        cxx_std_20
)

add_executable(app
    src/main.cpp
)

target_link_libraries(app
    PRIVATE
        core
)
```

这里的依赖关系是：

```text
app -> core
```

`core` 的 public include path 会传递给链接它的 target。

---

## 10. `PUBLIC` / `PRIVATE` / `INTERFACE`

这三个词是现代 CMake 的核心。

| 关键字 | 当前 target 使用 | 依赖当前 target 的别人使用 |
| --- | --- | --- |
| `PRIVATE` | 是 | 否 |
| `PUBLIC` | 是 | 是 |
| `INTERFACE` | 否 | 是 |

例子：

```cmake
target_include_directories(core
    PUBLIC include
    PRIVATE src
)
```

含义：

* `core` 自己能 include `include` 和 `src`
* 依赖 `core` 的 target 只能继承 `include`

经验规则：

* 头文件里需要暴露给使用者的 include path：`PUBLIC`
* 只有 `.cpp` 内部使用的 include path：`PRIVATE`
* header-only 库：常用 `INTERFACE`

---

## 11. 一个常见工程结构

```text
project/
    CMakeLists.txt
    include/
        demo/
            math.hpp
    src/
        math.cpp
        main.cpp
    tests/
        math_test.cpp
```

头文件：

```cpp
// include/demo/math.hpp
#pragma once

namespace demo {

int add(int a, int b);

}
```

实现：

```cpp
// src/math.cpp
#include "demo/math.hpp"

namespace demo {

int add(int a, int b) {
    return a + b;
}

}
```

使用：

```cpp
// src/main.cpp
#include "demo/math.hpp"

int main() {
    return demo::add(1, 2);
}
```

---

## 12. include guard 和 `#pragma once`

传统 include guard：

```cpp
#ifndef DEMO_MATH_HPP
#define DEMO_MATH_HPP

int add(int a, int b);

#endif
```

现代工程里也常用：

```cpp
#pragma once
```

两者目的都是避免同一个头文件在一个翻译单元内被重复包含。
注意它们解决的是“重复包含”，不是跨多个 `.cpp` 的重复定义。

---

## 13. 降低编译依赖

C++ 大项目编译慢，常常是 include 依赖太重。

常见做法：

* 头文件少 include，能前向声明就前向声明
* 实现细节放 `.cpp`
* 大型第三方头只在 `.cpp` 包含
* 公共头文件保持稳定

例子：

```cpp
// widget.hpp
#pragma once

#include <memory>

class Impl;

class Widget {
public:
    Widget();
    ~Widget();

private:
    std::unique_ptr<Impl> impl_;
};
```

这就是常说的 Pimpl 思路。
它能减少头文件暴露的实现细节，但会引入一次间接访问和动态分配成本。

---

## 14. 常见坑

### 14.1 把普通函数定义放头文件

如果没有 `inline`，多个翻译单元包含后可能重复定义。

### 14.2 `.cpp` 没加入 CMake target

这通常会导致 undefined symbol。

### 14.3 include path 靠全局变量到处扩散

现代 CMake 更推荐 target 管理依赖。

### 14.4 头文件包含太重

会让一点小改动触发大量重编译。

### 14.5 混淆编译错误和链接错误

编译错误通常发生在单个翻译单元。
链接错误通常发生在多个目标文件合并时。

---

## 15. 一页总结

这篇最值得记住的是：

1. `.cpp` 加上它 include 的头文件形成翻译单元
2. 声明让编译通过，定义让链接通过
3. 普通函数和全局变量定义不要随便放头文件
4. 模板通常需要在使用点可见，所以常放头文件
5. 现代 CMake 应围绕 target 管理 include、features 和 link
6. `PUBLIC` / `PRIVATE` / `INTERFACE` 表达依赖是否传递

如果只记一句：

> C++ 工程不是把文件堆在一起编译，而是把翻译单元、符号和 target 依赖组织清楚。

---

## 16. 参考资料

1. cppreference: translation phases
   <https://en.cppreference.com/w/cpp/language/translation_phases>

2. cppreference: definitions and ODR
   <https://en.cppreference.com/w/cpp/language/definition>

3. CMake: target_include_directories
   <https://cmake.org/cmake/help/latest/command/target_include_directories.html>

4. CMake: target_link_libraries
   <https://cmake.org/cmake/help/latest/command/target_link_libraries.html>
