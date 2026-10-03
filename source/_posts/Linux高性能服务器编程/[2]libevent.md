---
title: "`bufferevent_socket_connect()` 返回 0，为什么客户端仍然没连上？"
date: 2026-07-13 14:50:00
updated: 2026-07-13 14:50:00
categories:
  - "学习"
  - "Linux 服务器编程"
permalink: /notes/linux高性能服务器编程/2-libevent/
series: "Linux 服务器编程"
series_order: 2
---

时间：2026/05/04

> 关键词：libevent、异步连接、`BEV_EVENT_CONNECTED`、异步 DNS、状态机、超时、指数退避

第一次使用 libevent 写 TCP 客户端，很容易写出下面的判断：

```c
if (bufferevent_socket_connect(bev, address, address_length) == 0) {
    puts("连接成功");
    bufferevent_write(bev, request, request_length);
}
```

程序打印了“连接成功”，服务端却可能根本没有启动。原因不是 libevent 判断错了，而是我们误解了返回值：

> 返回 0 表示非阻塞连接操作已成功发起，不表示 TCP 连接已经建立。

真正的连接结果稍后才会进入 event callback。连接成功表现为 `BEV_EVENT_CONNECTED`，DNS、拒绝连接、超时等失败则表现为错误或超时事件。

这会进一步引出客户端最重要的设计问题：异步连接、发送请求、等待响应和失败重试不能写成一串同步语句，而要组织成一个有边界的状态机。

本文将完成一个 libevent 2.x 客户端，它能够：

1. 异步解析 IPv4 或 IPv6 主机名；
2. 正确等待连接完成事件；
3. 发送一行请求并读取一行响应；
4. 对连接和响应设置超时；
5. 失败后指数退避，最多尝试五次。

---

## 一、问题出在哪里：返回值回答的不是“连上了吗”

传统阻塞 `connect()` 会等到连接建立或失败后才返回。libevent 的 socket bufferevent 使用非阻塞连接，时间线更像这样：

```text
业务代码                     libevent / 内核                    服务端
   │                               │                              │
   ├─ socket_connect() ───────────▶│ 发起非阻塞 connect           │
   │◀─ 返回 0：已发起              │                              │
   │                               ├──── TCP 握手 ───────────────▶│
   │                               │◀─────────────────────────────│
   │◀─ BEV_EVENT_CONNECTED ────────┤                              │
   ├─ 写入应用层请求 ─────────────▶│                              │
```

如果端口没有监听，前半段仍可能返回 0，稍后才收到 `BEV_EVENT_ERROR`。

| 观察位置 | 成功意味着什么 |
| --- | --- |
| `bufferevent_socket_connect()` 返回 0 | 成功启动连接尝试 |
| 收到 `BEV_EVENT_CONNECTED` | TCP 连接已建立 |
| `bufferevent_write()` 返回 0 | 数据已追加到输出缓冲 |
| 输出缓冲变空 | 数据已交给底层发送路径，不代表对端业务已处理 |
| 收到协议响应 | 对端至少按协议返回了结果 |

这些事件处在不同层次，不能用前一层的成功代替后一层的确认。

---

## 二、客户端为什么需要状态机？

同步代码依赖调用顺序表达状态，异步代码却会在未来的不同回调中继续执行。若没有显式状态，很难回答：当前超时到底发生在连接阶段，还是等待响应阶段？EOF 是正常结束，还是响应尚未完成？

本文的状态流转为：

```text
IDLE
  ↓ start_connection()
CONNECTING
  ├─ CONNECTED ─▶ WAITING_RESPONSE ─▶ DONE
  └─ ERROR/TIMEOUT ─▶ RETRY_WAIT ─────┘
                         │
                         └─ 定时器到期后重新 CONNECTING
```

状态机不是为了增加抽象，而是为了给三个问题明确答案：

- 哪个回调现在允许做什么？
- 本次超时和错误应怎样解释？
- 旧连接的资源何时释放，何时创建新连接？

对于只有一次请求的小客户端，一个枚举和一个上下文结构就足够，不需要引入复杂框架。

---

## 三、为什么 DNS 也必须进入事件循环？

主机名连接可以写成：

```c
bufferevent_socket_connect_hostname(
    bev, dns_base, AF_UNSPEC, "example.com", 443);
```

其中 `AF_UNSPEC` 允许解析 IPv4 或 IPv6 地址。关键在第二个参数：如果传入 `NULL`，libevent 可能使用阻塞式名称解析，整个事件循环会在 DNS 返回前停止处理其他连接和定时器。

正确做法是让 `evdns_base` 与 `event_base` 关联，并让它活到所有相关连接尝试结束：

```c
struct evdns_base *dns = evdns_base_new(base, 1);
```

DNS 失败也通过 bufferevent 的 event callback 到达。此时要先读取 DNS 错误，再释放 `bufferevent`：

```c
int dns_error = bufferevent_socket_get_dns_error(bev);
if (dns_error != 0) {
    fprintf(stderr, "DNS error: %s\n", evutil_gai_strerror(dns_error));
}
```

---

## 四、最小可运行版本：异步连接、超时与退避重试

下面的程序使用 C11 和 libevent 2.x，面向 Linux、macOS 等类 Unix 环境。它连接指定主机，发送 `ping\n`，读取以换行结束的一条响应。Windows 的头文件和链接方式不同，需要结合目标环境调整。

```c
#include <event2/buffer.h>
#include <event2/bufferevent.h>
#include <event2/dns.h>
#include <event2/event.h>
#include <event2/util.h>

#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>

enum client_state {
    STATE_IDLE,
    STATE_CONNECTING,
    STATE_WAITING_RESPONSE,
    STATE_RETRY_WAIT,
    STATE_DONE
};

struct client {
    struct event_base *base;
    struct evdns_base *dns;
    struct bufferevent *bev;
    struct event *retry_timer;
    const char *host;
    int port;
    int attempt;
    int max_attempts;
    int exit_code;
    enum client_state state;
};

static int start_connection(struct client *client);
static void schedule_retry(struct client *client);

static const char *state_name(enum client_state state) {
    switch (state) {
    case STATE_IDLE: return "IDLE";
    case STATE_CONNECTING: return "CONNECTING";
    case STATE_WAITING_RESPONSE: return "WAITING_RESPONSE";
    case STATE_RETRY_WAIT: return "RETRY_WAIT";
    case STATE_DONE: return "DONE";
    }
    return "UNKNOWN";
}

static void release_connection(struct client *client) {
    if (client->bev != NULL) {
        struct bufferevent *old = client->bev;
        client->bev = NULL;
        bufferevent_free(old);
    }
}

static void finish(struct client *client, int exit_code) {
    client->state = STATE_DONE;
    client->exit_code = exit_code;
    release_connection(client);
    event_base_loopexit(client->base, NULL);
}

static void read_cb(struct bufferevent *bev, void *context) {
    struct client *client = context;
    struct evbuffer *input = bufferevent_get_input(bev);
    size_t length = 0;
    char *line = evbuffer_readln(input, &length, EVBUFFER_EOL_LF);

    if (line == NULL) {
        return;  /* 半行仍留在 input，等待后续字节 */
    }

    printf("response (%zu bytes): %s\n", length, line);
    free(line);
    finish(client, 0);
}

static void event_cb(struct bufferevent *bev, short events, void *context) {
    struct client *client = context;

    if (events & BEV_EVENT_CONNECTED) {
        static const char request[] = "ping\n";
        client->state = STATE_WAITING_RESPONSE;
        printf("connected, state=%s\n", state_name(client->state));

        struct timeval response_timeout = {10, 0};
        bufferevent_set_timeouts(bev, &response_timeout,
                                 &response_timeout);
        if (bufferevent_write(bev, request, sizeof(request) - 1) < 0) {
            fprintf(stderr, "could not queue request\n");
            release_connection(client);
            schedule_retry(client);
        }
        return;
    }

    int dns_error = bufferevent_socket_get_dns_error(bev);
    if (dns_error != 0) {
        fprintf(stderr, "DNS error: %s\n", evutil_gai_strerror(dns_error));
    } else if (events & BEV_EVENT_TIMEOUT) {
        fprintf(stderr, "timeout in state %s\n",
                state_name(client->state));
    } else if (events & BEV_EVENT_ERROR) {
        int socket_error = EVUTIL_SOCKET_ERROR();
        fprintf(stderr, "socket error: %s\n",
                evutil_socket_error_to_string(socket_error));
    } else if (events & BEV_EVENT_EOF) {
        fprintf(stderr, "peer closed before a complete response line\n");
    } else {
        return;
    }

    release_connection(client);
    schedule_retry(client);
}

static int start_connection(struct client *client) {
    client->attempt += 1;
    client->state = STATE_CONNECTING;
    printf("attempt %d/%d: %s:%d, state=%s\n",
           client->attempt, client->max_attempts,
           client->host, client->port, state_name(client->state));

    client->bev = bufferevent_socket_new(
        client->base, -1,
        BEV_OPT_CLOSE_ON_FREE | BEV_OPT_DEFER_CALLBACKS);
    if (client->bev == NULL) {
        fprintf(stderr, "bufferevent_socket_new failed\n");
        return -1;
    }

    bufferevent_setcb(client->bev, read_cb, NULL, event_cb, client);
    bufferevent_enable(client->bev, EV_READ | EV_WRITE);

    struct timeval connect_timeout = {5, 0};
    bufferevent_set_timeouts(client->bev, &connect_timeout,
                             &connect_timeout);

    if (bufferevent_socket_connect_hostname(
            client->bev, client->dns, AF_UNSPEC,
            client->host, client->port) < 0) {
        fprintf(stderr, "could not launch connection attempt\n");
        release_connection(client);
        return -1;
    }
    return 0;
}

static void retry_cb(evutil_socket_t fd, short events, void *context) {
    (void)fd;
    (void)events;
    struct client *client = context;

    if (start_connection(client) < 0) {
        schedule_retry(client);
    }
}

static void schedule_retry(struct client *client) {
    if (client->attempt >= client->max_attempts) {
        fprintf(stderr, "giving up after %d attempts\n", client->attempt);
        finish(client, 1);
        return;
    }

    int shift = client->attempt - 1;
    if (shift > 5) {
        shift = 5;
    }
    struct timeval delay = {1L << shift, 0};
    client->state = STATE_RETRY_WAIT;
    fprintf(stderr, "retry in %ld seconds\n", (long)delay.tv_sec);

    if (evtimer_add(client->retry_timer, &delay) < 0) {
        fprintf(stderr, "could not schedule retry timer\n");
        finish(client, 1);
    }
}

int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: %s HOST PORT\n", argv[0]);
        return 1;
    }

    char *end = NULL;
    long port = strtol(argv[2], &end, 10);
    if (*argv[2] == '\0' || *end != '\0' || port < 1 || port > 65535) {
        fprintf(stderr, "invalid port: %s\n", argv[2]);
        return 1;
    }

    struct client client = {0};
    client.host = argv[1];
    client.port = (int)port;
    client.max_attempts = 5;
    client.exit_code = 1;
    client.state = STATE_IDLE;

    client.base = event_base_new();
    if (client.base == NULL) {
        fprintf(stderr, "event_base_new failed\n");
        return 1;
    }

    client.dns = evdns_base_new(client.base, 1);
    client.retry_timer = evtimer_new(client.base, retry_cb, &client);
    if (client.dns == NULL || client.retry_timer == NULL) {
        fprintf(stderr, "could not initialize DNS or retry timer\n");
        if (client.retry_timer != NULL) event_free(client.retry_timer);
        if (client.dns != NULL) evdns_base_free(client.dns, 0);
        event_base_free(client.base);
        return 1;
    }

    if (start_connection(&client) < 0) {
        schedule_retry(&client);
    }
    event_base_dispatch(client.base);

    release_connection(&client);
    event_free(client.retry_timer);
    evdns_base_free(client.dns, 0);
    event_base_free(client.base);
    return client.exit_code;
}
```

如果项目已经安装 libevent 并提供 `pkg-config` 配置，可以编译：

```bash
cc -std=c11 -Wall -Wextra -Wpedantic async_client.c \
  $(pkg-config --cflags --libs libevent) -o async_client
```

测试时先启动上一篇的 Echo Server，或者使用能按行回显的测试服务：

```bash
./bounded_echo 9876
./async_client localhost 9876
```

成功时可看到：

```text
attempt 1/5: localhost:9876, state=CONNECTING
connected, state=WAITING_RESPONSE
response (4 bytes): ping
```

如果端口没有监听，客户端会在失败后按 1、2、4、8 秒等间隔重试，达到五次后退出。实际等待时间受错误返回速度影响。

---

## 五、这段代码怎样保证连接状态不混乱？

### 1. 先装好回调，再发起连接

`start_connection()` 的顺序是：

```text
创建 bufferevent
  → 设置 read/event callback
  → 启用 EV_READ/EV_WRITE
  → 配置超时
  → 发起 DNS 与 connect
```

本机连接可能极快完成。先准备回调，可以确保事件进入循环时已经有处理者。

### 2. 只在 `BEV_EVENT_CONNECTED` 后进入协议阶段

连接事件到达前，状态始终是 `CONNECTING`。成功后才改为 `WAITING_RESPONSE` 并写入请求。这样，连接超时和响应超时就能通过状态日志区分。

libevent 允许在连接完成前向输出缓冲追加数据，但显式等待连接事件更适合需要握手、鉴权或状态追踪的客户端。

### 3. 旧连接先释放，重试由定时器启动

失败路径不会在 event callback 中立刻递归调用 `start_connection()`，而是：

```text
释放失败的 bev
  → 设置一次性 retry timer
  → 回到事件循环
  → 定时器到期后创建全新的 bev
```

这既明确了对象所有权，也防止持续失败时形成高速重连循环。

### 4. 半行不会被误当成完整响应

`evbuffer_readln()` 只在输入缓冲出现换行符后返回。若 TCP 本次只送来 `po`，回调会退出；后续到达 `ng\n` 后，整个 `pong` 才被取出。

这再次说明：read callback 表示“有字节可处理”，不是“收到一条完整消息”。二进制协议应改用长度前缀并设置最大消息长度。

---

## 六、超时为什么必须与协议状态对应？

`bufferevent_set_timeouts()` 的读写超时，统计的是 bufferevent 希望读写、却没有成功取得进展的时间。本文在不同阶段重新配置超时：

| 状态 | 需要防止什么 |
| --- | --- |
| `CONNECTING` | DNS 或网络连接长期没有结果 |
| `WAITING_RESPONSE` | 服务端接受连接却不返回完整响应 |
| `RETRY_WAIT` | 由独立 timer 决定下一次尝试时间 |

对于更复杂的协议，仅靠读写超时仍不够。例如服务端每 9 秒发送一个无意义字节，可能让 10 秒读超时永远不触发，但完整响应始终没有到达。这时应另设“整个请求必须在 30 秒内完成”的总截止时间。

超时发生后也不能盲目重试所有请求。查询通常容易重试，支付、创建订单等非幂等操作则可能已经被服务器执行，只是响应在途中丢失。此类协议需要请求 ID、去重或结果查询机制。

---

## 七、指数退避还缺少什么？

固定间隔立即重连会制造惊群：服务器重启时，成千上万个客户端可能在同一秒发起连接，让刚恢复的服务再次过载。

本文使用有上限的指数退避：

```text
第 1 次失败 → 等 1 秒
第 2 次失败 → 等 2 秒
第 3 次失败 → 等 4 秒
第 4 次失败 → 等 8 秒
……最终限制到最大间隔
```

生产实现通常还要增加随机抖动（jitter），把客户端的重试时刻打散。同时应区分：

- 临时网络错误：可以退避重试；
- 永久配置错误：非法主机名、证书或凭据错误通常不应无限重试；
- 用户主动停止：不应自动重连；
- 非幂等请求结果未知：先查询状态，而不是直接重放。

重试是一种负载，不是免费的容错能力。

---

## 八、输出缓冲变空，为什么仍不算“发送成功”？

`bufferevent_write()` 把数据复制或追加到输出 `evbuffer`，随后 libevent 在 socket 可写时逐步发送。write callback 在输出降到低水位时触发。

```text
业务数据
  → bufferevent output
  → 本机 socket 发送缓冲
  → 网络
  → 对端 socket 接收缓冲
  → 对端应用处理
```

输出缓冲为空最多证明数据已经离开 libevent 的用户态输出队列，不能证明它越过了后续所有环节。如果业务需要“订单已受理”之类确认，必须等待应用层 response 或 ACK。

持续生产数据的客户端也要限制输出积压。若传感器每秒产生 10 MB，而网络只能发送 1 MB，输出缓冲最终仍会耗尽内存。可采用有界业务队列、暂停生产、合并过期状态或主动断开等策略；仅设置写水位不会自动阻止 `bufferevent_write()` 继续追加数据。

---

## 九、常见误区

### 误区 1：connect 接口返回 0 就可以宣布连接成功

返回 0 只是成功发起。只有 `BEV_EVENT_CONNECTED` 表示 TCP 建连完成。

### 误区 2：主机名连接天然是异步的

`bufferevent_socket_connect_hostname()` 若没有可用的 `evdns_base`，名称解析可能阻塞。事件循环程序应显式配置异步 DNS。

### 误区 3：收到连接事件代表应用协议可用

TCP 建连后可能还需 TLS、认证、版本协商或业务握手。应该继续推进状态，而不是直接标记整个任务成功。

### 误区 4：EOF 是正常完成

只有协议状态已经完整时，EOF 才可能是预期结束。本文在完整响应行之前收到 EOF，会将其视为失败。

### 误区 5：失败后立即创建新连接最可靠

高速重连会消耗客户端和服务器资源。应限制次数、指数退避并在生产环境加入抖动。

### 误区 6：错误后的旧 `bufferevent` 可以一直复用

进入不可恢复的 EOF、错误或超时后，创建新的 bufferevent 能让 fd、缓冲和回调状态重新回到明确起点。不要让新旧尝试共享模糊的连接状态。

---

## 十、什么时候适合这样使用 libevent 客户端？

libevent 客户端适合：

- 一个事件循环需要管理大量并发 TCP 连接；
- 项目已经使用 libevent，需要统一 socket、定时器和 DNS；
- 协议是流式或长连接，业务愿意显式维护连接状态；
- 需要精细控制缓冲、超时和重连策略。

如果程序只发起一次短连接请求，同步阻塞 I/O 配合明确超时可能更简单。如果目标协议是 HTTP，不应从裸 bufferevent 手写完整 HTTP 解析器；可以使用成熟 HTTP 客户端或结合项目现有的 `evhttp` 能力。TLS 场景也应使用经过验证的 TLS bufferevent 和证书验证配置，而不是在明文示例上自行拼接加密逻辑。

---

## 十一、总结

回到开头的问题：`bufferevent_socket_connect()` 返回 0 后仍可能没有连接，是因为它只启动了异步操作，最终结果尚未产生。

真正需要记住的是：

1. `BEV_EVENT_CONNECTED` 才表示 TCP 建连完成，不代表应用请求已经成功；
2. DNS、连接、请求和响应都应成为状态机中的明确阶段；
3. 主机名连接要提供 `evdns_base`，否则解析可能阻塞事件循环；
4. 超时要结合当前协议状态解释，重试还要考虑幂等性；
5. 失败连接应释放，重连应使用有上限的指数退避和随机抖动；
6. 写入输出缓冲不等于对端已经处理，业务成功必须由协议确认。

可以直接用于实践的一条建议是：**为每次连接尝试打印“状态、尝试次数、错误类别和下一次重试时间”，它比单独一行 `connect failed` 更能解释异步客户端真正发生了什么。**

---

## 参考资料

- [Libevent Book：Bufferevent 连接、回调与主机名解析](https://libevent.org/libevent-book/Ref6_bufferevent.html)
- [Libevent Book：异步 DNS](https://libevent.org/libevent-book/Ref9_dns.html)
- [Libevent Book：事件与定时器](https://libevent.org/libevent-book/Ref4_event.html)
