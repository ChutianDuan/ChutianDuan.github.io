---
title: "客户端 `send` 两次，服务端为什么不一定 `recv` 两次？讲清 TCP 消息边界"
date: 2026-07-13 09:36:24
updated: 2026-07-13 09:36:24
categories:
  - "学习"
  - "现代 C++ 实践"
permalink: /notes/现代c-实践/09-网络服务基础-tcp粘包-线程模型与http-s/
series: "现代 C++ 实践"
series_order: 9
---

时间：2026/04/09

客户端连续发送两条消息：

```cpp
send(fd, "hello", 5, 0);
send(fd, "world", 5, 0);
```

服务端直觉上可能写两个 `recv`，期待第一次得到 `hello`、第二次得到 `world`。真实结果却可能是：一次收到 `helloworld`，先收到 `he` 再收到剩余字节，或者经过更多次读取才凑齐。

TCP 没有弄乱消息，它从来就不知道“消息”是什么。TCP 提供的是可靠、有序的字节流；两次 `send` 的调用边界不会成为接收端可见的协议边界。所谓“粘包”和“半包”，本质上都是应用层错误地把一次 socket 调用当成一条消息。

本文从这条误解出发，实现一个可增量解析的长度前缀拆包器，再把部分读写、连接关闭、线程模型以及 HTTP/TLS 的协议分层串起来。理解这些边界，比记住一组 socket API 更重要。

---

## 1. TCP 到底承诺了什么？

建立连接后，TCP 向应用提供一条双向字节流。在连接正常且没有发生错误的前提下，接收端看到的字节顺序与发送端写入顺序一致，但每次读取返回多少字节由内核缓冲、网络分段、调度和调用参数共同决定。

```text
发送端应用： [hello] [world]       两次 send
                    ↓
TCP 字节流：  h e l l o w o r l d   没有应用消息边界
                    ↓
接收端可能： [he] [lloworl] [d]     三次 recv
          或 [helloworld]            一次 recv
```

这意味着：

- 一次 `recv` 可能只得到消息的一部分；
- 一次 `recv` 可能同时包含多条消息；
- 返回缓冲区长度不代表消息刚好结束；
- 即使本机测试总是一发一收，上线后也不能依赖这种现象。

TCP 解决可靠传输、排序、重传和拥塞控制，应用层仍必须定义 framing，即怎样从连续字节中恢复消息边界。

## 2. 常见的消息边界方案怎样选择？

| 方案 | 示例 | 优点 | 需要处理的问题 |
| --- | --- | --- | --- |
| 固定长度 | 每条恰好 32 字节 | 解析简单 | 浪费空间，消息尺寸受限 |
| 分隔符 | `hello\nworld\n` | 文本协议直观 | 转义、最大行长、查找成本 |
| 长度前缀 | `[4 字节长度][payload]` | 支持二进制和变长消息 | 字节序、长度校验、缓冲累积 |
| 自描述协议 | HTTP 头、TLV 等 | 扩展能力强 | 解析状态更复杂 |

长度前缀是二进制协议的常用起点。本文约定头部为 4 字节无符号大端整数，表示后续 payload 字节数：

```text
0               4                          4 + length
│ payload length │          payload                │
└── big-endian ──┴─────────────────────────────────┘
```

选择 4 字节头不代表允许 4 GiB 消息。解析器必须设置远小于类型上限的业务最大帧长，否则攻击者只发送一个巨大长度就可能诱导服务端持续占用内存。

## 3. 为什么拆包器必须保留跨调用状态？

一次读取可能只收到 2 个头部字节，解析器此时既不能报错，也不能凭空补齐。它要把字节留在连接自己的输入缓冲区中，等下一次数据到达后继续。

解析循环通常是：

```text
recv 得到若干字节
       ↓
追加到连接输入缓冲
       ↓
头部够 4 字节吗？──否──> 等更多数据
       │是
       ↓
校验 payload 长度
       ↓
完整帧到齐了吗？──否──> 等更多数据
       │是
       ↓
取出一帧并继续循环（缓冲里可能还有下一帧）
```

因此，拆包器通常是每条连接的状态，不应让多个连接混用同一缓冲。线程模型改变时，这个所有权边界仍然成立。

## 4. 一个可运行的长度前缀拆包器

下面的 C++20 程序不依赖真实网络，而是把两帧编码到一条“模拟 TCP 字节流”中，再按任意位置分三次喂给解析器。这样可以稳定验证半个头部、完整帧和多帧累积，而不依赖操作系统恰好怎样切分 `recv`。

```cpp
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

class FrameDecoder {
public:
    static constexpr std::uint32_t max_frame_size = 1024 * 1024;

    void append(std::span<const std::byte> bytes) {
        buffer_.insert(buffer_.end(), bytes.begin(), bytes.end());
    }

    std::optional<std::vector<std::byte>> next_frame() {
        constexpr std::size_t header_size = 4;
        if (available() < header_size) {
            return std::nullopt;
        }

        const std::uint32_t length = read_u32_be(buffer_.data() + consumed_);
        if (length > max_frame_size) {
            throw std::runtime_error("frame exceeds configured limit");
        }

        const std::size_t frame_size = header_size + length;
        if (available() < frame_size) {
            return std::nullopt;
        }

        const auto payload_begin = buffer_.begin()
            + static_cast<std::ptrdiff_t>(consumed_ + header_size);
        std::vector<std::byte> payload(
            payload_begin,
            payload_begin + static_cast<std::ptrdiff_t>(length));

        consumed_ += frame_size;
        compact_if_needed();
        return payload;
    }

private:
    std::size_t available() const noexcept {
        return buffer_.size() - consumed_;
    }

    static std::uint32_t read_u32_be(const std::byte* data) noexcept {
        return (std::uint32_t(std::to_integer<unsigned char>(data[0])) << 24)
             | (std::uint32_t(std::to_integer<unsigned char>(data[1])) << 16)
             | (std::uint32_t(std::to_integer<unsigned char>(data[2])) << 8)
             |  std::uint32_t(std::to_integer<unsigned char>(data[3]));
    }

    void compact_if_needed() {
        if (consumed_ == buffer_.size()) {
            buffer_.clear();
            consumed_ = 0;
        } else if (consumed_ >= 4096 && consumed_ * 2 >= buffer_.size()) {
            buffer_.erase(
                buffer_.begin(),
                buffer_.begin() + static_cast<std::ptrdiff_t>(consumed_));
            consumed_ = 0;
        }
    }

    std::vector<std::byte> buffer_;
    std::size_t consumed_ = 0;
};

void append_u32_be(std::vector<std::byte>& output, std::uint32_t value) {
    output.push_back(std::byte((value >> 24) & 0xff));
    output.push_back(std::byte((value >> 16) & 0xff));
    output.push_back(std::byte((value >> 8) & 0xff));
    output.push_back(std::byte(value & 0xff));
}

void append_frame(std::vector<std::byte>& output, std::string_view text) {
    if (text.size() > FrameDecoder::max_frame_size) {
        throw std::invalid_argument("text is too large");
    }
    append_u32_be(output, static_cast<std::uint32_t>(text.size()));
    std::transform(text.begin(), text.end(), std::back_inserter(output),
                   [](char character) { return std::byte(character); });
}

std::string as_string(const std::vector<std::byte>& bytes) {
    std::string result;
    result.reserve(bytes.size());
    std::transform(bytes.begin(), bytes.end(), std::back_inserter(result),
                   [](std::byte value) {
                       return static_cast<char>(std::to_integer<unsigned char>(value));
                   });
    return result;
}

void print_available_frames(FrameDecoder& decoder) {
    while (auto frame = decoder.next_frame()) {
        std::cout << as_string(*frame) << '\n';
    }
}

int main() {
    std::vector<std::byte> wire;
    append_frame(wire, "hello");
    append_frame(wire, "world");

    FrameDecoder decoder;
    const std::span<const std::byte> stream(wire);

    decoder.append(stream.first(2));          // 半个头部
    print_available_frames(decoder);          // 没有完整帧

    decoder.append(stream.subspan(2, 7));     // 凑齐第一帧
    print_available_frames(decoder);          // 输出 hello

    decoder.append(stream.subspan(9));        // 第二帧一次到齐
    print_available_frames(decoder);          // 输出 world
}
```

编译运行：

```bash
clang++ -std=c++20 -O2 -Wall -Wextra -pedantic \
  frame_decoder.cpp -o frame_decoder
./frame_decoder
```

预期输出：

```text
hello
world
```

真正关键的是 `next_frame()` 的返回语义：`nullopt` 表示当前字节还不够，不等于连接或协议发生错误；长度超过限制才是协议错误。每次追加数据后要循环调用，因为一次读取可能包含多帧。

示例用 `consumed_` 移动读取位置，而不是每解析一帧就擦除 `vector` 开头。只有已消费前缀足够大时才压缩，避免连续多帧造成反复搬移。生产实现还可能使用环形缓冲或分段缓冲，并根据协议决定是否复制 payload。

## 5. 长度前缀还需要防御哪些输入？

“先读长度再分配”是网络边界上的不可信输入处理，至少要检查：

- 长度是否超过业务上限；
- 头部整数采用哪种字节序；
- 连接缓冲区是否有总量上限；
- 长期只发送半包的慢客户端怎样超时；
- 未知消息类型、版本和校验失败怎样关闭连接；
- 长度加头部大小是否可能整数溢出。

本文先把 `uint32_t` 长度限制在 1 MiB，再转换到 `size_t` 计算，所以常见 32/64 位平台上相加不会溢出。协议设计仍应明确 payload 是否允许为空、文本编码是什么、错误后能否继续同步到下一帧。

分隔符协议同样需要最大长度。如果攻击者永远不发送换行，无上限缓冲仍会不断增长。framing 方案不同，资源上限问题不会消失。

## 6. `recv` 和 `send` 的返回值应该怎样解释？

对阻塞 TCP socket，`recv` 常见结果是：

| 返回值 | 含义 | 典型处理 |
| --- | --- | --- |
| `> 0` | 本次读取的字节数 | 追加缓冲并循环拆包 |
| `0` | 对端已正常关闭发送方向 | 处理 EOF 和剩余协议状态 |
| `< 0` 且 `EINTR` | 被信号中断 | 通常重试 |
| `< 0` 其他错误 | 连接或调用失败 | 按错误码处理并清理连接 |

非阻塞 socket 还会用 `EAGAIN`/`EWOULDBLOCK` 表示“现在没有更多数据”，这不是连接失败。边沿触发事件循环通常持续读取到该状态为止。

`send` 即使成功也可能只接受部分字节。应用必须保留未发送部分，并在以后继续；阻塞式小示例可以循环 `send_all`，非阻塞服务则通常维护每连接输出缓冲，并在 socket 可写时推进偏移。

```text
业务帧 -> 序列化 -> 输出缓冲 -> send 部分成功
                               ↑
                     保存剩余偏移，等待可写
```

Unix-like 平台向已关闭连接写入还可能产生 `SIGPIPE`。可以使用平台支持的 socket 选项或发送标志处理，但 Linux 的 `MSG_NOSIGNAL` 与 macOS 的 `SO_NOSIGPIPE` 不同，代码必须说明平台条件，不能假设一个写法跨平台通用。

## 7. 建立和关闭连接时发生了什么？

服务端的监听 socket 与已连接 socket 职责不同：

```text
socket -> bind -> listen
                    ↓
                  accept -> connected socket -> recv/send
```

内核完成 TCP 握手后，`accept` 返回代表某个连接的新描述符；监听描述符继续接受其他连接。不要拿监听 socket 直接收发业务数据。

TCP 是全双工协议，两个方向可以独立关闭。`recv` 返回 0 表示对端不再发送，但本端仍可能有数据要写。`shutdown(fd, SHUT_WR)` 表达本端完成发送，`close(fd)` 则释放当前进程持有的描述符；若描述符被复制，底层 socket 生命周期还与其他引用有关。

三次握手、FIN/ACK 和 `TIME_WAIT` 是理解连接状态的重要背景，但应用代码仍应以系统调用返回值和明确的连接状态机为准。不要把一次 `close()` 想象成网络两端瞬间同时消失。

## 8. UDP 为什么没有 TCP 式“粘包”？

UDP 是数据报（datagram）协议，一次发送形成一份数据报，接收 API 保留报文边界。因此，它没有把连续字节重新切分成应用消息的问题。

但 UDP 不保证到达、顺序或唯一性。接收缓冲过小时，数据报可能被截断；IP 分片会提高整包丢失概率。应用若需要序号、确认、重传、去重、拥塞控制和连接迁移，就必须设计相应协议，或选择 TCP/QUIC 等已有传输方案。

| 需求 | TCP | UDP |
| --- | --- | --- |
| 字节可靠有序 | 提供 | 不提供 |
| 应用消息边界 | 不提供 | 保留数据报边界 |
| 拥塞控制 | 提供 | 应用需谨慎控制发送 |
| 丢弃旧状态以追求实时性 | 不自然 | 常见 |

实时游戏位置、音视频和“最新值覆盖旧值”可能适合 UDP；每条业务消息必须可靠有序时，自己在 UDP 上重造可靠传输往往比预想复杂。

## 9. 每连接一个线程为什么难以扩展？

常见并发模型可以这样比较：

| 模型 | 优点 | 主要限制 |
| --- | --- | --- |
| 每连接一个线程 | 阻塞代码直观 | 大量连接带来线程栈和调度成本 |
| 单线程事件循环 | 连接规模大、状态集中 | 一个慢业务会阻塞所有连接 |
| 多事件循环 | 利用多核、I/O 分片 | 连接归属与跨线程协调更复杂 |
| Reactor + 工作池 | I/O 与业务计算分离 | 需要背压、结果回投和连接生命周期协议 |

Linux 的 `epoll`、macOS/BSD 的 `kqueue` 和 Windows 的 I/O 机制帮助程序高效等待大量 I/O 事件。它们是平台事件通知/完成机制，不是网络协议，也不是线程池。

一个常见分层是：

```text
I/O 线程：accept、recv、拆包、排队发送
                     ↓ 提交完整业务消息
工作线程：校验、计算、数据库/业务处理
                     ↓ 返回响应
I/O 线程：确认连接仍有效、编码并发送
```

工作线程不能长期持有可能失效的裸连接指针。响应回投时要用连接 ID、受控所有权或事件循环任务，并检查连接是否仍是同一代。任务队列必须有容量和过载策略，否则网络读得越快，内存积压越严重。

## 10. HTTP 和 HTTPS 位于哪一层？

可以用下面的简化分层理解：

```text
HTTP 语义：请求方法、状态码、头部、body
TLS：身份认证、机密性、完整性
TCP：可靠有序字节流（HTTP/1.1、HTTP/2 常见承载）
IP：跨网络传递数据包
```

HTTPS 通常表示 HTTP 运行在 TLS 保护的连接上，不是另一套 HTTP 消息字段。TLS 自己也有握手和记录边界，应用应使用成熟库并正确验证证书，不要自行实现加密协议。

这个简化图有版本边界：HTTP/3 运行在 QUIC 之上，而 QUIC 通常基于 UDP，不再是“HTTP over TLS over TCP”的堆叠。具体部署需要结合 HTTP 版本和所用库确认。

HTTP 本身也定义 framing。HTTP/1.1 可能通过 `Content-Length`、分块传输编码或连接关闭确定 body 边界；不能用一次 `recv` 当作完整 HTTP 请求。成熟服务应使用经过验证的 HTTP 解析器，处理长度冲突、请求走私等安全边界。

## 11. 网络服务应该怎样分层？

把所有逻辑写进一次读回调，会让传输状态、协议错误和业务异常互相污染。一个较清楚的边界是：

1. socket/事件层：处理描述符、可读写事件和错误；
2. 输入输出缓冲层：保存部分读写状态；
3. framing 层：恢复完整应用消息；
4. 协议层：解析字段、校验版本与限制；
5. 业务层：只接收完整、已验证的请求；
6. 调度层：决定在哪个执行上下文运行及如何回投结果。

这不是要求为每层创建一套继承框架，而是保证状态和错误有明确归属。小服务可以把几层放在同一文件中，但不应让业务函数猜测缓冲区里的半包意味着什么。

## 12. 压测应该证明什么？

服务“能回包”只证明功能链路通了。容量验证至少观察：

- 吞吐量，如请求/秒或消息/秒；
- 延迟分布，尤其 P95/P99，而不仅是平均值；
- 错误率和超时；
- CPU、内存、连接数和队列长度；
- 不同并发度、消息大小和慢客户端下的表现。

`wrk` 等工具适合快速压测 HTTP，但客户端本身也可能先达到瓶颈。性能测试应使用 Release 构建、固定环境、预热并重复测量，同时记录服务端资源。不要用单次 QPS 数字证明架构优劣。

## 13. 工程中最容易踩哪些坑？

### 误区一：一次 `send` 对应一次 `recv`

TCP 只保持字节顺序。消息边界必须由固定长度、分隔符、长度前缀或更高层协议定义。

### 误区二：`recv` 返回 0 表示暂时没数据

阻塞 TCP 中，0 表示对端正常关闭发送方向。非阻塞“暂时没数据”通常通过负返回值和 `EAGAIN`/`EWOULDBLOCK` 表达。

### 误区三：`send` 成功就表示整条消息已发出

返回值只说明本次接受的字节数，而且写入本机内核缓冲不等于对端业务已经处理。应用确认需要单独的协议 ACK。

### 误区四：事件循环可以执行任意业务

一次阻塞数据库查询或长计算会延迟该循环负责的所有连接。重业务应移出 I/O 热路径，并设置队列背压。

### 误区五：UDP 更快，所以总比 TCP 适合游戏

游戏中的可靠事件、资源下载和状态快照需求不同。协议选择应按消息语义、延迟、可靠性和网络环境决定，常见系统也会组合多种通道。

### 误区六：启用 TLS 就完成了安全设计

仍要正确验证证书、管理密钥、限制协议版本和密码套件，并防御应用层输入。TLS 保护传输通道，不替业务完成鉴权和权限控制。

## 14. 什么时候该自己实现 framing？

自定义二进制协议、游戏消息或内部 RPC 可能需要长度前缀 framing。此时应先定义最大帧长、字节序、版本、消息类型和错误策略，并对任意切分输入做测试。

如果使用 HTTP、WebSocket、gRPC 等成熟协议，优先使用成熟库的解析与状态机，不要在业务回调里重新按字符串拼凑。理解 framing 仍然重要，因为它帮助你正确设置限制、定位半包问题并判断库的回调语义。

## 15. 总结

开头两次 `send` 无法对应两次 `recv`，因为调用次数从来不是 TCP 协议的一部分。正确的接收端必须把任意长度字节追加到连接缓冲，再按应用协议循环恢复完整消息。

1. TCP 提供可靠有序字节流，不提供应用消息边界；
2. framing 必须处理半包、多包合并、最大长度和恶意慢输入；
3. `recv`、`send` 和连接关闭都需要根据返回值维护跨调用状态；
4. I/O 线程与业务线程的分工必须配合任务背压和连接生命周期；
5. HTTP、TLS、TCP/QUIC 位于不同层，具体关系取决于协议版本。

实现网络服务时，先写一个能接受“任意切分输入”的纯拆包器并做单元测试，再把它接到 socket 事件上。只要 framing 层能够独立验证，真实网络中的粘包和半包就不再是玄学问题。
