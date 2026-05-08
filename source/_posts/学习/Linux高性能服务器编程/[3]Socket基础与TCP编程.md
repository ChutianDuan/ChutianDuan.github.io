---
title: "Socket 基础与 TCP 编程"
date: 2026-05-04 15:10:08
updated: 2026-05-04 15:10:08
categories:
  - "学习"
  - "Linux高性能服务器编程"
permalink: /notes/linux高性能服务器编程/3-socket基础与tcp编程/
---

# Socket 基础与 TCP 编程

时间：2026/05/04

> 关键词：socket、TCP、`bind/listen/accept`、`connect`、非阻塞、粘包、半关闭、socket options
> 核心目标：把 Linux TCP socket 的基本生命周期、常见错误码和工程坑点串起来，为后续 `epoll`、libevent 和高性能服务端打底。

---

## 1. socket 到底是什么

在 Linux 里，socket 本质上也是一种文件描述符：

```c
int fd = socket(AF_INET, SOCK_STREAM, 0);
```

它和普通文件 fd 的相似点：

* 都可以用整数 fd 表示
* 都可以被 `close()`
* 都能放进 `epoll`

它的不同点：

* 背后连接的是协议栈，而不是磁盘文件
* 读写行为受 TCP 状态、内核缓冲区和网络影响
* 错误码比普通文件 I/O 更丰富

常见 socket 类型：

| 类型 | 含义 |
| --- | --- |
| `SOCK_STREAM` | TCP，面向连接的字节流 |
| `SOCK_DGRAM` | UDP，面向报文 |
| `SOCK_RAW` | 原始套接字，通常用于底层网络工具 |

---

## 2. TCP 服务端基本流程

TCP 服务端标准流程：

```text
socket
  -> setsockopt
  -> bind
  -> listen
  -> accept
  -> recv/send
  -> close
```

最小阻塞式 echo server：

```c
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <stdio.h>
#include <string.h>

int main(void) {
    int listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd < 0) {
        perror("socket");
        return 1;
    }

    int yes = 1;
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(9876);

    if (bind(listen_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("bind");
        close(listen_fd);
        return 1;
    }

    if (listen(listen_fd, SOMAXCONN) < 0) {
        perror("listen");
        close(listen_fd);
        return 1;
    }

    for (;;) {
        int conn_fd = accept(listen_fd, NULL, NULL);
        if (conn_fd < 0) {
            perror("accept");
            continue;
        }

        char buf[4096];
        ssize_t n = 0;
        while ((n = recv(conn_fd, buf, sizeof(buf), 0)) > 0) {
            send(conn_fd, buf, (size_t)n, 0);
        }

        close(conn_fd);
    }

    close(listen_fd);
    return 0;
}
```

这个版本只能用于理解流程。
真正高并发服务端通常要配合：

* 非阻塞 socket
* `epoll`
* 用户态输入/输出缓冲
* 协议解析状态机

---

## 3. TCP 客户端基本流程

客户端流程：

```text
socket
  -> connect
  -> send/recv
  -> close
```

最小示例：

```c
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <stdio.h>
#include <string.h>

int main(void) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        perror("socket");
        return 1;
    }

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(9876);
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("connect");
        close(fd);
        return 1;
    }

    const char *msg = "hello\n";
    send(fd, msg, strlen(msg), 0);

    char buf[4096];
    ssize_t n = recv(fd, buf, sizeof(buf), 0);
    if (n > 0) {
        fwrite(buf, 1, (size_t)n, stdout);
    }

    close(fd);
    return 0;
}
```

---

## 4. 地址、端口和字节序

IPv4 地址结构：

```c
struct sockaddr_in addr;
memset(&addr, 0, sizeof(addr));
addr.sin_family = AF_INET;
addr.sin_port = htons(9876);
addr.sin_addr.s_addr = htonl(INADDR_ANY);
```

注意：

* 端口要用 `htons`
* IPv4 地址整数要用 `htonl`
* 网络字节序是大端

常用转换：

```c
inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
inet_ntop(AF_INET, &addr.sin_addr, buf, sizeof(buf));
```

如果要同时支持 IPv4 / IPv6，更推荐用 `getaddrinfo()`：

```c
struct addrinfo hints;
memset(&hints, 0, sizeof(hints));
hints.ai_family = AF_UNSPEC;
hints.ai_socktype = SOCK_STREAM;
```

这样可以避免到处手写 `sockaddr_in` / `sockaddr_in6` 分支。

---

## 5. `bind()`、`listen()`、`accept()` 分别做什么

### 5.1 `bind()`

把 socket 绑定到本地 IP 和端口：

```c
bind(fd, (struct sockaddr *)&addr, sizeof(addr));
```

服务端通常需要 `bind()`。
客户端一般不需要手动 bind，内核会自动分配本地临时端口。

### 5.2 `listen()`

把 TCP socket 变成监听 socket：

```c
listen(fd, SOMAXCONN);
```

它不是开始读写数据，而是让内核维护连接队列。

### 5.3 `accept()`

从已完成连接队列中取出一个连接：

```c
int conn_fd = accept(listen_fd, NULL, NULL);
```

返回的 `conn_fd` 才是和客户端通信的 socket。
`listen_fd` 继续用于接收新连接。

---

## 6. `recv()` 和 `send()` 的真实语义

### 6.1 `recv()`

```c
ssize_t n = recv(fd, buf, sizeof(buf), 0);
```

返回值含义：

| 返回 | 含义 |
| --- | --- |
| `n > 0` | 收到 n 字节 |
| `n == 0` | 对端有序关闭，收到 EOF |
| `n < 0` | 出错或非阻塞下暂时无数据 |

重要点：

* `n == 0` 不是“现在没数据”
* TCP 上一次 `recv()` 不等于一条完整消息

### 6.2 `send()`

```c
ssize_t n = send(fd, data, len, MSG_NOSIGNAL);
```

返回值可能小于 `len`，表示只写入了一部分。
非阻塞服务端必须保存剩余数据，下次可写时继续发送。

建议：

* Linux 下写 socket 时考虑 `MSG_NOSIGNAL`
* 或者全局忽略 `SIGPIPE`
* 不要假设一次 `send()` 发完全部数据

---

## 7. TCP 是字节流：粘包和半包

TCP 不保留应用层消息边界。

应用层发送：

```text
send("hello")
send("world")
```

接收端可能看到：

```text
"helloworld"
```

也可能看到：

```text
"he"
"llowor"
"ld"
```

这不是 TCP 的 bug，而是字节流语义。

常见协议设计：

| 方式 | 说明 |
| --- | --- |
| 固定长度 | 每条消息长度固定 |
| 分隔符 | 例如 `\r\n` 结尾 |
| 长度前缀 | 包头里写 payload 长度 |
| TLV | Type-Length-Value，适合扩展 |

工程里最常见的是长度前缀：

```text
uint32_t length(network byte order) + payload
```

解析时必须基于用户态输入缓冲区做状态机。

---

## 8. 设置非阻塞

```c
#include <fcntl.h>

int set_nonblock(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0) {
        return -1;
    }
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}
```

非阻塞后：

* 没有新连接时 `accept()` 返回 `EAGAIN`
* 没数据可读时 `recv()` 返回 `EAGAIN`
* 暂时写不进去时 `send()` 返回 `EAGAIN`
* `connect()` 可能返回 `EINPROGRESS`

非阻塞不是“不会失败”，而是“不能立刻完成时不要睡眠”。

---

## 9. 非阻塞 `connect()` 怎么判断成功

客户端非阻塞连接常见流程：

```c
int rc = connect(fd, (struct sockaddr *)&addr, sizeof(addr));
if (rc == 0) {
    // 立即成功
} else if (errno == EINPROGRESS) {
    // 正在连接，等待 fd 可写
} else {
    // 立即失败
}
```

等到 `epoll` 报可写后，必须用 `SO_ERROR` 确认结果：

```c
int err = 0;
socklen_t len = sizeof(err);
getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len);

if (err == 0) {
    // connect 成功
} else {
    // connect 失败，err 是真实错误码
}
```

不能简单认为“可写 == 连接成功”。

---

## 10. 常用 socket options

### 10.1 `SO_REUSEADDR`

服务端重启时常用：

```c
int yes = 1;
setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
```

它能减少端口被 `TIME_WAIT` 等状态影响导致无法 bind 的情况。

### 10.2 `SO_REUSEPORT`

允许多个 socket 绑定同一个 IP/端口，常用于多进程或多线程 accept 扩展：

```c
setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &yes, sizeof(yes));
```

注意：

* 要在 `bind()` 前设置
* 负载分配由内核完成
* 不同系统支持和语义可能有差异

### 10.3 `TCP_NODELAY`

关闭 Nagle 算法：

```c
#include <netinet/tcp.h>

setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &yes, sizeof(yes));
```

适合低延迟小包交互。
但如果业务能合并小包，应用层批量发送通常更好。

### 10.4 `SO_KEEPALIVE`

启用 TCP keepalive：

```c
setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &yes, sizeof(yes));
```

它适合发现长时间断开的死连接，但默认探测时间通常很长。
服务端仍然应该有应用层心跳或读写超时。

### 10.5 `SO_RCVBUF` / `SO_SNDBUF`

调整内核收发缓冲：

```c
int size = 1 << 20;
setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &size, sizeof(size));
setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &size, sizeof(size));
```

缓冲区不是越大越好。
它会影响吞吐、延迟、内存占用和背压表现。

---

## 11. 半关闭与 `shutdown()`

`close(fd)` 表示关闭整个 socket。
`shutdown()` 可以关闭某个方向：

```c
shutdown(fd, SHUT_WR); // 不再发送，但仍可接收
shutdown(fd, SHUT_RD); // 不再接收
```

常见场景：

* 客户端发送完请求后，用 `SHUT_WR` 告诉服务端请求结束
* 服务端继续返回响应

但很多应用协议并不依赖 TCP 半关闭，而是在协议层定义结束标记。
在事件驱动服务端里，是否允许半关闭要和连接状态机一起设计。

---

## 12. 常见错误码速记

| 错误码 | 场景 | 处理 |
| --- | --- | --- |
| `EINTR` | 被信号打断 | 通常重试 |
| `EAGAIN/EWOULDBLOCK` | 非阻塞下暂时不可读/写/接 | 等下一次事件 |
| `EINPROGRESS` | 非阻塞 connect 正在进行 | 等可写后查 `SO_ERROR` |
| `ECONNRESET` | 对端 reset | 关闭连接 |
| `EPIPE` | 向已关闭连接写 | 关闭连接，避免 `SIGPIPE` |
| `ETIMEDOUT` | 超时 | 关闭或重试 |
| `ECONNREFUSED` | 对端端口未监听 | 连接失败 |
| `EMFILE` | 进程 fd 用尽 | 高优先级故障 |
| `ENFILE` | 系统 fd 用尽 | 系统级故障 |

最重要的是：

* `EAGAIN` 不等于失败
* `EINTR` 不等于失败
* `n == 0` 是对端关闭，不是暂时没数据

---

## 13. backlog、连接队列和 fd 上限

`listen(fd, backlog)` 里的 backlog 不是“最大并发连接数”。
它更接近内核已完成连接队列的长度提示。

高并发服务端要同时关注：

* `listen()` backlog
* `net.core.somaxconn`
* `ulimit -n`
* 进程最大 fd 数
* `accept()` 是否及时

如果 `accept()` 不及时，即使业务线程很空，也可能表现为客户端连接超时或被拒绝。

---

## 14. Socket 编程常见坑

### 14.1 忘记检查返回值

系统调用失败非常正常，不检查错误码就是把 bug 延后。

### 14.2 TCP 当消息协议用

TCP 是字节流，必须设计应用层消息边界。

### 14.3 非阻塞写不处理部分发送

一次 `send()` 可能只发送一部分。

### 14.4 对 `SIGPIPE` 没处理

向关闭连接写数据可能让进程收到 `SIGPIPE`。
Linux 下可以用 `MSG_NOSIGNAL` 或忽略该信号。

### 14.5 `SO_REUSEADDR` 在 `bind()` 后才设置

很多 socket option 必须在 `bind()` 或 `connect()` 前设置才有意义。

### 14.6 不限制连接和缓冲区

高并发服务端必须有上限：

* 最大连接数
* 每连接输入缓冲上限
* 每连接输出缓冲上限
* 请求大小上限
* 空闲超时

---

## 15. 一页总结

Socket 基础最值得记住的是：

1. socket 是协议栈背后的 fd
2. TCP 服务端主线是 `socket -> bind -> listen -> accept -> recv/send`
3. TCP 客户端主线是 `socket -> connect -> send/recv`
4. TCP 是字节流，应用层必须处理消息边界
5. 非阻塞 I/O 的核心是正确处理 `EAGAIN/EINTR/EINPROGRESS`
6. `send()` 可能部分成功，`recv()==0` 表示对端关闭
7. socket options 要在正确时机设置，并理解它们解决的问题

如果只记一句：

> Linux 高性能服务器的底层不是某个框架，而是把 TCP socket 的状态、错误码、缓冲区和协议边界处理正确。

---

## 16. 参考资料

1. Linux man-pages: socket
   <https://man7.org/linux/man-pages/man2/socket.2.html>

2. Linux man-pages: bind
   <https://man7.org/linux/man-pages/man2/bind.2.html>

3. Linux man-pages: listen
   <https://man7.org/linux/man-pages/man2/listen.2.html>

4. Linux man-pages: accept
   <https://man7.org/linux/man-pages/man2/accept.2.html>

5. Linux man-pages: tcp
   <https://man7.org/linux/man-pages/man7/tcp.7.html>
