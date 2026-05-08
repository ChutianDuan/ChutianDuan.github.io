---
title: "libevent 服务端入门：`event_base`、`evconnlistener` 与 `bufferevent`"
date: 2026-05-05 09:17:08
updated: 2026-05-05 09:17:08
categories:
  - "学习"
  - "Linux高性能服务器编程"
permalink: /notes/linux高性能服务器编程/1-libevent/
---

# libevent 服务端入门：`event_base`、`evconnlistener` 与 `bufferevent`

时间：2026/05/04

> 关键词：libevent、Reactor、`event_base`、`evconnlistener`、`bufferevent`、`evbuffer`、TCP 服务端
> 核心目标：理解 libevent 如何把 `socket + epoll + 非阻塞 I/O + 缓冲区` 封装成事件驱动服务端模型。

---

## 1. libevent 在解决什么问题

如果手写一个高并发 TCP 服务端，通常要自己处理：

* 创建、绑定、监听 socket
* 设置非阻塞
* `epoll` 注册和事件循环
* `accept/read/write` 的错误码
* 半包、粘包、发送缓冲积压
* 定时器和超时清理

libevent 的目标是把这些底层细节抽象成：

* `event_base`：事件循环
* `event`：普通 fd / timer / signal 事件
* `evconnlistener`：监听 socket 与 accept 封装
* `bufferevent`：带输入/输出缓冲区的连接 I/O 对象
* `evbuffer`：高效缓冲区

可以粗略理解成：

```text
epoll/kqueue/select 等后端
        ↑
    event_base
        ↑
evconnlistener / bufferevent / event
        ↑
      业务回调
```

---

## 2. 一个 TCP Reactor 在 libevent 里的映射

手写 Reactor：

```text
listen fd readable -> accept
conn fd readable   -> read
conn fd writable   -> write
timer expired      -> timeout callback
```

libevent 里大致对应：

```text
evconnlistener accept callback -> 新连接接入
bufferevent read callback      -> 连接可读且输入缓冲满足条件
bufferevent write callback     -> 输出缓冲降到低水位
bufferevent event callback     -> 连接成功、EOF、错误、超时
event_base_dispatch            -> 事件循环
```

关键变化是：

* 你不直接处理 `epoll_wait`
* 通常也不直接处理裸 `read/write`
* 连接上的数据先进入 `evbuffer`
* 业务逻辑在回调里消费输入缓冲并写入输出缓冲

---

## 3. `event_base`：事件循环对象

最基本的生命周期：

```c
#include <event2/event.h>

struct event_base *base = event_base_new();

event_base_dispatch(base);

event_base_free(base);
```

含义：

* `event_base_new()` 创建事件循环
* `event_base_dispatch()` 开始调度事件
* `event_base_free()` 释放事件循环资源

常见退出方式：

```c
event_base_loopexit(base, NULL); // 让 loop 尽快退出
event_base_loopbreak(base);      // 立即打断当前 loop
```

工程经验：

* 一个 `event_base` 通常只在一个 I/O 线程中运行
* 多线程服务端常见做法是“一组 I/O 线程，每个线程一个 event_base”
* 跨线程投递任务时要用线程安全机制，不要随意在别的线程直接操作连接对象

---

## 4. `evconnlistener`：监听与接入连接

传统 TCP 服务端需要：

```text
socket -> setsockopt -> bind -> listen -> accept
```

`evconnlistener_new_bind()` 可以把这套监听流程封装起来。

### 4.1 创建接口

```c
#include <event2/listener.h>

struct evconnlistener *evconnlistener_new_bind(
    struct event_base *base,
    evconnlistener_cb cb,
    void *ptr,
    unsigned flags,
    int backlog,
    const struct sockaddr *sa,
    int socklen
);
```

如果你已经自己创建并绑定了 socket，可以用：

```c
struct evconnlistener *evconnlistener_new(
    struct event_base *base,
    evconnlistener_cb cb,
    void *ptr,
    unsigned flags,
    int backlog,
    evutil_socket_t fd
);
```

参数含义：

| 参数 | 含义 |
| --- | --- |
| `base` | 事件循环 |
| `cb` | 新连接到来时的回调 |
| `ptr` | 传给回调的用户参数 |
| `flags` | listener 选项 |
| `backlog` | `listen()` 队列长度，`-1` 使用默认值 |
| `sa` / `socklen` | 监听地址 |

### 4.2 常用 flags

常用组合：

```c
LEV_OPT_CLOSE_ON_FREE | LEV_OPT_REUSEABLE
```

含义：

| flag | 含义 |
| --- | --- |
| `LEV_OPT_CLOSE_ON_FREE` | `evconnlistener_free()` 时关闭监听 fd |
| `LEV_OPT_REUSEABLE` | 设置地址复用，方便服务重启 |
| `LEV_OPT_CLOSE_ON_EXEC` | 子进程 `exec` 后关闭 fd |
| `LEV_OPT_DISABLED` | 创建后先不启用监听 |
| `LEV_OPT_REUSEABLE_PORT` | 支持时启用端口复用，常用于多进程/多线程监听同端口 |

注意：libevent 里历史拼写是 `REUSEABLE`，不是标准英文的 `REUSABLE`。

### 4.3 accept 回调

```c
typedef void (*evconnlistener_cb)(
    struct evconnlistener *listener,
    evutil_socket_t sock,
    struct sockaddr *addr,
    int len,
    void *ptr
);
```

新连接到来时，libevent 会把已 accept 的连接 fd 传给你。
最常见的下一步是把这个 fd 包成 `bufferevent`。

### 4.4 错误回调

```c
void evconnlistener_set_error_cb(
    struct evconnlistener *lev,
    evconnlistener_errorcb errorcb
);
```

错误回调里通常要打印真实错误，并按需要退出 loop：

```c
static void accept_error_cb(struct evconnlistener *listener, void *ctx) {
    struct event_base *base = evconnlistener_get_base(listener);
    int err = EVUTIL_SOCKET_ERROR();
    fprintf(stderr, "listener error: %s\n",
            evutil_socket_error_to_string(err));
    event_base_loopexit(base, NULL);
}
```

---

## 5. `bufferevent`：带缓冲的连接对象

`bufferevent` 可以理解成：

```text
socket fd
  + 输入缓冲 evbuffer
  + 输出缓冲 evbuffer
  + read/write/event 回调
```

创建 socket 型 bufferevent：

```c
#include <event2/bufferevent.h>

struct bufferevent *bufferevent_socket_new(
    struct event_base *base,
    evutil_socket_t fd,
    int options
);
```

服务端 accept 后通常写：

```c
struct bufferevent *bev = bufferevent_socket_new(
    base,
    fd,
    BEV_OPT_CLOSE_ON_FREE | BEV_OPT_DEFER_CALLBACKS
);
```

常用 options：

| option | 含义 |
| --- | --- |
| `BEV_OPT_CLOSE_ON_FREE` | `bufferevent_free()` 时关闭底层 fd |
| `BEV_OPT_DEFER_CALLBACKS` | 延迟回调，减少回调重入 |
| `BEV_OPT_THREADSAFE` | 给 bufferevent 加锁，需启用线程支持 |

设置回调：

```c
void bufferevent_setcb(
    struct bufferevent *bufev,
    bufferevent_data_cb readcb,
    bufferevent_data_cb writecb,
    bufferevent_event_cb eventcb,
    void *cbarg
);
```

启用读写事件：

```c
bufferevent_enable(bev, EV_READ | EV_WRITE);
```

---

## 6. 三类回调分别做什么

### 6.1 read callback

当输入缓冲里有数据，并且满足读水位条件时触发。

```c
static void read_cb(struct bufferevent *bev, void *ctx) {
    struct evbuffer *input = bufferevent_get_input(bev);
    struct evbuffer *output = bufferevent_get_output(bev);

    evbuffer_add_buffer(output, input);
}
```

这个例子把输入缓冲的数据直接移动到输出缓冲，实现 echo。

### 6.2 write callback

当输出缓冲降到写低水位时触发。
它不是“每次写完一条消息都触发”的语义，更适合做：

* 发送完成后关闭连接
* 继续发送下一批数据
* 解除上游背压

### 6.3 event callback

处理连接生命周期事件：

| 事件 | 含义 |
| --- | --- |
| `BEV_EVENT_CONNECTED` | 主动连接成功，客户端更常用 |
| `BEV_EVENT_EOF` | 对端关闭 |
| `BEV_EVENT_ERROR` | 连接错误 |
| `BEV_EVENT_TIMEOUT` | 读/写超时 |

服务端常见写法：

```c
static void event_cb(struct bufferevent *bev, short events, void *ctx) {
    if (events & BEV_EVENT_ERROR) {
        int err = EVUTIL_SOCKET_ERROR();
        fprintf(stderr, "connection error: %s\n",
                evutil_socket_error_to_string(err));
    }

    if (events & (BEV_EVENT_EOF | BEV_EVENT_ERROR | BEV_EVENT_TIMEOUT)) {
        bufferevent_free(bev);
    }
}
```

---

## 7. `evbuffer`：输入/输出缓冲区

每个 `bufferevent` 都有两个 `evbuffer`：

```c
struct evbuffer *bufferevent_get_input(struct bufferevent *bufev);
struct evbuffer *bufferevent_get_output(struct bufferevent *bufev);
```

常用操作：

| API | 用途 |
| --- | --- |
| `evbuffer_get_length(buf)` | 当前缓冲区字节数 |
| `evbuffer_add(buf, data, len)` | 追加数据 |
| `evbuffer_add_buffer(dst, src)` | 把 `src` 内容移动到 `dst` |
| `evbuffer_remove(buf, data, len)` | 拷贝并移除数据 |
| `evbuffer_copyout(buf, data, len)` | 只拷贝，不移除 |
| `evbuffer_drain(buf, len)` | 丢弃前 `len` 字节 |
| `evbuffer_readln(buf, &n, mode)` | 按行读取 |

也可以通过 `bufferevent_read/write` 操作：

```c
size_t bufferevent_read(struct bufferevent *bufev, void *data, size_t size);
int bufferevent_write(struct bufferevent *bufev, const void *data, size_t size);
```

经验上：

* 简单收发可以用 `bufferevent_read/write`
* 协议解析更常直接操作 `evbuffer`
* 不要假设一次 read callback 就是一条完整消息

---

## 8. 完整示例：TCP echo server

```c
#include <event2/buffer.h>
#include <event2/bufferevent.h>
#include <event2/event.h>
#include <event2/listener.h>
#include <event2/util.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static void echo_read_cb(struct bufferevent *bev, void *ctx) {
    (void)ctx;

    struct evbuffer *input = bufferevent_get_input(bev);
    struct evbuffer *output = bufferevent_get_output(bev);

    evbuffer_add_buffer(output, input);
}

static void echo_event_cb(struct bufferevent *bev, short events, void *ctx) {
    (void)ctx;

    if (events & BEV_EVENT_ERROR) {
        int err = EVUTIL_SOCKET_ERROR();
        fprintf(stderr, "bufferevent error: %s\n",
                evutil_socket_error_to_string(err));
    }

    if (events & BEV_EVENT_TIMEOUT) {
        fprintf(stderr, "connection timeout\n");
    }

    if (events & (BEV_EVENT_EOF | BEV_EVENT_ERROR | BEV_EVENT_TIMEOUT)) {
        bufferevent_free(bev);
    }
}

static void accept_conn_cb(struct evconnlistener *listener,
                           evutil_socket_t fd,
                           struct sockaddr *addr,
                           int socklen,
                           void *ctx) {
    (void)addr;
    (void)socklen;
    (void)ctx;

    struct event_base *base = evconnlistener_get_base(listener);
    struct bufferevent *bev = bufferevent_socket_new(
        base, fd, BEV_OPT_CLOSE_ON_FREE | BEV_OPT_DEFER_CALLBACKS);

    if (!bev) {
        evutil_closesocket(fd);
        return;
    }

    bufferevent_setcb(bev, echo_read_cb, NULL, echo_event_cb, NULL);
    bufferevent_enable(bev, EV_READ | EV_WRITE);

    struct timeval read_timeout = {60, 0};
    bufferevent_set_timeouts(bev, &read_timeout, NULL);
}

static void accept_error_cb(struct evconnlistener *listener, void *ctx) {
    (void)ctx;

    struct event_base *base = evconnlistener_get_base(listener);
    int err = EVUTIL_SOCKET_ERROR();

    fprintf(stderr, "listener error: %s\n",
            evutil_socket_error_to_string(err));

    event_base_loopexit(base, NULL);
}

int main(int argc, char **argv) {
    int port = 9876;
    if (argc > 1) {
        port = atoi(argv[1]);
    }
    if (port <= 0 || port > 65535) {
        fprintf(stderr, "invalid port\n");
        return 1;
    }

    struct event_base *base = event_base_new();
    if (!base) {
        fprintf(stderr, "could not create event_base\n");
        return 1;
    }

    struct sockaddr_in sin;
    memset(&sin, 0, sizeof(sin));
    sin.sin_family = AF_INET;
    sin.sin_addr.s_addr = htonl(INADDR_ANY);
    sin.sin_port = htons((uint16_t)port);

    struct evconnlistener *listener = evconnlistener_new_bind(
        base,
        accept_conn_cb,
        NULL,
        LEV_OPT_CLOSE_ON_FREE | LEV_OPT_REUSEABLE,
        -1,
        (struct sockaddr *)&sin,
        sizeof(sin));

    if (!listener) {
        fprintf(stderr, "could not create listener\n");
        event_base_free(base);
        return 1;
    }

    evconnlistener_set_error_cb(listener, accept_error_cb);

    printf("echo server listen on 0.0.0.0:%d\n", port);
    event_base_dispatch(base);

    evconnlistener_free(listener);
    event_base_free(base);
    return 0;
}
```

编译：

```bash
cc echo_server.c -o echo_server -levent
```

测试：

```bash
./echo_server 9876
nc 127.0.0.1 9876
```

---

## 9. 处理半包：长度前缀协议示意

TCP 是字节流，read callback 里可能拿到：

* 半条消息
* 一条消息
* 多条消息粘在一起

假设协议格式是：

```text
4 字节网络序长度 + payload
```

解析思路：

```c
#include <arpa/inet.h>
#include <stdint.h>
#include <stdlib.h>

static void protocol_read_cb(struct bufferevent *bev, void *ctx) {
    (void)ctx;

    struct evbuffer *input = bufferevent_get_input(bev);

    for (;;) {
        if (evbuffer_get_length(input) < 4) {
            return;
        }

        uint32_t net_len = 0;
        evbuffer_copyout(input, &net_len, sizeof(net_len));

        uint32_t body_len = ntohl(net_len);
        if (body_len > 1024 * 1024) {
            bufferevent_free(bev);
            return;
        }

        if (evbuffer_get_length(input) < 4 + body_len) {
            return;
        }

        evbuffer_drain(input, 4);

        unsigned char *body = malloc(body_len);
        if (!body) {
            bufferevent_free(bev);
            return;
        }

        evbuffer_remove(input, body, body_len);

        // process body[0..body_len)

        free(body);
    }
}
```

重点不是这段代码本身，而是循环条件：

* 缓冲区不够一个完整包头：返回
* 缓冲区不够完整包体：返回
* 够一条消息就取一条，继续尝试解析下一条

---

## 10. 水位线与背压

设置水位：

```c
void bufferevent_setwatermark(
    struct bufferevent *bufev,
    short events,
    size_t lowmark,
    size_t highmark
);
```

读水位：

```c
bufferevent_setwatermark(bev, EV_READ, 0, 64 * 1024);
```

含义：

* 输入缓冲超过高水位时，libevent 会暂停继续读
* 缓冲降下来后再恢复读

写水位：

* 输出缓冲降到低水位时触发 write callback
* 可以用来继续发送、关闭连接或恢复上游生产

工程上要记住：

> 高性能服务端不能无限制地往输出缓冲塞数据，否则慢客户端会拖垮内存。

---

## 11. 超时管理

设置读写超时：

```c
struct timeval rto = {30, 0};
struct timeval wto = {30, 0};
bufferevent_set_timeouts(bev, &rto, &wto);
```

触发后会进入 event callback：

```c
if (events & BEV_EVENT_TIMEOUT) {
    bufferevent_free(bev);
}
```

常见用法：

* 读超时：客户端长期不发数据，关闭连接
* 写超时：输出缓冲长期发不出去，说明对端太慢或网络异常
* 应用层心跳：不要只依赖 TCP keepalive

---

## 12. 多线程与 libevent

libevent 可以启用线程支持：

```c
#include <event2/thread.h>

evthread_use_pthreads();
```

编译链接时通常需要：

```bash
cc server.c -o server -levent -levent_pthreads -lpthread
```

但这不意味着“多个线程随便操作同一个连接”就安全。
更常见的结构是：

```text
main thread:
    accept 新连接
    按 fd 或轮询分配给某个 I/O 线程

I/O thread:
    每个线程一个 event_base
    管理自己名下的连接

worker thread:
    只做业务计算
    结果投递回对应 I/O 线程发送
```

这样可以减少锁竞争，也更容易排查连接状态。

### 12.1 多 I/O 线程 echo server 示例

下面这个例子采用：

```text
main event_base:
    evconnlistener accept 新连接
    轮询选择一个 worker
    通过 socketpair 把 fd 号发给 worker

worker event_base:
    监听自己的通知 fd
    收到新连接 fd 后创建 bufferevent
    后续读写都在本线程处理
```

注意：同一进程内的线程共享 fd 表，所以这里只需要把 fd 数值写给 worker，不需要像多进程那样用 `SCM_RIGHTS` 传递文件描述符。

```c
#include <event2/buffer.h>
#include <event2/bufferevent.h>
#include <event2/event.h>
#include <event2/listener.h>
#include <event2/thread.h>
#include <event2/util.h>

#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define WORKER_NUM 4

struct worker {
    int id;
    struct event_base *base;
    struct event *notify_event;
    evutil_socket_t notify_receive_fd;
    evutil_socket_t notify_send_fd;
    pthread_t tid;
};

struct server {
    struct event_base *base;
    struct worker workers[WORKER_NUM];
    int next_worker;
};

static void echo_read_cb(struct bufferevent *bev, void *ctx) {
    (void)ctx;

    struct evbuffer *input = bufferevent_get_input(bev);
    struct evbuffer *output = bufferevent_get_output(bev);

    evbuffer_add_buffer(output, input);
}

static void echo_event_cb(struct bufferevent *bev, short events, void *ctx) {
    (void)ctx;

    if (events & BEV_EVENT_ERROR) {
        int err = EVUTIL_SOCKET_ERROR();
        fprintf(stderr, "connection error: %s\n",
                evutil_socket_error_to_string(err));
    }

    if (events & (BEV_EVENT_EOF | BEV_EVENT_ERROR | BEV_EVENT_TIMEOUT)) {
        bufferevent_free(bev);
    }
}

static void create_connection(struct worker *worker, evutil_socket_t fd) {
    evutil_make_socket_nonblocking(fd);

    struct bufferevent *bev = bufferevent_socket_new(
        worker->base, fd, BEV_OPT_CLOSE_ON_FREE | BEV_OPT_DEFER_CALLBACKS);
    if (!bev) {
        evutil_closesocket(fd);
        return;
    }

    bufferevent_setcb(bev, echo_read_cb, NULL, echo_event_cb, worker);
    bufferevent_enable(bev, EV_READ | EV_WRITE);

    struct timeval read_timeout = {60, 0};
    bufferevent_set_timeouts(bev, &read_timeout, NULL);

    printf("worker %d accepted fd %d\n", worker->id, (int)fd);
}

static void worker_notify_cb(evutil_socket_t fd, short events, void *ctx) {
    (void)events;

    struct worker *worker = ctx;

    for (;;) {
        evutil_socket_t client_fd;
        ssize_t n = recv(fd, &client_fd, sizeof(client_fd), 0);
        if (n == sizeof(client_fd)) {
            create_connection(worker, client_fd);
            continue;
        }

        if (n < 0 && errno == EINTR) {
            continue;
        }

        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            return;
        }

        if (n == 0) {
            event_base_loopbreak(worker->base);
            return;
        }

        fprintf(stderr, "worker %d notify recv failed: %s\n",
                worker->id, strerror(errno));
        return;
    }
}

static void *worker_main(void *arg) {
    struct worker *worker = arg;

    worker->base = event_base_new();
    if (!worker->base) {
        fprintf(stderr, "worker %d could not create event_base\n", worker->id);
        return NULL;
    }

    worker->notify_event = event_new(
        worker->base,
        worker->notify_receive_fd,
        EV_READ | EV_PERSIST,
        worker_notify_cb,
        worker);
    if (!worker->notify_event) {
        event_base_free(worker->base);
        worker->base = NULL;
        return NULL;
    }

    event_add(worker->notify_event, NULL);

    printf("worker %d started\n", worker->id);
    event_base_dispatch(worker->base);

    event_free(worker->notify_event);
    event_base_free(worker->base);
    evutil_closesocket(worker->notify_receive_fd);
    return NULL;
}

static int start_worker(struct worker *worker, int id) {
    evutil_socket_t fds[2];

    if (evutil_socketpair(AF_UNIX, SOCK_DGRAM, 0, fds) < 0) {
        fprintf(stderr, "socketpair failed: %s\n", strerror(errno));
        return -1;
    }

    evutil_make_socket_nonblocking(fds[0]);
    evutil_make_socket_nonblocking(fds[1]);

    worker->id = id;
    worker->base = NULL;
    worker->notify_event = NULL;
    worker->notify_receive_fd = fds[0];
    worker->notify_send_fd = fds[1];

    if (pthread_create(&worker->tid, NULL, worker_main, worker) != 0) {
        evutil_closesocket(fds[0]);
        evutil_closesocket(fds[1]);
        return -1;
    }

    pthread_detach(worker->tid);
    return 0;
}

static int dispatch_to_worker(struct server *server, evutil_socket_t fd) {
    struct worker *worker = &server->workers[server->next_worker];
    server->next_worker = (server->next_worker + 1) % WORKER_NUM;

    ssize_t n = send(worker->notify_send_fd, &fd, sizeof(fd), 0);
    if (n != sizeof(fd)) {
        return -1;
    }

    return 0;
}

static void accept_conn_cb(struct evconnlistener *listener,
                           evutil_socket_t fd,
                           struct sockaddr *addr,
                           int socklen,
                           void *ctx) {
    (void)listener;
    (void)addr;
    (void)socklen;

    struct server *server = ctx;

    if (dispatch_to_worker(server, fd) < 0) {
        fprintf(stderr, "dispatch fd %d failed\n", (int)fd);
        evutil_closesocket(fd);
    }
}

static void accept_error_cb(struct evconnlistener *listener, void *ctx) {
    (void)ctx;

    struct event_base *base = evconnlistener_get_base(listener);
    int err = EVUTIL_SOCKET_ERROR();

    fprintf(stderr, "listener error: %s\n",
            evutil_socket_error_to_string(err));

    event_base_loopexit(base, NULL);
}

int main(int argc, char **argv) {
    int port = 9876;

    if (argc > 1) {
        port = atoi(argv[1]);
    }

    if (port <= 0 || port > 65535) {
        fprintf(stderr, "invalid port\n");
        return 1;
    }

    if (evthread_use_pthreads() < 0) {
        fprintf(stderr, "could not enable pthread support\n");
        return 1;
    }

    struct server server;
    memset(&server, 0, sizeof(server));

    for (int i = 0; i < WORKER_NUM; ++i) {
        if (start_worker(&server.workers[i], i) < 0) {
            fprintf(stderr, "could not start worker %d\n", i);
            return 1;
        }
    }

    server.base = event_base_new();
    if (!server.base) {
        fprintf(stderr, "could not create main event_base\n");
        return 1;
    }

    struct sockaddr_in sin;
    memset(&sin, 0, sizeof(sin));
    sin.sin_family = AF_INET;
    sin.sin_addr.s_addr = htonl(INADDR_ANY);
    sin.sin_port = htons((uint16_t)port);

    struct evconnlistener *listener = evconnlistener_new_bind(
        server.base,
        accept_conn_cb,
        &server,
        LEV_OPT_CLOSE_ON_FREE | LEV_OPT_REUSEABLE,
        -1,
        (struct sockaddr *)&sin,
        sizeof(sin));
    if (!listener) {
        fprintf(stderr, "could not create listener\n");
        event_base_free(server.base);
        return 1;
    }

    evconnlistener_set_error_cb(listener, accept_error_cb);

    printf("multi-thread echo server listen on 0.0.0.0:%d\n", port);
    event_base_dispatch(server.base);

    evconnlistener_free(listener);
    event_base_free(server.base);
    return 0;
}
```

编译：

```bash
cc mt_echo_server.c -o mt_echo_server -levent -levent_pthreads -lpthread
```

测试：

```bash
./mt_echo_server 9876
nc 127.0.0.1 9876
```

这个例子的关键点：

* `evthread_use_pthreads()` 必须在创建任何 `event_base` 之前调用
* main 线程只负责监听和分发，不创建连接上的 `bufferevent`
* 每个 `bufferevent` 只在所属 worker 线程里创建、读写和释放
* 这里不需要给 `bufferevent_socket_new()` 额外加 `BEV_OPT_THREADSAFE`，因为连接没有被多个线程同时操作
* `socketpair` 只是一个唤醒和投递机制，生产环境里通常还会加队列长度限制、优雅退出和负载统计

---

## 13. 常见坑

### 13.1 忘记 `BEV_OPT_CLOSE_ON_FREE`

释放 `bufferevent` 后 fd 没关，容易造成句柄泄漏。

### 13.2 在 read callback 里假设“一次回调一条消息”

TCP 是字节流，必须做协议拆包。

### 13.3 一直监听写事件或无限写入输出缓冲

慢客户端会造成输出缓冲堆积。
要配合写水位、队列上限和断开策略。

### 13.4 回调里直接做重 CPU 业务

I/O 线程被卡住后，所有连接都会受影响。
重计算应该移交给工作线程。

### 13.5 跨线程直接操作 `bufferevent`

如果没有清晰的线程模型，很容易产生竞态。
更稳妥的是把操作投递回连接所属的 I/O 线程。

---

## 14. 一页总结

libevent 服务端这篇最重要的是：

1. `event_base` 是事件循环
2. `evconnlistener` 封装监听 socket 和 accept
3. 每个连接通常对应一个 `bufferevent`
4. `bufferevent` 内部有输入/输出 `evbuffer`
5. read callback 负责解析输入缓冲，write callback 负责发送进度，event callback 负责生命周期
6. TCP 半包/粘包仍然要靠应用层协议解析
7. 水位、超时和背压是服务端稳定性关键

如果只记一句：

> libevent 帮你管理事件循环和非阻塞 I/O，但协议状态、连接生命周期和背压策略仍然要你自己设计清楚。

---

## 15. 参考资料

1. libevent book: Ref6 bufferevent
   <https://libevent.org/libevent-book/Ref6_bufferevent.html>

2. libevent book: Ref8 listener
   <https://libevent.org/libevent-book/Ref8_listener.html>

3. libevent book: Ref7 evbuffer
   <https://libevent.org/libevent-book/Ref7_evbuffer.html>
