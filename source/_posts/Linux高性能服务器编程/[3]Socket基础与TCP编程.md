---
title: "Socket 已经“可写”，为什么非阻塞 `connect()` 仍可能失败？"
date: 2026-07-13 14:32:44
updated: 2026-07-13 14:32:44
categories:
  - "学习"
  - "Linux 服务器编程"
permalink: /notes/linux高性能服务器编程/3-socket基础与tcp编程/
series: "Linux 服务器编程"
series_order: 3
---

把阻塞客户端改成非阻塞后，我们常写出这样的逻辑：

```cpp
const int result = ::connect(fd, address, address_length);
if (result < 0 && errno == EINPROGRESS) {
    add_to_epoll(fd, EPOLLOUT);
}

// 稍后收到 EPOLLOUT：连接成功，开始发送
```

问题是：客户端偶尔在第一条 `send()` 就收到 `EPIPE` 或 `ECONNREFUSED`。事件循环明明报告 socket 可写，连接为什么还会失败？

因为非阻塞 `connect()` 的可写事件只表示“连接尝试已经得出结果”，这个结果可能成功，也可能是拒绝、不可达或超时。必须再用 `getsockopt(fd, SOL_SOCKET, SO_ERROR, ...)` 读取挂起错误，只有 `SO_ERROR == 0` 才能进入已连接状态。

同样的误解也会发生在读写上：可读不保证一次拿到完整请求，可写不保证一次发送全部数据，`EAGAIN` 也不代表连接损坏。本文以一个完整的非阻塞 TCP 客户端为主线，把 socket 生命周期、就绪通知、部分读写、地址解析、半关闭和常见选项串成一套可执行状态机。

## 1. 我们遇到了什么问题？

阻塞 socket 把等待隐藏在系统调用里：

```text
connect() 等握手结果
recv()    等至少一个字节或关闭/错误
send()    可能等发送缓冲出现空间
accept()  等连接进入队列
```

切换为 `O_NONBLOCK` 后，内核不再替当前线程睡眠。不能立即完成时，系统调用返回一个状态，应用保存进度，等到下一次就绪通知再继续。

这不是简单地给原代码多加一个 `if (errno == EAGAIN)`。连接要显式经历：

```text
created
   |
   +-- connect()==0 --------------------> connected
   |
   +-- EINPROGRESS -> wait writable
                           |
                           +-- SO_ERROR==0 -> connected
                           |
                           +-- SO_ERROR!=0 -> failed -> close
```

发送也需要保留偏移：

```text
output[0 ... N)
       ^
       sent_offset

send() 返回 k -> sent_offset += k
EAGAIN          -> 等待下一次可写，偏移不能丢
```

如果每次事件到来都从输出开头重发，会产生重复字节；如果一次 `send()` 后直接丢弃缓冲，则会截断消息。

## 2. socket 是文件描述符，但为什么不能当普通文件理解？

Linux socket 由整数文件描述符引用，可以 `close()`、放进 `poll/epoll`，也遵循进程 fd 上限。但它背后连接的是协议栈和动态状态，而不是固定磁盘内容。

| socket 类型 | 语义 | 是否保留消息边界 |
| --- | --- | --- |
| `SOCK_STREAM` | 可靠、有序、面向连接的字节流，常用于 TCP | 否 |
| `SOCK_DGRAM` | 数据报，常用于 UDP | 是 |
| `SOCK_SEQPACKET` | 有序、可靠、面向连接的报文 | 是 |
| `SOCK_RAW` | 直接访问较低层协议 | 取决于协议，通常需要额外权限 |

对 TCP socket 的读写结果受连接状态、对端行为、内核缓冲、流量控制和网络错误共同影响。fd 可读可能意味着有数据，也可能意味着 EOF 或错误；fd 可写可能意味着连接成功，也可能意味着异步连接失败已经可以读取。

就绪（readiness）是一条“现在调用不会按原原因继续等待”的提示，不是业务操作成功证明。收到事件后仍要执行对应系统调用，并以返回值和 `errno` 为准。

## 3. 服务端与客户端的生命周期分别是什么？

### 3.1 服务端有两类不同职责的 fd

```text
socket
  -> setsockopt（需要在 bind 前设置的选项）
  -> bind
  -> listen
  -> listening fd
       |
       +-- accept -> connected fd A -> recv/send -> close
       +-- accept -> connected fd B -> recv/send -> close
```

监听 fd 只负责接收连接请求，`accept()` 返回的新 fd 才代表某一条 TCP 连接。关闭 connected fd 不影响监听；关闭监听 fd 也不会自动替应用完成所有已接收连接的业务收尾。

### 3.2 客户端通常让内核选择本地地址和临时端口

```text
getaddrinfo
  -> socket
  -> optional bind
  -> connect
  -> send/recv
  -> shutdown/close
```

普通客户端无需显式 `bind()`，内核会根据路由和地址选择本地地址与临时端口。代理、测试、多网卡策略或指定源地址时才可能主动绑定。

IPv4 的 `sockaddr_in` 和 IPv6 的 `sockaddr_in6` 布局不同。通用客户端更适合用 `getaddrinfo()` 生成候选地址，而不是把所有目标硬编码成 IPv4 数字字符串。

## 4. 阻塞和非阻塞返回值应怎样解释？

| 操作 | 成功/进展 | 已结束 | 暂时不能完成 | 其他错误 |
| --- | --- | --- | --- | --- |
| `accept` | 返回新 fd | — | `EAGAIN/EWOULDBLOCK` | 分类处理或报告 |
| `connect` | 返回 0 | — | `EINPROGRESS` | 关闭并按策略重试 |
| `recv` | 返回读取字节数 | 返回 0（对端发送 EOF） | `EAGAIN/EWOULDBLOCK` | 连接失败/中断等 |
| `send` | 返回已接受字节数 | — | `EAGAIN/EWOULDBLOCK` | `EPIPE`、reset 等 |

`EINTR` 表示调用被已捕获信号打断。是否直接重试取决于操作和状态：`recv/send/accept` 常在没有进度时重试；连接和带总截止时间的等待则要重新计算剩余预算，不能每次重试都把超时重置为完整时长。

`EAGAIN` 不是连接失败，它表示当前状态下没有可完成的进度。事件驱动代码应停止当前方向的循环，等待下一次对应事件。

## 5. 如何写出一个完整的非阻塞 TCP 客户端？

下面的客户端：

1. 用 `getaddrinfo()` 支持 IPv4/IPv6 候选；
2. 为每个候选创建新的非阻塞 socket；
3. 处理 `EINPROGRESS`，等待 `POLLOUT` 后检查 `SO_ERROR`；
4. 循环发送 `hello\n`，保留部分写偏移；
5. 使用 `shutdown(SHUT_WR)` 告知 Echo Server 请求字节结束；
6. 非阻塞读取响应，直到对端有序关闭。

它可以配合本专题 README 中的阻塞 Echo Server 运行。

### 5.1 运行条件

- 平台：Linux/POSIX socket 环境；
- 语言标准：C++17；
- I/O 模式：socket 为非阻塞，示例用 `poll()` 等待单个 fd；
- 单次等待超时：5 秒；
- Linux 专用点：发送使用 `MSG_NOSIGNAL`；
- 限制：为了聚焦 socket 状态，没有实现跨所有地址与读写阶段共享的绝对总截止时间。

将代码保存为 `nonblocking_client.cpp`：

```cpp
#include <fcntl.h>
#include <netdb.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <cstddef>
#include <cstring>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <system_error>
#include <utility>

class UniqueFd {
public:
    UniqueFd() noexcept = default;
    explicit UniqueFd(int fd) noexcept : fd_(fd) {}

    ~UniqueFd() { reset(); }

    UniqueFd(const UniqueFd&) = delete;
    UniqueFd& operator=(const UniqueFd&) = delete;

    UniqueFd(UniqueFd&& other) noexcept
        : fd_(std::exchange(other.fd_, -1)) {}

    UniqueFd& operator=(UniqueFd&& other) noexcept {
        if (this != &other) {
            reset();
            fd_ = std::exchange(other.fd_, -1);
        }
        return *this;
    }

    int get() const noexcept { return fd_; }

private:
    void reset() noexcept {
        if (fd_ >= 0) {
            ::close(fd_);
            fd_ = -1;
        }
    }

    int fd_ = -1;
};

[[noreturn]] void throw_errno(const char* operation) {
    throw std::system_error(errno, std::generic_category(), operation);
}

void set_nonblocking(int fd) {
    const int flags = ::fcntl(fd, F_GETFL, 0);
    if (flags < 0) {
        throw_errno("fcntl(F_GETFL)");
    }
    if (::fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) {
        throw_errno("fcntl(F_SETFL)");
    }
}

void wait_ready(int fd, short events, int timeout_ms) {
    pollfd item{fd, events, 0};

    for (;;) {
        const int result = ::poll(&item, 1, timeout_ms);

        if (result > 0) {
            if ((item.revents & POLLNVAL) != 0) {
                throw std::runtime_error("poll reported an invalid fd");
            }
            if ((item.revents & (events | POLLERR | POLLHUP)) != 0) {
                return;
            }
            throw std::runtime_error("poll returned an unexpected event");
        }

        if (result == 0) {
            throw std::runtime_error("I/O wait timed out");
        }

        if (errno != EINTR) {
            throw_errno("poll");
        }
    }
}

UniqueFd connect_one(const addrinfo& address, int timeout_ms) {
    UniqueFd fd(::socket(address.ai_family,
                         address.ai_socktype,
                         address.ai_protocol));
    if (fd.get() < 0) {
        throw_errno("socket");
    }

    set_nonblocking(fd.get());

    if (::connect(fd.get(), address.ai_addr, address.ai_addrlen) == 0) {
        return fd;
    }

    if (errno != EINPROGRESS) {
        throw_errno("connect");
    }

    wait_ready(fd.get(), POLLOUT, timeout_ms);

    int pending_error = 0;
    socklen_t length = sizeof(pending_error);
    if (::getsockopt(fd.get(), SOL_SOCKET, SO_ERROR,
                     &pending_error, &length) < 0) {
        throw_errno("getsockopt(SO_ERROR)");
    }
    if (pending_error != 0) {
        throw std::system_error(pending_error, std::generic_category(),
                                "connect");
    }

    return fd;
}

UniqueFd connect_to(const char* host, const char* service) {
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    addrinfo* raw_addresses = nullptr;
    const int result = ::getaddrinfo(host, service, &hints, &raw_addresses);
    if (result != 0) {
        throw std::runtime_error(std::string("getaddrinfo: ") +
                                 ::gai_strerror(result));
    }

    std::unique_ptr<addrinfo, decltype(&::freeaddrinfo)> addresses(
        raw_addresses, ::freeaddrinfo);

    std::string last_error = "no address candidates";
    for (const addrinfo* current = addresses.get(); current != nullptr;
         current = current->ai_next) {
        try {
            return connect_one(*current, 5000);
        } catch (const std::exception& error) {
            last_error = error.what();
        }
    }

    throw std::runtime_error("all address candidates failed; last error: " +
                             last_error);
}

void send_all(int fd, const std::string& data) {
    std::size_t offset = 0;

    while (offset < data.size()) {
        const ssize_t result = ::send(
            fd, data.data() + offset, data.size() - offset, MSG_NOSIGNAL);

        if (result > 0) {
            offset += static_cast<std::size_t>(result);
            continue;
        }

        if (result == 0) {
            throw std::runtime_error("send returned zero before completion");
        }

        if (errno == EINTR) {
            continue;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            wait_ready(fd, POLLOUT, 5000);
            continue;
        }
        throw_errno("send");
    }
}

void receive_to_stdout(int fd) {
    std::array<char, 4096> buffer{};

    for (;;) {
        const ssize_t result =
            ::recv(fd, buffer.data(), buffer.size(), 0);

        if (result > 0) {
            std::cout.write(buffer.data(), result);
            continue;
        }

        if (result == 0) {
            return;
        }

        if (errno == EINTR) {
            continue;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            wait_ready(fd, POLLIN, 5000);
            continue;
        }
        throw_errno("recv");
    }
}

int main(int argc, char* argv[]) {
    if (argc != 3) {
        std::cerr << "usage: " << argv[0] << " <host> <port>\n";
        return 1;
    }

    try {
        UniqueFd fd = connect_to(argv[1], argv[2]);
        send_all(fd.get(), "hello\n");

        if (::shutdown(fd.get(), SHUT_WR) < 0) {
            throw_errno("shutdown");
        }

        receive_to_stdout(fd.get());
    } catch (const std::exception& error) {
        std::cerr << "client failed: " << error.what() << '\n';
        return 1;
    }
}
```

先按 README 启动 `blocking_echo_server`，再编译运行客户端：

```bash
clang++ -std=c++17 -O2 -Wall -Wextra \
  nonblocking_client.cpp -o nonblocking_client
./nonblocking_client 127.0.0.1 8080
```

预期客户端输出：

```text
hello
```

如果目标端口没有监听，程序应该报告候选连接失败，而不是在“可写”事件后误报连接成功。具体错误文本随标准库本地化与地址候选顺序变化，不应写入固定断言。

## 6. 这段客户端如何保持状态正确？

### 6.1 每个失败地址都使用独立 socket

`getaddrinfo()` 可能返回 IPv6 和 IPv4 等多个候选。`connect_one()` 为每个候选新建 fd；连接失败抛异常后，`UniqueFd` 自动关闭它，再尝试下一个地址。

这不仅防止泄漏，也遵守可移植边界：一次 `connect()` 失败后，socket 状态不应被假定仍适合直接连接另一个地址。

### 6.2 为什么 `POLLOUT` 后还要读取 `SO_ERROR`？

握手完成或失败都会让连接尝试结束，fd 因此可能报告可写/错误事件。`getsockopt(SO_ERROR)` 返回并清除挂起错误：零表示成功，非零值本身就是连接错误码。

删除这一步，`ECONNREFUSED` 等异步失败就会被错误地推进到“已连接”状态。

### 6.3 为什么 `wait_ready()` 同时接受 HUP/ERR？

`POLLERR` 和 `POLLHUP` 可以与请求事件一起出现。它们只说明应该立即执行下一步获取具体结果：连接阶段读 `SO_ERROR`，接收阶段继续 `recv()` 以消费剩余数据并最终看到 0 或错误。

看到 HUP 就立刻丢弃 fd，可能漏掉内核中已经排队的最后一段响应。

### 6.4 部分发送的数据由谁持有？

`send_all()` 的 `data` 在函数返回前一直存活，`offset` 指向尚未发送部分。`EAGAIN` 时它等待可写后从原偏移继续。

单连接同步示例可以在函数栈上保存这些状态；真正的 Reactor 不能阻塞在 `poll()`，需要把输出缓冲和偏移放进连接对象，由事件循环在后续 `EPOLLOUT` 中继续推进。

### 6.5 `shutdown(SHUT_WR)` 为什么不是 `close()`？

客户端发完请求后关闭自己的写方向，让 README 中的 Echo Server 在回写后读到 EOF并关闭连接；客户端仍保留读方向，继续接收响应。

如果直接 `close()`，fd 生命周期结束，应用不能再读取响应。并不是所有协议都以半关闭表示请求结束；长度前缀和 HTTP 等协议通常有自己的消息边界。

## 7. 服务端切成非阻塞时还要注意什么？

### 7.1 Linux 的 accepted fd 不应假定继承 `O_NONBLOCK`

在 Linux 上，`accept()` 返回的新 socket 不继承监听 socket 的 `O_NONBLOCK` 等文件状态标志。服务端应显式设置，或使用：

```cpp
const int client = ::accept4(
    listener, nullptr, nullptr, SOCK_NONBLOCK | SOCK_CLOEXEC);
```

`accept4()` 和这些标志的跨平台支持需要验证。使用普通 `accept()` 时，随后 `fcntl()` 设置标志会存在额外系统调用和并发窗口。

### 7.2 就绪后仍要读/接到 `EAGAIN`

在 epoll 边沿触发（ET）模式中，一次通知后通常要循环 `accept()` / `recv()`，直到 `EAGAIN`，否则队列里剩余工作可能没有新的边沿来提醒。水平触发（LT）会在条件持续时重复通知，但也不能假设一次调用处理全部数据。

### 7.3 不要长期监听无意义的可写事件

TCP socket 在发送缓冲有空间时通常一直可写。如果连接没有待发送数据却永久注册 `EPOLLOUT`，事件循环可能持续被唤醒并忙转。

更合理的规则是：输出缓冲从空变为非空且一次未能发完时关注可写；缓冲清空后取消可写兴趣。

## 8. `bind`、`listen` 和 backlog 容易怎样误解？

`bind()` 把 socket 关联到本地地址和端口；`listen()` 把流 socket 变成被动监听状态；`accept()` 从等待队列取出已连接 socket。

`listen(fd, backlog)` 不是“服务器最大并发连接数”。它是连接等待队列相关的提示/上限，并受内核配置影响；已经被 accept 的连接、应用连接上限和文件描述符容量是不同资源。

高并发连接建立同时受以下因素约束：

- 应用调用 accept 的速度；
- backlog 与内核队列配置；
- 进程和系统 fd 上限；
- 内存与 socket buffer；
- 防火墙、SYN 防护和网络丢包；
- 应用层是否及时关闭无效连接。

把 backlog 调到很大，不能修复 accept 线程被业务阻塞的问题。

## 9. 常见 socket option 应该解决什么问题？

| 选项 | 典型目的 | 不能替代什么 |
| --- | --- | --- |
| `SO_REUSEADDR` | 按平台规则允许本地地址重用，方便服务重启等 | 不保证任意进程抢占同一监听端口 |
| `SO_REUSEPORT` | 在支持平台让多个 socket 绑定同一地址/端口并分配连接 | 不自动解决业务负载不均和共享状态 |
| `TCP_NODELAY` | 禁用 Nagle，减少某些小写入等待 | 不消除应用排队、拥塞和系统调用成本 |
| `SO_KEEPALIVE` | 启用 TCP 长时间存活探测 | 不替代业务心跳与请求截止时间 |
| `SO_RCVBUF/SO_SNDBUF` | 调整内核收发缓冲 | 不等于应用可以无限缓存 |
| `SO_RCVTIMEO/SO_SNDTIMEO` | 为部分阻塞 I/O 设置超时语义 | 不自动成为端到端业务 deadline |

选项设置时机和语义随协议与平台不同。例如地址重用类选项通常要在 `bind()` 前设置。调优前应读取目标 OS 文档，并用 `getsockopt()`、指标和压测确认实际值与效果。

缓冲区也不是越大越好：它可能提高带宽延迟积较大路径上的吞吐，也会增加每连接内存并延后背压显现。应用输出队列仍需单独上限。

## 10. 错误码怎样映射成工程动作？

| 错误/结果 | 常见含义 | 典型动作 |
| --- | --- | --- |
| `EINTR` | 调用被信号打断 | 结合截止时间与操作语义决定重试 |
| `EAGAIN/EWOULDBLOCK` | 当前不能立即读/写/accept | 保存状态，等待下一次就绪 |
| `EINPROGRESS` | 非阻塞连接尚未完成 | 等可写后检查 `SO_ERROR` |
| `ECONNREFUSED` | 目标拒绝连接，常见于无监听 | 失败或按退避策略重连 |
| `ECONNRESET` | 对端重置连接 | 终止连接并报告在途操作失败 |
| `EPIPE` | 向已关闭写方向发送 | 停止发送并处理 `SIGPIPE` |
| `ETIMEDOUT` | 某个网络操作超时 | 按幂等性和总预算决定重试 |
| `EMFILE` | 当前进程 fd 达到上限 | 进入过载保护并高优先级告警 |
| `ENFILE` | 系统范围 fd 耗尽 | 系统级故障处理 |

“遇到错误就重试”很危险。连接拒绝立即高速重试会制造重连风暴；超时请求若非幂等，重试可能重复执行；fd 耗尽时继续 accept 又无法持有新 fd。错误必须映射到有限退避、拒绝、降级或关闭等明确动作。

## 11. 常见误区

### 11.1 误区：fd 可写就说明 connect 成功

可写只表示异步连接得到结果。必须读取 `SO_ERROR`；非零值就是失败原因。

### 11.2 误区：非阻塞就是系统调用永远成功

它只保证不能立即完成时不让线程睡眠。`EAGAIN`、部分成功和所有真实网络错误仍要处理。

### 11.3 误区：收到 HUP 就可以不读直接关闭

HUP 可能与可读同时出现，缓冲中仍有数据。继续读到 0 或具体错误，才能避免截断尾部响应。

### 11.4 误区：一次 `send()` 返回正数，整个消息就发送完成

正数只表示本次接受的字节数。保存偏移和剩余缓冲，直到全部发送或连接失败。

### 11.5 误区：监听 socket 非阻塞，accepted socket 也一定非阻塞

Linux 不提供这个继承保证。使用 `accept4` 原子设置，或对新 fd 显式 `fcntl`。

### 11.6 误区：`SO_REUSEADDR` 能无条件绕过 `TIME_WAIT`

地址重用受本地地址、端口、先前 socket 选项和平台规则约束。它不是任意 bind 冲突的关闭开关。

### 11.7 误区：把内核缓冲调大就解决慢客户端

更大的缓冲只推迟压力暴露，并消耗更多内存。慢连接仍需输出上限、超时和关闭策略。

## 12. 什么时候使用阻塞、非阻塞或框架？

连接数少、每个连接生命周期短且线程等待成本可接受时，阻塞 socket 配合清晰的线程模型最容易写对。一次性工具和管理接口不必为了“高性能”强行引入 Reactor。

大量长连接、需要一个线程管理许多 fd 或严格控制线程数量时，非阻塞加 `epoll`/libevent 更合适。代价是必须显式保存连接、输入、输出、超时和关闭状态。

业务真正关注的是 HTTP/RPC 功能而不是网络框架时，应优先使用团队已有且经过生产验证的库。理解本篇语义用于正确配置、排障和设计背压，不代表每个项目都要重写 socket 层。

## 13. 总结

Socket 已经“可写”，非阻塞 `connect()` 仍可能失败，是因为就绪通知报告的是状态可以继续检查，而不是操作成功。

1. 非阻塞 I/O 把等待从系统调用转成应用状态机，连接和读写进度必须显式保存。
2. `EINPROGRESS` 后等待可写，再以 `SO_ERROR` 判定连接；失败 socket 应关闭并重建。
3. `recv()` 可能部分读取或返回 EOF，`send()` 可能部分成功，`EAGAIN` 只是暂时没有进度。
4. 监听 fd、连接 fd、输入缓冲、输出缓冲和超时都有独立所有权与上限。
5. socket option 只解决特定协议行为，不能替代应用层边界、背压和可观测性。

最直接的实践建议是：**为每个 socket 操作写出“成功、部分进展、暂时不可用、永久失败、对端关闭”五条分支；任何一条没有明确的状态转移，就不要急着把 fd 注册进 epoll。**

## 参考资料

- [Linux `socket(2)`](https://man7.org/linux/man-pages/man2/socket.2.html)
- [Linux `connect(2)`](https://man7.org/linux/man-pages/man2/connect.2.html)
- [Linux `poll(2)`](https://man7.org/linux/man-pages/man2/poll.2.html)
- [Linux `accept(2)`](https://man7.org/linux/man-pages/man2/accept.2.html)
- [Linux `socket(7)`](https://man7.org/linux/man-pages/man7/socket.7.html)
- [Linux `tcp(7)`](https://man7.org/linux/man-pages/man7/tcp.7.html)
