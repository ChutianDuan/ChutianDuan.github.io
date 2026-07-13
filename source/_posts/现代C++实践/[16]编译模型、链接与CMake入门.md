---
title: "头文件明明存在，为什么仍然 `undefined symbol`？从翻译单元到现代 CMake"
date: 2026-07-13 09:58:22
updated: 2026-07-13 09:58:22
categories:
  - "学习"
  - "现代 C++ 实践"
permalink: /notes/现代c-实践/16-编译模型-链接与cmake入门/
series: "现代 C++ 实践"
series_order: 16
---

时间：2026/05/04

项目里已经写了函数声明，编辑器也能跳转到头文件，单个 `.cpp` 编译通过，最终链接却失败：

```text
Undefined symbols for architecture arm64:
  "demo::add(int, int)", referenced from ...
```

这并不矛盾。头文件里的声明只让编译器知道函数如何调用，真正生成函数实现的 `.cpp` 还必须被编译，并且对应目标文件或库要进入最终链接。反过来，把普通函数定义直接写进头文件，又可能在多个翻译单元产生 `duplicate symbol`。

理解这两类错误，需要把 C++ 工程看成“多个翻译单元分别编译，再由链接器组合符号”，而不是一次性处理整个源码目录。本文从一条丢失的函数定义出发，讲清声明、定义、ODR、静态/动态库和 target-based CMake，并构建一个最小多文件项目。

---

## 1. 一个 C++ 程序怎样从文件变成可执行文件？

源文件大致经历预处理、编译/汇编和链接：

```text
main.cpp + 它包含的头文件
            ↓ 预处理与编译
          main.o

math.cpp + 它包含的头文件
            ↓ 预处理与编译
          math.o

main.o + math.o + 所需库
            ↓ 链接
            app
```

每个 `.cpp` 连同预处理后展开的头文件内容形成一个翻译单元（translation unit）。头文件通常不独立生成目标文件，而是被复制式地纳入每个包含它的翻译单元。

这解释了两件事：

- 修改公共头文件可能让许多 `.cpp` 重新编译；
- 头文件里的非 inline 外部定义可能在多个目标文件各生成一份，最终链接冲突。

实际标准翻译阶段更细，编译器驱动也可能合并步骤。工程排错只需先区分：单个翻译单元能否编译，以及所有目标能否链接。

## 2. 声明为什么能通过编译，却不能完成链接？

声明告诉编译器名字、参数和返回类型：

```cpp
namespace demo {
int add(int left, int right);
}
```

调用点据此生成“调用 `demo::add(int, int)`”的符号引用。定义才提供函数体：

```cpp
namespace demo {
int add(int left, int right) {
    return left + right;
}
}
```

如果定义所在 `math.cpp` 没有加入构建，编译 `main.cpp` 仍可成功，链接器却找不到符号。

常见错误阶段可以快速分类：

| 现象 | 多发生在哪一阶段 | 常见原因 |
| --- | --- | --- |
| 找不到头文件 | 预处理/编译 | include path 错、依赖未声明 |
| 类型不完整、语法或重载失败 | 编译 | 声明不可见、类型/语法错误 |
| undefined reference/symbol | 链接 | 定义未编译、库未链接、签名不一致 |
| duplicate/multiple definition | 链接 | 头文件重复外部定义、源文件重复加入 |
| 运行时找不到动态库 | 程序加载 | 搜索路径、安装名/RPATH、部署缺失 |

看到“编译报错”时先识别阶段，能避免不断修改 include path 去修复实际的链接问题。

## 3. ODR 为什么限制定义出现次数？

ODR（One Definition Rule，一个定义规则）细节很多，工程中先掌握两个重点：

1. 普通具有外部链接的非 inline 函数或变量，整个程序通常只能有一个定义；
2. 类、模板和 inline 实体可以在多个翻译单元出现定义，但相应定义必须满足 ODR 的一致性要求。

下面的头文件被两个 `.cpp` 包含后，可能产生重复符号：

```cpp
// bad.hpp
int twice(int value) {
    return value * 2;
}
```

小函数确实适合在头文件定义时，应标记 `inline`：

```cpp
inline int twice(int value) {
    return value * 2;
}
```

或者把声明放头文件、唯一定义放源文件：

```cpp
// twice.hpp
int twice(int value);

// twice.cpp
int twice(int value) { return value * 2; }
```

`inline` 在这里的关键语义是允许满足规则的多翻译单元定义，并不保证编译器一定把调用展开。是否进行调用内联由优化器决定。

## 4. 头文件里应该放什么？

通常适合放：

- 类型和函数声明；
- 模板定义；
- inline/类内定义的小函数；
- `inline constexpr` 常量；
- 使用者编译自身代码所必需的完整类型信息。

通常应移到 `.cpp`：

- 非 inline 普通函数定义；
- 只有实现需要的辅助类型和重型第三方头；
- 普通外部全局变量的唯一定义；
- 不希望成为公共编译依赖的实现细节。

普通全局变量可用声明与定义分开：

```cpp
// counter.hpp
extern int counter;

// counter.cpp
int counter = 0;
```

C++17 起，确实需要在头文件定义的常量可使用 inline variable：

```cpp
inline constexpr int max_retries = 3;
```

头文件应尽量自包含：直接包含它所需的声明，不依赖调用者碰巧先包含某个头。可以通过单独编译一个只包含该头的测试源验证。

## 5. include guard 为什么解决不了重复符号？

`#pragma once` 或 include guard 只防止同一头文件在**一个翻译单元**中重复展开：

```cpp
#pragma once

int add(int, int);
```

如果 `a.cpp` 和 `b.cpp` 都包含它，头文件仍会分别进入两个翻译单元，这是正常且必要的。guard 不能让头文件里的普通外部定义全程序只生成一次。

传统 include guard 可移植地使用唯一宏名：

```cpp
#ifndef DEMO_MATH_HPP
#define DEMO_MATH_HPP
// declarations
#endif
```

`#pragma once` 被主流编译器广泛支持且更简洁，但它不是用于修复 ODR 的关键字。

## 6. 为什么模板定义通常必须在头文件可见？

编译器在使用 `max_value<int>` 时需要看到模板定义，才能实例化具体代码：

```cpp
template <class T>
T max_value(T left, T right) {
    return left < right ? right : left;
}
```

若头文件只有声明、定义藏在另一个 `.cpp`，使用点通常无法生成所需实例。常见做法是把模板定义放头文件，或放 `.ipp/.inl` 后由头文件包含。

模板也可以在 `.cpp` 显式实例化一组固定类型，但这会限制可用类型，并需要仔细管理 extern template 与导出符号。它是编译时间和 ABI 策略，不是入门项目的默认写法。

## 7. 一个最小 target-based CMake 项目

项目结构：

```text
demo/
├── CMakeLists.txt
├── include/
│   └── demo/
│       └── math.hpp
└── src/
    ├── math.cpp
    └── main.cpp
```

公共头文件只提供声明：

```cpp
// include/demo/math.hpp
#pragma once

namespace demo {
int add(int left, int right);
}
```

源文件提供唯一定义：

```cpp
// src/math.cpp
#include "demo/math.hpp"

namespace demo {
int add(int left, int right) {
    return left + right;
}
}
```

可执行程序只依赖公共接口：

```cpp
// src/main.cpp
#include "demo/math.hpp"

#include <iostream>

int main() {
    std::cout << demo::add(20, 22) << '\n';
}
```

`CMakeLists.txt` 围绕 target 表达依赖：

```cmake
cmake_minimum_required(VERSION 3.20)
project(demo LANGUAGES CXX)

add_library(demo_math STATIC
    src/math.cpp
)

target_include_directories(demo_math
    PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_compile_features(demo_math
    PUBLIC
        cxx_std_20
)

add_executable(demo_app
    src/main.cpp
)

target_link_libraries(demo_app
    PRIVATE
        demo_math
)
```

配置、构建和运行：

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel 2
./build/demo_app
```

单配置生成器通常使用 `CMAKE_BUILD_TYPE`；Xcode、Visual Studio 等多配置生成器应在构建时使用 `--config Release`，可执行文件位置也可能包含配置子目录。具体路径以生成器输出为准。

预期程序输出：

```text
42
```

如果从 `add_library` 删除 `src/math.cpp`，CMake 仍可能成功配置，`main.cpp` 也能编译，但最终会出现 `demo::add` 未定义符号。这正是开头错误的完整因果链。

## 8. CMake 中的 `PUBLIC`、`PRIVATE`、`INTERFACE` 传播什么？

这些关键字描述 usage requirements 是否用于当前 target、是否传播给依赖者：

| 关键字 | 当前 target 使用 | 链接它的 target 继承 |
| --- | --- | --- |
| `PRIVATE` | 是 | 否 |
| `PUBLIC` | 是 | 是 |
| `INTERFACE` | 否 | 是 |

`math.cpp` 和 `main.cpp` 都要包含 `demo/math.hpp`。include 目录是 `demo_math` 公共接口的一部分，所以标为 `PUBLIC`，`demo_app` 通过 `target_link_libraries` 自动继承。

只有库实现 `.cpp` 使用的目录或编译定义应为 `PRIVATE`。header-only 库没有自己的编译步骤，常用 `INTERFACE` target：

```cmake
add_library(warnings INTERFACE)
target_compile_options(warnings INTERFACE -Wall -Wextra)
```

实际跨编译器项目不能把 GCC/Clang 选项无条件传给 MSVC，应使用编译器条件或项目已有 warnings target。

“链接一个 target”不仅加入库文件，还传播其公开 include 目录、编译特性和必要定义。相比全局 `include_directories()`、`add_definitions()`，依赖图更局部且可追踪。

## 9. 静态库和动态库的区别只在扩展名吗？

| 类型 | 常见扩展名 | 主要特点 |
| --- | --- | --- |
| 静态库 | Unix `.a`，Windows 常见 `.lib` | 链接时把所需代码纳入产物 |
| 动态库 | Linux `.so`、macOS `.dylib`、Windows `.dll` | 程序加载时解析共享库 |

动态库还需要处理部署搜索路径、符号可见性、版本和 ABI。公共边界暴露 STL 容器、异常、编译器特有类型或“在一侧分配、另一侧释放”时，要保证编译器、标准库和运行时兼容。

同一源码能构建成 shared library 不代表已经拥有稳定 ABI。插件接口和长期二进制兼容需要专门设计，不能只把 `STATIC` 改成 `SHARED`。

## 10. 怎样降低头文件带来的编译依赖？

每个公共头修改都可能让所有依赖翻译单元重编译。常见做法：

- 头文件只包含自身真正需要的依赖；
- 能用前向声明时避免暴露完整实现，但必须满足使用场景；
- 重型第三方头放到 `.cpp`；
- 实现辅助函数放匿名 namespace 或源文件内部；
- 公共接口保持小而稳定。

Pimpl 可以隐藏实现：

```cpp
// widget.hpp
#include <memory>

class Widget {
public:
    Widget();
    ~Widget(); // 在 .cpp 中定义，此处 Impl 才完整

private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};
```

它减少实现变化造成的重编译并有助于 ABI 隔离，但会引入动态分配、间接访问和更多样板。只有编译依赖或二进制边界确实需要时才使用，不要给每个小类都套 Pimpl。

## 11. CMake 为什么不应该收集所有 `.cpp` 到一个全局列表？

把整个仓库源文件 glob 到一个可执行 target 会模糊模块边界，测试、工具和生产程序可能意外链接彼此实现。明确 target 让构建图表达：

```text
demo_app ──PRIVATE──> demo_math
tests    ──PRIVATE──> demo_math
```

每个 target 只列自己拥有的源文件，并通过 `target_link_libraries` 声明依赖。新增 `.cpp` 时需要显式更新 CMake，这通常是有价值的代码审查信号。

对象文件重复进入链接也可能造成 duplicate symbol。例如既把 `math.cpp` 直接加入 app，又链接一个已经包含它的 object/static library。源文件应有清楚的 target 所有者。

## 12. 工程中最容易踩哪些坑？

### 误区一：IDE 能跳转到声明，说明实现已经链接

代码索引和编译数据库能找到头文件，不证明实现目标进入最终链接。检查 target 的源文件与 link line。

### 误区二：给头文件加 `#pragma once` 能修 duplicate symbol

它只防单翻译单元重复包含。跨翻译单元定义要使用正确的 inline/模板规则或移到一个 `.cpp`。

### 误区三：`inline` 一定提升运行速度

语言关键字主要改变定义规则；优化器是否展开调用由成本模型和优化设置决定。

### 误区四：只要写 `-std=c++20` 就完成 CMake 配置

硬编码选项不具备跨编译器表达力，也不会正确传播给依赖。优先 `target_compile_features(target PUBLIC cxx_std_20)`。

### 误区五：所有 include path 都设为全局

全局路径会让未声明依赖的 target 偶然编译成功，并污染子目录。把公开/私有需求挂在拥有它的 target 上。

### 误区六：动态库只是更省磁盘的静态库

动态加载带来运行时搜索、ABI、版本和符号可见性问题，需要部署与兼容策略。

## 13. 怎样系统排查一次构建错误？

1. 先读错误发生阶段：预处理、编译、链接还是加载；
2. 找不到头时检查消费 target 是否链接/继承正确依赖，而非先加全局路径；
3. undefined symbol 时比较声明与定义的完整签名，并确认实现 `.cpp` 进入库；
4. 检查最终可执行是否链接正确 target，必要时开启 verbose 构建查看命令；
5. duplicate symbol 时搜索定义，确认是否写入公共头或重复编译源；
6. 运行时库缺失时检查产物部署、RPATH/安装名和平台加载器信息。

CMake 可用 `cmake --build build --verbose` 查看实际编译与链接命令。不要只根据 CMake 源码猜测最终命令。

## 14. 总结

开头头文件存在却 undefined symbol，是因为声明只解决单翻译单元的编译，定义所在目标还没有参与最终链接。

1. 每个 `.cpp` 与包含内容形成独立翻译单元，目标文件最后由链接器组合；
2. 声明告诉编译器如何使用，定义提供实体，ODR 约束定义出现方式；
3. include guard 防单翻译单元重复包含，不能修复跨目标重复定义；
4. 模板定义通常要在实例化点可见，普通实现优先放 `.cpp`；
5. 现代 CMake 用 target 和 `PUBLIC/PRIVATE/INTERFACE` 表达可传播依赖。

下次遇到构建错误，先问“哪个翻译单元正在编译、哪个 target 应该拥有实现、最终链接命令里有没有它”。这三个问题通常比继续添加 include 路径更快找到根因。
