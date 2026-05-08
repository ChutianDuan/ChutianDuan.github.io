---
title: "测试、调试与 Sanitizer 工具链"
date: 2026-05-04 14:48:32
updated: 2026-05-04 14:48:32
categories:
  - "学习"
  - "现代C++实践"
permalink: /notes/现代c-实践/17-测试-调试与sanitizer工具链/
---

# 测试、调试与 Sanitizer 工具链

时间：2026/05/04

> 关键词：单元测试、集成测试、断言、日志、调试器、AddressSanitizer、UBSan、TSan、CI
> 核心目标：把“代码看起来对”变成“有测试、有诊断、有工具能抓问题”的工程流程。

---

## 1. 为什么 C++ 更需要工具链意识

C++ 的自由度很高，也意味着很多错误不会自动变成清晰异常：

* 越界访问
* use-after-free
* 数据竞争
* 未定义行为
* 资源泄漏
* ODR 或链接问题

所以现代 C++ 实践里，测试和诊断工具不是附属品，而是基本能力。

一个比较健康的本地开发流程是：

1. 写小而明确的单元测试
2. Debug 模式开启断言和诊断
3. 定期跑 Sanitizer 版本
4. CI 固定跑核心测试集

---

## 2. 测试分层

常见测试可以粗略分三层：

| 类型 | 目标 | 特点 |
| --- | --- | --- |
| 单元测试 | 验证一个函数或类 | 快、边界清楚 |
| 集成测试 | 验证多个模块协作 | 更接近真实路径 |
| 回归测试 | 固定历史 bug | 防止问题再次出现 |

不要一上来只写“大而全”的测试。
越底层的逻辑，越适合用小测试钉住行为。

---

## 3. 一个最小测试例子

即使不用测试框架，也可以先写最小可运行测试：

```cpp
#include <cassert>

int add(int a, int b) {
    return a + b;
}

int main() {
    assert(add(1, 2) == 3);
    assert(add(-1, 1) == 0);
}
```

这种测试很朴素，但比“手动运行看一眼输出”可靠。

工程里常用测试框架：

* GoogleTest
* Catch2
* doctest

框架的价值是：

* 更好的失败信息
* 测试组织
* fixture
* 参数化测试
* 和 CI 集成更自然

---

## 4. 测试什么

优先测试这些东西：

* 边界条件
* 空输入
* 错误路径
* 所有权转移
* 异常或错误返回
* 并发关闭流程
* 之前出过 bug 的路径

例子：

```cpp
#include <optional>
#include <string_view>

std::optional<int> parse_digit(std::string_view s) {
    if (s.size() != 1) return std::nullopt;
    if (s[0] < '0' || s[0] > '9') return std::nullopt;
    return s[0] - '0';
}
```

至少应该覆盖：

* `"0"`
* `"9"`
* `""`
* `"12"`
* `"x"`

---

## 5. 断言的作用

断言适合检查：

* 前置条件
* 内部不变量
* 理论上不该发生的状态

```cpp
#include <cassert>
#include <vector>

int get_first(const std::vector<int>& xs) {
    assert(!xs.empty());
    return xs.front();
}
```

断言不是错误处理。
如果空输入是正常业务失败，应该返回错误或抛异常，而不是只写 `assert`。

注意：

* 定义 `NDEBUG` 后，标准 `assert` 会被移除
* 不要把有副作用的表达式写进 `assert`

---

## 6. 日志和调试器各自解决什么

日志适合：

* 线上或长时间运行问题
* 记录关键状态转移
* 还原错误发生前后的上下文

调试器适合：

* 本地复现
* 观察变量
* 单步执行
* 查看调用栈

不要把日志当成测试，也不要用调试器代替可重复测试。
测试负责固定行为，日志和调试器负责定位问题。

---

## 7. AddressSanitizer：先抓内存错误

AddressSanitizer 常用于发现：

* 越界访问
* use-after-free
* double-free
* 部分内存泄漏问题

常见编译方式：

```bash
clang++ -std=c++20 -g -O1 -fno-omit-frame-pointer -fsanitize=address main.cpp -o app
./app
```

建议加上：

```bash
-fno-omit-frame-pointer
```

这样栈回溯通常更清楚。

如果需要 leak 检测：

```bash
ASAN_OPTIONS=detect_leaks=1 ./app
```

---

## 8. UndefinedBehaviorSanitizer

UBSan 常用于发现未定义行为，例如：

* 有符号整数溢出
* 非法类型转换
* 错误对齐访问
* 除零
* 某些无效 enum 值

常见编译方式：

```bash
clang++ -std=c++20 -g -O1 -fsanitize=undefined main.cpp -o app
./app
```

也可以和 ASan 一起用：

```bash
clang++ -std=c++20 -g -O1 -fno-omit-frame-pointer -fsanitize=address,undefined main.cpp -o app
```

很多 UB 在普通运行时看不出问题，但会让优化器基于错误假设重写代码。
所以 UBSan 对 C++ 很有价值。

---

## 9. ThreadSanitizer

TSan 用于发现数据竞争：

```bash
clang++ -std=c++20 -g -O1 -fsanitize=thread main.cpp -o app
./app
```

适合检查：

* 非原子共享变量并发读写
* 锁保护不一致
* 错误的对象发布

注意：

* TSan 运行开销较大
* 不建议和 ASan 在同一个构建里混用
* 对某些平台和第三方库支持有限

并发 bug 很难靠肉眼检查完整，TSan 是非常重要的辅助工具。

---

## 10. Debug / Release / RelWithDebInfo

常见构建类型：

| 类型 | 特点 |
| --- | --- |
| Debug | 无优化或低优化，调试友好 |
| Release | 高优化，性能接近发布 |
| RelWithDebInfo | 带调试信息的优化构建 |

排查性能或线上问题时，`RelWithDebInfo` 很有用：

* 接近真实优化路径
* 保留栈信息和符号

不要只在 Debug 下测试。
有些 UB、时序问题、未初始化问题会在 Release 下更容易暴露。

---

## 11. CMake 里加测试

一个最小结构：

```cmake
enable_testing()

add_executable(math_test
    tests/math_test.cpp
)

target_link_libraries(math_test
    PRIVATE
        core
)

add_test(NAME math_test COMMAND math_test)
```

运行：

```bash
ctest --test-dir build --output-on-failure
```

如果使用 GoogleTest，通常还会用它提供的测试发现工具。
但底层原则不变：

* 测试本身也是一个 target
* 测试链接被测库
* `ctest` 统一运行测试

---

## 12. CMake 里加 Sanitizer 选项

小项目可以先写得简单：

```cmake
option(ENABLE_ASAN "Enable AddressSanitizer" OFF)

if(ENABLE_ASAN)
    add_compile_options(-fsanitize=address -fno-omit-frame-pointer)
    add_link_options(-fsanitize=address)
endif()
```

更工程化的写法是把 Sanitizer 配置绑定到具体 target，避免污染第三方库。

例如：

```cmake
target_compile_options(app PRIVATE -fsanitize=address -fno-omit-frame-pointer)
target_link_options(app PRIVATE -fsanitize=address)
```

不要只加编译选项，链接阶段也要加对应 sanitizer。

---

## 13. 最小 CI 检查清单

一个实用的 C++ CI 至少可以包含：

1. 普通 Debug 构建
2. 普通 Release 或 RelWithDebInfo 构建
3. 单元测试
4. ASan + UBSan 测试
5. 关键并发模块定期跑 TSan

如果项目更成熟，还可以加：

* clang-tidy
* clang-format 检查
* 覆盖率
* benchmark 回归
* 包管理和依赖版本锁定

先把最关键的测试和 sanitizer 跑起来，比一开始追求全套流程更重要。

---

## 14. 常见坑

### 14.1 只测正常路径

错误路径和边界条件更容易藏 bug。

### 14.2 把 `assert` 当成用户输入校验

Release 下断言可能被移除。
可恢复错误应该走错误处理流程。

### 14.3 只在 Debug 下运行

Release 优化可能暴露完全不同的问题。

### 14.4 Sanitizer 只加了编译选项

链接阶段也需要对应选项。

### 14.5 把 TSan 报告轻易忽略

数据竞争不是“小概率问题”，而是未定义行为。

---

## 15. 一页总结

测试和工具链最值得记住的是：

1. 单元测试负责固定小范围行为
2. 回归测试负责防止历史 bug 回来
3. 断言检查内部不变量，不替代错误处理
4. ASan 抓内存错误，UBSan 抓未定义行为，TSan 抓数据竞争
5. Debug 和 Release 都要测
6. CMake 里测试和 sanitizer 最好按 target 管理

如果只记一句：

> 现代 C++ 工程要靠测试、断言、日志、调试器和 Sanitizer 共同兜底，不能只靠“我看代码应该没问题”。

---

## 16. 参考资料

1. Clang AddressSanitizer
   <https://clang.llvm.org/docs/AddressSanitizer.html>

2. Clang UndefinedBehaviorSanitizer
   <https://clang.llvm.org/docs/UndefinedBehaviorSanitizer.html>

3. Clang ThreadSanitizer
   <https://clang.llvm.org/docs/ThreadSanitizer.html>

4. CMake: testing
   <https://cmake.org/cmake/help/latest/manual/ctest.1.html>
