---
title: "单元测试全绿，程序为什么仍会被一个脏包打崩？用 Sanitizer 与 Fuzz 找出 C++ 隐藏错误"
date: 2026-07-13 16:34:51
updated: 2026-07-13 16:34:51
categories:
  - "学习"
  - "Linux 与 C++ 工程化"
permalink: /notes/liunx-c-工程化/sanitizer-fuzz-实战/
series: "Linux 与 C++ 工程化"
---

一个 UDP 解码器通过了所有手写测试：合法包能解析，版本错误会拒绝，空包也处理了。上线后，它却被下面 7 个字节打崩：

```text
50 4b 01 ff ff ff ff
```

前两个字节是合法 magic，版本也是 `1`，但长度字段声称后面还有 4 GiB 左右的数据。如果解析器只验证包头、随后相信长度字段，越界访问就发生在“测试没有想到的输入”上。

这类错误需要两种工具合作：Sanitizer（运行时检查器）负责在错误真正发生时给出栈和错误类型；模糊测试（fuzz testing）负责持续制造开发者没有手写出来的输入。本文从一个最小越界开始，逐步写出安全的 C++20 二进制解析器，再用 libFuzzer 搜索反例，并把发现的崩溃固化成普通回归测试。

示例以 Clang/LLVM 的 ASan、UBSan、TSan 和 libFuzzer 为主，命令适用于支持这些运行时的 Linux 与 macOS 环境。Apple Clang、上游 Clang、GCC、不同操作系统和架构的支持范围并不完全相同；执行前应以本机 `clang++ --version` 和对应编译器文档为准。Sanitizer 二进制用于测试，不应直接作为生产发布物。

## 1. 为什么普通单元测试没有发现这个问题？

单元测试只能执行已经提供的样例。下面三条都通过，只能证明这三条路径符合断言：

```text
合法最小包 → 解码成功
空输入     → 拒绝
错误 magic → 拒绝
```

它没有证明长度为 `0xffff`、包头被截断、尾部多一个字节，或者多个字段组合异常时仍然安全。C++ 中的越界访问、释放后使用（use-after-free）、有符号整数溢出和数据竞争还属于未定义行为（undefined behavior，UB）：程序可能崩溃，也可能看似正常，甚至换一个优化级别才出错。

三类测试回答的是不同问题：

| 手段 | 它回答的问题 | 它不能替代什么 |
| --- | --- | --- |
| 单元测试 | 已知输入的业务结果是否正确？ | 不会自动发明边界输入 |
| Sanitizer | 本次执行是否触发特定内存错误、UB 或数据竞争？ | 没走到的路径不会被检查 |
| Fuzz | 能否自动变异输入并探索更多执行路径？ | 没有断言或 Sanitizer 时，错误结果可能被忽略 |

所以闭环不是“三选一”，而是：

```text
单元测试提供业务不变量和合法种子
             ↓
libFuzzer 生成新输入并扩大覆盖
             ↓
ASan / UBSan 在执行路径上捕获错误
             ↓
最小化 crash → 修复 → 固化回归测试
```

最值得 fuzz 的通常是信任边界：UDP/TCP 二进制协议、SSE/HTTP 文本解析、配置文件、图片或压缩文件解码，以及任何接收外部字节流的接口。

---

## 2. Sanitizer 类型

| 工具 | 主要发现什么 | 重要边界 |
| --- | --- | --- |
| ASan | 堆/栈/全局越界、use-after-free、非法释放 | 只检查实际执行且被插桩的代码，不能证明“没有内存错误” |
| UBSan | 错误对齐、非法移位、有符号溢出等 UB | 默认部分检查报告后继续运行，CI 应明确失败策略 |
| TSan | 缺少 happens-before 关系的数据竞争 | 开销大，需要单独构建；非插桩依赖可能造成漏报或干扰 |
| LSan | 进程退出时仍可达不到的内存泄漏 | 常与 ASan 集成，支持与默认行为存在平台差异 |
| MSan | 使用未初始化内存 | 通常要求依赖库也被插桩，搭建成本明显更高 |

常用组合：

```text
本地/CI 快速检查：ASan + UBSan
并发代码专项：TSan
协议解析专项：libFuzzer + ASan + UBSan
```

ASan 与 UBSan 常组合使用。ASan 和 TSan 不能作为一个普通组合塞进同一个 binary，应建立两套构建。LSan 在 Linux 上通常随 ASan 默认启用；macOS 可通过 `ASAN_OPTIONS=detect_leaks=1` 尝试启用，其他平台需要结合编译器文档验证。

---

## 3. CMake 里加 Sanitizer

推荐按 target 添加，并在配置阶段直接拒绝互斥组合。下面要求 CMake 3.13+，因为使用了 `target_link_options`：

```cmake
# cmake/Sanitizers.cmake
option(ENABLE_ASAN "Enable AddressSanitizer" OFF)
option(ENABLE_UBSAN "Enable UndefinedBehaviorSanitizer" OFF)
option(ENABLE_TSAN "Enable ThreadSanitizer" OFF)

if(ENABLE_ASAN AND ENABLE_TSAN)
    message(FATAL_ERROR "ASan and TSan require separate builds")
endif()

function(enable_sanitizers target)
    if(NOT TARGET "${target}")
        message(FATAL_ERROR "unknown target: ${target}")
    endif()

    if(NOT CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
        message(WARNING "skip sanitizers for ${CMAKE_CXX_COMPILER_ID}")
        return()
    endif()

    set(SANITIZERS "")

    if(ENABLE_ASAN)
        list(APPEND SANITIZERS "address")
    endif()

    if(ENABLE_UBSAN)
        list(APPEND SANITIZERS "undefined")
    endif()

    if(ENABLE_TSAN)
        list(APPEND SANITIZERS "thread")
    endif()

    if(SANITIZERS)
        list(JOIN SANITIZERS "," SANITIZER_FLAGS)
        target_compile_options(${target} PRIVATE
            "-fsanitize=${SANITIZER_FLAGS}"
            -fno-omit-frame-pointer
        )
        target_link_options(${target} PRIVATE
            "-fsanitize=${SANITIZER_FLAGS}"
        )
    endif()
endfunction()
```

使用：

```cmake
include(cmake/Sanitizers.cmake)

add_executable(test_packet_codec tests/test_packet_codec.cpp)
target_link_libraries(test_packet_codec PRIVATE lab_core GTest::gtest_main)

# 被测库本身也要插桩；只给测试可执行文件加 flag 会漏掉库内检查。
enable_sanitizers(lab_core)
enable_sanitizers(test_packet_codec)
```

配置：

```bash
cmake -S . -B build-asan \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DENABLE_ASAN=ON \
  -DENABLE_UBSAN=ON

cmake --build build-asan -j2
ctest --test-dir build-asan --output-on-failure
```

TSan 单独一套：

```bash
cmake -S . -B build-tsan \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DENABLE_TSAN=ON

cmake --build build-tsan -j2
ctest --test-dir build-tsan --output-on-failure
```

`RelWithDebInfo` 保留调试信息并启用优化，更接近真实代码路径。官方建议至少使用 `-O1` 并保留 frame pointer 以改善报告；不要在函数里强塞 `-O1` 覆盖项目自己的构建类型。编译和最终链接都必须带相同的 `-fsanitize`，最终链接应由编译器驱动完成，而不是直接调用 `ld`。

---

## 4. ASan 如何把一次越界还原成可定位的证据？

下面是故意保留的错误示例 `bad.cpp`：

```cpp
#include <vector>

int main() {
    std::vector<int> xs{1, 2, 3};
    return xs[3];
}
```

编译：

```bash
clang++ -std=c++20 -g -O1 -fno-omit-frame-pointer \
  -fsanitize=address bad.cpp -o bad
./bad
```

ASan 会以非零状态退出，并报告 `heap-buffer-overflow`。报告中最有用的不是最后一行摘要，而是三组栈：越界发生在哪里、目标内存最初在哪里分配，以及它是否已经被释放。先修第一条报告再重跑，因为内存破坏后继续执行得到的后续症状可能没有意义。

如果报告只有地址没有文件行号，检查二进制是否包含 `-g`，并确保 `llvm-symbolizer` 在 `PATH` 或通过 `ASAN_SYMBOLIZER_PATH` 指定。macOS 上必要时对二进制运行 `dsymutil`。

## 5. 为什么有符号溢出不能当作“自然回绕”？

下面的代码不是可靠地返回 `INT_MIN`，而是触发 C++ 有符号整数溢出 UB：

```cpp
#include <climits>

int main() {
    int x = INT_MAX;
    return x + 1;
}
```

编译：

```bash
clang++ -std=c++20 -g -O1 -fno-omit-frame-pointer \
  -fsanitize=undefined -fno-sanitize-recover=undefined \
  ub.cpp -o ub
./ub
```

UBSan 会报告 `signed integer overflow` 并立即失败。`-fno-sanitize-recover=undefined` 把默认可能继续运行的检查改为终止，更适合 CI；也可以通过 `UBSAN_OPTIONS=halt_on_error=1` 配置运行时行为。

协议代码里常见 UB：

- `offset + len` 先回绕，随后绕过边界检查
- 非对齐地址强转成结构体指针
- enum 值非法
- 左移超过位宽

## 6. 最终 counter 偶尔正确，为什么仍然是数据竞争？

两个线程同时执行非原子的读—改—写，即使某次恰好打印正确结果，程序仍然有数据竞争：

```cpp
#include <thread>

int counter = 0;

void add() {
    for (int i = 0; i < 100000; ++i) {
        counter++;
    }
}

int main() {
    std::thread t1(add);
    std::thread t2(add);
    t1.join();
    t2.join();
    return counter == 200000 ? 0 : 1;
}
```

编译：

```bash
clang++ -std=c++20 -g -O1 -fsanitize=thread race.cpp -o race
./race
```

TSan 会报告两个冲突访问及线程创建位置。这里的状态只是独立计数器，可以用原子操作修复；完整版本如下：

```cpp
#include <atomic>
#include <thread>

std::atomic<int> counter{0};

void add() {
    for (int i = 0; i < 100000; ++i) {
        counter.fetch_add(1, std::memory_order_relaxed);
    }
}

int main() {
    std::thread t1(add);
    std::thread t2(add);
    t1.join();
    t2.join();
    return counter.load(std::memory_order_relaxed) == 200000 ? 0 : 1;
}
```

`memory_order_relaxed` 只保证 counter 的原子性，不建立它与其他业务数据之间的发布/获取关系。如果 counter 表示“另一块数据已经准备好”，就需要互斥锁或正确的 release/acquire 协议，不能照搬这个修复。

TSan 适合测：

- 日志队列
- 线程池
- 连接状态
- 共享缓存
- shutdown 流程

TSan 通常带来显著时间与内存开销，适合单独的并发测试构建。它也依赖代码插桩：第三方预编译库中的访问可能无法完整观察，因此“TSan 没报告”仍不是无竞争证明。

---

## 7. 协议解析为什么要 Fuzz

手写协议解析器最怕：

```text
收到一个你没想到的包。
```

例如：

- 空包
- 只有 magic 没有 body
- length 比实际大
- cmd_count 非常大
- type 是未知值
- version 不兼容
- 字段值越界
- 随机字节刚好绕过部分校验

单元测试只能覆盖你想到的输入。Fuzz 会持续生成你没想到的输入。

---

## 8. 如何写出一个能承受任意输入的最小解析器？

假设协议格式固定为：

```text
magic[2] | version[1] | payload_length[4, big-endian] | payload[N]
```

存在隐患的写法是把网络字节直接解释成 C++ 结构体：

```cpp
auto* packet = reinterpret_cast<const InputPacket*>(bytes.data());
```

它同时引入了对齐、对象生命周期、大小端、padding、长度校验和 ABI 稳定性问题。即使本机 x86 看起来能运行，换编译器、优化级别或架构后也可能触发 UB。网络协议描述的是字节，不是某个编译器恰好生成的结构体布局。

下面给出完整的 `packet_parser.hpp`。关键不是“每次先算 `offset + n`”，因为加法本身可能回绕；而是在始终满足 `offset_ <= size` 的前提下检查 `n > size - offset_`。

```cpp
#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <vector>

struct Packet {
    std::uint8_t version{};
    std::vector<std::uint8_t> payload;
};

class Reader {
public:
    explicit Reader(std::span<const std::uint8_t> bytes)
        : bytes_(bytes) {}

    std::optional<std::uint8_t> u8() {
        const auto part = take(1);
        if (!part) {
            return std::nullopt;
        }
        return (*part)[0];
    }

    std::optional<std::uint32_t> u32be() {
        const auto part = take(4);
        if (!part) {
            return std::nullopt;
        }
        return (std::uint32_t((*part)[0]) << 24) |
               (std::uint32_t((*part)[1]) << 16) |
               (std::uint32_t((*part)[2]) << 8) |
               std::uint32_t((*part)[3]);
    }

    std::optional<std::span<const std::uint8_t>> take(std::size_t n) {
        if (n > bytes_.size() - offset_) {
            return std::nullopt;
        }
        const auto result = bytes_.subspan(offset_, n);
        offset_ += n;
        return result;
    }

    bool done() const {
        return offset_ == bytes_.size();
    }

private:
    std::span<const std::uint8_t> bytes_;
    std::size_t offset_{0};
};

inline std::optional<Packet> decodePacket(
    std::span<const std::uint8_t> bytes) {
    constexpr std::uint32_t kMaxPayloadSize = 64 * 1024;
    Reader reader(bytes);

    const auto magic0 = reader.u8();
    const auto magic1 = reader.u8();
    const auto version = reader.u8();
    const auto payload_size = reader.u32be();

    if (!magic0 || !magic1 || !version || !payload_size) {
        return std::nullopt;
    }
    if (*magic0 != 'P' || *magic1 != 'K' || *version != 1) {
        return std::nullopt;
    }
    if (*payload_size > kMaxPayloadSize) {
        return std::nullopt;
    }

    const auto payload = reader.take(*payload_size);
    if (!payload || !reader.done()) {
        return std::nullopt;
    }

    return Packet{
        *version,
        std::vector<std::uint8_t>(payload->begin(), payload->end())
    };
}
```

配套的最小程序 `packet_demo.cpp`：

```cpp
#include "packet_parser.hpp"

#include <array>
#include <iostream>

int main() {
    const std::array<std::uint8_t, 10> valid{
        'P', 'K', 1, 0, 0, 0, 3, 'A', 'B', 'C'
    };
    const std::array<std::uint8_t, 7> truncated{
        'P', 'K', 1, 0xff, 0xff, 0xff, 0xff
    };

    const auto packet = decodePacket(valid);
    if (!packet) {
        std::cerr << "valid packet was rejected\n";
        return 1;
    }
    std::cout << "payload size: " << packet->payload.size() << '\n';
    std::cout << "truncated accepted: "
              << std::boolalpha << decodePacket(truncated).has_value()
              << '\n';
}
```

编译运行环境为 C++20：

```bash
clang++ -std=c++20 -O1 -g -Wall -Wextra -Wpedantic \
  -fsanitize=address,undefined -fno-omit-frame-pointer \
  packet_demo.cpp -o packet_demo
ASAN_OPTIONS=abort_on_error=1 \
UBSAN_OPTIONS=halt_on_error=1 ./packet_demo
```

预期输出：

```text
payload size: 3
truncated accepted: false
```

数据流非常直接：`Reader` 借用调用方的输入，不拥有内存；`take()` 先校验剩余长度，再移动游标；只有整个包验证完成，`decodePacket()` 才把 payload 复制进拥有内存的 `Packet`。如果业务允许尾随字段，应明确解析它们，而不是悄悄删除 `done()` 检查。

这个版本不会根据攻击者声明的长度预先分配巨大缓冲区，也不会在验证前访问 payload。`kMaxPayloadSize` 是业务资源上限，示例取 64 KiB；真实协议应根据传输层和业务约束确定，不能无限信任一个格式上合法的长度。不过，“Sanitizer 没报错”仍不等于协议语义正确，所以后面还要用不变量判断成功解码的对象是否合理。

---

## 9. libFuzzer 怎样把任意字节送进解析器？

Fuzz target 入口固定：

```cpp
extern "C" int LLVMFuzzerTestOneInput(
    const std::uint8_t* data,
    std::size_t size) {
    // feed data to parser
    return 0;
}
```

针对上面的 `decodePacket`，一个完整 harness 只做两件事：传入任意字节，并验证成功结果的不变量。

```cpp
// fuzz/fuzz_packet_decode.cpp
#include "packet_parser.hpp"

#include <cstddef>
#include <cstdlib>
#include <cstdint>
#include <span>

extern "C" int LLVMFuzzerTestOneInput(
    const std::uint8_t* data,
    std::size_t size) {

    const std::span<const std::uint8_t> bytes(data, size);
    const auto packet = decodePacket(bytes);

    if (packet) {
        // 成功解码后，header 必须完整，payload 必须刚好占据余下输入。
        if (size < 7 || packet->version != 1 ||
            packet->payload.size() != size - 7) {
            std::abort();
        }
    }

    return 0;
}
```

错误输入返回 `nullopt` 是正常行为，harness 不应因此崩溃。`abort()` 只表达“解析器声称成功，但返回对象破坏了业务不变量”。真实协议还可以检查命令数量上限、枚举取值、坐标范围，或执行 `decode(encode(packet))` 这样的往返性质。

Fuzz target 必须确定、快速、无外部副作用。不要依赖当前时间、网络、随机设备和共享可变全局状态，也不要把每轮输入写到磁盘。否则相同输入可能无法复现，执行速度也会低到难以探索深层路径。

---

## 10. 为什么只给 fuzz 可执行文件加 flag 仍然不够？

```cmake
option(ENABLE_FUZZING "Enable fuzz targets" OFF)

if(ENABLE_FUZZING)
    if(NOT CMAKE_CXX_COMPILER_ID MATCHES "Clang")
        message(FATAL_ERROR "libFuzzer target requires Clang")
    endif()

    add_executable(fuzz_packet_decode
        fuzz/fuzz_packet_decode.cpp
    )

    target_compile_features(fuzz_packet_decode PRIVATE cxx_std_20)
    target_include_directories(fuzz_packet_decode PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}
    )
    target_compile_options(fuzz_packet_decode PRIVATE
        -fsanitize=fuzzer,address,undefined
        -fno-omit-frame-pointer
    )
    target_link_options(fuzz_packet_decode PRIVATE
        -fsanitize=fuzzer,address,undefined
    )
endif()
```

这里的解析器位于 header 中，会随 harness 一起插桩。如果真实解析实现位于 `lab_core` 中，则需要链接该库，而且只插桩 harness 会让 libFuzzer 看不到库内覆盖变化，ASan/UBSan 对库内代码的检查也不完整。专用 fuzz 构建中，应额外配置：

```cmake
target_link_libraries(fuzz_packet_decode PRIVATE lab_core)
target_compile_options(lab_core PRIVATE
    -fsanitize=fuzzer-no-link,address,undefined
    -fno-omit-frame-pointer
)
```

`fuzzer-no-link` 只加入覆盖引导插桩，不为库提供 `main()`；最终 fuzz 可执行文件仍用 `-fsanitize=fuzzer,address,undefined` 完成链接。不要把这组 flag 带进普通生产构建。

构建：

```bash
cmake -S . -B build-fuzz \
  -DCMAKE_CXX_COMPILER=clang++ \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DENABLE_FUZZING=ON

cmake --build build-fuzz -j2
```

运行：

```bash
mkdir -p corpus/packet artifacts/packet
./build-fuzz/fuzz_packet_decode corpus/packet \
  -artifact_prefix=artifacts/packet/ \
  -max_total_time=30 -print_final_stats=1
```

`artifact_prefix` 指向的目录必须预先存在，所以上面的命令先执行了 `mkdir -p`。把 corpus 和 crash artifact 分开：corpus 保存能增加覆盖率的输入，artifact 保存触发错误的输入，二者生命周期不同。

如果发现崩溃，会生成类似：

```text
crash-7a8dc398...
```

把 crash 输入加入回归测试。

---

## 11. 种子语料

不要只让 fuzzer 从空输入开始。可以放一些合法包作为种子：

```bash
mkdir -p corpus/packet
cp tests/corpus/input_valid_min.bin corpus/packet/
cp tests/corpus/input_valid_full.bin corpus/packet/
cp tests/corpus/input_bad_magic.bin corpus/packet/
```

合法种子能帮助 fuzzer 先通过 magic、版本和长度检查，再变异 payload；错误种子则能覆盖拒绝路径。语料应尽量小且不重复，数量多并不等于覆盖高。

可以写一个小工具生成种子：

```cpp
// tools/write_packet_seed.cpp
#include <array>
#include <cstdint>
#include <fstream>
#include <iostream>

int main() {
    const std::array<std::uint8_t, 10> bytes{
        'P', 'K', 1, 0, 0, 0, 3, 'A', 'B', 'C'
    };

    std::ofstream out("input_valid_min.bin", std::ios::binary);
    out.write(
        reinterpret_cast<const char*>(bytes.data()),
        static_cast<std::streamsize>(bytes.size())
    );
    if (!out) {
        std::cerr << "failed to write seed\n";
        return 1;
    }
}
```

生成器应调用生产编码器时，可以顺便建立 `decode(encode(x)) == x` 的性质测试；这里手写字节只是为了让最小协议示例保持独立。

---

## 12. Fuzzer 找到 crash 后，修完为什么还不算结束？

假设 fuzzer 生成了 `artifacts/packet/crash-abc`，第一步是单独重放，确认同一个输入稳定触发同一问题：

```bash
./build-fuzz/fuzz_packet_decode artifacts/packet/crash-abc
```

输入过大时，让 libFuzzer 在有限时间内最小化它：

```bash
./build-fuzz/fuzz_packet_decode \
  -minimize_crash=1 -max_total_time=30 \
  -exact_artifact_path=artifacts/packet/crash-abc-min \
  artifacts/packet/crash-abc
```

最小输入更容易看出根因，也更适合代码评审。修复后再次重放，它必须正常退出；随后把这个反例加入普通回归测试。若协议语义规定该输入非法，就断言拒绝：

加入测试：

```cpp
#include "packet_parser.hpp"

#include <array>
#include <cstdint>
#include <gtest/gtest.h>

TEST(PacketCodecRegressionTest, RejectsFuzzerCrashABC) {
    const std::array<std::uint8_t, 7> bytes = {
        'P', 'K', 1, 0xff, 0xff, 0xff, 0xff
    };

    EXPECT_FALSE(decodePacket(bytes).has_value());
}
```

如果输入其实合法，回归测试就应断言修复后的正确对象，而不是为了让测试通过而强制拒绝。小 artifact 直接嵌入测试可避免工作目录差异；较大二进制可以存入 `tests/corpus/regression/`，但测试必须通过源码目录配置定位，并检查文件打开失败，不能依赖 CTest 当前目录。

crash 回归测试同时保留在 ASan/UBSan 构建中才有意义：普通执行“不再崩溃”并不能排除仍然发生但暂未显现的 UB。

---

## 13. Fuzz SSE parser

如果你写了 SSE parser，也可以 fuzz：

```cpp
// fuzz/fuzz_sse_parse.cpp
#include "lab/sse/SseParser.h"

#include <cstddef>
#include <cstdint>
#include <span>
#include <string_view>

extern "C" int LLVMFuzzerTestOneInput(
    const std::uint8_t* data,
    std::size_t size) {

    std::string_view text(
        reinterpret_cast<const char*>(data),
        size);

    auto events = lab::sse::parse(text);

    for (const auto& ev : events) {
        if (ev.event.size() > 128) {
            __builtin_trap();
        }
        if (ev.data.size() > 1024 * 1024) {
            __builtin_trap();
        }
    }

    return 0;
}
```

SSE parser 应该能接受：

- 空字符串
- 只有换行
- 只有 `data:`
- 超长行
- 多个事件
- 非 UTF-8 字节

这里“接受任意输入”指解析器必须安全返回，并不表示每组字节都要被当作合法 SSE。若协议层要求 UTF-8，解析器可以明确拒绝非法编码，但不能越界、无限循环或无上限分配内存。

---

## 14. CI 里怎样兼顾确定性回归与短时探索？

CI 里不能无限 fuzz，可以跑短时间 smoke fuzz：

```cmake
if(ENABLE_FUZZING)
    add_test(
        NAME fuzz_packet_decode_corpus
        COMMAND fuzz_packet_decode
                ${CMAKE_SOURCE_DIR}/tests/corpus/packet
                -runs=1
    )
    add_test(
        NAME fuzz_packet_decode_smoke
        COMMAND fuzz_packet_decode
                ${CMAKE_SOURCE_DIR}/tests/corpus/packet
                -max_total_time=10
                -print_final_stats=1
    )
    set_tests_properties(fuzz_packet_decode_corpus
        PROPERTIES LABELS "fuzz")
    set_tests_properties(fuzz_packet_decode_smoke
        PROPERTIES LABELS "fuzz;slow")
endif()
```

`-runs=1` 会执行已有 corpus，是可重复的回归门禁；10 秒随机探索能否发现新路径则受随机种子和机器速度影响，适合作为补充，不能替代前者。长期 fuzz 应放到独立任务中保存新增 corpus 和 artifact，并设置时间、内存与输入长度上限。

本地长时间跑：

```bash
./build-fuzz/fuzz_packet_decode corpus/packet -max_total_time=600
```

CI 短时间跑：

```bash
ctest --test-dir build-fuzz -L fuzz --output-on-failure
```

---

## 15. Sanitizer 环境变量

CI 中常让首次错误直接终止，并保留符号化栈：

```bash
ASAN_OPTIONS=abort_on_error=1:symbolize=1 ./test_packet_codec
```

```bash
UBSAN_OPTIONS=print_stacktrace=1:halt_on_error=1 ./test_packet_codec
```

```bash
TSAN_OPTIONS=halt_on_error=1 ./test_thread_pool
```

LSan 在 Linux 上通常随 ASan 默认启用；macOS 可以按当前 Clang 文档使用 `ASAN_OPTIONS=detect_leaks=1`，其他平台不能假设相同行为。若符号化失败，先确认 `llvm-symbolizer` 可用；macOS 还可能需要 `dsymutil`。环境变量只是运行策略，不会给一个未插桩的普通二进制凭空增加检查能力。

---

## 16. Sanitizer 常见误区

### 16.1 误区：只加编译选项，不加链接选项

这样可能在最终链接时报缺少运行时符号，或得到不完整配置。正确做法是编译和最终链接都使用一致的 `-fsanitize`，并让编译器驱动完成链接。

### 16.2 误区：只有 Debug `-O0` 才适合查错

`-O0` 可以运行，但它可能避开只在优化路径出现的问题。更实用的起点是 `RelWithDebInfo`，至少 `-O1`、保留 `-g` 和 frame pointer，再根据报告调整内联或尾调用优化。

### 16.3 误区：把 ASan、UBSan、TSan 全部混在一套构建里

ASan + UBSan 是常见组合，TSan 则应单独构建。配置阶段直接拒绝 ASan + TSan，比等到晦涩的编译或运行错误更可靠。

### 16.4 误区：Sanitizer 构建成功就代表代码安全

Sanitizer 只检查真正执行的路径，被测库若没有插桩还会进一步漏报。正确做法是结合边界测试、失败路径、真实语料和 fuzz，并观察覆盖率是否进入核心解析逻辑。

### 16.5 误区：TSan 报告偶尔出现，可以先忽略

数据竞争不是“偶尔算错一次”，而是 C++ 内存模型下的 UB。应先最小化并确认 happens-before 关系；只有确定来自无法修改的第三方代码时才使用窄范围 suppression，并记录原因和清理条件。

### 16.6 误区：Fuzzer 跑了一小时没崩，解析器就安全了

Fuzz 是搜索，不是穷举证明。结果受种子、字典、最大输入长度、执行速度和覆盖反馈影响。正确结论只能是“在记录的版本、配置、语料和时间预算内没有发现新问题”，不能写成绝对安全保证。

---

## 17. 一个项目怎样分阶段落地？

### 第一步：ASan + UBSan

先给纯函数、协议和状态类测试开启：

- `test_packet_codec`
- `test_sse_codec`
- `test_input_buffer`
- `test_state_history`
- `test_rollback`

### 第二步：TSan

给这些模块做专项测试：

- 线程池
- 异步日志
- 共享连接状态
- shutdown 流程

### 第三步：Fuzz

优先 fuzz：

- UDP packet decode
- SSE parser
- HTTP path rewrite / header parser
- config parser

### 第四步：把 crash 变成长期资产

每个 fuzz crash 都要记录编译器、Sanitizer、命令、随机种子和原始 artifact。最小化并修复后，把语义明确的反例加入 GoogleTest，把能增加覆盖的输入合并进 corpus。

## 18. 哪些场景适合，哪些场景不适合直接 fuzz？

Sanitizer 几乎适合所有能在测试环境运行的原生 C/C++ 代码，但高负载性能基准不能使用插桩后的耗时代表生产性能。TSan 尤其适合线程池、异步日志、共享缓存和 shutdown；它不适合作为低开销的生产监控器。

Fuzz 最适合“输入是字节或容易序列化、单轮执行快、结果有明确不变量”的模块，例如协议、文件格式、路径和配置解析。直接 fuzz 完整数据库服务、真实网络集群或依赖时钟的端到端流程通常效率很低。应先抽出纯解析核心，使用内存中的假依赖，再让少量集成测试覆盖外围系统。

涉及密码学、权限或业务授权时，fuzz 可以发现崩溃和部分性质违例，却不能替代安全设计评审、静态分析和形式化验证。工具的边界必须和它的价值一起说明。

## 19. 总结：让未知输入变成可重复的测试

开头的脏包之所以能越过单元测试，不是因为测试“完全没用”，而是因为手写样例、运行时检查和自动输入探索解决的是不同层面的问题：

1. ASan、UBSan 和 TSan 必须对实际被测代码插桩，并分别运行合适的测试路径。
2. 解析器应先验证边界与整数运算，再访问或分配数据；不要把网络字节强转成 C++ 结构体。
3. libFuzzer harness 要快速、确定、无副作用，并为成功结果声明业务不变量。
4. corpus、crash artifact 和普通回归测试承担不同职责，不能发现 crash 后修完即删。
5. “没有报告”只说明当前测试预算内没有观察到问题，不是安全证明。

最值得立刻执行的一步是：挑选一个暴露给外部输入的解码函数，为它建立 ASan + UBSan 构建和 10 秒 smoke fuzz，然后把第一个发现的反例完整走完“重放—最小化—修复—回归”闭环。

---

## 20. 参考

- AddressSanitizer：https://clang.llvm.org/docs/AddressSanitizer.html
- UndefinedBehaviorSanitizer：https://clang.llvm.org/docs/UndefinedBehaviorSanitizer.html
- ThreadSanitizer：https://clang.llvm.org/docs/ThreadSanitizer.html
- LeakSanitizer：https://clang.llvm.org/docs/LeakSanitizer.html
- libFuzzer：https://llvm.org/docs/LibFuzzer.html
- GoogleTest：https://google.github.io/googletest/
