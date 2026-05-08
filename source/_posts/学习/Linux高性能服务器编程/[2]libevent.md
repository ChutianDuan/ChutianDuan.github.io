---
title: "libevent 客户端与 `bufferevent` 进阶"
date: 2026-05-04 15:11:19
updated: 2026-05-04 15:11:19
categories:
  - "学习"
  - "Linux高性能服务器编程"
permalink: /notes/linux高性能服务器编程/2-libevent/
---

# libevent 客户端与 `bufferevent` 进阶

时间：2026/05/04

> 关键词：`bufferevent_socket_new`、`bufferevent_socket_connect`、异步 DNS、超时、水位线、重连、背压
> 核心目标：掌握如何用 libevent 主动连接服务器，并把读写、超时、DNS、重连和缓冲控制放进统一事件循环。

---

## 1. 客户端和服务端的 libevent 思路差异

服务端的主线是：

```text
evconnlistener -> accept -> bufferevent
```

客户端的主线是：

```text
bufferevent_socket_new(fd = -1)
    -> bufferevent_socket_connect
    -> BEV_EVENT_CONNECTED
    -> write request
    -> read response
```

也就是说：

* 服务端先监听，再为每个连接创建 `bufferevent`
* 客户端通常直接创建一个未连接的 `bufferevent`
* 连接成功、失败、超时都从 event callback 里得知

---

## 2. 创建客户端 `bufferevent`

```c
#include <event2/bufferevent.h>

struct bufferevent *bev = bufferevent_socket_new(
    base,
    -1,
    BEV_OPT_CLOSE_ON_FREE | BEV_OPT_DEFER_CALLBACKS
);
```

这里 `fd = -1` 表示：

* 让 libevent 自己创建 socket
* 后续由 `bufferevent_socket_connect()` 发起连接

常用选项：

| 选项 | 作用 |
| --- | --- |
| `BEV_OPT_CLOSE_ON_FREE` | 释放 `bev` 时关闭 socket |
| `BEV_OPT_DEFER_CALLBACKS` | 延迟执行回调，减少重入问题 |
| `BEV_OPT_THREADSAFE` | 给 `bev` 加锁，需先启用 libevent 线程支持 |

---

## 3. 回调要先设置，再发起连接

推荐顺序：

```c
bufferevent_setcb(bev, read_cb, write_cb, event_cb, ctx);
bufferevent_enable(bev, EV_READ | EV_WRITE);
bufferevent_set_timeouts(bev, &read_timeout, &write_timeout);
bufferevent_socket_connect(bev, (struct sockaddr *)&addr, sizeof(addr));
```

原因是：

* 连接可能很快成功或失败
* 先设置回调可以避免事件到来时没有处理逻辑
* 超时也应该在连接发起前准备好

---

## 4. 最小客户端示例：连接 IPv4 地址

```c
#include <event2/buffer.h>
#include <event2/bufferevent.h>
#include <event2/event.h>
#include <event2/util.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static void read_cb(struct bufferevent *bev, void *ctx) {
    (void)ctx;

    char buf[4096];
    size_t n = 0;

    while ((n = bufferevent_read(bev, buf, sizeof(buf))) > 0) {
        fwrite(buf, 1, n, stdout);
    }
}

static void write_cb(struct bufferevent *bev, void *ctx) {
    (void)bev;
    (void)ctx;
}

static void event_cb(struct bufferevent *bev, short events, void *ctx) {
    struct event_base *base = ctx;

    if (events & BEV_EVENT_CONNECTED) {
        const char *msg = "hello from libevent client\n";
        bufferevent_write(bev, msg, strlen(msg));
        return;
    }

    if (events & BEV_EVENT_ERROR) {
        int err = EVUTIL_SOCKET_ERROR();
        fprintf(stderr, "connect/io error: %s\n",
                evutil_socket_error_to_string(err));
    }

    if (events & BEV_EVENT_TIMEOUT) {
        fprintf(stderr, "timeout\n");
    }

    if (events & BEV_EVENT_EOF) {
        fprintf(stderr, "server closed\n");
    }

    if (events & (BEV_EVENT_EOF | BEV_EVENT_ERROR | BEV_EVENT_TIMEOUT)) {
        bufferevent_free(bev);
        event_base_loopexit(base, NULL);
    }
}

int main(int argc, char **argv) {
    const char *ip = "127.0.0.1";
    int port = 9876;

    if (argc > 1) {
        ip = argv[1];
    }
    if (argc > 2) {
        port = atoi(argv[2]);
    }

    struct event_base *base = event_base_new();
    if (!base) {
        fprintf(stderr, "could not create event_base\n");
        return 1;
    }

    struct bufferevent *bev = bufferevent_socket_new(
        base, -1, BEV_OPT_CLOSE_ON_FREE | BEV_OPT_DEFER_CALLBACKS);
    if (!bev) {
        event_base_free(base);
        return 1;
    }

    bufferevent_setcb(bev, read_cb, write_cb, event_cb, base);
    bufferevent_enable(bev, EV_READ | EV_WRITE);

    struct timeval timeout = {10, 0};
    bufferevent_set_timeouts(bev, &timeout, &timeout);

    struct sockaddr_in sin;
    memset(&sin, 0, sizeof(sin));
    sin.sin_family = AF_INET;
    sin.sin_port = htons((uint16_t)port);

    if (evutil_inet_pton(AF_INET, ip, &sin.sin_addr) <= 0) {
        fprintf(stderr, "invalid ip: %s\n", ip);
        bufferevent_free(bev);
        event_base_free(base);
        return 1;
    }

    if (bufferevent_socket_connect(
            bev, (struct sockaddr *)&sin, sizeof(sin)) < 0) {
        fprintf(stderr, "connect start failed\n");
        bufferevent_free(bev);
        event_base_free(base);
        return 1;
    }

    event_base_dispatch(base);

    event_base_free(base);
    return 0;
}
```

编译：

```bash
cc client.c -o client -levent
```

测试时可以先启动上一篇的 echo server：

```bash
./echo_server 9876
./client 127.0.0.1 9876
```

---

## 5. `BEV_EVENT_CONNECTED` 不等于服务端已回包

主动连接成功时，event callback 会收到：

```c
BEV_EVENT_CONNECTED
```

这只表示 TCP 连接建立完成，之后你可以：

* 发送请求
* 启动应用层握手
* 切换连接状态

它不表示：

* 服务端已经处理业务
* 服务端一定会持续在线
* 应用协议已经完成

所以客户端通常要维护自己的状态：

```text
CONNECTING -> CONNECTED -> REQUEST_SENT -> RESPONSE_READING -> DONE
```

---

## 6. 使用主机名连接：异步 DNS

如果直接调用阻塞式 `getaddrinfo()`，事件循环可能被卡住。
libevent 提供了异步 DNS：

```c
#include <event2/dns.h>

struct evdns_base *dns = evdns_base_new(base, 1);

int rc = bufferevent_socket_connect_hostname(
    bev,
    dns,
    AF_UNSPEC,
    "example.com",
    80
);
```

参数说明：

| 参数 | 含义 |
| --- | --- |
| `dns` | DNS 解析器对象 |
| `AF_UNSPEC` | IPv4 / IPv6 都可以 |
| `hostname` | 主机名 |
| `port` | 端口 |

DNS 错误可以这样拿：

```c
int err = bufferevent_socket_get_dns_error(bev);
if (err) {
    fprintf(stderr, "dns error: %s\n", evutil_gai_strerror(err));
}
```

清理时：

```c
evdns_base_free(dns, 0);
```

---

## 7. 输入缓冲解析：不要假设一次读完

客户端同样要处理半包和粘包。
如果协议是按行返回，可以用：

```c
static void line_read_cb(struct bufferevent *bev, void *ctx) {
    (void)ctx;

    struct evbuffer *input = bufferevent_get_input(bev);

    for (;;) {
        size_t n = 0;
        char *line = evbuffer_readln(input, &n, EVBUFFER_EOL_CRLF);
        if (!line) {
            break;
        }

        printf("line: %.*s\n", (int)n, line);
        free(line);
    }
}
```

如果协议是二进制长度前缀，就要像服务端一样：

* 先检查包头够不够
* 再检查包体够不够
* 一次循环内尽量把完整消息都解析掉

---

## 8. 输出缓冲与写回调

`bufferevent_write()` 的语义是：

> 把数据追加到输出缓冲，之后由 libevent 在 socket 可写时异步发送。

```c
bufferevent_write(bev, data, len);
```

它不是阻塞式 `send()`。
调用成功只表示数据进入输出缓冲，不表示对端已经收到。

write callback 的触发条件是：

* 输出缓冲长度降到写低水位

这适合做发送完成后的动作：

```c
static void write_done_cb(struct bufferevent *bev, void *ctx) {
    struct evbuffer *output = bufferevent_get_output(bev);
    if (evbuffer_get_length(output) == 0) {
        // 请求已经全部刷入内核发送路径
    }
}
```

注意：

* 这仍然不等于对端应用层已处理
* 如果需要确认，协议层要有 ACK 或 response

---

## 9. 水位线：控制读写压力

读水位：

```c
bufferevent_setwatermark(bev, EV_READ, 1, 64 * 1024);
```

含义：

* 输入缓冲至少 1 字节时触发读回调
* 输入缓冲超过 64 KiB 时暂停继续读

写水位：

```c
bufferevent_setwatermark(bev, EV_WRITE, 0, 0);
```

多数简单客户端不用特别设置写水位。
但如果客户端会持续大批量发送，就应该给业务层加队列上限，避免输出缓冲无限增长。

---

## 10. 超时：连接、读、写都要考虑

```c
struct timeval rto = {10, 0};
struct timeval wto = {10, 0};
bufferevent_set_timeouts(bev, &rto, &wto);
```

常见理解：

* 非阻塞 connect 阶段通常靠写超时兜底
* 等响应阶段通常靠读超时兜底
* 大量数据发送阶段可能触发写超时

event callback 里处理：

```c
if (events & BEV_EVENT_TIMEOUT) {
    bufferevent_free(bev);
}
```

不要让客户端无限等服务端响应。
超时本身就是协议状态机的一部分。

---

## 11. 重连策略

客户端常常需要重连，但不能无脑死循环重连。

推荐策略：

* 连接失败后延迟重连
* 指数退避，例如 1s、2s、4s、8s
* 设置最大退避时间
* 手动关闭和网络错误要区分
* 重连前清理旧 `bufferevent`

用 libevent 定时器表达重连：

```c
struct event *timer = evtimer_new(base, reconnect_cb, ctx);
struct timeval delay = {2, 0};
evtimer_add(timer, &delay);
```

重连时再重新创建：

```text
new bufferevent -> set callbacks -> enable -> connect
```

不要试图在已经进入错误状态的 `bufferevent` 上反复复用所有状态。

---

## 12. `bufferevent_pair_new`：进程内自通信

libevent 还可以创建一对互联的 `bufferevent`：

```c
struct bufferevent *pair[2];
bufferevent_pair_new(base, BEV_OPT_CLOSE_ON_FREE, pair);
```

`pair[0]` 写入的数据会从 `pair[1]` 读到，反之亦然。
它常用于：

* 测试协议解析器
* 模拟连接
* 进程内组件通信

这不是网络 socket，但接口和 `bufferevent` 一致。

---

## 13. 客户端常见坑

### 13.1 `connect()` 前没设置回调和超时

事件可能很快到来，尤其是本机连接。

### 13.2 把 `bufferevent_write()` 当成发送完成

它只是写入输出缓冲。
应用层确认要靠协议 response。

### 13.3 使用阻塞 DNS

阻塞解析会卡住整个事件循环。
推荐使用 `bufferevent_socket_connect_hostname()`。

### 13.4 错误后复用旧 `bev`

收到 `EOF/ERROR/TIMEOUT` 后通常释放旧对象，重连时创建新的 `bufferevent`。

### 13.5 没有输出队列上限

如果对端慢或网络异常，输出缓冲可能持续增长。

---

## 14. 一页总结

libevent 客户端最重要的是：

1. `bufferevent_socket_new(base, -1, ...)` 创建未连接 I/O 对象
2. 先设置回调、启用事件和超时，再调用 connect
3. `BEV_EVENT_CONNECTED` 表示 TCP 连接建立完成
4. DNS 连接推荐用 `bufferevent_socket_connect_hostname`
5. `bufferevent_write` 只是写入输出缓冲，不等于对端收到
6. 读回调里仍然要做协议拆包
7. 重连要有退避，不要无限快速重试

如果只记一句：

> libevent 客户端的核心是把“连接中、已连接、读响应、写请求、失败重连”全部变成事件循环里的状态机。

---

## 15. 参考资料

1. libevent book: Ref6 bufferevent
   <https://libevent.org/libevent-book/Ref6_bufferevent.html>

2. libevent book: Ref9 dns
   <https://libevent.org/libevent-book/Ref9_dns.html>

3. libevent book: Ref4 event
   <https://libevent.org/libevent-book/Ref4_event.html>
