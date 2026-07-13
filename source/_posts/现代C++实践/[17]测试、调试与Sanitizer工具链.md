---
title: "测试全绿，程序为什么仍会崩溃？建立 C++ 测试与诊断证据链"
date: 2026-07-13 10:01:58
updated: 2026-07-13 10:01:58
categories:
  - "学习"
  - "现代 C++ 实践"
permalink: /notes/现代c-实践/17-测试-调试与sanitizer工具链/
series: "现代 C++ 实践"
series_order: 17
---

时间：2026/05/04

一个数组函数通过了所有单元测试，线上仍然偶发崩溃。测试只验证了返回值，却没有覆盖空输入；越界访问在测试机器上碰巧没有立即出错。另一个并发模块跑了一千次都正常，但代码里存在数据竞争，程序行为从语言规则上已经未定义。

“测试通过”只能证明被执行的输入满足了写下的断言，不能证明没有内存错误、未定义行为和竞态。反过来，Sanitizer 没有报告，也只说明它在当前构建、平台和已执行路径中没有检测到相应问题。

可靠的 C++ 工程需要一条互补证据链：编译器警告尽早拦截可疑代码，测试固定业务行为，断言检查内部不变量，Sanitizer 捕获运行时违规，调试器和日志负责定位，CI 保证这些检查可重复执行。

---

## 1. 每种工具到底能证明什么？

| 工具 | 最擅长回答的问题 | 不能单独证明什么 |
| --- | --- | --- |
| 编译警告/静态分析 | 源码中是否有可推断的可疑模式 | 所有运行时路径都安全 |
| 单元测试 | 小范围输入输出和状态转移是否符合预期 | 未执行输入、UB 和竞态不存在 |
| 集成测试 | 模块协议与依赖协作是否正确 | 每个边界分支都覆盖 |
| 断言 | 开发构建中内部不变量是否被违反 | 用户输入得到可靠错误处理 |
| ASan/UBSan | 已执行路径是否有多类内存错误/UB | 未执行路径安全、没有逻辑 bug |
| TSan | 已执行并发路径是否出现可检测数据竞争 | 没有死锁或所有并发语义正确 |
| 调试器 | 当前复现的调用栈和状态是什么 | 问题以后不会再次发生 |
| 日志/指标 | 线上问题前发生了哪些可观察事件 | 源码级根因和完整内存状态 |

工具链的目标不是找到一个“最强工具”，而是让不同证据交叉验证。功能测试与 Sanitizer 测试通常应该运行同一批核心用例，使业务断言和运行时安全检查覆盖相同路径。

## 2. 测试应该怎样分层？

常见层次不是按名字划分，而是按范围和反馈速度：

- **单元测试**：一个函数或小类，依赖少、执行快、失败定位明确；
- **组件/集成测试**：多个模块、真实序列化或数据库适配层协作；
- **端到端测试**：从外部入口验证关键用户流程，最接近部署但较慢；
- **回归测试**：把历史 bug 的最小复现固定下来，可以位于任一层。

越底层、确定性的规则越适合大量快速单测。少量端到端测试确认系统接线，不要让所有边界条件都只能启动完整服务才能验证。

测试优先覆盖：

- 空、最小、最大和边界外输入；
- 正常失败、异常、超时和取消路径；
- 所有权转移与对象关闭顺序；
- 并发模块的启动、停止和积压排空；
- 历史缺陷的最小触发条件。

## 3. 一个不依赖测试框架的最小测试程序

标准 `assert` 在定义 `NDEBUG` 后会消失，不适合作为独立测试程序唯一的结果机制。下面的 C++20 示例用明确检查、失败信息和进程退出码测试单字符数字解析。

```cpp
#include <iostream>
#include <optional>
#include <string_view>

std::optional<int> parse_digit(std::string_view text) {
    if (text.size() != 1 || text.front() < '0' || text.front() > '9') {
        return std::nullopt;
    }
    return text.front() - '0';
}

class TestRunner {
public:
    void check(bool condition, std::string_view name) {
        ++total_;
        if (!condition) {
            ++failed_;
            std::cerr << "FAILED: " << name << '\n';
        }
    }

    int finish() const {
        std::cout << total_ - failed_ << '/' << total_ << " tests passed\n";
        return failed_ == 0 ? 0 : 1;
    }

private:
    int total_ = 0;
    int failed_ = 0;
};

int main() {
    TestRunner tests;

    tests.check(parse_digit("0") == 0, "lower boundary");
    tests.check(parse_digit("9") == 9, "upper boundary");
    tests.check(!parse_digit(""), "empty input");
    tests.check(!parse_digit("12"), "more than one character");
    tests.check(!parse_digit("x"), "non-digit input");

    return tests.finish();
}
```

编译运行：

```bash
clang++ -std=c++20 -O2 -Wall -Wextra -pedantic \
  parse_digit_test.cpp -o parse_digit_test
./parse_digit_test
```

预期输出和退出状态：

```text
5/5 tests passed
exit status: 0
```

真实项目通常使用 GoogleTest、Catch2、doctest 或已有框架，获得 fixture、参数化测试、过滤和更好的差异信息。但框架不能替代用例设计：只写一个正常输入，无论输出多漂亮，覆盖仍然很弱。

## 4. `assert` 应该检查什么？

断言适合开发者承诺的内部条件：

```cpp
int first(const std::vector<int>& values) {
    assert(!values.empty());
    return values.front();
}
```

如果空数组来自用户或网络，是可预期输入，就应该返回错误或抛出符合接口约定的异常，而不是依赖 assert。发布构建常定义 `NDEBUG`，断言可能完全移除。

绝不要把副作用放进断言：

```cpp
assert(initialize()); // Release 中 initialize 可能根本不执行
```

正确做法是先执行，再断言结果：

```cpp
const bool initialized = initialize();
assert(initialized);
```

断言失败通常说明程序不变量被破坏，应保留现场并修复代码，不应捕获后继续运行在未知状态。

## 5. 为什么 Debug 和 Release 都要测试？

| 构建 | 价值 | 局限 |
| --- | --- | --- |
| Debug | 易单步、变量较完整、断言和检查常开启 | 时序和性能偏离部署 |
| Release | 与发布优化更接近 | 调试信息可能少，错误更难定位 |
| RelWithDebInfo | 优化同时保留符号 | 局部变量仍可能被优化掉 |

未定义行为在不同优化级别可能表现不同，并发时序也会变化。只测 Debug 会漏掉发布配置、条件宏、链接优化和性能路径问题；只测 Release 又会降低日常定位效率。

测试目标应与生产使用相同的语言标准、关键编译定义和依赖版本。否则“测试二进制”与“部署二进制”可能走不同代码。

## 6. ASan、UBSan 和 TSan 分别检查什么？

### AddressSanitizer（ASan）

常用于发现 heap/stack/global 越界、use-after-free、double free 等内存错误：

```bash
clang++ -std=c++20 -O1 -g -fno-omit-frame-pointer \
  -fsanitize=address test.cpp -o test_asan
./test_asan
```

部分平台运行时还能集成 leak 检测，但支持与默认行为依赖编译器和操作系统，应在 CI 环境实际确认。

### UndefinedBehaviorSanitizer（UBSan）

可检测许多已执行的未定义行为，如部分有符号溢出、错误对齐、除零和无效转换：

```bash
clang++ -std=c++20 -O1 -g -fno-omit-frame-pointer \
  -fsanitize=address,undefined test.cpp -o test_asan_ubsan
./test_asan_ubsan
```

ASan 和 UBSan 经常组合，但并非所有 UBSan 检查默认启用或都能恢复执行。CI 中通常希望错误让任务失败，而不是只打印后继续。

### ThreadSanitizer（TSan）

用于检测实际执行路径中的数据竞争：

```bash
clang++ -std=c++20 -O1 -g -fno-omit-frame-pointer \
  -fsanitize=thread -pthread concurrent_test.cpp -o test_tsan
./test_tsan
```

TSan 通常不与 ASan 放进同一个构建，运行和内存开销也更大。平台、系统库和第三方二进制会影响支持情况。数据竞争是未定义行为，不能因为“只有一条报告”或“线上很少发生”就忽略；但报告仍要阅读完整访问栈，确认同步模型和第三方 suppression 是否合理。

## 7. 为什么 Sanitizer 不能证明程序安全？

Sanitizer 是动态检测：没有运行到的分支不会被检查。输入、线程调度和对象生命周期没有触发缺陷时，报告为空并不构成安全证明。

提高价值的做法包括：

- 用同一套单元/集成测试跑 Sanitizer 构建；
- 增加错误路径、取消和关闭用例；
- 对解析器使用模糊测试扩大输入空间；
- 让并发用例重复执行并改变调度压力；
- 保留符号和 frame pointer，确保报告可定位；
- 把运行时报告作为 CI 失败，而非日志警告。

Sanitizer 本身也可能受平台运行时限制或与特定库不兼容。连续挂起或工具初始化失败时，应停止盲目重跑，记录工具链版本，缩小最小程序，并转移到项目支持的 CI/容器平台验证。

## 8. CMake 怎样让测试成为 target？

CTest 负责发现和运行 CMake 注册的测试：

```cmake
include(CTest)

if(BUILD_TESTING)
    add_executable(parse_digit_test
        tests/parse_digit_test.cpp
    )

    target_link_libraries(parse_digit_test
        PRIVATE
            core
    )

    target_compile_features(parse_digit_test PRIVATE cxx_std_20)
    add_test(NAME parse_digit COMMAND parse_digit_test)
endif()
```

运行：

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build --parallel 2
ctest --test-dir build --output-on-failure
```

测试链接被测库 target，而不是复制一份实现源文件。这样生产程序和测试使用相同实现与 PUBLIC usage requirements。

## 9. Sanitizer 选项为什么要同时进入编译和链接？

Sanitizer 既需要编译器插桩，也需要链接相应运行时。只添加 compile options 可能在最终链接时报未定义符号或生成不完整产物。

应把配置限制在自己的 target，并检查编译器支持：

```cmake
option(ENABLE_ASAN "Enable AddressSanitizer" OFF)

if(ENABLE_ASAN)
    if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
        target_compile_options(parse_digit_test PRIVATE
            -fsanitize=address,undefined
            -fno-omit-frame-pointer
        )
        target_link_options(parse_digit_test PRIVATE
            -fsanitize=address,undefined
        )
    else()
        message(FATAL_ERROR "ENABLE_ASAN is unsupported by this toolchain")
    endif()
endif()
```

不要无条件使用全局 `add_compile_options` 污染第三方依赖，也不要把上面的 GNU/Clang 参数传给 MSVC。成熟项目可以建立内部 INTERFACE sanitizer target，集中复用，但小项目不必提前制造复杂抽象。

## 10. 日志和调试器分别何时有用？

调试器（macOS 上常用 LLDB，Linux 上常见 GDB/LLDB）适合稳定本地复现：设置断点、查看线程和调用栈、观察变量与内存。优化构建中变量可能被消除或重排，这是正常现象。

日志和指标适合无法停住的线上或长时间问题。有效日志应记录：

- 请求/连接/任务的稳定 ID；
- 关键状态转移和错误码；
- 必要的持续时间、队列深度和资源计数；
- 时间与线程/执行上下文。

不要记录密钥、Token 或完整敏感载荷，也不要在高频热路径无上限输出。日志帮助重建事件，不替代断言业务结果的测试。

一次调试修复后，应把最小复现转成回归测试。否则知识只留在调试会话中，下一次重构可能让 bug 回来。

## 11. 并发测试怎样避免“跑很多次就算通过”？

并发测试应验证明确不变量和终止条件，而不是依赖 `sleep(100ms)` 猜任务已经完成。优先使用 `join`、barrier、latch、future 或条件变量建立可观察同步。

测试应设置整体超时，避免死锁无限占用 CI；失败时记录线程状态和队列指标。重复运行可以扩大调度覆盖，但不能把一万次没失败当作没有数据竞争。TSan、代码审查和明确 happens-before 关系仍然必要。

## 12. CI 最小检查集应该包含什么？

按项目规模逐步建立：

1. 至少一个受支持编译器上的警告构建；
2. Debug 测试；
3. Release 或 RelWithDebInfo 构建与核心测试；
4. 支持平台上的 ASan + UBSan 测试；
5. 并发模块定期或分任务运行 TSan；
6. 构建与测试命令设置合理超时并保留失败日志。

格式检查、clang-tidy、覆盖率、fuzz 和 benchmark 回归可以按真实需求增加。覆盖率高只说明代码被执行，不说明断言有质量；CI 项目多也不等于证据更强。

## 13. 工程中最容易踩哪些坑？

### 误区一：测试通过等于没有 UB

测试只判断写下的结果。运行同一测试的 Sanitizer 构建才能捕获一部分已执行 UB。

### 误区二：把 assert 当作输入校验

Release 可能移除 assert。可恢复外部错误必须使用稳定返回或异常契约。

### 误区三：只有 Debug 需要测试

优化、宏和链接配置都可能改变行为。发布配置至少要运行核心用例。

### 误区四：忽略 flaky 测试，失败时重跑到绿

不稳定测试可能暴露真实竞态或共享环境污染。应保存首次失败证据、定位根因，而不是让自动重试掩盖。

### 误区五：Sanitizer 报告发生在标准库，所以与业务无关

容器内部崩溃常由业务更早的越界、悬空或竞态触发。沿读写栈追到最初非法访问。

### 误区六：一次测试同时打开所有检测器

检测器兼容性和资源开销不同。ASan+UBSan 与 TSan 通常拆成独立构建，得到更清晰报告。

## 14. 总结

开头测试全绿却线上崩溃，是因为测试只覆盖了部分输入和功能断言，没有验证语言层面的内存与并发规则。

1. 单元、集成和回归测试固定行为，不能单独证明没有 UB；
2. assert 检查内部不变量，外部可恢复错误必须使用发布构建仍存在的机制；
3. ASan/UBSan 检查已执行的内存与 UB 路径，TSan 单独检查数据竞争；
4. Debug、Release/RelWithDebInfo 和诊断构建都应执行核心测试；
5. 日志与调试器负责定位，修复后要把复现固化成自动回归测试。

为一个历史崩溃写测试时，不只断言最终输出；同时让相同用例在诊断构建下运行，并覆盖创建、失败、取消和销毁全过程。只有业务行为与运行时规则都被检查，“测试通过”才拥有更强含义。
