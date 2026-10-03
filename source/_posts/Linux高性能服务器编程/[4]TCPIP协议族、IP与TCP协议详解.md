---
title: "TCP 已经建立，为什么一次 `recv()` 仍读不完整？从字节流到连接状态讲清楚"
date: 2026-07-13 14:26:44
updated: 2026-07-13 14:26:44
categories:
  - "学习"
  - "Linux 服务器编程"
permalink: /notes/linux高性能服务器编程/4-tcpip协议族-ip与tcp协议详解/
series: "Linux 服务器编程"
series_order: 4
---

客户端连续发送两条消息：

```text
hello
world
```

服务端却可能出现不同读取结果：一次只收到 `he`，下一次收到 `llo\nworld\n`；也可能第一次正好拿到完整的 `hello\n`。代码没有改，网络也没有报错，为什么 `recv()` 的边界每次都不一样？

因为 TCP 保证的是可靠、有序的**字节流**，并不保留应用调用 `send()` 时的消息边界。TCP 可以按照 MSS、拥塞窗口、接收窗口和网卡卸载等条件分段，接收端内核又会按当前缓冲状态把字节交给应用。应用看到的是连续字节，不是发送端的函数调用记录。

这只是协议理解影响服务端代码的一个例子。`TIME_WAIT`、`CLOSE_WAIT`、重传、小窗口、RST 和路径 MTU 等现象，也只有放回 TCP/IP 分层与状态机中才能解释。本文将沿着“一次请求如何到达服务端”展开，并用一个完整的长度前缀解码器解决最常见的半包与多帧连读问题。

## 1. 我们遇到了什么问题？

下面的服务端逻辑看起来十分自然：

```cpp
// 错误示例：把一次 recv 当成一条完整消息
char buffer[4096];
const ssize_t size = ::recv(fd, buffer, sizeof(buffer), 0);

if (size > 0) {
    handle_one_message(buffer, static_cast<std::size_t>(size));
}
```

它把“这次系统调用返回的字节”误认为“协议中的一条消息”。真实情况至少包括：

- 消息头只有一部分到达；
- 一条大消息分多次读取；
- 多条小消息在一次读取中同时出现；
- 先读到完整消息，后面还附带下一条消息的半个头；
- `recv()` 返回 0，表示对端发送方向已经有序关闭；
- 调用被信号打断，返回 `-1` 且 `errno == EINTR`；
- 非阻塞模式当前无数据，返回 `EAGAIN` / `EWOULDBLOCK`。

如果 `handle_one_message` 直接解析一个并不完整的对象，轻则报格式错误，重则根据伪造长度申请巨量内存或越界访问。

因此，协议栈给服务端的第一条工程约束是：

> TCP 负责按序交付字节，应用负责从字节流中恢复消息边界。

## 2. 一次请求经过哪些层，问题该从哪里查？

常见 TCP/IP 模型可以按四层理解：

| 层次 | 典型协议/对象 | 解决的问题 | 服务端常见故障 |
| --- | --- | --- | --- |
| 应用层 | HTTP、DNS、自定义 RPC | 消息格式与业务语义 | 半包、错误长度、超时、背压 |
| 传输层 | TCP、UDP | 端到端数据传输 | 握手、重传、窗口、连接状态 |
| 网络层 | IPv4、IPv6、ICMP | 跨网络寻址与路由 | 无路由、TTL、PMTU、不可达 |
| 链路层 | Ethernet、ARP、IPv6 ND | 当前链路上的下一跳交付 | 邻居解析失败、VLAN、网卡问题 |

发送 HTTP 请求时，数据大致逐层封装：

```text
HTTP message
    ↓
TCP segment
    ↓
IPv4 packet / IPv6 packet
    ↓
Ethernet frame（在以太网链路上）
```

接收端反向解封装，内核最终把 TCP 字节放入 socket 接收缓冲。应用通常不直接操作 IP 包和以太网帧，但底层任何一层失败都会表现为 `connect()` 超时、读写停滞或连接重置。

分层的价值不是背诵名字，而是缩小调查范围。例如：域名没有地址先看 DNS；地址存在但没有路由先看路由表；同网段下一跳解析失败看邻居表；SYN 发出却没有响应再看路径、防火墙和对端监听；连接建立后协议解析失败才回到应用层字节边界。

## 3. IP 地址知道了，为什么还需要 MAC 和邻居解析？

IP 地址用于跨网络寻址，链路层地址用于当前一跳的帧投递。以 IPv4 以太网为例：

- 目标与本机位于同一子网时，主机通过 ARP 查询目标 IPv4 对应的 MAC；
- 目标位于其他网络时，主机根据路由选择下一跳，通常查询网关接口的 MAC；
- 帧先交给下一跳，不会直接 ARP 远端服务器的 MAC。

```text
application wants 203.0.113.10
             |
             v
route lookup chooses gateway 192.168.1.1
             |
             v
ARP resolves 192.168.1.1 -> gateway MAC
             |
             v
Ethernet frame goes to gateway; IP destination remains 203.0.113.10
```

ARP 是 IPv4 机制。IPv6 不使用 ARP，而通过 ICMPv6 Neighbor Discovery（邻居发现，ND）完成相邻节点发现、地址解析和路由器发现等工作。排障时要先确认地址族，不能拿 IPv4 的 ARP 结论解释 IPv6。

Linux 上可以从路由和邻居表开始观察：

```bash
ip route get 203.0.113.10
ip neigh show
```

容器、网络 namespace、策略路由和 overlay 网络会让“本机路由表”具有上下文；命令必须在与服务进程相同的网络命名空间中解释。

## 4. IP 提供什么，又不保证什么？

IP 的核心工作是携带源/目的地址，并根据路由尽力把数据报送往下一跳。它本身不保证：

- 数据报一定送达；
- 多个数据报按发送顺序到达；
- 数据报不重复；
- 路径始终不变。

IPv4 头部中，服务端排障经常关注源/目的地址、协议号、总长度、TTL、分片字段和头部校验。IPv6 的基本头格式不同，使用 Hop Limit，并通过 Next Header 串联扩展头；不能把 IPv4 字段表直接套到 IPv6。

ICMP/ICMPv6 也不是“只给 ping 使用”。目标不可达、TTL/Hop Limit 超时和路径 MTU 相关反馈都可能通过控制消息返回。防火墙无差别丢弃这些消息，可能让故障从明确错误变成难以解释的超时。

### 4.1 MTU、MSS 和分片是什么关系？

MTU（Maximum Transmission Unit）是链路层一次能承载的网络层包大小上限；TCP MSS（Maximum Segment Size）描述一个 TCP 报文段中愿意接收的数据部分上限。二者相关，但不是同一个数。

IPv4 在允许条件下可能由源端或路由器分片；IPv6 路由器不执行分片，需要源端根据路径条件处理。分片带来明显风险：任一分片丢失，整个原始数据报无法完整重组；中间设备也可能限制或丢弃分片。

TCP 通常结合 MSS 与路径 MTU 进行分段和调整。应用层不应按“一个 IP 包就是一条业务消息”设计协议，因为分段、重传、合并和卸载都不会保留这种对应关系。UDP 需要更加谨慎控制单个数据报大小，因为一个被分片的 UDP 数据报只有在所有分片到齐后才能交付。

## 5. TCP 的可靠字节流是怎样建立的？

TCP 用源 IP、源端口、目的 IP、目的端口区分连接，并通过序号、确认、重传和校验实现可靠、按序字节流。TCP 头部中最常用于排障的字段包括：

| 字段 | 观察意义 |
| --- | --- |
| Sequence Number | 本段第一个数据字节在流中的序号 |
| Acknowledgment Number | 接收方下一步期望的序号 |
| SYN / FIN | 建立序号空间、结束一个发送方向 |
| RST | 立即重置连接，而非有序关闭 |
| Window | 接收方当前愿意接收的字节范围 |
| MSS / Window Scale / SACK | 握手时协商的传输能力 |

### 5.1 三次握手不只是“打三次招呼”

典型主动连接过程如下：

```text
client                              server
  | ---- SYN, seq=x ----------------> |
  | <--- SYN+ACK, seq=y, ack=x+1 ---- |
  | ---- ACK, ack=y+1 --------------> |
```

双方同步初始序号，并确认建立双向传输所需的状态；MSS、窗口扩大、SACK permitted、时间戳等选项通常也在 SYN 中协商。

Linux 服务端调用 `listen()` 后，内核处理握手相关状态；完成连接进入等待应用取走的队列，`accept()` 返回一个新的已连接 fd，监听 fd 继续接收其他连接。握手队列、完成队列和应用 accept 速度共同影响连接建立表现，不能把所有连接超时都归咎于“网络慢”。

### 5.2 `ESTABLISHED` 不代表业务一定健康

TCP 建立只说明传输连接状态成立。它不保证：

- 对端业务线程没有死锁；
- 应用协议版本兼容；
- 请求已经被读取；
- 响应能在业务截止时间内完成；
- 中间代理不会随后关闭空闲连接。

因此 TCP keepalive 与应用层健康检查也不能互相替代。前者检测连接层面的长期失活，后者验证业务语义与截止时间。

## 6. 如何正确从任意 TCP 字节块恢复消息？

常见消息边界方案包括定长、分隔符、长度前缀和 TLV。下面选择 4 字节大端长度前缀：

```text
+------------------+-----------------------+
| payload length   | payload bytes         |
| 4 bytes, big-end | exactly length bytes  |
+------------------+-----------------------+
```

完整示例不依赖网络调度的偶然结果，而是主动把两帧数据切成 `2、7、1、8` 字节喂给解码器，稳定验证半个头、完整帧和下一帧残留。

### 6.1 运行条件

- 语言标准：C++17；
- 第三方依赖：无；
- 输入：编码后的 `hello` 与 `world` 两帧；
- 最大 payload：1024 字节；
- 重点：任意 feed 边界都不改变帧结果。

将代码保存为 `frame_decoder.cpp`：

```cpp
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using Bytes = std::vector<std::uint8_t>;

constexpr std::size_t max_payload_size = 1024;

std::uint32_t read_big_endian_u32(const std::uint8_t* data) {
    return (std::uint32_t{data[0]} << 24) |
           (std::uint32_t{data[1]} << 16) |
           (std::uint32_t{data[2]} << 8) |
           std::uint32_t{data[3]};
}

Bytes encode_frame(const std::string& message) {
    if (message.size() > max_payload_size) {
        throw std::length_error("message is too large");
    }

    const auto size = static_cast<std::uint32_t>(message.size());
    Bytes frame{
        static_cast<std::uint8_t>(size >> 24),
        static_cast<std::uint8_t>(size >> 16),
        static_cast<std::uint8_t>(size >> 8),
        static_cast<std::uint8_t>(size)
    };
    frame.insert(frame.end(), message.begin(), message.end());
    return frame;
}

class FrameDecoder {
public:
    std::vector<std::string> feed(const std::uint8_t* data,
                                  std::size_t size) {
        buffer_.insert(buffer_.end(), data, data + size);

        std::vector<std::string> messages;
        std::size_t offset = 0;

        while (buffer_.size() - offset >= 4) {
            const std::uint32_t payload_size =
                read_big_endian_u32(buffer_.data() + offset);

            if (payload_size > max_payload_size) {
                throw std::length_error("frame payload is too large");
            }

            const std::size_t frame_size = 4 + payload_size;
            if (buffer_.size() - offset < frame_size) {
                break;
            }

            const auto* payload = reinterpret_cast<const char*>(
                buffer_.data() + offset + 4);
            messages.emplace_back(payload, payload_size);
            offset += frame_size;
        }

        if (offset > 0) {
            buffer_.erase(buffer_.begin(), buffer_.begin() + offset);
        }

        return messages;
    }

private:
    Bytes buffer_;
};

int main() {
    Bytes stream = encode_frame("hello");
    const Bytes second = encode_frame("world");
    stream.insert(stream.end(), second.begin(), second.end());

    FrameDecoder decoder;
    std::size_t cursor = 0;

    for (const std::size_t requested : std::array<std::size_t, 4>{2, 7, 1, 100}) {
        const std::size_t size =
            std::min(requested, stream.size() - cursor);

        std::cout << "feed " << size << " bytes\n";
        for (const std::string& message :
             decoder.feed(stream.data() + cursor, size)) {
            std::cout << "message: " << message << '\n';
        }

        cursor += size;
        if (cursor == stream.size()) {
            break;
        }
    }
}
```

编译并运行：

```bash
clang++ -std=c++17 -O2 -Wall -Wextra frame_decoder.cpp -o frame_decoder
./frame_decoder
```

预期输出：

```text
feed 2 bytes
feed 7 bytes
message: hello
feed 1 bytes
feed 8 bytes
message: world
```

如果把 feed 切分改成 `18`、`1+1+...` 或其他组合，输出消息仍应是 `hello`、`world`。这才是解析器需要维持的不变量。

## 7. 这段解码器怎样处理半包和多帧？

### 7.1 输入缓冲保存跨 `recv()` 状态

每次 `feed()` 先把新字节追加到 `buffer_`。如果不足 4 字节，连长度都无法确定，直接保留并等待下次输入；长度已知但 payload 未到齐时，也保留完整前缀。

真实非阻塞连接需要为每个 fd 保存独立 decoder 或输入缓冲，不能把所有连接的字节混到一个全局解析器中。

### 7.2 为什么长度字段使用大端？

协议必须固定跨机器的字节序。示例明确使用大端（network byte order），手工移位解码，因此不依赖主机是小端还是大端。

固定字节序不等于固定 C++ 对象布局。不要把结构体直接 `send()`：padding、对齐、大小端和版本变化都会让线上格式不稳定。

### 7.3 最大长度为什么必须在分配前检查？

攻击者可以声明一个数 GB 的 payload，却永远不发送内容。若解析器立即按长度分配，就会被少量连接拖垮内存。示例在接受长度后先检查 `max_payload_size`，再等待剩余字节。

真实服务还需要输入缓冲总上限、读取超时、单位连接配额和过载策略。长度合法不代表业务一定愿意无限等待。

### 7.4 为什么不在每解析一帧时立刻 erase？

从 `vector` 头部擦除会搬移剩余数据。示例先用 `offset` 连续解析所有完整帧，最后只擦除一次已消费前缀。高吞吐实现可以进一步采用读写索引、环形缓冲或 `evbuffer`，避免频繁搬移。

## 8. 四次挥手、半关闭和 `recv()==0` 应该怎样理解？

TCP 是全双工的，两个发送方向可以分别结束。一方发送 FIN 表示“我没有更多字节要发送”，不等于它拒绝继续接收。

```text
A                                  B
| ---- application data ---------> |
| ---- FIN -----------------------> |  A 的发送方向结束
| <--- ACK ------------------------ |
| <--- remaining response -------- |  B 仍可发送
| <--- FIN ------------------------ |
| ---- ACK -----------------------> |
```

当应用读完内核中 FIN 之前的所有数据后，`recv()` 返回 0，表示对端发送方向到达 EOF。本端仍可能发送数据，直到自己关闭写方向或连接被重置。

Linux 的 `shutdown(fd, SHUT_WR)` 用于半关闭本端发送方向；`close(fd)` 则释放应用对 fd 的引用，并按 socket 状态推进关闭。协议是否使用半关闭，应由应用层设计明确决定，不能把 EOF 和“完整请求结束”无条件画等号。

RST 表示重置，不是有序的 FIN 关闭。读写可能返回 `ECONNRESET`、`EPIPE` 等错误，尚未读取的数据语义也与正常 EOF 不同。

## 9. `TIME_WAIT` 与 `CLOSE_WAIT` 到底是谁的问题？

| 状态 | 本端发生了什么 | 首先检查什么 |
| --- | --- | --- |
| `SYN_RECV` | 收到 SYN，握手尚未完成 | 握手压力、队列、丢包、防火墙 |
| `ESTABLISHED` | TCP 连接已建立 | 业务是否读取/处理、对端是否慢 |
| `CLOSE_WAIT` | 收到对端 FIN，等待本地应用关闭 | fd 所有权、EOF 路径、任务是否卡住 |
| `FIN_WAIT1/2` | 本端主动关闭后等待对端推进 | 对端关闭行为与超时策略 |
| `TIME_WAIT` | 关闭流程完成后保留旧连接状态 | 谁主动关闭、短连接率、端口压力 |
| `LAST_ACK` | 本端在被动关闭路径发出 FIN | 最后 ACK 是否到达 |

大量 `CLOSE_WAIT` 通常说明内核已经把对端关闭通知给应用，但应用没有及时释放连接：可能遗漏 `close()`，也可能持有 fd 的任务永远未结束。调小 TCP 状态超时不能修复应用所有权。

`TIME_WAIT` 常出现在主动关闭方，用于处理最后 ACK 可能需要重传以及避免旧连接报文干扰相同连接标识的新实例。它是正常协议状态，不是看到数量多就应该删除。应先确认它是否真的造成临时端口或资源压力，再检查短连接模型、连接复用和主动关闭方设计。

Linux 上可以按状态观察：

```bash
ss -tan state syn-recv
ss -tan state close-wait
ss -tan state time-wait
```

命令结果必须结合服务端口、进程和采样时间解释。总数上升可能只是流量上升，而不是单连接生命周期泄漏。

## 10. 流量控制、拥塞控制和应用背压有何不同？

这三个概念都可能让发送变慢，但保护的对象不同：

| 机制 | 保护谁 | 典型信号 | 应用看到什么 |
| --- | --- | --- | --- |
| TCP 流量控制 | 接收端缓冲能力 | 接收窗口 rwnd | 对端不读时发送受限 |
| TCP 拥塞控制 | 网络路径 | 丢包、ECN、ACK/RTT 等 | 吞吐下降、重传、延迟变化 |
| 应用层背压 | 进程内资源和依赖 | 队列深度、内存、截止时间 | 暂停读、拒绝、降级或断开 |

如果服务端业务长期不读取 socket，接收缓冲会逐步占满，内核通告的窗口缩小；如果客户端不读取响应，服务端发送缓冲和应用输出队列会增长。事件驱动服务器必须设置输出上限和慢连接策略，不能因为 `send()` 暂时成功就无限接受业务数据。

拥塞控制关注共享网络，不等于接收端流量控制。看到吞吐下降时，应结合 RTT、重传、窗口和应用队列判断，而不是只调某个 socket buffer。

## 11. Nagle、延迟 ACK 和 `TCP_NODELAY` 为什么不能靠口诀？

Nagle 算法的目标是减少未确认的小段持续注入网络；延迟 ACK 允许接收方在一定条件下稍后确认。对请求—响应式小消息，应用写入方式与这些机制可能共同影响延迟。

Linux 可以用 `TCP_NODELAY` 禁用 Nagle：

```cpp
int enabled = 1;
::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY,
             &enabled, sizeof(enabled));
```

这不等于“打开低延迟模式”。如果应用把一个 100 字节响应拆成十次 `send()`，禁用合并可能制造更多小包和系统调用；反过来，等待业务层凑批也可能增加排队延迟。

正确做法是先定义消息大小和延迟目标，减少无意义的小写入，再在目标内核、网络和负载上对比 `TCP_NODELAY`。具体 ACK 和分段行为需要抓包与实现版本共同验证。

## 12. 怎样按层排查一次连接故障？

假设客户端连接 `203.0.113.10:8080` 超时，可以按以下顺序缩小范围：

1. 域名是否解析为预期地址；
2. `ip route get` 是否选择正确接口和下一跳；
3. 邻居解析是否成功；
4. 抓包中 SYN 是否发出、是否收到 SYN+ACK/RST/ICMP；
5. 服务端是否监听正确地址和端口；
6. 握手后应用是否及时 accept、读取和响应；
7. 输出是否被流量控制、拥塞或业务背压限制。

Linux 抓取目标端口流量：

```bash
tcpdump -nn -i any 'tcp port 8080'
```

抓包通常需要相应权限。虚拟网卡、容器、NAT 和硬件卸载可能让某个观察点看到的包形态与物理线路不同；需要结合抓取位置和网卡 offload 配置解释，而不是只看一张截图。

一次 Web 请求也可以沿同一链路观察：

```text
DNS -> route/neighbor -> SYN -> SYN/ACK -> ACK
    -> HTTP bytes -> HTTP response bytes -> FIN or RST
```

缺失哪一段，调查就先停在哪一层。

## 13. 常见误区

### 13.1 误区：一次 `send()` 对应一次 `recv()`

TCP 不保留记录边界。正确做法是维护连接输入缓冲，并按定长、分隔符、长度前缀或 TLV 解析。

### 13.2 误区：看到 PSH 就能把它当消息结束标志

PSH 是 TCP 发送/交付语义的一部分，不是应用协议通用帧边界。中间分段和接收 API 也不会为业务保留 `send()` 调用边界。

### 13.3 误区：`recv()==0` 说明整个连接已经什么都不能做

它表示对端发送方向的有序 EOF。本端可能仍能发送剩余响应；是否继续由应用协议和半关闭设计决定。

### 13.4 误区：大量 `TIME_WAIT` 就应该立刻调内核参数

`TIME_WAIT` 是正确关闭路径的一部分。先证明它造成实际端口或资源压力，并找出主动关闭和短连接来源。

### 13.5 误区：`CLOSE_WAIT` 是内核没有回收连接

该状态通常正在等待本地应用关闭。应检查 EOF/error 分支、fd RAII、任务取消和引用所有权。

### 13.6 误区：TCP 可靠，所以应用不需要校验长度和资源

TCP 可靠传输对端发送的字节，包括恶意长度。帧上限、超时、认证和业务校验仍由应用负责。

### 13.7 误区：打开 `TCP_NODELAY` 一定降低延迟

它只影响 Nagle 行为，不会消除应用排队、系统调用、拥塞、线程调度和依赖耗时。必须在真实消息模式下测量。

## 14. 什么时候应该深入理解这些协议细节？

只要负责长连接服务、RPC、代理、游戏网关、数据库客户端、消息系统或线上网络排障，就需要理解字节流、状态机、窗口和 MTU。框架可以封装系统调用，但无法替你定义应用层消息、超时和背压。

如果只是通过成熟 HTTP 客户端调用普通接口，不必先实现 TCP 栈或手写抓包解析；但仍应知道连接池、超时、EOF 和重试的语义边界，避免把传输错误误判为业务错误。

协议知识也不能替代测量。拥塞算法、offload、内核参数和中间网络设备随环境变化，具体表现需要结合目标 Linux 版本、网络拓扑、抓包和指标验证。

## 15. 总结

TCP 已经建立，一次 `recv()` 仍然可能读不完整，是因为连接建立只创建可靠、有序的字节流，不会为应用创建消息边界。

1. TCP/IP 分层是一条排障路径：先定位应用、传输、网络还是链路问题。
2. IPv4 使用 ARP 解析下一跳，IPv6 使用 Neighbor Discovery；路由决定要解析谁。
3. TCP 用握手、序号、确认和重传维护字节流，但应用必须实现帧解析与资源上限。
4. FIN 结束一个发送方向；`CLOSE_WAIT` 常指向应用未关闭，`TIME_WAIT` 通常是正常主动关闭状态。
5. 流量控制、拥塞控制和应用背压保护不同资源，不能用一个“网络慢”概括。

最直接的实践建议是：**先把任何 TCP 解析器改造成可以接受任意切分输入的状态机，并用“逐字节输入、两帧合并、超长长度、EOF 留半帧”四类测试验证，再把它接到真实 socket。**

## 参考资料

- [RFC 9293：Transmission Control Protocol](https://www.rfc-editor.org/rfc/rfc9293.html)
- [RFC 8200：Internet Protocol, Version 6](https://www.rfc-editor.org/rfc/rfc8200.html)
- [RFC 4861：Neighbor Discovery for IPv6](https://www.rfc-editor.org/rfc/rfc4861.html)
- [Linux `tcp(7)`](https://man7.org/linux/man-pages/man7/tcp.7.html)
- [Linux `ip(7)`](https://man7.org/linux/man-pages/man7/ip.7.html)
