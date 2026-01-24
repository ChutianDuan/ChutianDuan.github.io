---
title: "libevent"
date: 2026-01-07 10:41:47
tags:
  - "网络编程"
  - "libevent"
  - "事件驱动"
categories:
  - "学习"
  - "Linux高性能服务器编程"
thumbnail: /img/covers/cover4.jpg
---
# bufferevent


## 1. 基本概念

* **bufferevent**：在套接字之上封装了**输入/输出缓冲**与**回调**机制的 I/O 对象，避免手写 `read/write` 和边沿触发细节。
* **事件循环**：`event_base` 驱动，所有 I/O、超时、信号都在此 loop 内调度。

---

## 2. 关键 API

### buferevent_socket_new()

```c
struct bufferevent* bufferevent_socket_new(
    struct event_base *base,
    evutil_socket_t fd,           // 通常传 -1，让 libevent 自己创建 socket
    int options                   // 常用：BEV_OPT_CLOSE_ON_FREE | BEV_OPT_DEFER_CALLBACKS
);
```

**说明**

* `fd = -1`：由 libevent 负责创建 socket，更简洁。
* `BEV_OPT_CLOSE_ON_FREE`：在 `bufferevent_free()` 时自动关闭 socket。
* `BEV_OPT_DEFER_CALLBACKS`：把回调延迟到事件循环安全点执行，减少重入问题。

### buferevent_socket_connect()

```c
int bufferevent_socket_connect(
    struct bufferevent *bev,
    struct sockaddr *addr,
    int addrlen
);
```

**说明**

* 非阻塞发起连接；成功返回 0，失败返回 -1（同时触发 event 回调中的 `BEV_EVENT_ERROR`）。
* 连接成功后会触发 event 回调中的 `BEV_EVENT_CONNECTED`。

> 如果要用主机名而非 IP，推荐 `bufferevent_socket_connect_hostname()`（需配合 `evdns_base` 进行异步解析）。

---

## 3. 最小可用示例（IPv4）

```c
#include <event2/event.h>
#include <event2/bufferevent.h>
#include <event2/buffer.h>
#include <event2/util.h>
#include <arpa/inet.h>
#include <string.h>
#include <stdio.h>

static void read_cb(struct bufferevent* bev, void* ctx) {
    char buf[4096];
    size_t n;
    while ((n = bufferevent_read(bev, buf, sizeof(buf))) > 0) {
        fwrite(buf, 1, n, stdout);
    }
}

static void event_cb(struct bufferevent* bev, short what, void* ctx) {
    if (what & BEV_EVENT_CONNECTED) {
        printf("[OK] connected\n");
        const char* msg = "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        bufferevent_write(bev, msg, strlen(msg));
    }
    if (what & BEV_EVENT_EOF) {
        printf("[*] server closed\n");
        bufferevent_free(bev);
    }
    if (what & BEV_EVENT_ERROR) {
        int err = EVUTIL_SOCKET_ERROR();
        fprintf(stderr, "[ERR] %s\n", evutil_socket_error_to_string(err));
        bufferevent_free(bev);
    }
    if (what & BEV_EVENT_TIMEOUT) {
        printf("[!] timeout\n");
        bufferevent_free(bev);
    }
}

int main() {
    struct event_base* base = event_base_new();

    //创建套字 socket
    struct bufferevent* bev = bufferevent_socket_new(
        base, -1, BEV_OPT_CLOSE_ON_FREE | BEV_OPT_DEFER_CALLBACKS);
    // 将read_cb event_cb 回调函数先绑定防止漏听
    bufferevent_setcb(bev, read_cb, NULL, event_cb, NULL);
    bufferevent_enable(bev, EV_READ | EV_WRITE);

    // 可选：设置读/写超时（连接阶段通常走写超时）
    struct timeval rto = {10, 0}, wto = {10, 0};
    bufferevent_set_timeouts(bev, &rto, &wto);

    // 目标地址
    struct sockaddr_in sin;
    memset(&sin, 0, sizeof(sin));
    sin.sin_family = AF_INET;
    sin.sin_port   = htons(8080);
    evutil_inet_pton(AF_INET, "127.0.0.1", &sin.sin_addr);

    if (bufferevent_socket_connect(bev, (struct sockaddr*)&sin, sizeof(sin)) < 0) {
        perror("connect");
        bufferevent_free(bev);
        event_base_free(base);
        return 1;
    }

    event_base_dispatch(base);

    event_base_free(base);
    return 0;
}
```

---

## 4. 使用要点与常见坑

1. **回调必须先设再 connect**
   先 `bufferevent_setcb()` + `bufferevent_enable()`，再调用 `bufferevent_socket_connect()`，避免早到事件丢失。

2. **超时设置**

   * `bufferevent_set_timeouts()` 同时设置读/写超时。
   * 连接阶段通常依赖**写超时**触发（因为 connect 过程中会等待可写）。

3. **水位（可选）**

   * 读水位：`bufferevent_setwatermark(bev, EV_READ, low, high)`
     当输入缓冲超过 `high` 时会**暂时禁用读事件**，防止内存暴涨。
   * 写水位：同理控制输出缓冲积压。

4. **线程安全**

   * libevent 可多线程，但一个 `event_base` 通常**只在一个线程**内跑；跨线程提交任务请用 `event_base_once()` 或管道/通知机制。

5. **DNS 支持（推荐）**

   * 异步解析：`evdns_base_new(base, 1)` + `bufferevent_socket_connect_hostname(bev, dns, AF_UNSPEC, "example.com", 80)`
   * 避免阻塞式 `getaddrinfo()`。

6. **清理顺序**

   * 一般在 `event_cb` 收到 `EOF/ERROR/TIMEOUT` 后 `bufferevent_free()`；loop 退出后 `event_base_free()`。

7. **错误定位**

   * `BEV_EVENT_ERROR` 时使用 `EVUTIL_SOCKET_ERROR()` + `evutil_socket_error_to_string()` 打印 errno。
   * 常见：`ECONNREFUSED`（服务未起）、`ETIMEDOUT`（网络/防火墙/超时）、`EHOSTUNREACH`。

8. **选项建议**

   * `BEV_OPT_CLOSE_ON_FREE`：免漏句柄
   * `BEV_OPT_DEFER_CALLBACKS`：减少重入与回调嵌套
   * 如需**逐线程**回调可考虑 `BEV_OPT_THREADSAFE`（需要启用 `evthread_use_pthreads()` 等）。

---

## 5. 主机名连接（带 DNS）的示例（简版）

```c
#include <event2/dns.h>

struct evdns_base* dns = evdns_base_new(base, 1); // 1=初始化内置解析器
int rc = bufferevent_socket_connect_hostname(
    bev, dns, AF_UNSPEC, "example.com", 80);
if (rc < 0) { /* handle error */ }
```

---

## 6. 小结（流程速记）

1. `event_base_new()`
2. `bufferevent_socket_new(base, -1, BEV_OPT_CLOSE_ON_FREE | BEV_OPT_DEFER_CALLBACKS)`
3. `bufferevent_setcb()` → `bufferevent_enable(EV_READ|EV_WRITE)` → `bufferevent_set_timeouts()`
4. `bufferevent_socket_connect()`（或 `_connect_hostname()`）
5. 在 `event_cb` 处理 `BEV_EVENT_CONNECTED / EOF / ERROR / TIMEOUT`
6. 退出时 `bufferevent_free()`、`event_base_free()`

---

## 7. 进阶建议

* **TLS**：用 `bufferevent_openssl_socket_new()` 包装 SSL 会话，接口与普通 `bev` 基本一致。
* **背压控制**：配合水位、分块写入，避免写缓冲过大。
* **协议层**：在 `read_cb` 内从 `evbuffer` 取数据，做**半包/粘包**处理（如定长头 + 可变体）。
