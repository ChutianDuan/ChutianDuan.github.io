---
title: "解析失败该返回 `false`、`expected` 还是抛异常？建立 C++ 错误处理边界"
date: 2026-07-13 09:49:23
updated: 2026-07-13 09:49:23
categories:
  - "学习"
  - "现代 C++ 实践"
permalink: /notes/现代c-实践/13-错误处理与expected-异常设计/
series: "现代 C++ 实践"
series_order: 13
---

时间：2026/04/09

一个端口解析函数可以有许多看似合理的接口：

```cpp
int parse_port(std::string_view text);                    // 失败返回 -1？会抛异常？
bool parse_port(std::string_view text, int& output);      // 为什么失败？output 是否被修改？
std::optional<int> parse_port(std::string_view text);     // 没有值，但原因是什么？
std::expected<int, ParseError> parse_port(std::string_view text);
```

错误处理最难的地方不是会不会写 `try/catch`，而是决定失败在当前接口中属于什么：正常缺失、可恢复业务分支、违反前置条件，还是无法在本层处理的异常情况。选错机制后，调用者可能忽略错误、被迫处理不可能分支，或在每层重复捕获再抛出。

本文以端口解析为例，建立一套可执行的判断方式：何时使用 `optional`、C++23 `expected`、异常、错误码或断言，异常怎样与 RAII 和 `noexcept` 配合，以及怎样在模块边界转换错误风格。

---

## 1. 先分类失败，再选择语法

“函数失败”至少包含几类性质不同的事件：

| 失败类别 | 示例 | 调用方通常能做什么 | 常见表达 |
| --- | --- | --- | --- |
| 正常缺失 | map 中没有 key、缓存未命中 | 使用默认值或走另一分支 | `optional<T>` |
| 可恢复输入/业务错误 | 配置格式错、端口越界、权限不足 | 提示、重试、返回错误响应 | `expected<T, E>`、错误码 |
| 环境或深层操作失败 | 构造资源失败、I/O 链路中断 | 在较高边界统一处理 | 异常或显式错误结果 |
| 编程错误 | 违反前置条件、内部不变量损坏 | 修复程序，而非业务恢复 | 断言、契约、终止策略 |

同一种底层事件在不同边界可能采用不同表达。例如文件不存在：在“可选用户配置”中是正常缺失，在“加载唯一生产密钥”中可能是启动失败。错误机制取决于接口语义，不由系统调用错误码单独决定。

不要把编程错误包装成每层都要处理的 `expected`。如果函数要求索引必须有效，调用者传入越界索引通常不是普通业务分支；更好的做法是通过类型、边界检查和测试消除错误，并明确违反前置条件的策略。

## 2. `optional`、`expected` 与异常分别表达什么？

### `optional<T>`：有值或没有值

它适合“不存在”本身已经足够解释结果：

```cpp
std::optional<User> find_cached_user(UserId id);
```

如果调用方需要区分格式错误、超出范围和后端超时，`optional` 会丢失关键信息。

### `expected<T, E>`：值或显式错误

`std::expected<T, E>` 是 C++23 标准库类型。失败是预期分支、调用方需要检查原因时，它把错误写进返回类型：

```cpp
std::expected<std::uint16_t, ParseError>
parse_port(std::string_view text);
```

错误值 `E` 应方便调用方决策，而不是只提供一段无法稳定判断的文本。可以用枚举表示类别，再在展示边界转换为消息；需要位置、系统错误码等上下文时，使用结构体。

### 异常：中断当前路径，寻找处理边界

异常适合当前层无法继续、又不希望每一层手工转发错误的情况。抛出后会沿调用栈传播，直到匹配的 `catch`；期间已构造的自动对象会析构。

它很适合构造函数无法建立类不变量，也适合一条深层操作链在较高请求入口统一转换为错误响应。但异常是否允许跨模块、线程、ABI 和实时边界，必须符合项目约定。

## 3. 一个完整的 `expected` 解析示例

下面的 C++23 程序把空输入、格式错误和数值越界区分开。`std::from_chars` 不分配、不依赖空字符结尾，也不会抛出解析异常，很适合底层数值解析。

```cpp
#include <charconv>
#include <cstdint>
#include <expected>
#include <iostream>
#include <string_view>
#include <system_error>

enum class ParseError {
    empty,
    invalid_format,
    out_of_range,
};

std::string_view message(ParseError error) noexcept {
    switch (error) {
    case ParseError::empty: return "input is empty";
    case ParseError::invalid_format: return "port must contain only an integer";
    case ParseError::out_of_range: return "port must be between 1 and 65535";
    }
    return "unknown parse error";
}

std::expected<std::uint16_t, ParseError>
parse_port(std::string_view text) noexcept {
    if (text.empty()) {
        return std::unexpected(ParseError::empty);
    }

    unsigned int value = 0;
    const char* const begin = text.data();
    const char* const end = begin + text.size();
    const auto [position, error] = std::from_chars(begin, end, value);

    if (error == std::errc::result_out_of_range) {
        return std::unexpected(ParseError::out_of_range);
    }
    if (error != std::errc{} || position != end) {
        return std::unexpected(ParseError::invalid_format);
    }
    if (value == 0 || value > 65535) {
        return std::unexpected(ParseError::out_of_range);
    }
    return static_cast<std::uint16_t>(value);
}

void print_result(std::string_view input) {
    if (auto port = parse_port(input)) {
        std::cout << input << " -> " << *port << '\n';
    } else {
        std::cout << '"' << input << "\" -> " << message(port.error()) << '\n';
    }
}

int main() {
    print_result("8080");
    print_result("");
    print_result("80http");
    print_result("70000");
}
```

使用支持 `<expected>` 的 C++23 标准库编译：

```bash
clang++ -std=c++23 -O2 -Wall -Wextra -pedantic \
  parse_port.cpp -o parse_port
./parse_port
```

预期输出：

```text
8080 -> 8080
"" -> input is empty
"80http" -> port must contain only an integer
"70000" -> port must be between 1 and 65535
```

启用 `-std=c++23` 不等于所配标准库必然实现 `<expected>`。旧 Apple Clang、libc++ 或 libstdc++ 环境可能需要升级项目工具链，或使用项目已有的 `Result`/`StatusOr` 类型；不要为了单个类型擅自引入另一套包管理器或全局依赖。

## 4. 这段代码为什么没有用异常？

无效配置是解析器预期会遇到的输入。调用方通常要在原位置显示错误并继续处理其他字段，因此错误是返回契约的一部分。`expected` 让检查显式，并避免把错误原因放进输出参数或线程局部状态。

函数声明为 `noexcept` 的依据不是“返回 expected 就应该不抛”，而是实现所调用的操作都满足不抛条件：`from_chars`、枚举构造和该 expected 的简单值/错误构造在这里无需分配。若错误类型改为可能分配的 `std::string`，或者实现加入会抛操作，就必须重新审查承诺。

`expected` 也不会自动让调用方处理错误。无视返回值仍然可能丢失失败；关键接口可以使用 `[[nodiscard]]` 或项目规范提醒调用方，但最终仍需清晰控制流和测试。

## 5. 什么时候把 `expected` 转成异常？

一个高层构造函数要求端口必须有效，否则对象根本无法建立不变量。可以在这个边界转换：

```cpp
std::uint16_t parse_port_or_throw(std::string_view text) {
    auto result = parse_port(text);
    if (!result) {
        throw std::invalid_argument(std::string(message(result.error())));
    }
    return *result;
}
```

反方向也很常见：模块内部库会抛异常，但对外 API 约定返回结果对象，就在边界捕获并映射：

```cpp
std::expected<Data, LoadError> load_safely() noexcept {
    try {
        return library_load_or_throw();
    } catch (const FileNotFound&) {
        return std::unexpected(LoadError::not_found);
    } catch (...) {
        return std::unexpected(LoadError::unknown);
    }
}
```

第二个例子只有在构造 `Data` 和 `unexpected` 也满足整体不抛策略时，才应保留 `noexcept`。此外，捕获所有异常会把 `bad_alloc` 等情况也映射成 unknown，是否合适必须由边界策略决定。

转换应该集中在模块、请求、线程或 ABI 边界。不要在同一层一会返回错误、一会抛异常，让调用方同时防守两条未说明的通道。

## 6. 异常传播为什么必须依赖 RAII？

异常抛出后，控制流不会继续执行函数末尾的手动清理：

```cpp
FILE* file = std::fopen(path, "rb");
do_work_that_may_throw();
std::fclose(file); // 抛异常时到不了这里
```

RAII 把资源释放放进析构函数，栈展开自然执行：

```cpp
std::ifstream input(path);
if (!input) {
    throw std::runtime_error("cannot open file");
}
parse_stream(input); // 抛异常时 input 仍会析构并关闭文件
```

互斥锁、动态内存、文件和 socket 都应由对象管理。异常机制只负责转移控制流，不会替裸资源调用正确的释放函数。

栈展开只析构已经构造完成的对象。构造某成员失败时，已构造的前序成员会析构，但对象自身的析构函数不会执行，因为整个对象从未完成构造。这也是成员本身应使用 RAII 的原因。

## 7. 异常安全保证到底保证什么？

异常安全描述操作失败后留下的状态：

| 保证 | 抛异常后的承诺 |
| --- | --- |
| 无泄漏/基本保证 | 不泄漏资源，对象仍满足不变量，但状态可能变化 |
| 强保证 | 操作要么完成，要么外部可观察状态保持原样 |
| 不抛保证 | 操作保证不会让异常逃出 |

强保证常用“先准备，后提交”：

```cpp
void ConfigManager::reload(std::string_view text) {
    Config replacement = parse_config_or_throw(text); // 可能失败，尚未改当前状态
    config_.swap(replacement);                         // swap 必须满足相应保证
}
```

不是每个函数都需要强保证。大批量更新有时只能提供基本保证，但接口应说明失败后哪些部分可能改变。所谓“不抛”也不是函数不会失败，而是失败通过其他方式表达，或此操作在约束下确实不能失败。

## 8. `try/catch` 应该放在哪里？

只在能够恢复、转换错误风格或补充真正有用上下文的地方捕获。常见边界包括：

- `main` 或服务进程的顶层循环；
- 线程入口，防止异常逃出导致 `std::terminate`；
- HTTP/RPC 请求入口，把异常转换为错误响应；
- GUI 事件回调；
- C ABI 和插件 ABI 边界；
- 需要把第三方异常转换为项目错误类型的适配层。

捕获时通常按 `const&`，并按具体到抽象排列：

```cpp
try {
    load_config();
} catch (const ConfigError& error) {
    handle_config_error(error);
} catch (const std::exception& error) {
    handle_standard_error(error);
}
```

按值捕获基类可能切片。重新抛出当前异常应使用 `throw;`，而不是 `throw error;`，后者会创建新异常并可能丢失动态类型。

空的 `catch (...) {}` 会把未知状态伪装成成功。`catch (...)` 适合最外层记录或转换，但必须有明确处置：返回失败、终止当前任务，或者重新抛出。

## 9. 构造函数和析构函数为什么需要不同策略？

构造函数无法通过返回值报告失败。若对象不能满足不变量，抛异常能保证调用方不会得到半初始化对象：

```cpp
class Server {
public:
    explicit Server(std::uint16_t port)
        : socket_(open_listen_socket(port)) {}

private:
    Socket socket_;
};
```

成员初始化列表中的异常发生在构造函数体之前。若要补充上下文，可以使用构造函数 function-try-block，但对象没有构造成功，通常只能转换或重新抛出，不能假装恢复。

析构函数则不应让异常逃出。若析构发生在另一异常的栈展开期间又抛出，程序会终止。会失败且调用方需要知道结果的操作，应提供显式 `close()`、`commit()` 或 `flush()`；析构只做不抛的兜底清理。

```cpp
writer.close(); // 可显式报告刷新失败
// 析构函数只保证尽力释放资源，不承担可靠提交结果
```

## 10. `noexcept` 是优化提示还是契约？

它首先是行为契约：异常一旦逃出 `noexcept` 函数，程序调用 `std::terminate()`。

```cpp
void swap(Buffer& other) noexcept;
```

析构、真正不抛的移动操作、swap 和简单观察函数常适合声明 `noexcept`。标准容器在扩容时也可能依据移动构造是否 `noexcept`，选择移动还是为异常安全保守地复制。

不要为了“性能更好”盲目添加。函数新增一个可能抛出的成员操作后，旧 `noexcept` 会把可传播错误变成进程终止。模板中可以使用条件形式：

```cpp
template <class T>
void exchange_values(T& left, T& right)
    noexcept(noexcept(std::swap(left, right))) {
    using std::swap;
    swap(left, right);
}
```

即使声明不抛，函数内部仍可捕获异常并不让它逃出；但静默吞错通常不是合理策略。

## 11. 错误类型应该保存字符串还是结构化信息？

字符串便于日志，却不适合稳定的程序决策。不要让调用方比较 `"file not found"` 来决定是否重试。更稳妥的错误结构可以包含：

```cpp
struct ParseError {
    ParseErrorCode code;
    std::size_t offset;
    std::string message;
};
```

`code` 供程序分支，`offset` 提供定位，`message` 面向人类。错误类型也要控制大小和分配成本，尤其在热路径或 `noexcept` 接口中。

底层错误传播到上层时，应保留有用因果信息，而不是每层只替换成“operation failed”。异常可以通过嵌套异常或自定义字段携带上下文；expected 风格可以在错误结构中追加阶段、路径和系统错误码。注意日志不要泄露密钥、完整用户输入等敏感内容。

## 12. 实时与跨 ABI 场景有什么特殊约束？

部分代码库禁用异常，可能出于实时延迟、二进制大小、平台支持或 ABI 约束。此时 `expected`/状态码可以成为统一方案，但它仍需要：

- 每层检查和传播；
- 明确错误对象分配行为；
- 避免在失败分支再失败；
- 工具或宏减少重复样板，但不能隐藏控制流。

C++ 异常不应未经约定跨 C ABI、不同编译器运行时或某些插件边界传播。在边界内捕获并转换为稳定错误码或项目结果类型。

实时线程即使不抛异常，也要避免错误构造时分配、锁和日志 I/O。错误机制选择必须结合执行环境，而不是简单断言哪一种“零成本”。

## 13. 工程中最容易踩哪些坑？

### 误区一：所有失败都抛异常

高频输入校验和正常查找缺失用异常会隐藏常见控制流。明确结果类型通常更合适。

### 误区二：所有失败都返回 `expected`

这会迫使调用方处理违反不变量等编程错误，并在深层调用中产生大量机械传播。机制仍要按失败性质选择。

### 误区三：每层捕获、记录、再抛出

同一异常会产生重复日志，且普通日志没有增加上下文。让异常到真正处理边界，只在有价值时补充信息。

### 误区四：`noexcept` 表示函数内部不会发生任何失败

它只保证异常不逃出。函数可能返回错误码，也可能因违反承诺直接终止。

### 误区五：析构失败可以正常抛出

析构异常与栈展开相遇会终止程序。重要提交操作要显式调用并处理结果，析构只负责安全清理。

### 误区六：错误消息就是错误类型

只返回文本会让程序分支依赖不稳定文案，也不利于本地化。用结构化 code 表达机器语义，文本用于展示和诊断。

## 14. 一个实用的选择顺序

面对一个可能失败的函数，可以依次问：

1. 这是调用者违反前置条件吗？优先改接口、断言或按项目策略终止，不伪装成普通失败。
2. “没有结果”是否正常且无需原因？使用 `optional`。
3. 失败是否是调用方常见、可恢复分支？使用 `expected` 或项目结果类型。
4. 当前层是否无法处理，且项目允许异常沿调用链传播？抛出有语义的异常，在高层边界捕获。
5. 是否跨线程、C ABI、插件或实时边界？在边界转换为约定的稳定表示。
6. 失败后对象必须保持什么状态？明确基本、强或不抛保证，并用 RAII 实现。

同一个系统可以使用多种机制，但每个模块接口要有一致、可预测的规则。混合机制应该发生在明确边界，而不是随机分布在相邻函数中。

## 15. 总结

开头的端口解析属于可预期、调用方需要原因的失败，因此 `expected<Port, ParseError>` 比 `-1`、输出参数或无说明异常更贴近接口语义。但这不意味着项目里所有错误都应改成 expected。

1. 先区分正常缺失、可恢复失败、环境异常和编程错误，再选机制；
2. `optional` 只表达有无，`expected` 显式携带错误，异常跨调用栈寻找处理边界；
3. 异常安全依赖 RAII，并要说明失败后的状态保证；
4. 构造失败适合抛异常，析构不能让异常逃出，`noexcept` 是终止级契约；
5. 在线程、ABI、实时和模块边界集中转换错误风格，避免同层混乱。

为新接口设计错误处理时，先写出三句话：“哪些失败是正常的？谁能恢复？失败后状态是什么？”答案确定后，返回类型与捕获位置通常就不会再靠个人偏好决定。
