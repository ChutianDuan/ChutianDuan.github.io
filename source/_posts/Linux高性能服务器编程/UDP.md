---
title: "UDP 保留报文边界，为什么一次 `recvfrom()` 仍会静默丢掉尾部？"
date: 2026-07-13 14:41:08
updated: 2026-07-13 14:41:08
categories:
  - "学习"
  - "Linux 服务器编程"
permalink: /notes/linux高性能服务器编程/udp/
series: "Linux 服务器编程"
---

时间：2026/04/09

> 关键词：UDP、报文边界、`recvmsg`、`MSG_TRUNC`、MTU、可靠传输、拥塞控制

很多人第一次学习 UDP 时，会记住一句话：

> UDP 保留报文边界，不存在 TCP 那样的“粘包”和“半包”。

这句话没有错，却很容易被误解成“接收端一定能拿到完整报文”。

假设发送端发来 16 字节，而接收端只准备了 8 字节缓冲区：

```cpp
char buffer[8];
ssize_t n = recvfrom(fd, buffer, sizeof(buffer), 0, nullptr, nullptr);
handle_message(buffer, n);
```

这次调用通常只复制前 8 字节，后 8 字节会被丢弃。下一次接收拿到的是**下一份 UDP 报文**，不是上一份报文剩余的内容。

这正是本文要解决的问题：

1. UDP 的“报文边界”到底意味着什么？
2. 怎样可靠地发现报文被截断？
3. `connect()` 用在 UDP 上有什么意义？
4. 如果业务需要可靠性，应用层究竟要补哪些机制？

---

## 一、UDP 保留边界，但不替应用保留被截掉的尾部

一次 UDP 发送对应一份独立报文。接收端不会像读取 TCP 字节流那样，把两份报文拼进一次读取，也不会把一份报文的剩余内容留给下一次读取。

可以把接收队列想象成一摞信封：

```text
内核接收队列： [报文 A] [报文 B] [报文 C]
                    ↓ 一次 recvfrom()
应用程序：       只取出一整个信封
```

问题是，如果应用准备的“桌面”放不下信封 A，超出的部分不会重新塞回队列：

```text
报文 A：       ABCDEFGHIJKLMNOP
应用缓冲区：   ABCDEFGH
被丢弃：               IJKLMNOP
下一次读取：   报文 B，而不是 IJKLMNOP
```

因此，“没有半包处理”只说明应用不需要像 TCP 那样累计字节并自行切帧，不代表缓冲区可以随便设小。

---

## 二、UDP 与 TCP：差异不只是“一个快、一个可靠”

| 维度 | UDP | TCP |
| --- | --- | --- |
| 应用看到的数据 | 独立报文 | 连续字节流 |
| 建立通信 | 无传输层握手 | 三次握手 |
| 边界 | 保留每次发送的报文边界 | 不保留写入边界 |
| 送达 | 不保证 | 在连接有效期内可靠重传 |
| 顺序与去重 | 不保证 | 按序交付并处理重复段 |
| 流量控制 | 应用负责 | TCP 接收窗口 |
| 拥塞控制 | 应用负责 | TCP 协议栈负责 |
| 对端关闭 | 没有类似 EOF 的统一语义 | `recv()` 返回 0 表示有序关闭 |

UDP 的协议头确实只有 8 字节，但“协议头小”不等于业务一定更快。应用若自己补齐重传、排序、流控、拥塞控制和安全握手，复杂度很快就会接近一套传输协议。

还有一个容易忽略的区别：**零长度 UDP 报文是合法报文**。因此 UDP 上 `recv()` 返回 0，可能只是收到了一份空报文，不能照搬 TCP 逻辑把它当成连接关闭。

---

## 三、先看清 UDP 套接字的基本工作流

服务端通常需要绑定本地地址：

```cpp
int fd = socket(AF_INET, SOCK_DGRAM, 0);

sockaddr_in local{};
local.sin_family = AF_INET;
local.sin_addr.s_addr = htonl(INADDR_ANY);
local.sin_port = htons(9000);

bind(fd, reinterpret_cast<sockaddr*>(&local), sizeof(local));
```

UDP 没有 `listen()` 和 `accept()`。同一个套接字可以通过 `recvfrom()` 接收多个来源的报文：

```cpp
std::array<char, 2048> buffer{};
sockaddr_in peer{};
socklen_t peer_length = sizeof(peer);

ssize_t n = recvfrom(fd, buffer.data(), buffer.size(), 0,
                     reinterpret_cast<sockaddr*>(&peer), &peer_length);
```

回复时把来源地址交给 `sendto()`：

```cpp
sendto(fd, buffer.data(), static_cast<std::size_t>(n), 0,
       reinterpret_cast<const sockaddr*>(&peer), peer_length);
```

这里的“一次发送”应当被当成一个原子报文。若发送失败，应处理错误，而不是像 TCP 那样从未发送部分继续循环；那样会产生另一份 UDP 报文，改变协议语义。

---

## 四、可运行实验：8 字节缓冲区接收 16 字节报文

下面的程序不依赖外部服务器，也不启动后台进程。它在一个进程中创建两个回环 UDP 套接字，先复现截断，再证明两次发送不会被合并。

```cpp
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <cstddef>
#include <iostream>
#include <stdexcept>
#include <string>
#include <system_error>

class UniqueFd {
public:
    explicit UniqueFd(int fd) : fd_(fd) {}
    ~UniqueFd() {
        if (fd_ >= 0) {
            close(fd_);
        }
    }

    UniqueFd(const UniqueFd&) = delete;
    UniqueFd& operator=(const UniqueFd&) = delete;

    int get() const { return fd_; }

private:
    int fd_;
};

[[noreturn]] void throw_errno(const char* operation) {
    throw std::system_error(errno, std::generic_category(), operation);
}

void send_datagram(int fd, const sockaddr_in& target,
                   const char* data, std::size_t size) {
    ssize_t n;
    do {
        n = sendto(fd, data, size, 0,
                   reinterpret_cast<const sockaddr*>(&target),
                   sizeof(target));
    } while (n < 0 && errno == EINTR);

    if (n < 0) {
        throw_errno("sendto");
    }
    if (static_cast<std::size_t>(n) != size) {
        throw std::runtime_error("unexpected partial UDP send");
    }
}

std::string receive_datagram(int fd) {
    std::array<char, 64> buffer{};
    ssize_t n;
    do {
        n = recv(fd, buffer.data(), buffer.size(), 0);
    } while (n < 0 && errno == EINTR);

    if (n < 0) {
        throw_errno("recv");
    }
    return {buffer.data(), static_cast<std::size_t>(n)};
}

int main() try {
    UniqueFd receiver(socket(AF_INET, SOCK_DGRAM, 0));
    if (receiver.get() < 0) {
        throw_errno("socket(receiver)");
    }

    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons(0);  // 让内核选择空闲端口

    if (bind(receiver.get(), reinterpret_cast<sockaddr*>(&address),
             sizeof(address)) < 0) {
        throw_errno("bind");
    }

    socklen_t address_length = sizeof(address);
    if (getsockname(receiver.get(), reinterpret_cast<sockaddr*>(&address),
                    &address_length) < 0) {
        throw_errno("getsockname");
    }

    UniqueFd sender(socket(AF_INET, SOCK_DGRAM, 0));
    if (sender.get() < 0) {
        throw_errno("socket(sender)");
    }

    const std::string large = "ABCDEFGHIJKLMNOP";
    send_datagram(sender.get(), address, large.data(), large.size());

    std::array<char, 8> small{};
    iovec io{small.data(), small.size()};
    msghdr message{};
    message.msg_iov = &io;
    message.msg_iovlen = 1;

    ssize_t copied;
    do {
        copied = recvmsg(receiver.get(), &message, 0);
    } while (copied < 0 && errno == EINTR);
    if (copied < 0) {
        throw_errno("recvmsg");
    }

    const bool truncated = (message.msg_flags & MSG_TRUNC) != 0;
    std::cout << "copied=" << copied
              << ", truncated=" << (truncated ? "yes" : "no")
              << ", data="
              << std::string(small.data(), static_cast<std::size_t>(copied))
              << '\n';

    send_datagram(sender.get(), address, "one", 3);
    send_datagram(sender.get(), address, "two", 3);
    std::cout << "datagram=" << receive_datagram(receiver.get()) << '\n';
    std::cout << "datagram=" << receive_datagram(receiver.get()) << '\n';
} catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
}
```

在 Linux 或 macOS 上可用 C++17 编译：

```bash
c++ -std=c++17 -Wall -Wextra -Wpedantic udp_truncation.cpp -o udp_truncation
./udp_truncation
```

预期输出：

```text
copied=8, truncated=yes, data=ABCDEFGH
datagram=one
datagram=two
```

这个结果说明了三件事：

1. 16 字节报文只复制了 8 字节；
2. `recvmsg()` 通过 `MSG_TRUNC` 告诉应用发生了截断；
3. 后续的 `one` 和 `two` 仍是两份独立报文。

普通 `recvfrom()` 只返回实际复制进缓冲区的长度，代码若不掌握协议最大报文长度，便可能把截断数据当成合法消息。Linux 还支持在调用 `recvmsg()` 时传入 `MSG_TRUNC`，以获取报文原始长度，但跨平台代码应先核对目标系统语义。

`MSG_WAITALL` 也不能解决这个问题：它对数据报套接字没有“等待填满缓冲区”的效果。正确方案是规定协议最大报文长度、准备足够大的缓冲区，并检查截断标志。

---

## 五、UDP 上调用 `connect()`，并不会建立连接

UDP 也允许调用：

```cpp
connect(fd, reinterpret_cast<const sockaddr*>(&server), sizeof(server));
send(fd, data, size, 0);
recv(fd, buffer, capacity, 0);
```

这里没有三次握手。调用成功通常只表示内核记住了默认对端，而不是证明服务器存在、端口开放或后续报文一定送达。

“已连接 UDP”主要带来这些效果：

- 可以使用 `send()` / `recv()`，无需每次传目标地址；
- 入站报文只接受指定对端；
- 某些 ICMP 或异步网络错误更容易通过套接字错误返回给应用；
- 内核不必在每次发送时重新选择目标信息。

它适合固定服务器的游戏客户端、遥测代理等场景。但它仍然没有 TCP 的连接状态、可靠性和关闭语义。

---

## 六、MTU：报文能发送，不等于沿途适合这样发送

UDP 理论长度字段允许较大的数据报，但工程上不能把它当成“可以放心一次发几十 KB”。IP 包超过路径 MTU 后，可能发生分片，或在禁止分片时直接失败。

分片的代价很明显：

- 任意一个分片丢失，整份 UDP 报文都无法重组；
- 隧道、VPN、容器网络会继续挤占有效 MTU；
- 中间设备对分片的支持可能不一致；
- 大报文会放大单次丢包造成的损失。

Linux 默认进行路径 MTU 探测，过大的 UDP 写入可能返回 `EMSGSIZE`。关闭 PMTU 探测并依赖 IP 分片通常不是好主意。

协议设计时应：

1. 明确应用层最大报文长度；
2. 把 IP、UDP、隧道及加密头部都计入预算；
3. 在真实网络环境中验证路径 MTU；
4. 对大业务消息做应用层分片，并设置总片数、总长度和超时上限；
5. 不把“1200 字节”之类经验值误写成所有网络都成立的定律。

应用层分片还必须防御恶意输入。若攻击者声称“一条消息共有十万片”，服务端不能据此无限分配内存。

---

## 七、UDP 的“不可靠”具体包括什么？

UDP 不保证：

- 报文一定送达；
- 报文只送达一次；
- 报文按发送顺序到达；
- 发送速度不会压垮网络或接收方；
- `sendto()` 成功就代表对端已经收到。

`sendto()` 成功通常只表示数据已被本机协议栈接受。之后可能在本机队列、路由链路、对端网卡或应用接收队列中丢失。

但不同业务对“可靠”的要求并不相同：

| 数据 | 常见策略 | 原因 |
| --- | --- | --- |
| 玩家位置快照 | 新数据覆盖旧数据 | 迟到的旧位置已无价值 |
| 购买道具命令 | 可靠、去重、鉴权 | 丢失或重复都会造成状态错误 |
| 实时语音帧 | 过期即丢弃 | 晚到重传会增加卡顿 |
| 地图资源块 | 可靠传输、校验 | 每一块都必须完整 |

因此，不要先问“UDP 怎么全部可靠”，而要先问“哪类消息值得重传，能等待多久”。

---

## 八、在 UDP 上补可靠性，至少要补到什么程度？

最小的停等协议看起来很简单：

```text
发送 seq=N ───────────────▶
             ◀──────── ACK=N

超时未收到 ACK：重新发送 seq=N
```

但这只是教学模型。生产协议至少还要回答下面的问题。

### 1. 序号与重复抑制

每份可靠消息需要序号。接收端必须记录已处理范围，否则 ACK 丢失导致发送端重传时，同一笔业务可能执行两次。

序号还会回绕，因此不能简单使用普通整数大小比较。协议需要明确序号位数、窗口范围和回绕比较规则。

### 2. ACK 设计

逐包 ACK 简单，但开销大。常见设计包括：

- 累积 ACK：表示某序号之前都已收到；
- 选择确认：用位图或区间报告窗口中的缺口；
- 延迟 ACK：稍等一小段时间，合并多个确认。

ACK 本身也可能丢失、乱序或被伪造。

### 3. 重传超时不是一个固定常量

固定 100 毫秒在局域网可能太慢，在移动网络又可能太激进。成熟实现会根据 RTT 样本估算重传超时，并在连续失败时退避。

过早重传会制造额外拥塞；过晚重传则拉高尾延迟。

### 4. 滑动窗口、流控与拥塞控制

停等协议每次只能有一个未确认报文，带宽时延积稍大时吞吐量便很差。滑动窗口允许多个报文在途：

```text
发送窗口：[已确认][在途][在途][可发送][不可发送]
接收窗口：          [已收到][缺口][已收到]
```

但“允许同时发送多少”包含两个不同问题：

- **流量控制**：接收端还有多少缓冲能力？
- **拥塞控制**：网络当前承受得住多快的发送速率？

只做重传而不做拥塞控制，可能在丢包时进一步加大发送量，形成拥塞崩溃。UDP 应用同样需要对网络公平，RFC 8085 对此给出了明确的设计指导。

### 5. 会话、安全与资源上限

只用来源 IP 和端口标识玩家并不牢靠，NAT 映射可能变化，来源地址也可能被伪造。完整协议往往还需要：

- 随机且不可猜测的会话 ID；
- 握手与地址所有权验证；
- 报文鉴权与重放保护；
- 每个会话的发送、重组和乱序缓存上限；
- 防止反射放大的响应策略；
- 超时清理和公平调度。

当需求变成“可靠、有序、加密、支持迁移、具备拥塞控制”时，优先评估 QUIC 或经过验证的可靠 UDP 库，而不是在业务代码中临时造一套“小 TCP”。

---

## 九、高并发 UDP 服务真正容易丢包的地方

即使网络完全正常，服务器自身也可能丢包：

```text
网卡 → 内核接收队列 → socket 接收缓冲区 → 应用读取 → 业务队列
          任一环节处理不过来，都可能丢弃报文
```

工程上应重点观察：

- 套接字接收缓冲区及其溢出统计；
- 应用事件循环每秒能取走多少报文；
- 单个来源是否占满处理预算；
- 业务线程队列是否产生反压；
- 报文大小、乱序率、重复率和过期率；
- 内核或 ICMP 返回的异步错误。

Linux 高吞吐场景可考虑非阻塞 I/O、`epoll`、`recvmmsg()` 和 `sendmmsg()` 批量收发。它们是平台相关优化，应先通过指标确认瓶颈，不要在简单服务上预先增加复杂度。

只增大 `SO_RCVBUF` 也不是万能答案。它只能吸收短时突发；如果应用长期处理速度低于到达速度，任何有限缓冲区最终都会耗尽，而且更大的队列可能让过期实时数据滞留得更久。

一个 UDP 套接字往往服务大量对端，因此还应做每会话限额和公平调度，避免某个高流量来源拖垮所有正常用户。

---

## 十、常见误区

### 误区 1：UDP 没有粘包，所以缓冲区多大都行

报文边界不会消失，但过小缓冲区会截断并丢弃尾部。应规定协议上限并检查 `MSG_TRUNC`。

### 误区 2：UDP 的 `recv()` 返回 0 表示对端关闭

零长度 UDP 报文合法。UDP 没有 TCP 那样统一的流结束语义。

### 误区 3：UDP `connect()` 成功表示服务器在线

它通常只设置默认对端，没有进行传输层握手。

### 误区 4：没有重传，所以 UDP 延迟一定更低

当应用需要可靠性时，错误的重传策略可能比 TCP 更慢、更拥塞。UDP 的优势在于可以按消息价值选择策略，而不是天然更快。

### 误区 5：发送成功等于接收成功

发送成功只说明本机接受了报文。需要业务确认时，必须设计应用层响应和幂等处理。

### 误区 6：只要增大接收缓冲区就不会丢包

缓冲区只能应对暂时峰值，不能修复持续过载。最终仍需限速、批处理、缩短处理路径或扩容。

---

## 十一、什么时候适合使用 UDP？

UDP 适合以下情况：

- 数据天然按独立消息组织；
- 新状态可以淘汰旧状态；
- 过期数据宁可丢弃，也不值得重传；
- 需要广播或组播；
- 团队明确具备传输协议设计和运维观测能力。

如果业务要求“每个字节都必须可靠、按序到达”，又没有特殊的队头阻塞或连接迁移需求，TCP 往往更简单。如果还需要现代加密、多路复用和连接迁移，可以评估 QUIC，而不是从裸 UDP 开始补齐所有能力。

---

## 十二、总结

理解 UDP，关键不是背下“无连接、不可靠、速度快”，而是准确掌握它给应用提供的语义：

1. UDP 保留报文边界，但接收缓冲区过小会永久丢失报文尾部；
2. `recvmsg()` 的 `MSG_TRUNC` 可以帮助发现截断；
3. 零长度报文合法，不能把返回 0 当成 TCP 式关闭；
4. UDP `connect()` 设置默认对端，却不会建立可靠连接；
5. 大报文可能受路径 MTU、分片和隧道开销影响；
6. 可靠 UDP 不只是加序号和重传，还需要 ACK、去重、RTO、流控、拥塞控制与安全防护；
7. 高性能来自可观测的队列、批量收发和过载治理，而不是单纯换成 UDP。

真正成熟的选择不是“TCP 还是 UDP 谁更快”，而是先定义每类消息的正确语义，再选择能以最低复杂度实现这些语义的传输方案。
