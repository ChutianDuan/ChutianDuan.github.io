---
title: "错误处理与 `expected`、异常设计"
date: 2026-05-08 14:36:46
updated: 2026-05-08 14:36:46
categories:
  - "学习"
  - "现代C++实践"
permalink: /notes/现代c-实践/13-错误处理与expected-异常设计/
---

# 错误处理与 `expected`、异常设计

时间：2026/04/09

> 关键词：异常、`noexcept`、`std::expected`、`optional`、错误传播、恢复性错误、编程错误
> 核心目标：建立一套工程上可执行的判断标准，知道什么时候该抛异常，什么时候该返回错误值或 `expected`。

---

## 1. 错误处理不是“选一个 API”那么简单

错误处理真正要先回答的是：

* 这是不是预期内会发生的失败
* 调用方是否应该恢复
* 失败信息需要多详细
* 代码库是否接受异常

所以讨论异常和 `expected` 时，重点不是站队，而是：

* 哪种语义更适合这一层接口

---

## 2. 先把失败分类型

最有用的分类通常是：

### 2.1 编程错误 / 违反前置条件

例如：

* 越界
* 非法状态
* 不满足接口约束

这类错误通常不属于“正常业务失败”。

### 2.2 可恢复的业务失败

例如：

* 解析失败
* 文件不存在
* 权限不足
* 网络超时

调用方通常有机会决定下一步怎么做。

### 2.3 致命错误

例如：

* 系统资源耗尽
* 程序已进入不一致状态

---

## 3. 异常适合什么场景

异常最适合：

* 错误很少发生
* 一旦发生，需要沿调用栈自动展开
* 局部函数不适合层层手动返回错误码

典型例子：

* 构造函数失败
* 资源获取失败
* 深层调用链中的异常退出

---

## 4. `expected` 适合什么场景

`std::expected<T, E>` 更适合：

* 失败是正常、可预期分支
* 调用方需要显式处理失败
* 你希望错误成为接口类型的一部分

例如：

* 配置解析
* 用户输入校验
* 业务规则检查
* 网络协议解析

---

## 5. `optional` 和 `expected` 的区别

`optional<T>` 表示：

* 可能有值，也可能没值

但它不告诉你：

* 为什么没值

`expected<T, E>` 表示：

* 要么有 `T`
* 要么有错误 `E`

所以经验上：

* 只有“有没有结果”时，用 `optional`
* 需要表达“为什么失败”时，用 `expected`

---

## 6. 一个最直接的例子

```cpp
std::optional<User> find_user(int id);
std::expected<User, ParseError> parse_user(std::string_view text);
```

前者表达“可能没有”，后者表达“失败且要知道原因”。

---

## 7. 什么时候不适合抛异常

### 7.1 失败是高频正常分支

### 7.2 热路径里非常在意开销和可预测性

### 7.3 跨 ABI / 跨模块边界不方便统一异常策略

### 7.4 团队整体约束就是禁用异常

这时更适合：

* `expected`
* error code
* status object

---

## 8. 什么时候异常特别合理

### 8.1 构造函数失败

### 8.2 无法在每层都写样板检查

### 8.3 资源清理由 RAII 承担

异常和 RAII 配合得最好：

* 抛出异常
* 栈展开
* 局部资源自动释放

---

## 9. 一个 `expected` 风格的例子

```cpp
#include <expected>
#include <string_view>

enum class ParseError {
    Empty,
    InvalidNumber
};

std::expected<int, ParseError> parse_int(std::string_view s) {
    if (s.empty()) {
        return std::unexpected(ParseError::Empty);
    }
    int value = 0;
    for (char ch : s) {
        if (ch < '0' || ch > '9') {
            return std::unexpected(ParseError::InvalidNumber);
        }
        value = value * 10 + (ch - '0');
    }
    return value;
}
```

---

## 10. 异常风格的例子

```cpp
int parse_int_or_throw(std::string_view s) {
    if (s.empty()) throw std::invalid_argument("empty");
    int value = 0;
    for (char ch : s) {
        if (ch < '0' || ch > '9') {
            throw std::invalid_argument("invalid number");
        }
        value = value * 10 + (ch - '0');
    }
    return value;
}
```

---

## 11. 一层系统里最好统一风格

最容易出问题的是混乱：

* 一半函数抛异常
* 一半函数返回错误码
* 一半函数返回空值

更稳妥的做法是：

* 每一层接口尽量有统一错误处理约定

---

## 12. `noexcept` 的意义

`noexcept` 表示：

* 这个函数承诺不抛异常

它既是语义约束，也会影响某些容器对移动操作的选择。

---

## 13. 析构函数为什么通常不能抛

析构阶段如果异常继续外逃，尤其在栈展开过程中，会很危险。
工程上通常遵循：

* 析构函数不要让异常逃出

---

## 14. 一个很实用的决策表

### 14.1 用异常

当失败：

* 不常发生
* 不适合做常规分支
* 需要栈展开自动清理

### 14.2 用 `expected`

当失败：

* 很常见
* 需要显式处理
* 希望错误成为接口类型的一部分

### 14.3 用 `optional`

当失败：

* 只是“没有结果”
* 不需要详细错误原因

---

## 15. 常见坑

### 15.1 用异常做普通循环分支

### 15.2 用 `optional` 隐藏真实错误信息

### 15.3 一个模块里混用三四种错误风格

### 15.4 给所有函数乱加 `noexcept`

---

## 16. 参考实例：`expected` 风格解析配置

当失败是正常分支，并且调用方需要知道原因时，可以把错误写进返回类型。

```cpp
#include <expected>
#include <charconv>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>

enum class ParseError {
    empty,
    invalid_number,
    out_of_range,
};

std::expected<int, ParseError> parse_port(std::string_view text) {
    if (text.empty()) {
        return std::unexpected(ParseError::empty);
    }

    int value = 0;
    const char* first = text.data();
    const char* last = text.data() + text.size();

    auto [ptr, ec] = std::from_chars(first, last, value);
    if (ec != std::errc{} || ptr != last) {
        return std::unexpected(ParseError::invalid_number);
    }

    if (value <= 0 || value > 65535) {
        return std::unexpected(ParseError::out_of_range);
    }

    return value;
}

void load_endpoint(std::string_view port_text) {
    auto port = parse_port(port_text);
    if (!port) {
        report_parse_error(port.error());
        return;
    }

    connect_to_port(*port);
}
```

同样的场景如果用异常，适合“失败少见、希望跨多层传播”的边界：

```cpp
int parse_port_or_throw(std::string_view text) {
    auto port = parse_port(text);
    if (!port) {
        throw std::runtime_error("invalid port");
    }
    return *port;
}
```

选择标准仍然是：

* 高频可恢复失败：`expected`
* 不常发生、跨层传播失败：异常
* 只是没有值且不关心原因：`optional`

---

## 17. 一页总结

错误处理最重要的不是“异常 vs `expected` 谁更先进”，而是：

1. 先判断失败是不是正常可恢复分支
2. 再决定错误是否应该进入类型系统
3. 再决定是否需要异常自动展开调用栈

可以直接记这条经验：

* 不常发生、跨层传播、依赖 RAII 清理：优先考虑异常
* 常见失败、需要显式处理、想把错误写进接口：优先考虑 `expected`

如果只记一句：

> 错误处理风格最怕的不是选错，而是同一层接口没有一致性。
