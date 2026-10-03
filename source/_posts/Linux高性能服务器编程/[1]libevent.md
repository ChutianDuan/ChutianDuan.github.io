---
title: "用了 `bufferevent`，为什么慢客户端仍能拖垮服务器？"
date: 2026-07-13 14:46:10
updated: 2026-07-13 14:46:10
categories:
  - "学习"
  - "Linux 服务器编程"
permalink: /notes/linux高性能服务器编程/1-libevent/
series: "Linux 服务器编程"
series_order: 1
---

时间：2026/05/04

> 关键词：libevent、Reactor、`event_base`、`evconnlistener`、`bufferevent`、`evbuffer`、水位、背压

libevent 能替我们处理非阻塞 socket、事件通知和收发缓冲，于是最简单的 Echo Server 只需要一行核心代码：

```c
evbuffer_add_buffer(output, input);
```

它把收到的所有数据移进发送缓冲，看上去既简洁又高效。

可如果客户端以每秒 10 MB 的速度发送，却只以每秒 10 KB 的速度接收回显，会发生什么？

```text
客户端快速发送
      ↓
libevent 输入缓冲
      ↓ read callback 不断搬运
libevent 输出缓冲持续增长
      ↓
慢客户端来不及接收
      ↓
服务器内存被连接逐步吃光
```

`bufferevent` 解决的是“怎样做缓冲式非阻塞 I/O”，并不会自动替业务决定“每个连接最多能积压多少数据”。本文就从这个问题出发，理解 libevent 的核心对象、回调语义、协议拆包和背压策略。

---

## 一、libevent 替我们做了什么，没有做什么？

手写一个 Reactor 风格 TCP 服务器，通常需要处理：

- 创建、绑定和监听 socket；
- 将 fd 设置为非阻塞；
- 注册 `epoll`、`kqueue` 或其他事件后端；
- 循环调用 `accept()`、`read()` 和 `write()`；
- 正确处理 `EINTR`、`EAGAIN` 和部分写；
- 管理定时器、信号和连接生命周期。

libevent 将它们映射为几个主要对象：

```text
epoll / kqueue / poll / select
              ↓
          event_base              事件循环
          ↙       ↘
evconnlistener   bufferevent      监听器与连接 I/O
                      ↓
             input/output evbuffer
                      ↓
                  业务回调
```

| 对象 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| `event_base` | 等待并分发事件 | 不替业务并行执行耗时任务 |
| `evconnlistener` | 监听、接收新连接 | 不管理连接协议状态 |
| `bufferevent` | 非阻塞读写、输入输出缓冲、超时 | 不定义消息边界和业务背压 |
| `evbuffer` | 保存、移动和消费字节 | 不知道哪些字节是一条完整消息 |

换句话说，libevent 降低了 I/O 编程的机械复杂度，但协议、安全、限流和资源所有权仍由应用决定。

---

## 二、一次 TCP 连接如何进入 libevent？

### 1. `event_base`：事件循环的所有者

最小生命周期是：

```c
struct event_base *base = event_base_new();
if (base == NULL) {
    /* 处理分配失败 */
}

event_base_dispatch(base);
event_base_free(base);
```

`event_base_dispatch()` 通常持续运行，直到没有注册事件，或代码调用：

```c
event_base_loopexit(base, NULL);  /* 完成本轮事件后尽快退出 */
event_base_loopbreak(base);       /* 打断当前循环 */
```

一个 `event_base` 通常由一个 I/O 线程驱动。回调也在这个线程中执行，因此回调里做一次 500 毫秒的计算，就可能让该循环管理的所有连接停顿 500 毫秒。

### 2. `evconnlistener`：封装监听与 `accept()`

创建并绑定 TCP 监听器：

```c
struct evconnlistener *listener = evconnlistener_new_bind(
    base,
    accept_cb,
    context,
    LEV_OPT_CLOSE_ON_FREE | LEV_OPT_REUSEABLE,
    -1,
    (const struct sockaddr *)&address,
    sizeof(address));
```

这里的历史拼写确实是 `REUSEABLE`。两个常用标志分别表示：

- `LEV_OPT_CLOSE_ON_FREE`：释放 listener 时关闭监听 fd；
- `LEV_OPT_REUSEABLE`：允许服务关闭后更快重新绑定同一地址。

默认情况下，listener 接收的新 socket 会被设为非阻塞。回调拿到的是已经完成 `accept()` 的连接 fd：

```c
static void accept_cb(struct evconnlistener *listener,
                      evutil_socket_t fd,
                      struct sockaddr *peer,
                      int peer_length,
                      void *context);
```

如果后续对象创建失败，回调必须关闭这个 fd；一旦把它交给带 `BEV_OPT_CLOSE_ON_FREE` 的 `bufferevent`，关闭责任就转移给 `bufferevent`。

### 3. `bufferevent`：连接 fd 加两只缓冲区

```c
struct bufferevent *bev = bufferevent_socket_new(
    base,
    fd,
    BEV_OPT_CLOSE_ON_FREE | BEV_OPT_DEFER_CALLBACKS);
```

可把它理解为：

```text
socket fd
  ├── input evbuffer  ← 内核读取的数据
  ├── output evbuffer → 等待写入内核的数据
  └── read / write / event 三类回调
```

`BEV_OPT_DEFER_CALLBACKS` 会把回调延迟到事件循环中调度，能够减少复杂依赖造成的回调嵌套和重入。它不等于把回调放到另一个线程。

新建 socket bufferevent 后，应设置回调并启用读取：

```c
bufferevent_setcb(bev, read_cb, write_cb, event_cb, context);
bufferevent_enable(bev, EV_READ | EV_WRITE);
```

---

## 三、三个回调的真实语义

### read callback：输入缓冲满足读条件

```c
static void read_cb(struct bufferevent *bev, void *context) {
    struct evbuffer *input = bufferevent_get_input(bev);
    /* 从 input 中循环解析完整消息 */
}
```

一次回调不等于一条业务消息。TCP 是字节流，本次可能只有半个包头，也可能含有十条消息。

### write callback：输出缓冲降到写低水位

它不是“每调用一次 `bufferevent_write()` 就触发一次”。更准确的语义是：输出缓冲已被充分排空，长度达到或低于写低水位。

因此 write callback 适合：

- 恢复被暂停的上游读取；
- 继续生产下一批输出；
- 在数据真正排空后关闭连接。

### event callback：连接状态变化

常见标志包括：

| 标志 | 含义 |
| --- | --- |
| `BEV_EVENT_CONNECTED` | 主动连接完成，客户端更常见 |
| `BEV_EVENT_EOF` | 对端关闭写方向或连接结束 |
| `BEV_EVENT_ERROR` | 发生不可恢复错误 |
| `BEV_EVENT_TIMEOUT` | 配置的读或写超时触发 |
| `BEV_EVENT_READING` / `WRITING` | 错误发生在哪个方向 |

出现 EOF 时立即 `bufferevent_free()`，会放弃仍在输出缓冲中的数据。若协议要求“回完最后一条响应再关闭”，就要进入 `closing` 状态，停止读取，等待输出缓冲排空后再释放。

---

## 四、完整示例：有内存上限的 Echo Server

下面的 C11 示例给每个连接设置 256 KiB 输出上限：达到上限便暂停读取，输出降到 64 KiB 后再恢复。它演示的是背压骨架，不包含 TLS、鉴权和优雅停机。

> 适用 libevent 2.x。不同发行版的链接参数可能不同，应以项目现有构建配置为准。

```c
#include <event2/buffer.h>
#include <event2/bufferevent.h>
#include <event2/event.h>
#include <event2/listener.h>
#include <event2/util.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum {
    OUTPUT_LOW_WATERMARK = 64 * 1024,
    OUTPUT_LIMIT = 256 * 1024
};

struct connection {
    int closing;
};

static void close_connection(struct bufferevent *bev, struct connection *conn) {
    bufferevent_free(bev);
    free(conn);
}

static int pump_echo(struct bufferevent *bev) {
    struct evbuffer *input = bufferevent_get_input(bev);
    struct evbuffer *output = bufferevent_get_output(bev);
    size_t input_length = evbuffer_get_length(input);
    size_t output_length = evbuffer_get_length(output);

    if (output_length >= OUTPUT_LIMIT) {
        bufferevent_disable(bev, EV_READ);
        return 0;
    }

    size_t capacity = OUTPUT_LIMIT - output_length;
    size_t amount = input_length < capacity ? input_length : capacity;
    if (amount > 0 && evbuffer_remove_buffer(input, output, amount) < 0) {
        return -1;
    }

    if (evbuffer_get_length(input) > 0 ||
        evbuffer_get_length(output) >= OUTPUT_LIMIT) {
        bufferevent_disable(bev, EV_READ);
    } else {
        bufferevent_enable(bev, EV_READ);
    }
    return 0;
}

static void read_cb(struct bufferevent *bev, void *context) {
    struct connection *conn = context;
    if (!conn->closing && pump_echo(bev) < 0) {
        close_connection(bev, conn);
    }
}

static void write_cb(struct bufferevent *bev, void *context) {
    struct connection *conn = context;
    struct evbuffer *input = bufferevent_get_input(bev);
    struct evbuffer *output = bufferevent_get_output(bev);

    if (conn->closing) {
        if (pump_echo(bev) < 0) {
            close_connection(bev, conn);
            return;
        }
        bufferevent_disable(bev, EV_READ);
        if (evbuffer_get_length(input) == 0 &&
            evbuffer_get_length(output) == 0) {
            close_connection(bev, conn);
        }
        return;
    }

    if (pump_echo(bev) < 0) {
        close_connection(bev, conn);
    }
}

static void event_cb(struct bufferevent *bev, short events, void *context) {
    struct connection *conn = context;

    if (events & BEV_EVENT_ERROR) {
        int error = EVUTIL_SOCKET_ERROR();
        fprintf(stderr, "connection error: %s\n",
                evutil_socket_error_to_string(error));
    }

    if (events & BEV_EVENT_EOF) {
        conn->closing = 1;
        if (pump_echo(bev) < 0) {
            close_connection(bev, conn);
            return;
        }
        bufferevent_disable(bev, EV_READ);
        bufferevent_setwatermark(bev, EV_WRITE, 0, 0);
        if (evbuffer_get_length(bufferevent_get_input(bev)) == 0 &&
            evbuffer_get_length(bufferevent_get_output(bev)) == 0) {
            close_connection(bev, conn);
        }
        return;
    }

    if (events & (BEV_EVENT_ERROR | BEV_EVENT_TIMEOUT)) {
        close_connection(bev, conn);
    }
}

static void accept_cb(struct evconnlistener *listener,
                      evutil_socket_t fd,
                      struct sockaddr *peer,
                      int peer_length,
                      void *context) {
    (void)peer;
    (void)peer_length;
    (void)context;

    struct event_base *base = evconnlistener_get_base(listener);
    struct connection *conn = calloc(1, sizeof(*conn));
    if (conn == NULL) {
        evutil_closesocket(fd);
        return;
    }

    struct bufferevent *bev = bufferevent_socket_new(
        base, fd, BEV_OPT_CLOSE_ON_FREE | BEV_OPT_DEFER_CALLBACKS);
    if (bev == NULL) {
        free(conn);
        evutil_closesocket(fd);
        return;
    }

    bufferevent_setcb(bev, read_cb, write_cb, event_cb, conn);
    bufferevent_setwatermark(bev, EV_WRITE, OUTPUT_LOW_WATERMARK, 0);

    struct timeval read_timeout = {60, 0};
    struct timeval write_timeout = {30, 0};
    bufferevent_set_timeouts(bev, &read_timeout, &write_timeout);
    bufferevent_enable(bev, EV_READ | EV_WRITE);
}

static void listener_error_cb(struct evconnlistener *listener, void *context) {
    (void)context;
    int error = EVUTIL_SOCKET_ERROR();
    fprintf(stderr, "listener error: %s\n",
            evutil_socket_error_to_string(error));
    event_base_loopexit(evconnlistener_get_base(listener), NULL);
}

int main(int argc, char **argv) {
    int port = argc == 2 ? atoi(argv[1]) : 9876;
    if (port < 1 || port > 65535) {
        fprintf(stderr, "usage: %s [port]\n", argv[0]);
        return 1;
    }

    struct event_base *base = event_base_new();
    if (base == NULL) {
        fprintf(stderr, "event_base_new failed\n");
        return 1;
    }

    struct sockaddr_in address;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_ANY);
    address.sin_port = htons((uint16_t)port);

    struct evconnlistener *listener = evconnlistener_new_bind(
        base, accept_cb, NULL,
        LEV_OPT_CLOSE_ON_FREE | LEV_OPT_REUSEABLE,
        -1, (const struct sockaddr *)&address, sizeof(address));
    if (listener == NULL) {
        fprintf(stderr, "evconnlistener_new_bind failed\n");
        event_base_free(base);
        return 1;
    }

    evconnlistener_set_error_cb(listener, listener_error_cb);
    printf("echo server listening on 0.0.0.0:%d\n", port);
    event_base_dispatch(base);

    evconnlistener_free(listener);
    event_base_free(base);
    return 0;
}
```

如果项目已安装 libevent 并提供 `pkg-config` 元数据，可编译为：

```bash
cc -std=c11 -Wall -Wextra -Wpedantic bounded_echo.c \
  $(pkg-config --cflags --libs libevent) -o bounded_echo
```

手工测试：

```bash
./bounded_echo 9876
nc 127.0.0.1 9876
```

这段代码的重点不是 Echo 功能，而是数据流被明确限制：

```text
output < 256 KiB  → 允许继续读取
output ≥ 256 KiB  → bufferevent_disable(EV_READ)
output ≤ 64 KiB   → write callback 恢复读取
```

暂停 `EV_READ` 会把反压逐步传回内核接收缓冲和 TCP 接收窗口。若客户端仍不消费，写超时最终负责回收连接。

---

## 五、水位线为什么不等于完整的背压策略？

设置读取高水位：

```c
bufferevent_setwatermark(bev, EV_READ, 1, 64 * 1024);
```

它表示输入缓冲达到 64 KiB 后暂停从底层继续读取。但如果 read callback 每次都立即把输入搬到输出，输入缓冲会迅速变空，读取又能继续，输出仍可能无限增长。

写水位的语义也不同：

```c
bufferevent_setwatermark(bev, EV_WRITE, 64 * 1024, 0);
```

它主要控制输出降到低水位时何时调用 write callback，并不会替应用拒绝继续向输出缓冲追加数据。因此资源策略至少要同时回答：

- 单连接最大输入、输出和业务队列是多少？
- 达到上限后暂停、丢弃还是断开？
- 什么条件下恢复生产？
- 全局内存吃紧时怎样保证公平？

只有限制单连接还不够。一百万个连接各允许积压 256 KiB，理论上仍是巨量内存。生产服务还需要全局预算、用户级预算和过载降级。

---

## 六、`evbuffer` 怎样解析 TCP 半包？

假设协议格式为：

```text
4 字节网络序正文长度 + 正文字节
```

读取回调必须循环解析，直到缓冲区不足一条完整消息：

```c
#include <arpa/inet.h>
#include <event2/buffer.h>
#include <stdint.h>

enum { MAX_BODY_SIZE = 1024 * 1024 };

static int parse_messages(struct evbuffer *input) {
    for (;;) {
        if (evbuffer_get_length(input) < sizeof(uint32_t)) {
            return 0;
        }

        uint32_t network_length;
        if (evbuffer_copyout(input, &network_length,
                             sizeof(network_length)) != sizeof(network_length)) {
            return -1;
        }

        uint32_t body_length = ntohl(network_length);
        if (body_length > MAX_BODY_SIZE) {
            return -1;
        }

        size_t frame_length = sizeof(network_length) + (size_t)body_length;
        if (evbuffer_get_length(input) < frame_length) {
            return 0;
        }

        evbuffer_drain(input, sizeof(network_length));
        /* 此处按业务需要移动或消费 body_length 字节。 */
        evbuffer_drain(input, body_length);
    }
}
```

判断顺序很重要：

1. 不够固定包头就等待；
2. 先校验长度上限，防止恶意长度触发大内存分配；
3. 不够完整包体就等待；
4. 够一帧才消费，并继续解析下一帧。

常用 `evbuffer` API：

| API | 行为 |
| --- | --- |
| `evbuffer_get_length()` | 查询当前字节数 |
| `evbuffer_copyout()` | 复制但不消费 |
| `evbuffer_remove()` | 复制并消费 |
| `evbuffer_drain()` | 不复制，直接消费 |
| `evbuffer_add()` | 追加字节 |
| `evbuffer_add_buffer()` | 尽量少拷贝地移动全部数据 |
| `evbuffer_remove_buffer()` | 尽量少拷贝地移动指定长度 |

不要缓存 `evbuffer_pullup()` 返回的内部指针并跨越缓冲区修改操作使用；缓冲变化后，内部存储位置可能改变。

---

## 七、超时并不是一个万能的“空闲计时器”

```c
struct timeval read_timeout = {60, 0};
struct timeval write_timeout = {30, 0};
bufferevent_set_timeouts(bev, &read_timeout, &write_timeout);
```

读写超时统计的是 bufferevent 希望执行相应 I/O、却长期没有成功进展的时间。若读取被应用禁用，或输入缓冲已达到高水位，读超时并不继续按“连接空闲时间”工作。

因此需要区分：

- I/O 读写超时：网络长期没有进展；
- 协议握手超时：建立连接后迟迟不完成认证；
- 业务空闲超时：用户多久没有发送有效请求；
- 心跳超时：对端是否仍处于应用层活跃状态。

后面三种通常应使用独立 timer 和连接状态实现，而不是全部依赖 `bufferevent_set_timeouts()`。

---

## 八、多线程：一个连接最好只归一个 I/O 线程

libevent 可以通过平台线程支持启用内部锁，例如 POSIX 线程环境：

```c
#include <event2/thread.h>

evthread_use_pthreads();  /* 必须在创建 event_base 之前调用 */
```

但线程安全能力不意味着多个线程应该随意操作同一个连接。更清晰的模型是：

```text
accept 线程
    ↓ 将新 fd 投递到有界队列
I/O 线程 0 ─ event_base 0 ─ 管理一组固定连接
I/O 线程 1 ─ event_base 1 ─ 管理另一组固定连接
    ↓ 将耗时任务投递到业务线程池
业务完成
    ↓ 把结果投递回原 I/O 线程
原 I/O 线程操作 bufferevent
```

这样做的价值是明确连接所有权并减少锁竞争。跨线程投递还必须有队列容量、唤醒机制、失败策略和优雅退出；只用一个无上限队列把 fd 或任务不断塞给 worker，同样会把压力从 socket 缓冲搬到用户态队列。

对于入门服务，不要急着把单线程 Echo 扩展成复杂线程池。先用指标证明一个事件循环的 I/O 或业务计算已成为瓶颈，再选择拆分方式。

---

## 九、常见错误与排查方向

### 1. 忘记 `BEV_OPT_CLOSE_ON_FREE`

释放 `bufferevent` 后底层 fd 仍打开，最终可能耗尽进程的文件描述符。若不使用该标志，就必须明确由谁关闭 fd，不能两边都关或都不关。

### 2. 回调里假设“一次就是一条消息”

TCP 没有消息边界。使用固定头、长度前缀或明确分隔符，并在 `evbuffer` 中循环解析。

### 3. 输出缓冲没有上限

重点监控每连接及全局输出积压。慢客户端应触发暂停读取、超时、降级或断开策略。

### 4. EOF 时立即释放，最后响应丢失

如果输出尚未排空，需要进入关闭状态，等 write callback 确认排空后再释放。错误和超时通常可以直接关闭。

### 5. 在 I/O 回调中执行耗时业务

记录回调耗时和事件循环延迟。数据库慢查询、压缩、大 JSON 解析和模型推理都不应长期占用 I/O 线程。

### 6. 误以为启用 `BEV_OPT_THREADSAFE` 就没有竞态

内部加锁只能保护部分对象操作，不能自动保护业务状态，也不能解决回调顺序、对象生命周期和队列过载问题。

---

## 十、总结

libevent 的入门重点不是记住 API 名称，而是掌握数据和所有权怎样流动：

1. `event_base` 驱动事件循环，回调不能长时间阻塞；
2. `evconnlistener` 接管监听，accept 回调接收新连接 fd；
3. `bufferevent` 管理非阻塞 I/O 和输入、输出 `evbuffer`；
4. read callback 解析字节流，write callback 表示输出降到低水位，event callback 管理生命周期；
5. 输入高水位只能限制输入缓冲，不能阻止业务无限填充输出缓冲；
6. 真正的背压需要容量上限、暂停与恢复条件、超时以及全局资源预算；
7. TCP 消息边界、业务状态、安全和多线程所有权仍需要应用自己设计。

如果只记住一句话：

> `bufferevent` 让非阻塞 I/O 更容易写，但服务器能否在慢客户端和突发流量下保持稳定，取决于你是否给每条数据流设置了明确的边界。

---

## 参考资料

- [Libevent Book：Bufferevent 概念、回调、水位与超时](https://libevent.org/libevent-book/Ref6_bufferevent.html)
- [Libevent Book：Evbuffer 操作](https://libevent.org/libevent-book/Ref7_evbuffer.html)
- [Libevent Book：Connection listener](https://libevent.org/libevent-book/Ref8_listener.html)
