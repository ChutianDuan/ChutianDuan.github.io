---
title: "模板报错为什么总在实现深处？用 C++20 concepts 写清泛型接口"
date: 2026-07-13 10:11:53
updated: 2026-07-13 10:11:53
categories:
  - "学习"
  - "现代 C++ 实践"
permalink: /notes/现代c-实践/20-c-20-concepts与泛型接口约束/
series: "现代 C++ 实践"
series_order: 20
---

时间：2026/05/08

下面的模板表面上接受任何类型：

```cpp
template <class T>
auto add(const T& left, const T& right) {
    return left + right;
}
```

真正的要求却藏在函数体：`T` 必须支持某种 `operator+`，返回值还要满足后续使用。传入不支持的类型时，编译器只能先实例化实现，再从一串重载候选和模板内部报告失败。

concepts 的价值不是让模板“更高级”，而是把这些隐含要求提到接口上：哪些类型能参与重载、哪些表达式必须合法、返回类型应满足什么约束。本文从一个泛型平均值函数出发，对比无约束模板、`static_assert`、requires-expression 和命名 concept，并说明类型约束为何不能替代运行期校验与语义测试。

---

## 1. 为什么 `static_assert` 还不够？

传统模板可以在函数体中检查：

```cpp
template <class T>
T twice(T value) {
    static_assert(std::is_integral_v<T>, "T must be integral");
    return value * 2;
}
```

它比任由乘法表达式失败更清楚，但检查发生在模板已经被选中并实例化之后。`static_assert` 不直接参与重载可行性和排序，也不把要求展示在函数模板声明的接口位置。

C++20 concept 是可命名的编译期谓词，约束可以参与候选筛选：

```cpp
template <std::integral T>
T twice(T value) {
    return value * 2;
}
```

不满足 `std::integral` 的类型不会成为这个模板的有效实例。诊断通常会指出约束不满足，而不是只在 `operator*` 深处失败；具体文字仍由编译器决定。

## 2. 三种约束写法怎样选择？

它们可以表达相近接口：

```cpp
template <class T>
requires std::integral<T>
T twice(T value);

template <std::integral T>
T twice(T value);

std::integral auto twice(std::integral auto value);
```

一般原则：

- 单一、直观标准 concept 可直接约束模板参数；
- 多类型关系或组合条件适合尾部/前置 requires-clause；
- 简短局部函数可用 constrained `auto`；
- 公共接口的类型关系复杂时，显式模板参数往往更易读。

返回类型前的 constrained `auto` 也会约束推导结果，但不要把参数 concept 和返回 concept 混为一谈。签名应让调用者能看出要求，而不是为了缩短语法选择最隐晦形式。

## 3. 标准库 concept 为什么应该优先复用？

`<concepts>` 与 `<ranges>` 已提供常见词汇：

| concept | 表达的核心要求 |
| --- | --- |
| `same_as<T, U>` | 两个类型相同 |
| `convertible_to<From, To>` | 满足规定的显式/隐式转换关系 |
| `derived_from<D, B>` | 公有且无歧义的派生关系等要求 |
| `integral<T>` / `floating_point<T>` | 标准定义的整数/浮点类别 |
| `invocable<F, Args...>` | 可以用给定参数调用 |
| `predicate<F, Args...>` | 调用结果满足布尔谓词语义要求 |
| `ranges::input_range<R>` | 可以至少单遍读取 range |
| `ranges::random_access_range<R>` | 迭代器支持随机访问能力 |

标准 concept 不只是名字统一，还可能带有标准规定的语义要求和重载 subsumption 关系。自己用相似布尔表达式重造一份，可能影响重载排序并让生态接口难以组合。

## 4. requires-expression 怎么读？

自定义“可以写入 ostream”概念：

```cpp
template <class T>
concept StreamWritable = requires(std::ostream& output, const T& value) {
    { output << value } -> std::same_as<std::ostream&>;
};
```

`requires(...) { ... }` 是 requires-expression，用假想参数检查表达式是否满足要求，不会真的运行输出操作。大致有四类 requirement：

```cpp
template <class T>
concept Example = requires(T value) {
    value.reset();                         // simple requirement：表达式合法
    typename T::value_type;                // type requirement：嵌套类型存在
    { value.size() } noexcept              // compound：合法且 noexcept
        -> std::convertible_to<std::size_t>;
    requires sizeof(T) <= 64;              // nested：另一个约束成立
};
```

约束应只描述算法真正使用的能力。无端要求 `size()` 必须 `noexcept` 或类型必须小于 64 字节，会把原本可用的类型排除在外。

## 5. 一个可运行的数值 range 平均值示例

下面的 C++20 示例接受任意单遍数值 range，不锁死为 `vector`。空输入通过 `optional` 表达；结果统一为 `double`，避免整数 range 做整数除法。

```cpp
#include <array>
#include <concepts>
#include <iomanip>
#include <iostream>
#include <optional>
#include <ranges>
#include <string_view>
#include <type_traits>
#include <vector>

template <class T>
concept Arithmetic =
    (std::integral<std::remove_cv_t<T>>
        || std::floating_point<std::remove_cv_t<T>>)
    && (!std::same_as<std::remove_cv_t<T>, bool>);

template <class R>
concept ArithmeticRange =
    std::ranges::input_range<R>
    && Arithmetic<std::ranges::range_value_t<R>>
    && std::convertible_to<std::ranges::range_reference_t<R>, long double>;

template <ArithmeticRange R>
std::optional<double> mean(R&& values) {
    long double sum = 0.0L;
    std::size_t count = 0;

    for (auto&& value : values) {
        sum += static_cast<long double>(value);
        ++count;
    }

    if (count == 0) {
        return std::nullopt;
    }
    return static_cast<double>(sum / static_cast<long double>(count));
}

void print(std::string_view label, std::optional<double> value) {
    std::cout << label << ": ";
    if (value) {
        std::cout << std::fixed << std::setprecision(2) << *value << '\n';
    } else {
        std::cout << "empty\n";
    }
}

int main() {
    const std::vector<int> integers{1, 2, 3, 4};
    const std::array<double, 3> decimals{2.0, 3.0, 4.0};
    const std::vector<int> empty;

    print("integers", mean(integers));
    print("decimals", mean(decimals));
    print("empty", mean(empty));
}
```

编译运行：

```bash
clang++ -std=c++20 -O2 -Wall -Wextra -pedantic \
  concepts_mean.cpp -o concepts_mean
./concepts_mean
```

预期输出：

```text
integers: 2.50
decimals: 3.00
empty: empty
```

接口只要求单遍读取，所以它也可以接受许多 view 和输入 range。实现没有调用 `size()` 或下标，因此不应过度约束为 `sized_range` 或 `random_access_range`。

## 6. 为什么 concept 要描述最小必要能力？

下面的约束把实现偶然使用的容器写死：

```cpp
template <class T>
concept IntVector = std::same_as<T, std::vector<int>>;
```

若算法只需遍历可转换为数值的元素，就不该排除 `array`、`span` 和 view。过度约束会：

- 降低复用；
- 让调用者为了适配制造临时容器；
- 把实现细节变成公共契约；
- 增加无意义的自定义 concept。

反过来，约束太弱也会让错误落回函数体。例如接口声明 `input_range`，实现却使用 `range[0]`，就应该改实现或加强为 random-access/sized 相关约束。约束必须与实现真实操作保持同步。

## 7. concept 能验证语义吗？

编译器主要验证表达式与类型关系。许多标准 concept 还规定无法由编译器完全检查的语义要求，例如相等比较应具有一致性，谓词不应破坏算法假设。

一个类型可以“语法上”满足比较表达式，却让结果依赖随机数：

```cpp
bool operator<(const Item&, const Item&) {
    return random_bit(); // 表达式合法，但不满足排序语义
}
```

concept 无法证明严格弱序、算法复杂度、线程安全、无副作用或业务正确性。满足语法但违反所要求语义，标准算法仍可能得到错误甚至未定义行为。

所以 concept 是接口约束，不是形式化验证。语义需要文档、不变量、测试和代码审查。

## 8. concept 为什么不能替代运行期检查？

```cpp
template <std::integral T>
T divide(T numerator, T denominator) {
    return numerator / denominator;
}
```

约束保证类型是整数，不保证 `denominator != 0`。用户输入、容器是否为空、文件是否存在等运行期值必须用正常控制流检查。

可用类型约束减少“这个操作根本不存在”的编译错误；值域校验处理“操作存在，但本次输入不合法”。两者位于不同阶段，不能互相替代。

## 9. concepts 怎样参与重载选择？

可以为不同类型类别提供重载：

```cpp
void print_value(std::integral auto value);
void print_value(std::floating_point auto value);
```

更受约束的候选在标准的约束 subsumption 规则下可能优先。但逻辑上等价的任意布尔表达式不一定被编译器识别为同一约束结构：

```cpp
template <class T>
concept SignedIntegral = std::integral<T> && std::signed_integral<T>;
```

复用命名 concept 和相同原子约束有助于形成可预测排序。大量相互重叠的 requires-clause 会产生歧义和难读诊断，设计重载集时应保持互斥或清晰包含关系。

concept 不是标签派发的万能替代。若不同实现只是几行差异，单个模板内的 `if constexpr` 可能更清楚。

## 10. 静态多态与虚函数多态怎样选择？

| 需求 | concepts/模板 | 虚函数/类型擦除 |
| --- | --- | --- |
| 具体类型在编译期已知 | 适合 | 也可但可能多余 |
| 运行时加载和选择实现 | 不直接解决 | 适合 |
| 跨稳定 ABI 边界 | 模板会暴露实现和实例化 | 需专门设计的虚接口/C ABI 更常见 |
| 希望内联与类型特化 | 适合 | 间接调用可能限制 |
| 不同类型放入同一容器 | 需 variant/擦除等额外机制 | 基类指针较直接 |
| 控制编译时间和代码体积 | 实例化可能增加 | 共享实现可能更小 |

concepts 支持结构化静态多态：类型无需继承，只要满足操作。它不会让运行时插件自动变成模板参数，也不会天然提供 ABI 稳定。

## 11. concepts 会让程序更快吗？

约束本身主要影响编译期候选选择和诊断。模板可能帮助内联与专门化，但无约束模板也具备这些能力；运行速度取决于生成代码、算法和数据布局。

concepts 还可能增加约束求值和模板实例化带来的编译成本。公共泛型接口值得约束，简单内部模板若错误已经清晰，不必为形式统一创建复杂 concept。

性能应在 Release 构建下测量运行时间，也要观察构建时间和二进制体积，不能凭“静态多态”直接下结论。

## 12. 工程中最容易踩哪些坑？

### 误区一：concept 越具体，接口越安全

锁死具体容器只会减少合法调用。安全来自约束与真实最小能力一致。

### 误区二：requires-expression 会执行测试代码

它在未求值语境检查表达式有效性，不会真的调用函数或产生副作用。

### 误区三：满足 concept 就满足全部业务语义

复杂度、线程安全、严格弱序和业务不变量通常无法由语法约束证明。

### 误区四：concept 能检查运行期数值

类型满足 `integral` 不代表除数非零、端口有效或索引不越界。

### 误区五：所有模板都必须创建自定义 concept

优先使用标准 concept。只在一处使用且要求简单时，直接 requires-clause 可能更清楚。

### 误区六：concepts 取代虚函数

前者主要约束编译期多态，后者服务运行时动态派发，变化阶段不同。

## 13. 什么时候值得添加 concept？

公共模板接口、错误经常落入实现深处、多个重载需要按能力区分，或算法确实需要明确 range/可调用对象能力时，concept 很有价值。

内部一次性模板、要求已由调用位置明显保证、或 concept 只能重复函数体一行简单表达式时，可以保持简单。约束应随着实现操作变化而维护，并为不满足约束的调用写编译测试或示例。

## 14. 总结

开头的无约束 `add` 把 `operator+` 要求藏在函数体，所以失败只能在实例化深处暴露。concept 把类型能力移到候选接口上，让重载和诊断更接近真实契约。

1. 优先复用标准 concepts，自定义概念只描述最小必要能力；
2. requires-expression 检查类型和表达式，不运行代码，也不能证明所有语义；
3. 约束必须与实现使用的操作一致，过强和过弱都会伤害接口；
4. concepts 处理编译期类型可用性，运行期值域仍需检查；
5. 静态多态、动态多态和类型擦除服务不同变化阶段，不能互相机械替代。

为一个模板添加 concept 前，把函数体对 `T` 做的每种操作列出来，再删除与实现无关的要求。最后得到的最小能力集合，才是值得进入公共签名的约束。
