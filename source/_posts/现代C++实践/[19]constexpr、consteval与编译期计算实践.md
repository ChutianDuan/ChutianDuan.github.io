---
title: "加了 `constexpr` 为什么还会在运行期执行？讲清 `consteval` 与编译期边界"
date: 2026-07-13 10:08:56
updated: 2026-07-13 10:08:56
categories:
  - "学习"
  - "现代 C++ 实践"
permalink: /notes/现代c-实践/19-constexpr-consteval与编译期计算实践/
series: "现代 C++ 实践"
series_order: 19
---

时间：2026/05/08

下面的函数声明为 `constexpr`：

```cpp
constexpr int square(int value) {
    return value * value;
}
```

传入字面量时，它可以参与 `static_assert`；传入命令行读取的数字时，同一个函数仍会在运行期求值。`constexpr` 并不是“强制编译器提前计算”的开关，而是表示函数在满足常量表达式规则时**可以**用于常量求值。

如果业务要求端口号必须在编译期验证，就需要 `consteval`；如果只要求静态对象避免动态初始化，则是 `constinit`。三个关键字名字相近，却约束不同阶段。本文以端口常量和查表数据为主线，讲清可编译期、必须编译期、静态初始化和类型分支的边界。

---

## 1. `const` 与 `constexpr` 的差异是什么？

`const` 主要表达对象初始化后不能通过该名字修改，初始化值可以来自运行期：

```cpp
const int timeout = read_timeout_from_config();
```

`constexpr` 变量必须由常量表达式初始化，并且自身也是 const：

```cpp
constexpr int max_clients = 1024;
std::array<int, max_clients> counters{};
```

区别可以概括为：

| 声明 | 初始化何时可得 | 之后能否修改 | 能否作为常量表达式使用 |
| --- | --- | --- | --- |
| `const T` | 可在运行期 | 否 | 不一定 |
| `constexpr T` | 必须可常量求值 | 否 | 是 |
| 普通 `T` | 可在运行期 | 是 | 通常否 |

编译器可能把普通或 const 值也优化成常量，但优化结果不等于语言保证。数组界限、非类型模板参数和 `static_assert` 需要的是语言意义上的常量表达式。

## 2. `constexpr` 函数什么时候在编译期执行？

同一个函数可以有两种调用上下文：

```cpp
constexpr int square(int value) {
    return value * value;
}

static_assert(square(5) == 25); // 必须常量求值

int runtime_square(int value) {
    return square(value);       // value 运行期才知道，合法
}
```

`static_assert`、constexpr 变量初始化和模板参数等上下文要求常量表达式，求值失败会产生编译错误。普通表达式不要求常量求值，编译器即使能在优化阶段折叠，也属于 as-if 优化，不是 API 契约。

这也是 `constexpr` 的重要价值：同一套纯计算/校验逻辑既能检查编译期常量，也能处理运行期输入，避免维护两份实现。

## 3. 常量求值有哪些限制？

C++20 的 constexpr 能力已经支持循环、分支和许多标准库操作，但常量表达式仍不能依赖当时未知的运行期状态，也不能执行不允许出现在常量求值中的操作，例如普通 I/O。

```cpp
constexpr int read_value() {
    // std::cin >> value; 不能成为常量求值
}
```

一个 constexpr 函数体中可以包含某些只在运行期路径使用的代码，只要本次常量求值没有违反规则；具体许可随语言标准演进。工程中应以项目选择的 C++ 标准和标准库支持为准，不能把新标准示例直接假设在旧工具链可用。

## 4. `consteval` 为什么更严格？

`consteval` 定义立即函数（immediate function）。潜在求值调用必须产生编译期结果：

```cpp
struct Port {
    unsigned short value;
};

consteval Port port_literal(unsigned int value) {
    if (value == 0 || value > 65535) {
        throw "port out of range";
    }
    return Port{static_cast<unsigned short>(value)};
}

constexpr Port https = port_literal(443);
```

传入运行期值会编译失败：

```cpp
unsigned int value = read_port();
Port port = port_literal(value); // 错：value 不是常量表达式
```

`throw` 在这里不是把异常留到运行期，而是让非法分支无法完成常量求值，从而产生编译诊断。诊断文字由编译器决定，不能把字符串当作稳定错误协议。

`consteval` 适合只允许字面量/编译期描述符的接口，例如格式字符串验证、固定协议标签和生成编译期元数据。运行期配置不要强塞进立即函数，应提供独立的显式错误返回校验。

## 5. 一个可运行的完整示例

下面的 C++20 程序同时展示：`static_assert` 强制常量求值、`consteval` 端口校验、constexpr 查表、运行期复用 `square`，以及 `constinit` 静态变量。

```cpp
#include <array>
#include <iostream>

constexpr int square(int value) noexcept {
    return value * value;
}

constexpr std::array<int, 8> make_squares() noexcept {
    std::array<int, 8> result{};
    for (std::size_t index = 0; index < result.size(); ++index) {
        result[index] = square(static_cast<int>(index));
    }
    return result;
}

struct Port {
    unsigned short value;
};

consteval Port port_literal(unsigned int value) {
    if (value == 0 || value > 65535) {
        throw "port must be between 1 and 65535";
    }
    return Port{static_cast<unsigned short>(value)};
}

constinit unsigned int requests_seen = 0;

int main(int argc, char*[]) {
    constexpr auto squares = make_squares();
    constexpr Port https = port_literal(443);

    static_assert(square(5) == 25);
    static_assert(squares[6] == 36);

    const int input = argc == 1 ? 7 : 8;
    ++requests_seen;

    std::cout << "square(" << input << ") = " << square(input) << '\n';
    std::cout << "https port = " << https.value << '\n';
    std::cout << "table[5] = " << squares[5] << '\n';
    std::cout << "requests = " << requests_seen << '\n';
}
```

编译运行：

```bash
clang++ -std=c++20 -O2 -Wall -Wextra -pedantic \
  compile_time.cpp -o compile_time
./compile_time
```

预期默认输出：

```text
square(7) = 49
https port = 443
table[5] = 25
requests = 1
```

`squares` 和 `https` 的上下文要求常量表达式；命令行 `input` 只能在运行期得到，所以 `square(input)` 是普通运行期语义，尽管优化器仍可能针对具体上下文优化。

## 6. `constinit` 保证了什么？

`constinit` 只能用于具有静态或线程存储期的变量，要求其初始化是静态初始化，不允许退化成动态初始化：

```cpp
constinit int global_counter = 0;
```

它不意味着不可修改：

```cpp
++global_counter; // 合法，但并发访问仍需同步
```

与其他关键字比较：

| 工具 | 约束重点 |
| --- | --- |
| `constexpr` | 值是常量表达式，且对象不可修改 |
| `consteval` | 函数调用必须完成常量求值 |
| `constinit` | 静态/线程对象必须静态初始化，可仍然可变 |

`constinit` 能避免变量自身的动态初始化，降低静态初始化顺序问题，但不会让所有跨翻译单元依赖自动安全。如果一个全局对象的构造依赖另一个复杂全局对象，仍应减少全局状态或使用函数局部静态等明确生命周期方案。

## 7. `static_assert` 应该验证哪些约束？

它适合编译期可判定且违反后无法生成正确程序的条件：

```cpp
template <std::size_t Capacity>
class FixedBuffer {
    static_assert(Capacity > 0, "capacity must not be zero");
    static_assert(Capacity <= 4096, "capacity exceeds protocol limit");
};
```

不要用它验证运行期用户输入，也不要把所有实现细节都锁成编译错误。约束变成模板参数会产生不同类型与更多实例化，可能增加编译时间和二进制体积。

如果限制来自部署配置、命令行或网络数据，就应在运行期返回明确错误。判断关键是：调用方是否能在不重新编译程序的情况下改变这个值。

## 8. `if constexpr` 与普通 `if` 的区别是什么？

泛型代码可以按类型选择实现：

```cpp
template <class T>
std::string to_text(const T& value) {
    if constexpr (std::is_integral_v<T>) {
        return std::to_string(value);
    } else {
        return value.to_string();
    }
}
```

依赖模板参数的未选分支不会被实例化，因此 `T=int` 时不会要求整数拥有成员 `to_string()`。普通 `if` 的两个分支都必须在编译后有效，只是运行时选择执行哪一个。

非依赖名称等代码仍需满足语法和查找规则；“未选分支完全不编译”是过度简化。现代 concepts 往往能把支持的类型范围表达得更清楚，`if constexpr` 则适合在已支持类型内部选择少量实现。

## 9. 编译期查表什么时候值得使用？

固定、小型且频繁读取的映射可以在编译期生成：平方表、CRC 常量、字符分类、协议字段表。收益可能包括消除运行期初始化并提前验证。

但查表不一定比直接计算快。现代 CPU、缓存和优化器可能让一个乘法比内存读取更便宜。表太大会增加编译时间、目标文件和缓存压力。性能结论应在 Release 构建下测量真实访问模式。

同样，编译期 hash 可以产生稳定 ID：

```cpp
constexpr std::uint32_t fnv1a(std::string_view text);
```

hash 仍然可能碰撞。若错误匹配不可接受，应保存原字符串或执行二次校验，不能把“编译期算出”误认为“数学上唯一”。

## 10. 编译期解析为什么不适合所有配置？

两位数字、固定标签等微型格式适合 consteval 解析，因为规则简单、值随程序构建固定。把 JSON/YAML、大型路由表或频繁变化业务配置放进编译期，会带来：

- 修改配置必须重新编译；
- 编译时间和内存上升；
- 错误信息落入模板/常量求值诊断；
- 构建产物数量和缓存失效率增加；
- 运行期热更新失去可能。

编译期并非更“高级”的运行阶段，而是部署灵活性、诊断方式和成本不同的选择。

## 11. 怎样观察当前是否处于常量求值？

C++20 提供 `std::is_constant_evaluated()`，允许同一个 constexpr 函数在常量求值与运行期选择不同实现：

```cpp
constexpr int compute(int value) {
    if (std::is_constant_evaluated()) {
        return portable_constexpr_algorithm(value);
    }
    return optimized_runtime_algorithm(value);
}
```

这适合编译期不能使用某些平台优化、运行期又有更高效实现的场景。但两条路径必须保持相同语义并分别测试。为追求微小优化引入双实现，会增加维护和验证成本。

C++23 的 `if consteval` 提供更直接的语法，但使用前要确认项目语言标准与工具链。

## 12. 工程中最容易踩哪些坑？

### 误区一：`constexpr` 函数一定在编译期执行

只有常量表达式上下文强制常量求值。普通运行期参数仍可正常调用。

### 误区二：`consteval` 是“更快的 constexpr”

它是调用限制：所有调用必须常量求值。价值在提前验证和禁止运行期使用，不是性能标签。

### 误区三：`constinit` 等于 const

它约束初始化阶段，不约束后续修改，也不提供线程安全。

### 误区四：模板参数越多，运行期越快

类型级配置会增加实例化、编译时间和代码体积。运行期才变化的值不应进入类型系统。

### 误区五：编译期 hash 不会冲突

计算时机不改变 hash 的碰撞性质。关键匹配需要二次确认。

### 误区六：把复杂工作挪到编译期就是零成本

成本转移到开发构建、CI、缓存和二进制。仍需测量整体工程代价。

## 13. 什么时候适合编译期计算？

适合：值随二进制固定、规则小而稳定、错误应该阻止构建、结果进入数组大小或类型系统，或者能消除重复静态初始化。

不适合：值来自用户/网络/部署配置，需要热更新，解析规模大，或编译成本已经成为瓶颈。很多普通 `constexpr` 小函数可以保留两用能力，不必把调用者强制成 consteval。

## 14. 总结

开头的 `square` 在运行期执行并不违反 `constexpr`：它承诺的是“满足规则时可以常量求值”，而不是每次调用都必须提前计算。

1. `const` 约束修改，`constexpr` 提供常量表达式，二者不是同义词；
2. `constexpr` 函数可复用于编译期和运行期，常量上下文才强制前者；
3. `consteval` 要求立即求值，适合编译期字面量校验；
4. `constinit` 保证静态初始化，但变量仍可修改且仍需并发同步；
5. 编译期表、解析和模板配置会消耗编译时间与灵活性，必须有真实收益。

看到一个稳定规则时，先问“这个值是否随二进制固定、错误是否必须阻止构建”。如果答案都为是，再考虑 consteval 或类型级配置；否则用 constexpr 复用逻辑，或老实保留运行期校验。
