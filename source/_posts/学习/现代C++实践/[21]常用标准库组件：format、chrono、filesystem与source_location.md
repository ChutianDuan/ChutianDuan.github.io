---
title: "常用标准库组件：format、chrono、filesystem 与 source_location"
date: 2026-05-08 14:29:26
updated: 2026-05-08 14:29:26
categories:
  - "学习"
  - "现代C++实践"
permalink: /notes/现代c-实践/21-常用标准库组件-format-chrono-filesystem与source_location/
---

# 常用标准库组件：format、chrono、filesystem 与 source_location

时间：2026/05/08

> 关键词：`std::format`、`std::chrono`、`std::filesystem`、`std::source_location`、`std::bit`、随机数
> 核心目标：把现代 C++ 标准库里最常用于工程代码的组件串起来，减少手写工具函数和平台相关代码。

---

## 1. 为什么要单独整理这些组件

很多 C++ 工程里会重复造这些小轮子：

* 字符串格式化
* 时间统计
* 路径拼接
* 文件遍历
* 日志行号
* 位操作
* 随机数

现代标准库已经提供了不少可用组件。
掌握它们不一定会让代码更“高级”，但能让代码更少错、更统一、更容易跨平台。

---

## 2. `std::format`：类型安全格式化

传统 `printf` 容易出现格式和参数不匹配：

```cpp
std::printf("%d\n", "hello"); // 错误但可能编译过
```

C++20 提供 `std::format`：

```cpp
#include <format>
#include <string>

std::string msg = std::format("user={}, score={}", "alice", 95);
```

输出：

```text
user=alice, score=95
```

基本格式：

```cpp
auto a = std::format("{}", 42);
auto b = std::format("{:04}", 7);       // 0007
auto c = std::format("{:.2f}", 3.14159); // 3.14
auto d = std::format("{:<10}", "cpp");  // 左对齐
auto e = std::format("{:>10}", "cpp");  // 右对齐
```

注意：如果你的编译器/标准库版本还没完整支持 `std::format`，工程里常用 `{fmt}` 作为替代。

---

## 3. 自定义类型的格式化

可以给类型提供 formatter：

```cpp
#include <format>
#include <string>

struct Point {
    int x = 0;
    int y = 0;
};

template <>
struct std::formatter<Point> : std::formatter<std::string> {
    auto format(const Point& p, std::format_context& ctx) const {
        return std::formatter<std::string>::format(
            std::format("({}, {})", p.x, p.y),
            ctx
        );
    }
};

int main() {
    Point p{3, 4};
    auto s = std::format("point={}", p);
}
```

对于业务类型，建议优先提供明确的格式：

```cpp
auto s = std::format("id={}, name={}", user.id, user.name);
```

只有类型本身经常需要统一展示时，再专门写 formatter。

---

## 4. `std::chrono`：不要再裸写毫秒整数

坏接口：

```cpp
void set_timeout(int timeout_ms);
```

调用时容易搞错单位：

```cpp
set_timeout(5); // 5 ms 还是 5 s？
```

更好的接口：

```cpp
#include <chrono>

void set_timeout(std::chrono::milliseconds timeout);

set_timeout(std::chrono::seconds(5));
set_timeout(std::chrono::milliseconds(500));
```

`chrono` 把单位放进类型系统，能减少大量隐形 bug。

---

## 5. 计时优先用 `steady_clock`

测耗时不要用系统时间。
系统时间可能被 NTP 或用户调整。

```cpp
#include <chrono>
#include <iostream>

class Timer {
public:
    Timer() : start_(clock::now()) {}

    double elapsed_ms() const {
        auto end = clock::now();
        std::chrono::duration<double, std::milli> d = end - start_;
        return d.count();
    }

private:
    using clock = std::chrono::steady_clock;
    clock::time_point start_;
};

int main() {
    Timer t;
    do_work();
    std::cout << "cost=" << t.elapsed_ms() << "ms\n";
}
```

常用选择：

* `steady_clock`：测耗时
* `system_clock`：表示日历时间、日志时间
* `high_resolution_clock`：不一定比前两者更适合，实际可能只是别名

---

## 6. chrono 字面量

```cpp
using namespace std::chrono_literals;

auto timeout = 500ms;
auto interval = 2s;
auto one_day = 24h;
```

可以写出更清楚的代码：

```cpp
std::this_thread::sleep_for(100ms);
```

如果在头文件里，不建议直接写：

```cpp
using namespace std::chrono_literals;
```

可以在函数内部使用，减少命名污染。

---

## 7. `std::filesystem::path`：跨平台路径拼接

不要手动拼路径分隔符：

```cpp
std::string full = dir + "/" + file;
```

用 `filesystem`：

```cpp
#include <filesystem>

namespace fs = std::filesystem;

fs::path dir = "logs";
fs::path file = "app.txt";
fs::path full = dir / file;
```

常用操作：

```cpp
fs::path p = "/tmp/demo.txt";

auto filename = p.filename();   // demo.txt
auto stem = p.stem();           // demo
auto ext = p.extension();       // .txt
auto parent = p.parent_path();  // /tmp
```

---

## 8. 创建目录和遍历文件

创建目录：

```cpp
#include <filesystem>

namespace fs = std::filesystem;

void ensure_dir(const fs::path& dir) {
    if (!fs::exists(dir)) {
        fs::create_directories(dir);
    }
}
```

遍历目录：

```cpp
#include <filesystem>
#include <iostream>

namespace fs = std::filesystem;

void list_cpp_files(const fs::path& root) {
    for (const auto& entry : fs::recursive_directory_iterator(root)) {
        if (!entry.is_regular_file()) {
            continue;
        }

        if (entry.path().extension() == ".cpp") {
            std::cout << entry.path() << "\n";
        }
    }
}
```

注意：

* 文件系统操作可能抛异常
* 权限、符号链接、循环链接都要考虑
* 遍历大目录时不要默认全量递归

---

## 9. filesystem 的错误处理版本

如果不想用异常，可以传 `std::error_code`：

```cpp
#include <filesystem>
#include <system_error>

namespace fs = std::filesystem;

bool try_remove(const fs::path& p) {
    std::error_code ec;
    bool removed = fs::remove(p, ec);
    if (ec) {
        log_error(ec.message());
        return false;
    }
    return removed;
}
```

这和错误处理章节能接上：

* 异常适合少见失败
* `error_code` 适合你想显式处理每一步失败

---

## 10. `std::source_location`：日志自动带位置

C++20 的 `source_location` 可以捕获调用点文件、行号、函数名。

```cpp
#include <source_location>
#include <iostream>
#include <string_view>

void log(std::string_view msg,
         const std::source_location& loc = std::source_location::current()) {
    std::cout << loc.file_name() << ":" << loc.line()
              << " " << loc.function_name()
              << " - " << msg << "\n";
}

void f() {
    log("hello");
}
```

比宏更类型安全，也更容易封装。

注意：

```cpp
void log_impl(std::string_view msg,
              std::source_location loc);

void log(std::string_view msg,
         std::source_location loc = std::source_location::current()) {
    log_impl(msg, loc);
}
```

默认参数要放在最外层 API 上，才能捕获真正调用点。

---

## 11. `std::bit`：位操作不要手写太多

C++20 `<bit>` 提供常用位工具：

```cpp
#include <bit>
#include <cstdint>

static_assert(std::has_single_bit(8u));
static_assert(std::bit_width(8u) == 4);
static_assert(std::popcount(0b1011u) == 3);
```

常见用途：

```cpp
bool is_power_of_two(std::uint32_t x) {
    return std::has_single_bit(x);
}

std::uint32_t next_capacity(std::uint32_t n) {
    return std::bit_ceil(n);
}
```

比自己写位运算更不容易错，也更能表达意图。

---

## 12. `std::bit_cast`：安全表达按位转换

以前很多人用 `reinterpret_cast` 或 union 做位解释。
C++20 提供 `std::bit_cast`：

```cpp
#include <bit>
#include <cstdint>

float f = 1.0f;
std::uint32_t bits = std::bit_cast<std::uint32_t>(f);
```

要求：

* 源类型和目标类型大小相同
* 类型通常应是 trivially copyable

它比直接乱用 `reinterpret_cast` 更安全、更清楚。

---

## 13. 随机数：不要用 `rand()`

现代 C++ 随机数由两部分组成：

* 引擎：生成随机位
* 分布：把随机位映射成目标分布

```cpp
#include <random>
#include <iostream>

int main() {
    std::random_device rd;
    std::mt19937 rng(rd());
    std::uniform_int_distribution<int> dist(1, 6);

    for (int i = 0; i < 5; ++i) {
        std::cout << dist(rng) << "\n";
    }
}
```

如果需要可复现测试，固定 seed：

```cpp
std::mt19937 rng(12345);
```

如果是安全随机数，标准库随机数通常不够，要用系统或密码学库提供的安全随机接口。

---

## 14. 一个小工具组合示例：扫描目录并打印报告

```cpp
#include <chrono>
#include <filesystem>
#include <format>
#include <iostream>
#include <source_location>

namespace fs = std::filesystem;

void log(std::string_view msg,
         const std::source_location& loc = std::source_location::current()) {
    std::cout << std::format("{}:{} {}\n",
                             loc.file_name(),
                             loc.line(),
                             msg);
}

std::size_t count_files(const fs::path& root, std::string_view ext) {
    std::size_t count = 0;

    for (const auto& entry : fs::recursive_directory_iterator(root)) {
        if (entry.is_regular_file() && entry.path().extension() == ext) {
            ++count;
        }
    }

    return count;
}

int main() {
    auto start = std::chrono::steady_clock::now();

    fs::path root = "src";
    auto count = count_files(root, ".cpp");

    auto end = std::chrono::steady_clock::now();
    std::chrono::duration<double, std::milli> ms = end - start;

    log(std::format("found {} cpp files in {:.2f} ms", count, ms.count()));
}
```

这里组合了：

* `filesystem` 管路径和遍历
* `chrono` 测耗时
* `format` 构造消息
* `source_location` 自动带调用点

---

## 15. 常见误区

### 15.1 手写路径分隔符

跨平台路径用 `std::filesystem::path`，不要自己拼 `/` 或 `\`。

### 15.2 用 `system_clock` 测耗时

测耗时优先 `steady_clock`。

### 15.3 `string_view` 传给异步日志后再保存

异步日志如果晚点再格式化，`string_view` 可能已经悬空。
跨线程保存时通常要复制成 `std::string`。

### 15.4 以为 `std::format` 所有环境都可用

不同标准库支持进度可能不同。
工程里要用 CI 验证目标平台，必要时用 `{fmt}`。

### 15.5 随机测试每次都用随机 seed

测试失败后很难复现。
测试用例建议记录 seed 或固定 seed。

---

## 16. 一页总结

现代标准库里最值得日常使用的组件：

1. `std::format`：类型安全格式化
2. `std::chrono`：把时间单位放进类型系统
3. `std::filesystem`：跨平台路径与文件操作
4. `std::source_location`：日志和诊断自动带调用点
5. `<bit>`：标准位操作工具
6. `<random>`：引擎 + 分布的随机数模型

一句话：

> 这些组件的价值在于减少自制小工具，让常见工程代码更清楚、更可移植、更容易测试。
