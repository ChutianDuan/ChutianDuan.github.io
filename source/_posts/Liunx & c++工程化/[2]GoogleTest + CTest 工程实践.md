---
title: "`TEST()` 明明写了，为什么 CTest 却说没有测试？"
date: 2026-07-13 15:29:05
updated: 2026-07-13 15:29:05
categories:
  - "学习"
  - "Linux 与 C++ 工程化"
permalink: /notes/liunx-c-工程化/2-googletest-ctest-工程实践/
series: "Linux 与 C++ 工程化"
series_order: 2
---

时间：2026/05/12
整理：2026/06/19

> 关键词：GoogleTest、GoogleMock、CTest、CMake、单元测试、Fixture、参数化测试、CI

---

一个很常见的 C++ 测试现场是：测试源码能编译，直接运行测试程序也能看到用例，到了工程根目录执行 CTest，却只得到一句：

```text
Test project /path/to/build
No tests were found!!!
```

另一种情况更隐蔽：CTest 确实执行了测试，但它只显示一个名为 `lab_unit_tests` 的大测试。里面究竟是协议解析、限流逻辑，还是某个参数化用例失败了，必须翻很长的日志才能知道。

问题不在 `TEST()` 宏本身，而在几个容易混在一起的层次：GoogleTest 负责定义并运行 C++ 测试，CMake 负责构建测试程序，CTest 则只调度那些被明确注册到构建树中的测试。少了其中任何一环，都会出现“测试明明存在，CTest 却看不见”的错觉。

本文用一个可运行的二进制协议编解码工程贯穿全文，逐步解决以下问题：

- 怎样让生产程序和测试复用同一份业务代码；
- `include(CTest)`、`gtest_discover_tests()` 分别做了什么；
- 如何覆盖正常路径、脏数据、边界值和外部依赖；
- 为什么某些测试虽然能通过，却依旧脆弱、缓慢或不适合并行；
- 怎样把本地测试命令原样放进 CI。

## 1. 写了 `TEST()`，为什么还不算完成工程集成？

GoogleTest 和 CTest 解决的是不同层次的问题：

| 工具 | 负责什么 | 典型内容 |
| --- | --- | --- |
| GoogleTest | 编写和执行 C++ 测试用例 | `TEST`、断言、Fixture、参数化测试 |
| GoogleMock | 替换外部依赖并验证交互 | `MOCK_METHOD`、`EXPECT_CALL` |
| CMake | 构建业务库和测试程序 | `add_library`、`add_executable`、`target_link_libraries` |
| CTest | 统一注册、筛选和运行测试 | `ctest`、标签、超时、并行执行 |
| CI | 在提交后自动构建和回归 | GitHub Actions、GitLab CI |

一次完整的测试流程是：

```text
业务源码
  │
  ├─ CMake 编译为业务库 lab_core
  │
  └─ 测试源码链接 lab_core + GoogleTest
           │
           ├─ 直接运行测试程序：使用 GoogleTest 参数
           │
           └─ 通过 CTest 运行：统一筛选、并行、超时和报告
```

最终希望把日常回归固定为三条命令：

```bash
cmake -S . -B build -DBUILD_TESTING=ON
cmake --build build --parallel 2
ctest --test-dir build --output-on-failure
```

### 1.1 为什么业务代码应该先编成库

不推荐把业务逻辑全部写在 `main.cpp`：

```text
main.cpp
├─ 参数解析
├─ 网络监听
├─ 协议编解码
├─ 鉴权
└─ 状态更新
```

这种结构会让测试只能启动整个程序，难以隔离某个函数或模块。

更合适的组织方式是：

```text
业务逻辑 → library
应用入口 → executable，链接 library
测试程序 → executable，链接同一个 library
```

测试和生产程序因此使用同一份实现，不需要复制代码。

---

## 2. 测试分层与优先级

工程中的测试通常分为四层：

| 层级 | 示例 | 特点 |
| --- | --- | --- |
| 单元测试 | 协议字段解析、路径改写、哈希计算 | 快、确定、依赖少 |
| 模块测试 | Tracker 状态更新、Gateway 请求处理 | 可能有状态，但不启动完整系统 |
| 集成测试 | 真实数据库、模型、网络组件协作 | 较慢，依赖运行环境 |
| 端到端测试 | 启动服务并发送真实 HTTP 请求 | 最接近生产，定位成本也最高 |

推荐的数量关系不是硬性比例，但方向应当是：

```text
大量单元测试
    ↓
适量模块测试
    ↓
少量集成测试
    ↓
极少量端到端测试
```

优先测试这些代码：

- 输入边界明确的纯函数；
- 协议、配置和文本解析；
- 状态转换；
- 错误码和返回值映射；
- 曾经出现过缺陷的路径；
- 修改频繁且影响范围大的核心逻辑。

不要优先测试：

- 第三方库已经充分测试的内部行为；
- 只有简单 getter/setter 的数据类；
- 私有实现步骤；
- 很容易变化、但业务价值很低的调用顺序。

---

## 3. 一个完整、可运行的最小工程

下面用二进制输入包编解码作为主线。它具备几个适合测试的特征：

- 正常输入可以做 round-trip；
- 非法 magic、版本、长度需要拒绝；
- 字段存在边界；
- 实现不依赖网络和数据库；
- 测试运行速度快。

### 3.1 目录结构

```text
cpp-test-lab/
├── CMakeLists.txt
├── include/
│   └── lab/
│       ├── gateway_service.h
│       └── packet_codec.h
├── src/
│   ├── gateway_service.cpp
│   └── packet_codec.cpp
└── tests/
    ├── CMakeLists.txt
    ├── test_gateway_service.cpp
    └── test_packet_codec.cpp
```

这个示例使用 C++20 和 CMake 3.20，并把 GoogleTest 固定为 `v1.17.0`，避免构建结果随上游分支变化。GoogleTest 1.17.0 本身至少要求 C++17；如果项目仍停留在 C++11 或 C++14，需要根据编译器支持情况选用兼容版本，并结合对应版本文档验证。

### 3.2 顶层 `CMakeLists.txt`

```cmake
cmake_minimum_required(VERSION 3.20)

project(cpp_test_lab
    VERSION 1.0.0
    LANGUAGES CXX
)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(lab_core
    src/gateway_service.cpp
    src/packet_codec.cpp
)

target_include_directories(lab_core
    PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_compile_features(lab_core PUBLIC cxx_std_20)

# 提供 BUILD_TESTING 选项，并在开启时调用 enable_testing()。
include(CTest)

if(BUILD_TESTING)
    add_subdirectory(tests)
endif()
```

几个关键点：

1. `lab_core` 是业务库，应用程序和测试程序都可以链接它。
2. `PUBLIC` 头文件目录会传递给链接 `lab_core` 的目标。
3. `include(CTest)` 会提供 `BUILD_TESTING` 选项，通常默认开启。
4. 不构建测试时可以显式传入 `-DBUILD_TESTING=OFF`。

不要同时无意义地写：

```cmake
include(CTest)
enable_testing()
```

`include(CTest)` 在 `BUILD_TESTING=ON` 时已经会启用测试。只有不使用 `CTest` 模块时，才需要自己直接调用 `enable_testing()`。

---

## 4. 引入 GoogleTest

常用方式有三种：

| 方式 | 适合场景 | 特点 |
| --- | --- | --- |
| `FetchContent` | 学习、小型项目、CI | 项目可自行下载固定版本 |
| `find_package(GTest CONFIG REQUIRED)` | vcpkg、Conan、系统包 | 依赖由外部包管理器提供 |
| 源码子目录 | 已把依赖纳入仓库 | 离线稳定，但需要维护依赖源码 |

一个项目选择一种即可，不要混用。

### 4.1 `FetchContent` 方式

`tests/CMakeLists.txt`：

```cmake
include(FetchContent)

FetchContent_Declare(
    googletest
    GIT_REPOSITORY https://github.com/google/googletest.git
    GIT_TAG v1.17.0
    GIT_SHALLOW TRUE
)

# Windows 使用共享 CRT 时可避免运行库不一致。
set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)

FetchContent_MakeAvailable(googletest)

add_executable(lab_unit_tests
    test_gateway_service.cpp
    test_packet_codec.cpp
)

target_link_libraries(lab_unit_tests
    PRIVATE
        lab_core
        GTest::gmock
        GTest::gtest_main
)

include(GoogleTest)

gtest_discover_tests(lab_unit_tests
    DISCOVERY_TIMEOUT 30
    PROPERTIES
        LABELS unit
        TIMEOUT 10
)
```

这里不需要自己写测试 `main()`，因为链接了 `GTest::gtest_main`。

如果测试程序需要自定义全局初始化，可以：

1. 自己提供 `main()`；
2. 链接 `GTest::gtest` 和 `GTest::gmock`；
3. 不再链接 `GTest::gtest_main`。

### 4.2 包管理器方式

如果 GoogleTest 已由 vcpkg、Conan 或系统包提供：

```cmake
find_package(GTest CONFIG REQUIRED)

add_executable(lab_unit_tests
    test_gateway_service.cpp
    test_packet_codec.cpp
)

target_link_libraries(lab_unit_tests
    PRIVATE
        lab_core
        GTest::gmock
        GTest::gtest_main
)

include(GoogleTest)
gtest_discover_tests(lab_unit_tests)
```

包管理器方式不应再写 `FetchContent_MakeAvailable(googletest)`，否则可能同时出现两套 GoogleTest target。

### 4.3 为什么固定版本

不推荐：

```cmake
GIT_TAG main
```

主分支随时可能变化，今天能构建不代表下周仍能构建。工程中应固定 tag 或 commit：

```cmake
GIT_TAG v1.17.0
```

升级依赖时单独修改版本、运行测试并提交，变化才是可审查的。

---

## 5. 被测模块：二进制协议编解码

### 5.1 协议格式

示例协议采用网络字节序，也就是大端序：

```text
偏移  大小  字段
0     2     magic："LB"
2     1     version：1
3     1     type：1，表示 InputPacket
4     4     seq
8     2     command count
10    N*7   commands
```

每个 command：

```text
大小  字段
4     tick
1     moveX，只允许 -1、0、1
1     moveY，只允许 -1、0、1
1     buttons
```

### 5.2 头文件

```cpp
// include/lab/packet_codec.h
#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <vector>

namespace lab::net {

struct InputCmd {
    std::uint32_t tick{};
    std::int8_t moveX{};
    std::int8_t moveY{};
    std::uint8_t buttons{};

    bool operator==(const InputCmd&) const = default;
};

struct InputPacket {
    std::uint32_t seq{};
    std::vector<InputCmd> commands;

    bool operator==(const InputPacket&) const = default;
};

inline constexpr std::size_t kMaxCommands = 64;

std::vector<std::uint8_t> encodeInput(const InputPacket& packet);
std::optional<InputPacket> decodeInput(
    std::span<const std::uint8_t> bytes);

} // namespace lab::net
```

`encodeInput()` 接收程序内部已经构造好的对象。对象不满足内部约束时抛出 `std::invalid_argument`。

`decodeInput()` 处理不可信的外部字节。解析失败是正常业务分支，因此返回 `std::nullopt`，不靠异常处理常见脏包。

### 5.3 实现

```cpp
// src/packet_codec.cpp
#include "lab/packet_codec.h"

#include <bit>
#include <stdexcept>

namespace lab::net {
namespace {

constexpr std::uint8_t kMagic0 = 'L';
constexpr std::uint8_t kMagic1 = 'B';
constexpr std::uint8_t kVersion = 1;
constexpr std::uint8_t kInputType = 1;
constexpr std::size_t kHeaderSize = 10;
constexpr std::size_t kCommandSize = 7;

bool validAxis(std::int8_t value) {
    return value >= -1 && value <= 1;
}

void appendU16(std::vector<std::uint8_t>& out, std::uint16_t value) {
    out.push_back(static_cast<std::uint8_t>(value >> 8));
    out.push_back(static_cast<std::uint8_t>(value));
}

void appendU32(std::vector<std::uint8_t>& out, std::uint32_t value) {
    out.push_back(static_cast<std::uint8_t>(value >> 24));
    out.push_back(static_cast<std::uint8_t>(value >> 16));
    out.push_back(static_cast<std::uint8_t>(value >> 8));
    out.push_back(static_cast<std::uint8_t>(value));
}

std::uint16_t readU16(
    std::span<const std::uint8_t> bytes,
    std::size_t offset) {
    return static_cast<std::uint16_t>(
        (static_cast<std::uint16_t>(bytes[offset]) << 8) |
        static_cast<std::uint16_t>(bytes[offset + 1]));
}

std::uint32_t readU32(
    std::span<const std::uint8_t> bytes,
    std::size_t offset) {
    return (static_cast<std::uint32_t>(bytes[offset]) << 24) |
           (static_cast<std::uint32_t>(bytes[offset + 1]) << 16) |
           (static_cast<std::uint32_t>(bytes[offset + 2]) << 8) |
           static_cast<std::uint32_t>(bytes[offset + 3]);
}

} // namespace

std::vector<std::uint8_t> encodeInput(const InputPacket& packet) {
    if (packet.commands.size() > kMaxCommands) {
        throw std::invalid_argument("too many input commands");
    }

    for (const auto& command : packet.commands) {
        if (!validAxis(command.moveX) || !validAxis(command.moveY)) {
            throw std::invalid_argument("axis must be -1, 0 or 1");
        }
    }

    std::vector<std::uint8_t> out;
    out.reserve(kHeaderSize + packet.commands.size() * kCommandSize);

    out.push_back(kMagic0);
    out.push_back(kMagic1);
    out.push_back(kVersion);
    out.push_back(kInputType);
    appendU32(out, packet.seq);
    appendU16(
        out,
        static_cast<std::uint16_t>(packet.commands.size()));

    for (const auto& command : packet.commands) {
        appendU32(out, command.tick);
        out.push_back(std::bit_cast<std::uint8_t>(command.moveX));
        out.push_back(std::bit_cast<std::uint8_t>(command.moveY));
        out.push_back(command.buttons);
    }

    return out;
}

std::optional<InputPacket> decodeInput(
    std::span<const std::uint8_t> bytes) {
    if (bytes.size() < kHeaderSize) {
        return std::nullopt;
    }

    if (bytes[0] != kMagic0 ||
        bytes[1] != kMagic1 ||
        bytes[2] != kVersion ||
        bytes[3] != kInputType) {
        return std::nullopt;
    }

    const auto count = readU16(bytes, 8);
    if (count > kMaxCommands) {
        return std::nullopt;
    }

    const auto expectedSize =
        kHeaderSize + static_cast<std::size_t>(count) * kCommandSize;

    if (bytes.size() != expectedSize) {
        return std::nullopt;
    }

    InputPacket packet;
    packet.seq = readU32(bytes, 4);
    packet.commands.reserve(count);

    std::size_t offset = kHeaderSize;
    for (std::uint16_t i = 0; i < count; ++i) {
        InputCmd command;
        command.tick = readU32(bytes, offset);
        command.moveX =
            std::bit_cast<std::int8_t>(bytes[offset + 4]);
        command.moveY =
            std::bit_cast<std::int8_t>(bytes[offset + 5]);
        command.buttons = bytes[offset + 6];

        if (!validAxis(command.moveX) || !validAxis(command.moveY)) {
            return std::nullopt;
        }

        packet.commands.push_back(command);
        offset += kCommandSize;
    }

    return packet;
}

} // namespace lab::net
```

实现中的安全要点：

- 不把字节缓冲区直接 `reinterpret_cast` 成结构体，避免对齐、填充和字节序问题；
- 先验证总长度，再读取字段；
- 先限制 `count`，再计算和分配；
- 解析外部输入时，每个字段都重新验证；
- 使用明确的大端读写函数，不依赖宿主机器字节序。

---

## 6. 基础测试：正常路径和错误路径

`tests/test_packet_codec.cpp`：

```cpp
#include "lab/packet_codec.h"

#include <gtest/gtest.h>

#include <cstdint>
#include <stdexcept>
#include <vector>

namespace {

lab::net::InputPacket makePacket() {
    lab::net::InputPacket packet;
    packet.seq = 42;
    packet.commands = {
        {.tick = 100, .moveX = 1, .moveY = 0, .buttons = 1},
        {.tick = 101, .moveX = 0, .moveY = -1, .buttons = 0},
    };
    return packet;
}

TEST(PacketCodecTest, RoundTripsInputPacket) {
    const auto input = makePacket();

    const auto bytes = lab::net::encodeInput(input);
    const auto output = lab::net::decodeInput(bytes);

    ASSERT_TRUE(output.has_value());
    EXPECT_EQ(*output, input);
}

TEST(PacketCodecTest, EncodesHeaderInNetworkByteOrder) {
    lab::net::InputPacket packet;
    packet.seq = 0x01020304;

    const auto bytes = lab::net::encodeInput(packet);

    ASSERT_EQ(bytes.size(), 10U);
    EXPECT_EQ(bytes[0], static_cast<std::uint8_t>('L'));
    EXPECT_EQ(bytes[1], static_cast<std::uint8_t>('B'));
    EXPECT_EQ(bytes[2], 1U);
    EXPECT_EQ(bytes[3], 1U);
    EXPECT_EQ(bytes[4], 0x01U);
    EXPECT_EQ(bytes[5], 0x02U);
    EXPECT_EQ(bytes[6], 0x03U);
    EXPECT_EQ(bytes[7], 0x04U);
    EXPECT_EQ(bytes[8], 0U);
    EXPECT_EQ(bytes[9], 0U);
}

TEST(PacketCodecTest, RejectsEmptyBuffer) {
    const std::vector<std::uint8_t> bytes;
    EXPECT_FALSE(lab::net::decodeInput(bytes).has_value());
}

TEST(PacketCodecTest, RejectsBadMagic) {
    auto bytes = lab::net::encodeInput(makePacket());
    bytes[0] = 0;

    EXPECT_FALSE(lab::net::decodeInput(bytes).has_value());
}

TEST(PacketCodecTest, RejectsUnsupportedVersion) {
    auto bytes = lab::net::encodeInput(makePacket());
    bytes[2] = 2;

    EXPECT_FALSE(lab::net::decodeInput(bytes).has_value());
}

TEST(PacketCodecTest, RejectsTruncatedPacket) {
    auto bytes = lab::net::encodeInput(makePacket());
    bytes.pop_back();

    EXPECT_FALSE(lab::net::decodeInput(bytes).has_value());
}

TEST(PacketCodecTest, RejectsTrailingBytes) {
    auto bytes = lab::net::encodeInput(makePacket());
    bytes.push_back(0);

    EXPECT_FALSE(lab::net::decodeInput(bytes).has_value());
}

TEST(PacketCodecTest, RejectsInvalidAxisWhileEncoding) {
    auto packet = makePacket();
    packet.commands[0].moveX = 2;

    EXPECT_THROW(
        lab::net::encodeInput(packet),
        std::invalid_argument);
}

TEST(PacketCodecTest, RejectsTooManyCommands) {
    lab::net::InputPacket packet;
    packet.commands.resize(lab::net::kMaxCommands + 1);

    EXPECT_THROW(
        lab::net::encodeInput(packet),
        std::invalid_argument);
}

} // namespace
```

### 6.1 为什么先 `ASSERT_TRUE` 再解引用

下面的写法有风险：

```cpp
EXPECT_TRUE(output.has_value());
EXPECT_EQ(output->seq, 42U);
```

`EXPECT_TRUE` 失败后，测试仍会继续执行，随后解引用空的 `optional`。

应改成：

```cpp
ASSERT_TRUE(output.has_value());
EXPECT_EQ(output->seq, 42U);
```

`ASSERT_*` 失败会立即结束当前测试函数，适合保护后续断言的前置条件。

---

## 7. 常用断言

### 7.1 `EXPECT_*` 和 `ASSERT_*`

| 类型 | 失败后的行为 | 使用场景 |
| --- | --- | --- |
| `EXPECT_*` | 记录失败，继续当前测试 | 希望一次看到多个不相关字段的差异 |
| `ASSERT_*` | 记录失败，立即结束当前测试函数 | 后续代码依赖当前条件成立 |

示例：

```cpp
ASSERT_NE(ptr, nullptr);
EXPECT_EQ(ptr->status(), Status::Ready);
EXPECT_EQ(ptr->size(), 3U);
```

不要在返回值不是 `void` 的普通辅助函数中直接使用 `ASSERT_*`。Fatal assertion 的控制流是从当前函数返回，通常应把断言留在测试函数或返回 `void` 的测试辅助函数中。

### 7.2 常见比较

```cpp
EXPECT_TRUE(condition);
EXPECT_FALSE(condition);

EXPECT_EQ(actual, expected);
EXPECT_NE(actual, unexpected);
EXPECT_LT(actual, upper);
EXPECT_LE(actual, upper);
EXPECT_GT(actual, lower);
EXPECT_GE(actual, lower);

EXPECT_STREQ(actualCString, expectedCString);
EXPECT_STRNE(actualCString, unexpectedCString);

EXPECT_FLOAT_EQ(actualFloat, expectedFloat);
EXPECT_DOUBLE_EQ(actualDouble, expectedDouble);
EXPECT_NEAR(actual, expected, absoluteError);

EXPECT_THROW(call(), std::invalid_argument);
EXPECT_NO_THROW(call());
```

比较 `std::string`：

```cpp
EXPECT_EQ(actualString, "ok");
```

比较 C 字符串内容：

```cpp
EXPECT_STREQ(actualCString, "ok");
```

如果对两个 `const char*` 使用 `EXPECT_EQ`，比较的是指针地址，不是字符串内容。

### 7.3 Matcher

GoogleMock 的 matcher 不只用于 mock，也可以改善普通断言的表达力：

```cpp
#include <gmock/gmock.h>

using ::testing::ElementsAre;
using ::testing::HasSubstr;

EXPECT_THAT(values, ElementsAre(1, 2, 3));
EXPECT_THAT(errorMessage, HasSubstr("invalid version"));
```

对于容器，`EXPECT_THAT` 通常比手写循环更容易读，也能给出更清楚的失败信息。

### 7.4 给失败信息补上下文

```cpp
for (const auto& testCase : cases) {
    EXPECT_EQ(parse(testCase.input), testCase.expected)
        << "input = " << testCase.input;
}
```

断言后面的 `<<` 只在失败时输出，适合补充输入、索引和业务标识。

---

## 8. Fixture：共享测试准备逻辑

当多个测试需要相同的对象和初始化过程时，可以使用 `TEST_F`：

```cpp
class PacketCodecFixture : public ::testing::Test {
protected:
    void SetUp() override {
        packet_.seq = 42;
        packet_.commands.push_back(
            {.tick = 100, .moveX = 1, .moveY = 0, .buttons = 1});
    }

    lab::net::InputPacket packet_;
};

TEST_F(PacketCodecFixture, PreservesSequenceNumber) {
    const auto decoded =
        lab::net::decodeInput(lab::net::encodeInput(packet_));

    ASSERT_TRUE(decoded.has_value());
    EXPECT_EQ(decoded->seq, 42U);
}

TEST_F(PacketCodecFixture, PreservesCommandCount) {
    const auto decoded =
        lab::net::decodeInput(lab::net::encodeInput(packet_));

    ASSERT_TRUE(decoded.has_value());
    EXPECT_EQ(decoded->commands.size(), 1U);
}
```

Fixture 的生命周期：

```text
每个 TEST_F
  → 创建一个全新的 Fixture 对象
  → 调用 SetUp()
  → 执行测试体
  → 调用 TearDown()
  → 销毁 Fixture 对象
```

因此，一个测试修改 `packet_` 不会污染另一个测试。

如果准备逻辑只是一两行，普通辅助函数通常比 Fixture 更直接。Fixture 不应变成一个塞满所有测试数据的“万能基类”。

---

## 9. 参数化测试：同一规则覆盖多组输入

参数化测试适合：

- 边界值；
- 路径改写；
- 状态码映射；
- 协议字段组合；
- 多种等价输入；
- 同一接口的多种实现。

示例：验证所有合法移动方向都能 round-trip。

```cpp
#include "lab/packet_codec.h"

#include <gtest/gtest.h>

#include <cstdint>
#include <tuple>

class PacketAxisTest
    : public ::testing::TestWithParam<std::tuple<int, int>> {};

TEST_P(PacketAxisTest, RoundTripsValidAxisValues) {
    const auto [moveX, moveY] = GetParam();

    lab::net::InputPacket packet;
    packet.commands.push_back({
        .tick = 1,
        .moveX = static_cast<std::int8_t>(moveX),
        .moveY = static_cast<std::int8_t>(moveY),
        .buttons = 0,
    });

    const auto decoded =
        lab::net::decodeInput(lab::net::encodeInput(packet));

    ASSERT_TRUE(decoded.has_value());
    ASSERT_EQ(decoded->commands.size(), 1U);
    EXPECT_EQ(decoded->commands[0], packet.commands[0]);
}

INSTANTIATE_TEST_SUITE_P(
    ValidDirections,
    PacketAxisTest,
    ::testing::Values(
        std::tuple{-1, -1},
        std::tuple{-1, 0},
        std::tuple{-1, 1},
        std::tuple{0, -1},
        std::tuple{0, 0},
        std::tuple{0, 1},
        std::tuple{1, -1},
        std::tuple{1, 0},
        std::tuple{1, 1}));
```

不要把完全不同的业务场景硬塞进参数表。参数化测试应表达“同一规则，不同数据”，而不是为了减少 `TEST` 数量牺牲可读性。

---

## 10. Death Test

Death test 验证某段代码会让进程终止：

```cpp
#include <cassert>

int requirePositive(int value) {
    assert(value > 0);
    return value;
}

TEST(RequirePositiveDeathTest, DiesForZero) {
#ifndef NDEBUG
    EXPECT_DEATH(requirePositive(0), "");
#endif
}
```

适用范围：

- 内部不变量被破坏；
- 不可恢复的程序员错误；
- 明确要求进程终止的底层组件。

不适合：

- 用户输入校验；
- 网络脏包；
- 配置错误；
- 可以正常返回错误码的业务失败。

Release 构建可能定义 `NDEBUG` 并移除 `assert`，因此不要把基于 `assert` 的 death test 当成主要输入验证手段。

---

## 11. GoogleMock：隔离外部依赖

Mock 最适合数据库、Redis、HTTP Client、模型推理器、时钟等外部依赖。纯函数和普通值对象直接测试真实实现即可。

### 11.1 被测服务

```cpp
// include/lab/gateway_service.h
#pragma once

#include <string>
#include <string_view>

namespace lab::gateway {

class RateLimiter {
public:
    virtual ~RateLimiter() = default;
    virtual bool allow(std::string_view userId) = 0;
};

struct Response {
    int status{};
    std::string body;

    bool operator==(const Response&) const = default;
};

class GatewayService {
public:
    explicit GatewayService(RateLimiter& limiter);

    Response handle(std::string_view userId);

private:
    RateLimiter& limiter_;
};

} // namespace lab::gateway
```

```cpp
// src/gateway_service.cpp
#include "lab/gateway_service.h"

namespace lab::gateway {

GatewayService::GatewayService(RateLimiter& limiter)
    : limiter_(limiter) {}

Response GatewayService::handle(std::string_view userId) {
    if (!limiter_.allow(userId)) {
        return {.status = 429, .body = "rate limited"};
    }

    return {.status = 200, .body = "accepted"};
}

} // namespace lab::gateway
```

核心设计不是“为了 mock 多写一个接口”，而是让业务服务依赖一个明确的外部能力：

```text
GatewayService → RateLimiter 接口
                     ├─ 生产：RedisRateLimiter
                     └─ 测试：MockRateLimiter
```

### 11.2 Mock 和测试

`tests/test_gateway_service.cpp`：

```cpp
#include "lab/gateway_service.h"

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include <string_view>

namespace {

class MockRateLimiter : public lab::gateway::RateLimiter {
public:
    MOCK_METHOD(
        bool,
        allow,
        (std::string_view userId),
        (override));
};

TEST(GatewayServiceTest, RejectsRateLimitedUser) {
    MockRateLimiter limiter;
    lab::gateway::GatewayService service(limiter);

    EXPECT_CALL(limiter, allow("user-1"))
        .WillOnce(::testing::Return(false));

    const auto response = service.handle("user-1");

    EXPECT_EQ(response.status, 429);
    EXPECT_EQ(response.body, "rate limited");
}

TEST(GatewayServiceTest, AcceptsAllowedUser) {
    MockRateLimiter limiter;
    lab::gateway::GatewayService service(limiter);

    EXPECT_CALL(limiter, allow("user-2"))
        .WillOnce(::testing::Return(true));

    const auto response = service.handle("user-2");

    EXPECT_EQ(response.status, 200);
    EXPECT_EQ(response.body, "accepted");
}

} // namespace
```

### 11.3 `EXPECT_CALL` 的含义

```cpp
EXPECT_CALL(limiter, allow("user-1"))
    .Times(1)
    .WillOnce(::testing::Return(false));
```

表示：

```text
allow() 必须用 "user-1" 调用一次，并在这次调用中返回 false。
```

`.Times(1)` 在这里只有说明作用，因为单个 `WillOnce` 已经隐含一次调用。

常用写法：

```cpp
using ::testing::_;
using ::testing::AtLeast;
using ::testing::Return;

EXPECT_CALL(mock, read("config.json"))
    .WillOnce(Return("{}"));

EXPECT_CALL(mock, send(_))
    .Times(AtLeast(1));

EXPECT_CALL(mock, remove(_))
    .Times(0);
```

### 11.4 `ON_CALL` 和 `EXPECT_CALL`

```cpp
ON_CALL(mock, now())
    .WillByDefault(Return(fixedTime));
```

`ON_CALL` 只设置默认行为，不要求调用一定发生。

```cpp
EXPECT_CALL(mock, save(_))
    .Times(1);
```

`EXPECT_CALL` 同时定义行为约束，测试结束时会验证调用是否满足预期。

不要给每一个无关调用都写 `EXPECT_CALL`。过度验证内部调用顺序会让正常重构也导致测试失败。优先断言外部可观察结果，只对真正属于契约的交互设置期望。

### 11.5 Mock、Stub、Fake

| 类型 | 关注点 | 示例 |
| --- | --- | --- |
| Stub | 固定返回什么 | 文件读取始终返回某段配置 |
| Fake | 简化但可工作的实现 | 内存 Repository 替代 MySQL |
| Mock | 是否按约定交互 | 验证发送函数被调用一次 |

很多场景下，一个简单 Fake 比大量 `EXPECT_CALL` 更稳定。例如测试 Repository 上层业务时，内存实现通常比逐次模拟数据库调用更易维护。

---

## 12. `gtest_discover_tests()` 与 CTest

### 12.1 普通 `add_test`

```cmake
add_test(
    NAME lab_unit_tests
    COMMAND lab_unit_tests
)
```

CTest 只看到一个测试：

```text
lab_unit_tests
```

内部任何 GoogleTest case 失败，CTest 都只会把这个测试程序标记为失败。

### 12.2 自动发现

```cmake
include(GoogleTest)
gtest_discover_tests(lab_unit_tests)
```

CMake 会通过测试程序的 `--gtest_list_tests` 输出发现测试，包括参数化实例，并把它们分别注册给 CTest：

```text
PacketCodecTest.RoundTripsInputPacket
PacketCodecTest.RejectsBadMagic
GatewayServiceTest.RejectsRateLimitedUser
ValidDirections/PacketAxisTest.RoundTripsValidAxisValues/(-1,-1)
...
```

好处：

- CTest 能精确报告失败 case；
- 可以用正则筛选到测试套件或单个 case；
- 参数化测试实例也会被发现；
- 新增 GoogleTest case 后通常不需要重新修改 CMake 测试列表。

测试程序必须先成功构建并可运行，CTest 才能得到发现结果。交叉编译时还需要正确配置 `CROSSCOMPILING_EMULATOR`，或根据工程情况调整 discovery 策略。

### 12.3 什么时候使用 `gtest_add_tests`

`gtest_add_tests()` 在 CMake 配置阶段扫描测试源码，适合无法运行目标程序来完成发现的特殊环境。

常规本机构建优先使用：

```cmake
gtest_discover_tests()
```

它能识别参数化测试的真实实例，也不依赖简单的源码正则解析。

---

## 13. CTest 常用命令

### 13.1 构建并运行

```bash
cmake -S . -B build \
  -DCMAKE_BUILD_TYPE=Debug \
  -DBUILD_TESTING=ON

cmake --build build --parallel 2

ctest --test-dir build --output-on-failure
```

多配置生成器需要指定配置：

```bash
cmake --build build --config Debug --parallel 2
ctest --test-dir build -C Debug --output-on-failure
```

Visual Studio、Xcode 和部分 Ninja Multi-Config 工程属于多配置生成器。

### 13.2 查看测试列表

```bash
ctest --test-dir build -N
```

排查“为什么没有发现测试”时，先执行这条命令。

### 13.3 详细输出

```bash
ctest --test-dir build --verbose
```

更完整：

```bash
ctest --test-dir build --extra-verbose
```

日常回归通常使用 `--output-on-failure`，只有失败时打印详细日志，输出更干净。

### 13.4 按名称筛选

```bash
ctest --test-dir build \
  -R 'PacketCodecTest' \
  --output-on-failure
```

排除：

```bash
ctest --test-dir build \
  -E 'Integration|Slow' \
  --output-on-failure
```

`-R` 和 `-E` 使用正则表达式，匹配的是 CTest 中注册的测试名称。

### 13.5 按标签筛选

```bash
ctest --test-dir build -L unit --output-on-failure
ctest --test-dir build -L integration --output-on-failure
ctest --test-dir build -LE slow --output-on-failure
```

### 13.6 并行执行

```bash
ctest --test-dir build -j 4 --output-on-failure
```

只有相互独立的测试才能安全并行。多个测试如果共享固定端口、同一个数据库或同一个输出文件，需要隔离资源，或者暂时限制并行数量。

### 13.7 重复运行，排查偶现失败

```bash
ctest --test-dir build \
  --repeat until-fail:20 \
  -R 'ConcurrentQueueTest'
```

这个命令适合暴露不稳定测试，但不能代替 ThreadSanitizer 等并发检查工具。

### 13.8 只重跑上次失败项

```bash
ctest --test-dir build \
  --rerun-failed \
  --output-on-failure
```

---

## 14. 直接运行 GoogleTest 程序

CTest 适合工程级统一调度；直接运行测试二进制适合本地快速调试。

列出测试：

```bash
./build/tests/lab_unit_tests --gtest_list_tests
```

只运行一个 suite：

```bash
./build/tests/lab_unit_tests \
  --gtest_filter='PacketCodecTest.*'
```

运行一个 case：

```bash
./build/tests/lab_unit_tests \
  --gtest_filter='PacketCodecTest.RejectsBadMagic'
```

排除测试：

```bash
./build/tests/lab_unit_tests \
  --gtest_filter='*:-*DeathTest.*'
```

随机顺序：

```bash
./build/tests/lab_unit_tests \
  --gtest_shuffle \
  --gtest_repeat=20
```

CTest 的 `-R` 和 GoogleTest 的 `--gtest_filter` 不属于同一层：

```text
ctest -R              → 筛选 CTest 注册项
--gtest_filter        → 测试程序内部筛选 GoogleTest case
```

使用 `gtest_discover_tests()` 后，每个 case 已成为独立 CTest 项，通常优先用 `ctest -R`。

---

## 15. 标签、超时和集成测试

对 GoogleTest 自动发现的整组测试设置属性：

```cmake
gtest_discover_tests(lab_unit_tests
    PROPERTIES
        LABELS unit
        TIMEOUT 10
)
```

普通集成测试可以直接注册：

```cmake
add_executable(http_integration_test
    test_http_integration.cpp
)

target_link_libraries(http_integration_test
    PRIVATE
        lab_core
)

add_test(
    NAME integration.http
    COMMAND http_integration_test
)

set_tests_properties(integration.http
    PROPERTIES
        LABELS "integration;network"
        TIMEOUT 30
        WORKING_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}
)
```

建议：

- 单元测试默认短超时，例如 5～10 秒；
- 集成测试单独使用 `integration` 标签；
- 需要网络、模型或数据库的测试不要伪装成快速单元测试；
- 不要依赖调用者当前 shell 的工作目录；
- 测试产生的临时文件写入构建目录或独立临时目录，不污染源码目录。

---

## 16. 测试命名

推荐格式：

```text
被测对象 + 场景/条件 + 预期行为
```

示例：

```cpp
TEST(PacketCodecTest, RejectsBadMagic)
TEST(PacketCodecTest, RejectsTruncatedPacket)
TEST(GatewayServiceTest, RejectsRateLimitedUser)
TEST(RollbackTest, RestoresSnapshotThenReplaysInputs)
```

不推荐：

```cpp
TEST(Test1, Case1)
TEST(PacketTest, Normal)
TEST(GatewayTest, Works)
```

测试失败时，名称本身应尽量回答：

```text
什么对象，在什么情况下，没有表现出什么行为？
```

一个测试最好聚焦一个行为，但可以包含多个共同描述该行为的断言。例如返回响应时，同时检查 status 和 body 是合理的。

---

## 17. 测试数据和辅助函数

### 17.1 使用 Builder 或工厂函数提供默认对象

简单场景：

```cpp
InputPacket makeValidPacket() {
    return {
        .seq = 1,
        .commands = {
            {.tick = 10, .moveX = 0, .moveY = 0, .buttons = 0},
        },
    };
}
```

测试只覆盖与当前场景有关的字段：

```cpp
TEST(PacketCodecTest, RejectsInvalidHorizontalAxis) {
    auto packet = makeValidPacket();
    packet.commands[0].moveX = 2;

    EXPECT_THROW(encodeInput(packet), std::invalid_argument);
}
```

不要在每个测试中复制几十行无关初始化。

### 17.2 也不要隐藏关键输入

如果 Builder 让测试读者看不到关键条件，就失去意义。

不清楚：

```cpp
auto packet = makeCase(7);
```

更清楚：

```cpp
auto packet = makeValidPacket();
packet.commands[0].moveX = 2;
```

### 17.3 文件型测试数据

小文本优先直接写在测试中：

```cpp
const std::string config = R"(
port = 8080
timeout_ms = 500
)";
```

只有较大的二进制样本、图片或固定 corpus 才放进 `tests/data/`。路径应由 CMake 明确传入，不要假设测试总从项目根目录运行。

---

## 18. 常见错误与排查

### 18.1 CTest 显示 `No tests were found`

依次检查：

```bash
cmake -S . -B build -DBUILD_TESTING=ON
cmake --build build --parallel 2
ctest --test-dir build -N
```

再确认：

- 顶层调用了 `include(CTest)` 或 `enable_testing()`；
- `add_subdirectory(tests)` 实际执行了；
- `gtest_discover_tests()` 对应的 target 已成功构建；
- 没有在错误的 build 目录运行；
- 多配置生成器是否缺少 `-C Debug` 或 `-C Release`。

### 18.2 链接时出现重复 `main`

原因通常是：

```text
自己写了 main()
+ 又链接 GTest::gtest_main
```

二选一：

```cmake
# 不写 main()
target_link_libraries(test_target PRIVATE GTest::gtest_main)
```

或：

```cmake
# 自己写 main()
target_link_libraries(test_target PRIVATE GTest::gtest)
```

### 18.3 测试找不到业务头文件或符号

测试应链接业务 target：

```cmake
target_link_libraries(lab_unit_tests PRIVATE lab_core)
```

不要在测试 target 上重复抄写业务库的 include path 和源文件列表。target 之间的依赖关系应该由 `target_link_libraries` 表达。

### 18.4 `EXPECT_EQ` 比较浮点数失败

浮点计算不应默认做严格相等比较：

```cpp
EXPECT_NEAR(actual, expected, 1e-6);
```

容差应来自业务精度要求，不要随意写成一个巨大值来让测试通过。

### 18.5 测试偶尔失败

常见原因：

- 依赖真实时间；
- 依赖线程调度顺序；
- 使用固定端口；
- 多个测试写同一个文件；
- 依赖随机数但没有记录 seed；
- 依赖测试执行顺序；
- 调用真实网络服务。

处理方向：

- 注入 Clock；
- 使用独立临时目录；
- 使用系统分配的临时端口；
- 固定并打印随机 seed；
- 每个测试独立创建状态；
- 用 Fake 或 Mock 隔离外部系统。

不要用增加 `sleep()` 来“修复”竞态测试。

### 18.6 Mock 测试重构后频繁失败

如果业务结果没变，只是内部调用顺序变化，测试却大量失败，通常说明验证了过多实现细节。

优先保留：

- 业务返回值；
- 状态变化；
- 必须发生的关键外部副作用；
- 安全相关的禁止调用。

谨慎验证：

- 无关方法的精确调用次数；
- 内部步骤顺序；
- 可以自由重构的协作细节。

### 18.7 FetchContent 在离线环境失败

`FetchContent` 首次配置需要访问依赖仓库。离线或严格企业环境应使用：

- 包管理器的本地二进制缓存；
- 内部依赖镜像；
- 预下载源码；
- 项目已有的 vendored dependency。

不要让生产构建是否成功取决于一个不受控的远程主分支。

---

## 19. CI 示例

`.github/workflows/cpp-tests.yml`：

```yaml
name: cpp-tests

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Configure
        run: >
          cmake -S . -B build
          -DCMAKE_BUILD_TYPE=RelWithDebInfo
          -DBUILD_TESTING=ON

      - name: Build
        run: cmake --build build --parallel 2

      - name: Test
        run: >
          ctest --test-dir build
          --output-on-failure
          --timeout 30
```

CI 中至少验证：

```text
配置成功
→ 编译成功
→ 测试成功
```

后续确有需要时再增加独立任务：

- ASan + UBSan；
- TSan；
- 覆盖率；
- 集成测试；
- Fuzz regression corpus。

不要一开始把所有重型检查塞进同一个任务。快速单元测试应尽早给出结果，慢测试可以分开运行。

---

## 20. 项目中的测试清单

### 20.1 RAG Gateway

第一批，纯逻辑和低依赖模块：

- SSE 编码，多行 `data` 的处理；
- 路径重写；
- hop-by-hop header 过滤；
- API key 格式校验；
- request id 格式；
- 限流 key 生成；
- 错误码到 HTTP status 的映射；
- 上传文件扩展名和大小边界；
- 配置文本解析。

第二批，使用 Fake 或 Mock：

- Redis 返回允许、拒绝、超时；
- 上游 HTTP 返回 200、4xx、5xx、超时；
- LLM Client 返回正常流、空流、中途失败；
- Repository 查询成功、未找到、异常；
- Clock 固定在限流窗口边界。

少量集成测试：

- 启动真实 Gateway，发出一个 HTTP 请求；
- SSE 响应头和事件流格式；
- 测试环境中的 Redis 或数据库交互。

### 20.2 权威同步服务器

第一批：

- Packet encode/decode round-trip；
- magic、version、type 错误；
- 截断包和尾随字节；
- command 数量上限；
- tick/seq 回绕比较；
- InputBuffer 环形覆盖；
- StateHistory 读写；
- WorldSnapshot restore；
- hash 稳定性；
- rollback replay 后状态一致。

第二批：

- Fake Clock 驱动固定 tick；
- Mock Transport 模拟丢包、乱序、重复包；
- Fake Snapshot Store；
- 多客户端输入到达顺序。

专项工具：

- 协议解析配合 ASan、UBSan；
- 并发队列配合 TSan；
- 字节解析入口配合 libFuzzer。

### 20.3 YOLO / ByteTrack / 推理服务

不用 Mock 的部分：

- IoU；
- NMS；
- bbox 坐标变换；
- letterbox 前后映射；
- 模型输出后处理；
- Tracker 状态转换；
- 配置字段校验。

适合 Fake 或 Mock 的部分：

- 模型推理器返回固定 tensor；
- 文件读取器返回固定配置；
- Repository 返回固定检测记录；
- HTTP Client 返回固定响应。

真实模型推理更适合作为少量集成测试，不要让所有单元测试都加载大型模型文件。

---

## 21. 推荐实施顺序

不要一次性给整个项目补齐所有测试。按风险和收益推进：

### 第一阶段：建立最小闭环

```text
1. 把核心业务代码提取为 library
2. 引入 GoogleTest
3. 写 3～5 个纯逻辑测试
4. 使用 gtest_discover_tests()
5. 确保 ctest 一键通过
```

### 第二阶段：覆盖边界和历史缺陷

```text
1. 正常路径
2. 空输入
3. 最小值、最大值
4. 截断输入
5. 非法枚举和版本
6. 曾经修复过的 bug
```

每修复一个 bug，先补一个能复现它的测试，再修改实现。

### 第三阶段：隔离外部依赖

只对真正影响测试速度或稳定性的依赖引入接口、Fake 或 Mock：

```text
数据库
Redis
HTTP
模型
时间
随机数
```

### 第四阶段：接入 CI

把本地已稳定运行的命令原样放入 CI：

```bash
cmake -S . -B build -DBUILD_TESTING=ON
cmake --build build --parallel 2
ctest --test-dir build --output-on-failure
```

不要在 CI 中发明一套与本地完全不同的构建流程。

---

## 22. 测试代码审查清单

新增或修改测试时检查：

- [ ] 测试名称能描述场景和预期行为；
- [ ] 测试只依赖必要组件；
- [ ] 每个测试能独立运行；
- [ ] 不依赖执行顺序；
- [ ] 不依赖真实当前时间；
- [ ] 不使用固定共享端口或共享输出文件；
- [ ] 外部输入覆盖正常、空、边界和非法情况；
- [ ] `ASSERT_*` 用于保护后续操作；
- [ ] 浮点数使用合理容差；
- [ ] C 字符串使用内容比较；
- [ ] Mock 只验证契约相关交互；
- [ ] 测试失败信息足以定位问题；
- [ ] 新测试已被 `ctest -N` 发现；
- [ ] 最小测试命令可以稳定通过。

---

## 23. 一页总结

```text
业务代码：
    编译为 library，不把逻辑困在 main.cpp

GoogleTest：
    TEST      → 独立行为
    TEST_F    → 共享初始化
    TEST_P    → 同一规则的多组数据
    ASSERT_*  → 前置条件失败后停止
    EXPECT_*  → 记录失败并继续检查

GoogleMock：
    隔离数据库、网络、模型、时钟等外部依赖
    优先验证业务结果，谨慎验证内部调用细节

CMake：
    构建业务库和测试 executable
    include(CTest) 提供 BUILD_TESTING

CTest：
    gtest_discover_tests() 注册每个 GoogleTest case
    -R 按名称筛选
    -L 按标签筛选
    --output-on-failure 显示失败详情

CI：
    configure → build → ctest
```

最重要的三条原则：

1. 先让代码容易测试，再追求测试数量。
2. 测试外部可观察行为，不绑定无关实现细节。
3. 单元测试要快、稳定、独立，才能真正成为日常开发工具。

---

## 24. 官方参考

- GoogleTest Primer：<https://google.github.io/googletest/primer.html>
- GoogleTest Testing Reference：<https://google.github.io/googletest/reference/testing.html>
- GoogleTest Advanced Topics：<https://google.github.io/googletest/advanced.html>
- GoogleTest Assertions Reference：<https://google.github.io/googletest/reference/assertions.html>
- GoogleTest Matchers Reference：<https://google.github.io/googletest/reference/matchers.html>
- GoogleMock for Dummies：<https://google.github.io/googletest/gmock_for_dummies.html>
- GoogleMock Cookbook：<https://google.github.io/googletest/gmock_cook_book.html>
- CMake `CTest` 模块：<https://cmake.org/cmake/help/latest/module/CTest.html>
- CMake `GoogleTest` 模块：<https://cmake.org/cmake/help/latest/module/GoogleTest.html>
- CTest 命令手册：<https://cmake.org/cmake/help/latest/manual/ctest.1.html>
- GoogleTest Releases：<https://github.com/google/googletest/releases>
