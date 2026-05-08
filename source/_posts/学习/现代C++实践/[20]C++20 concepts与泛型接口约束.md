---
title: "C++20 concepts 与泛型接口约束"
date: 2026-05-08 14:32:41
updated: 2026-05-08 14:32:41
categories:
  - "学习"
  - "现代C++实践"
permalink: /notes/现代c-实践/20-c-20-concepts与泛型接口约束/
---

# C++20 concepts 与泛型接口约束

时间：2026/05/08

> 关键词：concept、requires、泛型约束、`std::integral`、`std::ranges`、重载选择、错误信息
> 核心目标：用 concepts 把模板参数的要求写清楚，让泛型接口更像普通接口一样可读、可诊断。

---

## 1. concepts 解决什么问题

传统模板很强，但错误信息经常很难读。

```cpp
template <class T>
auto add(T a, T b) {
    return a + b;
}
```

如果传入不支持 `+` 的类型，错误可能出现在很深的模板实例化里。
concepts 的目标是把约束提前写出来：

```cpp
#include <concepts>

template <class T>
requires std::integral<T>
T add(T a, T b) {
    return a + b;
}
```

现在接口明确表示：

> 这里只接受整数类型。

---

## 2. 标准库已有 concepts

`<concepts>` 里有很多常用概念：

```cpp
#include <concepts>

static_assert(std::integral<int>);
static_assert(std::floating_point<double>);
static_assert(std::same_as<int, int>);
static_assert(std::convertible_to<int, double>);
```

常见的有：

* `std::same_as<T, U>`
* `std::derived_from<T, U>`
* `std::convertible_to<T, U>`
* `std::integral<T>`
* `std::floating_point<T>`
* `std::regular<T>`
* `std::predicate<F, Args...>`
* `std::invocable<F, Args...>`

优先用标准库已有概念，别急着自己造。

---

## 3. 三种常见写法

### 3.1 requires 子句

```cpp
template <class T>
requires std::integral<T>
T twice(T x) {
    return x * 2;
}
```

### 3.2 约束模板参数

```cpp
template <std::integral T>
T twice(T x) {
    return x * 2;
}
```

### 3.3 约束 `auto`

```cpp
std::integral auto twice(std::integral auto x) {
    return x * 2;
}
```

工程里常见选择：

* 简单函数：约束模板参数或约束 `auto`
* 约束复杂：写 `requires`
* 公共库接口：倾向写得更明确

---

## 4. 自定义 concept：从最小需求开始

假设你只要求类型能调用 `.size()` 并返回可转成 `std::size_t` 的值：

```cpp
#include <concepts>
#include <cstddef>

template <class T>
concept Sized = requires(const T& x) {
    { x.size() } -> std::convertible_to<std::size_t>;
};

template <Sized T>
std::size_t length(const T& x) {
    return static_cast<std::size_t>(x.size());
}
```

可以调用：

```cpp
std::string s = "hello";
std::vector<int> v{1, 2, 3};

length(s);
length(v);
```

注意：concept 应该描述“你真正需要什么”，不要过度指定类型。

---

## 5. `requires` 表达式怎么读

```cpp
#include <concepts>
#include <cstddef>
#include <functional>

template <class T>
concept Hashable = requires(T x) {
    { std::hash<T>{}(x) } -> std::convertible_to<std::size_t>;
};
```

含义：

* 给定一个 `T x`
* 表达式 `std::hash<T>{}(x)` 必须合法
* 返回值必须能转成 `std::size_t`

更复杂一点：

```cpp
#include <concepts>
#include <ostream>

template <class T>
concept Printable = requires(std::ostream& os, const T& value) {
    { os << value } -> std::same_as<std::ostream&>;
};
```

这个 concept 表示对象能被输出到流。

---

## 6. 用 concept 改善错误信息

没有约束的版本：

```cpp
template <class T>
void dump(const T& value) {
    std::cout << value << "\n";
}
```

约束后的版本：

```cpp
#include <concepts>
#include <iostream>

template <class T>
concept StreamWritable = requires(std::ostream& os, const T& value) {
    { os << value } -> std::same_as<std::ostream&>;
};

template <StreamWritable T>
void dump(const T& value) {
    std::cout << value << "\n";
}
```

当类型不满足条件时，编译器更容易告诉你：

```text
T does not satisfy StreamWritable
```

这比在 `operator<<` 深处爆炸更友好。

---

## 7. concept 参与重载选择

```cpp
#include <concepts>
#include <iostream>

void print_value(std::integral auto x) {
    std::cout << "integer: " << x << "\n";
}

void print_value(std::floating_point auto x) {
    std::cout << "float: " << x << "\n";
}

void print_value(const std::string& s) {
    std::cout << "string: " << s << "\n";
}
```

调用：

```cpp
print_value(42);
print_value(3.14);
print_value(std::string("hello"));
```

这比写一堆 `enable_if` 更直观。

---

## 8. 约束函数对象：`std::invocable`

泛型算法经常接收回调。

```cpp
#include <concepts>
#include <functional>
#include <vector>

template <class F>
requires std::invocable<F, int>
void repeat(int n, F f) {
    for (int i = 0; i < n; ++i) {
        std::invoke(f, i);
    }
}
```

使用：

```cpp
repeat(3, [](int i) {
    std::cout << i << "\n";
});
```

如果还要求返回 `bool`：

```cpp
template <class F>
requires std::predicate<F, int>
int count_if_index(int n, F pred) {
    int count = 0;
    for (int i = 0; i < n; ++i) {
        if (std::invoke(pred, i)) {
            ++count;
        }
    }
    return count;
}
```

---

## 9. 约束 range：和 ranges 配合

`<ranges>` 里也有很多 concept：

```cpp
#include <ranges>
#include <vector>
#include <iostream>

template <std::ranges::input_range R>
void print_all(const R& r) {
    for (const auto& x : r) {
        std::cout << x << "\n";
    }
}
```

如果要求能随机访问：

```cpp
template <std::ranges::random_access_range R>
auto middle(const R& r) {
    return r[std::ranges::size(r) / 2];
}
```

如果还要求元素类型是整数：

```cpp
#include <concepts>
#include <ranges>

template <class R>
concept IntegralRange =
    std::ranges::input_range<R> &&
    std::integral<std::ranges::range_value_t<R>>;

template <IntegralRange R>
long long sum_integrals(const R& r) {
    long long sum = 0;
    for (auto x : r) {
        sum += x;
    }
    return sum;
}
```

---

## 10. 避免过度约束

坏例子：

```cpp
template <class T>
concept VectorInt = std::same_as<T, std::vector<int>>;

template <VectorInt T>
int sum(const T& xs);
```

这个接口只能接收 `std::vector<int>`。
但你真正需要的可能只是“一段整数 range”。

更好的写法：

```cpp
template <IntegralRange R>
long long sum(const R& xs) {
    long long out = 0;
    for (auto x : xs) {
        out += x;
    }
    return out;
}
```

这样可以接收：

* `std::vector<int>`
* `std::array<int, N>`
* `std::span<int>`
* ranges view

约束应该贴近需求，而不是贴近你当前想到的实现类型。

---

## 11. concept 不是运行期检查

concept 在编译期检查类型能力：

```cpp
template <std::integral T>
T divide(T a, T b) {
    return a / b;
}
```

它保证 `T` 是整数，但不保证：

```cpp
divide(10, 0); // 运行期仍然可能错误
```

所以概念约束不能替代运行期校验。

---

## 12. 用 concept 表达策略对象接口

```cpp
#include <concepts>
#include <string_view>

struct Request {
    std::string_view path;
};

struct Response {
    int status = 200;
};

template <class H>
concept Handler = requires(H h, const Request& req) {
    { h.handle(req) } -> std::same_as<Response>;
};

template <Handler H>
Response dispatch(H& handler, const Request& req) {
    return handler.handle(req);
}
```

实现一个 handler：

```cpp
struct HealthHandler {
    Response handle(const Request& req) {
        if (req.path == "/health") {
            return Response{200};
        }
        return Response{404};
    }
};
```

这个接口没有强迫继承，也没有虚函数。
只要类型满足结构要求，就能用。

这就是静态多态的一种实践。

---

## 13. concepts 和多态的选择

用 concepts：

* 编译期确定类型
* 性能敏感
* 希望内联
* 模板库
* 策略对象

用虚函数：

* 运行期动态选择类型
* ABI 边界更稳定
* 插件式加载
* 需要统一容器保存不同派生对象

两者不是谁取代谁。
它们分别服务于静态多态和动态多态。

---

## 14. 一个更完整的泛型算法例子

```cpp
#include <concepts>
#include <cstddef>
#include <ranges>
#include <vector>

template <class T>
concept Number = std::integral<T> || std::floating_point<T>;

template <class R>
concept NumberRange =
    std::ranges::input_range<R> &&
    Number<std::ranges::range_value_t<R>>;

template <NumberRange R>
auto mean(const R& xs) {
    using T = std::ranges::range_value_t<R>;

    T sum{};
    std::size_t count = 0;

    for (const auto& x : xs) {
        sum += x;
        ++count;
    }

    if (count == 0) {
        return T{};
    }

    return sum / static_cast<T>(count);
}
```

使用：

```cpp
std::vector<double> xs{1.0, 2.0, 3.0};
auto m = mean(xs);
```

这个例子里：

* 算法不关心具体容器
* 只要求输入是数字 range
* 空 range 有定义好的行为

---

## 15. 常见误区

### 15.1 concepts 会让代码自动更快

不会。
它主要改善接口约束和错误诊断。性能仍取决于代码结构和优化器。

### 15.2 concept 越细越好

不一定。
过细会让接口僵硬，调用者很难满足。

### 15.3 concept 能替代单元测试

不能。
它只能检查类型能力，不能验证业务逻辑。

### 15.4 所有模板都必须加 concept

内部小模板如果很清楚，可以不加。
公共接口、错误难读的接口更值得加。

### 15.5 用 `same_as` 锁死具体类型

除非必须是这个类型，否则优先描述能力。

---

## 16. 一页总结

concepts 最重要的实践原则：

1. 优先用标准库已有 concept
2. 自定义 concept 描述最小必要能力
3. 公共泛型接口值得加约束
4. 不要用 concept 替代运行期检查
5. 不要过度约束到具体容器类型
6. concepts 适合静态多态，虚函数适合动态多态

一句话：

> concept 是把模板的“隐含要求”变成“显式接口”的工具。
