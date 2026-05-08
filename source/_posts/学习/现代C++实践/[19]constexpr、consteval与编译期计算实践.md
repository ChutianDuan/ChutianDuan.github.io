---
title: "constexpr、consteval 与编译期计算实践"
date: 2026-05-08 14:32:41
updated: 2026-05-08 14:32:41
categories:
  - "学习"
  - "现代C++实践"
permalink: /notes/现代c-实践/19-constexpr-consteval与编译期计算实践/
---

# constexpr、consteval 与编译期计算实践

时间：2026/05/08

> 关键词：`constexpr`、`consteval`、`constinit`、`static_assert`、`if constexpr`、编译期校验
> 核心目标：掌握现代 C++ 里“能在编译期算清楚的，就不要拖到运行期”的实用写法。

---

## 1. 编译期计算解决什么问题

有些值在编译时就已经确定：

* 数组大小
* 协议字段长度
* 哈希表种子
* 配置上限
* 类型分支
* 查表数据
* 模板泛型里的策略选择

如果能在编译期完成，就能得到几个收益：

1. 运行期少做重复计算
2. 错误更早暴露
3. 常量能进入类型系统
4. 优化器更容易生成好代码

但也不要把所有东西都搬到编译期。
编译期计算会增加编译时间，也会让错误信息变复杂。

---

## 2. `constexpr` 变量

`constexpr` 变量必须能在编译期初始化：

```cpp
constexpr int max_clients = 1024;
constexpr double pi = 3.141592653589793;

std::array<int, max_clients> counters{};
```

和 `const` 的区别：

```cpp
const int runtime_value = read_config(); // 运行期常量
constexpr int compile_value = 42;        // 编译期常量
```

`const` 只表示之后不能改。
`constexpr` 还要求初始化结果能作为编译期常量使用。

---

## 3. `constexpr` 函数：既能编译期，也能运行期

```cpp
constexpr int square(int x) {
    return x * x;
}

static_assert(square(5) == 25);

int runtime(int x) {
    return square(x); // x 运行期才知道，也可以调用
}
```

`constexpr` 函数不是“只能编译期调用”。
它的意思是：

> 如果参数在编译期已知，并且函数满足规则，就可以在编译期求值。

---

## 4. 编译期校验：`static_assert`

`static_assert` 适合把约束写在代码里：

```cpp
constexpr std::size_t packet_header_size = 8;

static_assert(packet_header_size % 4 == 0,
              "packet header must be 4-byte aligned");
```

模板里更常见：

```cpp
template <class T>
void serialize(const T& value) {
    static_assert(std::is_trivially_copyable_v<T>,
                  "serialize requires trivially copyable type");

    write_bytes(&value, sizeof(T));
}
```

错误会在编译期出现，而不是等到线上数据坏掉。

---

## 5. 一个实用例子：编译期单位换算

```cpp
#include <chrono>

constexpr std::chrono::milliseconds frame_time(int fps) {
    return std::chrono::milliseconds(1000 / fps);
}

static_assert(frame_time(60).count() == 16);

constexpr auto tick = frame_time(50);
```

这类小函数比魔法数字更清晰：

```cpp
constexpr auto network_timeout = std::chrono::seconds(5);
constexpr auto render_budget = std::chrono::milliseconds(16);
```

---

## 6. `constexpr` 容器和查表

C++20 之后，很多标准库类型的 `constexpr` 能力更强。
实际工程里最常见的是用 `std::array` 做编译期表：

```cpp
#include <array>

constexpr std::array<int, 10> make_squares() {
    std::array<int, 10> out{};
    for (std::size_t i = 0; i < out.size(); ++i) {
        out[i] = static_cast<int>(i * i);
    }
    return out;
}

constexpr auto squares = make_squares();

static_assert(squares[4] == 16);
```

这种写法适合：

* 小型查表
* 编码映射
* 固定协议表
* 编译期测试数据

---

## 7. `consteval`：必须编译期执行

`consteval` 函数被称为立即函数。
它必须在编译期求值。

```cpp
consteval int port_literal(int port) {
    if (port <= 0 || port > 65535) {
        throw "invalid port";
    }
    return port;
}

constexpr int http_port = port_literal(80);
```

如果这样写：

```cpp
int p = read_port();
int x = port_literal(p); // 错：p 不是编译期常量
```

会编译失败。

适合 `consteval` 的场景：

* 编译期字面量校验
* 生成强类型常量
* 只允许编译期构造的描述符
* 防止运行期误用

---

## 8. `consteval` 做字符串校验

例如要求日志分类名非空且不超过长度：

```cpp
#include <string_view>

consteval std::string_view category(std::string_view name) {
    if (name.empty()) {
        throw "empty category";
    }
    if (name.size() > 16) {
        throw "category too long";
    }
    return name;
}

constexpr auto net = category("network");
```

如果写成：

```cpp
constexpr auto bad = category("");
```

编译期就能报错。
这种写法适合把约束提前到编译阶段。

---

## 9. `constinit`：保证静态对象静态初始化

`constinit` 用于静态存储期变量，保证它不会发生动态初始化。

```cpp
constinit int global_counter = 0;
```

它不是 `const`：

```cpp
constinit int value = 1;

void f() {
    ++value; // 可以修改
}
```

但初始化必须是编译期可完成的：

```cpp
int read_config();

constinit int x = read_config(); // 错：不能动态初始化
```

适合：

* 全局计数器
* 静态状态
* 需要避免静态初始化顺序问题的对象

注意：

* `constinit` 保证初始化时机
* `constexpr` 保证值是常量表达式并隐含 const
* 两者关注点不同

---

## 10. `if constexpr`：编译期分支

泛型代码中，经常根据类型选择实现。

```cpp
#include <type_traits>
#include <string>

template <class T>
std::string to_text(const T& value) {
    if constexpr (std::is_integral_v<T>) {
        return std::to_string(value);
    } else if constexpr (std::is_floating_point_v<T>) {
        return std::to_string(value);
    } else {
        return value.to_string();
    }
}
```

`if constexpr` 的未选分支不会实例化。
所以当 `T` 是整数时，编译器不会要求整数有 `to_string()` 成员函数。

这比以前用复杂 SFINAE 更容易读。

---

## 11. 编译期 hash：实用但要谨慎

一个简单的 FNV-1a 字符串 hash：

```cpp
#include <cstdint>
#include <string_view>

constexpr std::uint32_t fnv1a(std::string_view s) {
    std::uint32_t hash = 2166136261u;
    for (char c : s) {
        hash ^= static_cast<unsigned char>(c);
        hash *= 16777619u;
    }
    return hash;
}

static_assert(fnv1a("GET") != fnv1a("POST"));

constexpr auto get_id = fnv1a("GET");
```

可以用于：

* 协议命令 id
* 资源名映射
* switch 前的分类

但不要把 hash 当成绝对无冲突。
如果冲突会造成严重问题，必须保留字符串二次校验。

---

## 12. 编译期解析小配置

可以写一个非常小的编译期 parser：

```cpp
#include <string_view>

consteval int parse_digit(char c) {
    if (c < '0' || c > '9') {
        throw "not a digit";
    }
    return c - '0';
}

consteval int parse_two_digits(std::string_view s) {
    if (s.size() != 2) {
        throw "expected two digits";
    }
    return parse_digit(s[0]) * 10 + parse_digit(s[1]);
}

constexpr int major = parse_two_digits("23");
```

这种代码适合非常小、非常固定的格式。
不要把复杂 JSON/YAML 解析器搬到编译期，除非真的有明确收益。

---

## 13. 编译期和运行期复用同一套逻辑

`constexpr` 函数的一个好处是可以复用：

```cpp
constexpr bool is_power_of_two(std::size_t n) {
    return n != 0 && (n & (n - 1)) == 0;
}

static_assert(is_power_of_two(64));

bool validate_buffer_size(std::size_t n) {
    return is_power_of_two(n);
}
```

同一段逻辑：

* 编译期检查常量
* 运行期检查用户输入

这比维护两套实现更稳。

---

## 14. 类型级配置：用常量表达式控制模板

```cpp
#include <array>
#include <cstddef>
#include <stdexcept>

template <std::size_t Capacity>
class FixedBuffer {
public:
    static_assert(Capacity > 0);
    static_assert(Capacity <= 4096);

    constexpr std::size_t capacity() const noexcept {
        return Capacity;
    }

    void push(char c) {
        if (size_ == Capacity) {
            throw std::runtime_error("buffer full");
        }
        data_[size_++] = c;
    }

private:
    std::array<char, Capacity> data_{};
    std::size_t size_ = 0;
};

FixedBuffer<256> buffer;
```

`Capacity` 是类型的一部分。
`FixedBuffer<128>` 和 `FixedBuffer<256>` 是不同类型。

适合：

* 固定容量队列
* 小缓冲
* 协议字段
* 数值维度

不适合运行期才知道大小的情况。

---

## 15. 编译期计算的常见限制

现代 C++ 的 `constexpr` 已经很强，但仍要注意：

* 不能做不允许的运行期 I/O
* 不能依赖运行期输入
* 编译期异常只用于让求值失败，不是运行期异常机制
* 编译期计算过重会拖慢编译
* 错误信息可能比运行期更难读

判断标准：

> 如果某个值是稳定常量、约束明确、错误越早越好，就适合编译期。

---

## 16. 常见误区

### 16.1 `constexpr` 一定更快

不一定。
如果参数是运行期值，函数仍然运行期执行。

### 16.2 所有配置都放进模板参数

模板参数会制造更多类型和更多编译实例。
运行期配置就老实用运行期数据。

### 16.3 `constinit` 等于不可修改

不等于。
`constinit` 管初始化时机，`const` 管可修改性。

### 16.4 编译期 hash 可以完全替代字符串

不能。
hash 有冲突风险，重要路径要二次校验。

### 16.5 编译期越多越现代

不是。
工程里还要考虑编译时间、可读性和调试成本。

---

## 17. 一页总结

编译期计算最常用的工具：

1. `constexpr`：能编译期算，也能运行期用
2. `consteval`：必须编译期算
3. `constinit`：保证静态变量静态初始化
4. `static_assert`：编译期校验约束
5. `if constexpr`：泛型代码里的编译期分支

一句话：

> 编译期计算的价值不是炫技，而是把稳定规则提前验证，把重复计算提前完成。
