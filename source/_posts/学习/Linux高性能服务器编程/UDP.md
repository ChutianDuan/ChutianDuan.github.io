---
title: "UDP 通信"
date: 2026-05-07 15:52:02
updated: 2026-05-07 15:52:02
categories:
  - "学习"
  - "Linux高性能服务器编程"
permalink: /notes/linux高性能服务器编程/udp/
---

# UDP 通信

时间：2026/04/09

> 关键词：报文、无连接、不可靠传输、`sendto/recvfrom`、MTU、丢包重传、滑动窗口
> 核心目标：先把 UDP 的“简单”理解透，再搞清楚为什么很多实时协议愿意在 UDP 之上自己补可靠性。

---

## 1. UDP 是什么

UDP（User Datagram Protocol）是**面向报文**的传输层协议。

它的特点很直接：

* **无连接**：通信前不需要三次握手
* **报文边界保留**：发送一次 `sendto`，接收端看到的是一个完整报文，天然没有 TCP 粘包问题
* **尽力而为**：协议本身不保证送达、不保证顺序、不保证不重复
* **开销小、时延低**：头部只有 8 字节，协议栈处理也更轻

所以 UDP 很适合：

* 实时音视频
* 在线游戏
* DNS
* 广播 / 组播
* 能容忍少量丢包，但很在意时延的业务

---

## 2. UDP 和 TCP 的核心差异

| 维度 | UDP | TCP |
| --- | --- | --- |
| 连接语义 | 无连接 | 面向连接 |
| 数据形式 | 报文 | 字节流 |
| 可靠性 | 不保证 | 保证送达、按序、去重 |
| 顺序 | 不保证 | 保证 |
| 重传 | 应用层自己做 | 内核协议栈负责 |
| 流量控制 | 没有 | 有 |
| 拥塞控制 | 没有 | 有 |
| 时延 | 更低 | 较稳定但更重 |

最重要的一点：

> UDP 只是“帮你发包”，TCP 则是“帮你把传输这件事做完整”。

---

## 3. Linux 下 UDP 的常用接口

### 3.1 创建 socket

```c
int fd = socket(AF_INET, SOCK_DGRAM, 0);
```

`SOCK_DGRAM` 表示 UDP 套接字。

### 3.2 服务端绑定地址

```c
bind(fd, (struct sockaddr*)&addr, sizeof(addr));
```

和 TCP 一样，服务端通常需要 `bind` 到固定 IP/端口。

### 3.3 接收与发送

```c
ssize_t n = recvfrom(fd, buf, sizeof(buf), 0,
                     (struct sockaddr*)&peer, &peer_len);

sendto(fd, data, len, 0,
       (struct sockaddr*)&peer, peer_len);
```

这是一对最常见的 UDP I/O 接口：

* `recvfrom`：收到数据时，顺便告诉你包来自谁
* `sendto`：每次发送时明确指定目标地址

### 3.4 `connect()` 对 UDP 也有用

```c
connect(fd, (struct sockaddr*)&peer, sizeof(peer));
```

UDP 上的 `connect()` **不是建立连接**，而是：

* 给这个 socket 绑定一个默认对端
* 之后可以直接用 `send/recv`
* 内核只接收该对端发来的报文
* 某些错误能更直接反馈给调用方

所以很多客户端 UDP 程序也会先 `connect()`，这样代码更简洁。

---

## 4. UDP 通信的基本流程

### 4.1 服务端

1. `socket(AF_INET, SOCK_DGRAM, 0)`
2. `bind()`
3. 循环 `recvfrom()`
4. 根据来源地址决定回包对象
5. `sendto()` 返回结果

### 4.2 客户端

1. `socket(AF_INET, SOCK_DGRAM, 0)`
2. 可选：`connect()`
3. `sendto()` 或 `send()`
4. `recvfrom()` 或 `recv()`

和 TCP 相比，UDP 没有：

* `listen()`
* `accept()`

因为它没有连接队列这一层。

---

## 5. UDP 的工程注意点

### 5.1 没有粘包，不等于没有协议设计

UDP 保留报文边界，但应用层仍然要定义：

* 包头
* 消息类型
* 序号
* 校验
* 重传策略

否则出了问题很难排查。

### 5.2 丢包、乱序、重复都是正常现象

UDP 编程默认就要接受这些情况：

* 某个包永远收不到
* 后发的包先到
* 同一个包被收到两次

这不是异常，而是 UDP 的正常工作方式。

### 5.3 尽量避免 IP 分片

如果 UDP 报文过大，IP 层可能分片。分片带来的问题：

* 任一分片丢失，整个报文作废
* 网络设备对分片不友好
* 性能和稳定性都变差

工程上通常建议：

* 单个应用层包尽量控制在 **MTU 以下**
* 以太网常见安全值可以先按 `1200` 字节左右设计

这也是 QUIC 常见的保守做法之一。

### 5.4 高性能场景通常要配合事件循环

在 Linux 上，大量 UDP socket 或高频收发通常会配合：

* `epoll`
* 非阻塞 socket
* 定时器管理重传
* 批量收发（如 `recvmmsg/sendmmsg`）

单线程阻塞式 `recvfrom()` 适合入门，不适合高并发服务。

---

## 6. 一个最小 UDP 回显服务端

```c
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>

int main() {
    int fd = socket(AF_INET, SOCK_DGRAM, 0);

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(9999);

    bind(fd, (struct sockaddr*)&addr, sizeof(addr));

    for (;;) {
        char buf[2048];
        struct sockaddr_in peer;
        socklen_t len = sizeof(peer);

        ssize_t n = recvfrom(fd, buf, sizeof(buf), 0,
                             (struct sockaddr*)&peer, &len);
        if (n <= 0) {
            continue;
        }

        sendto(fd, buf, (size_t)n, 0,
               (struct sockaddr*)&peer, len);
    }

    close(fd);
    return 0;
}
```

这个例子足够说明 UDP 服务端的基本模型：

* 一个 socket
* 不断收报文
* 每个报文都自带来源地址
* 回包时显式指定目标

---

## 7. 用 UDP 实现 TCP，应该怎么想

这里更准确的说法不是“把 TCP 原样重写一遍”，而是：

> 在 UDP 之上补齐 TCP 的核心能力，做出一个“可靠、有序、可控”的传输层。

这是很多实时网络框架的常见思路，例如：

* **KCP**：在 UDP 上实现可靠传输，强调低延迟
* **QUIC**：在 UDP 上实现更现代的连接、多路复用、拥塞控制与加密

### 7.1 先分清目标

如果你只是想让消息“更可靠”，那通常只需要做：

* 序号
* ACK
* 超时重传
* 简单窗口

如果你想完整模拟 TCP，则还要补：

* 连接管理
* 按序交付
* 流量控制
* 拥塞控制
* RTT 估计与重传定时器
* 关闭连接

真正困难的部分其实不是“发包”，而是：

* **如何在复杂网络环境里稳定地控制发送节奏**

### 7.2 最小协议头可以这样设计

```c
struct PacketHeader {
    uint32_t conn_id;    // 连接标识
    uint32_t seq;        // 当前包序号
    uint32_t ack;        // 已确认到的对端序号
    uint16_t flags;      // SYN / ACK / FIN / RST 等
    uint16_t wnd;        // 通告接收窗口
    uint32_t ts;         // 时间戳，用于 RTT 估计
    uint16_t len;        // payload 长度
    uint16_t checksum;   // 包头+包体校验
};
```

如果只是做“可靠消息”而不是“字节流”，这个头已经够搭框架了。

### 7.3 把 TCP 的能力拆成 6 层功能

#### 1. 连接管理

在 UDP 上自己定义连接状态：

* `CLOSED`
* `SYN_SENT`
* `SYN_RECV`
* `ESTABLISHED`
* `FIN_WAIT`

可以直接借用 TCP 的思路：

1. 客户端发 `SYN(seq=x)`
2. 服务端回 `SYN|ACK(seq=y, ack=x+1)`
3. 客户端再发 `ACK(ack=y+1)`

这样做的价值是：

* 双方都知道初始序号
* 可以建立会话状态
* 便于后续超时、重传和断线清理

#### 2. 可靠性

发送端维护一个**未确认发送队列**：

* 每发一个包，都放进 `unacked_map`
* 记录发送时间、重传次数
* 定时扫描超时包并重发

接收端收到包后返回 ACK。

最简单的 ACK 策略可以先做：

* **累计确认**：`ack = 下一个期待收到的序号`

再进一步可做：

* **选择确认**（SACK）：显式告诉对端哪些乱序包已经收到

#### 3. 有序交付

如果包乱序到达：

* 先放入接收缓冲区
* 只有当 `seq == expected_seq` 时才向上层提交
* 提交后继续检查后续缓存是否已连续

这就是 TCP “按序交付”的核心。

#### 4. 流量控制

需要告诉对方：

* 我这边接收缓冲还有多大

也就是在包头里放 `wnd`，类似 TCP 的接收窗口。

否则发送方可能发得太快，把接收方内存顶爆。

#### 5. 拥塞控制

这是最难的一层。

最偷懒的版本可以先不做，只设固定发送速率，但这不是真正的 TCP 级能力。

更接近 TCP 的做法是引入：

* 慢启动
* 拥塞避免
* 丢包后乘法减小

如果没有拥塞控制，你的协议在局域网看起来正常，到了公网通常就会失控。

#### 6. 关闭连接

同样可以模仿 TCP：

* 一端发 `FIN`
* 对端回 `ACK`
* 双方完成收尾和资源回收

否则 session 容易泄漏。

---

## 8. 一个“UDP 版 TCP”最小实现框架

如果从工程结构上设计，可以拆成下面几层：

1. **UdpSocket 层**
   负责 `socket/bind/sendto/recvfrom` 和 `epoll`
2. **Session 层**
   用 `peer_addr + conn_id` 管理会话状态
3. **Reliability 层**
   管理 `seq/ack`、发送窗口、重传队列、乱序缓冲
4. **Timer 层**
   负责 RTO、心跳、超时断线
5. **Congestion / Flow Control 层**
   控制能发多少、发多快
6. **Application 层**
   真正的业务协议

一个发送端主循环大概是：

```text
应用层提交消息
-> 分配 seq
-> 封包并发送
-> 放入未确认队列
-> 等待 ACK
-> 超时则重传
-> 收到 ACK 后从队列删除
```

一个接收端主循环大概是：

```text
收到 UDP 报文
-> 校验包头
-> 根据 conn_id 找到 session
-> 判断 seq 是否重复 / 乱序 / 正常
-> 更新接收窗口
-> 发送 ACK
-> 按序把数据交给上层
```

---

## 9. 代码示例：用 UDP 做一个最小可靠传输

下面这个例子不是完整 TCP，而是一个教学版的**可靠消息协议**。

它只实现 TCP 里最核心的一小部分能力：

* 每个数据包带 `seq`
* 接收端返回 `ACK`
* `ack` 表示“下一个期待收到的序号”
* 发送端超时没有收到 ACK 就重传
* 接收端用 `expected_seq` 去重，并只按序交付数据

为了让代码足够短，这里使用的是**停等协议**：

```text
发送 seq=0 -> 等 ACK=1
发送 seq=1 -> 等 ACK=2
发送 seq=2 -> 等 ACK=3
```

停等协议性能很低，但非常适合理解“用 UDP 补 TCP 可靠性”的基本骨架。

```c
// reliable_udp_stopwait.c
// gcc reliable_udp_stopwait.c -o reliable_udp_stopwait
//
// 终端 1:
// ./reliable_udp_stopwait server 9999
//
// 终端 2:
// ./reliable_udp_stopwait client 127.0.0.1 9999 hello world udp

#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>

#define MAX_PAYLOAD 1000
#define RTO_MS 500
#define MAX_RETRY 10

#define FLAG_DATA 0x01
#define FLAG_ACK  0x02

#pragma pack(push, 1)
typedef struct {
    uint32_t seq;      // 当前数据包序号
    uint32_t ack;      // 累计确认号：下一个期待收到的 seq
    uint16_t flags;    // DATA / ACK
    uint16_t len;      // payload 长度
} PacketHeader;
#pragma pack(pop)

typedef struct {
    PacketHeader header;
    char payload[MAX_PAYLOAD];
} Packet;

static int send_packet(int fd,
                       const struct sockaddr_in *peer,
                       socklen_t peer_len,
                       uint32_t seq,
                       uint32_t ack,
                       uint16_t flags,
                       const void *data,
                       uint16_t len) {
    if (len > MAX_PAYLOAD) {
        fprintf(stderr, "payload too large: %u\n", len);
        return -1;
    }

    Packet pkt;
    memset(&pkt, 0, sizeof(pkt));
    pkt.header.seq = htonl(seq);
    pkt.header.ack = htonl(ack);
    pkt.header.flags = htons(flags);
    pkt.header.len = htons(len);

    if (data != NULL && len > 0) {
        memcpy(pkt.payload, data, len);
    }

    size_t packet_len = sizeof(PacketHeader) + len;
    ssize_t n = sendto(fd, &pkt, packet_len, 0,
                       (const struct sockaddr *)peer, peer_len);
    if (n != (ssize_t)packet_len) {
        perror("sendto");
        return -1;
    }

    return 0;
}

static ssize_t recv_packet(int fd,
                           Packet *pkt,
                           struct sockaddr_in *peer,
                           socklen_t *peer_len) {
    ssize_t n = recvfrom(fd, pkt, sizeof(*pkt), 0,
                         (struct sockaddr *)peer, peer_len);
    if (n < 0) {
        perror("recvfrom");
        return -1;
    }

    if (n < (ssize_t)sizeof(PacketHeader)) {
        fprintf(stderr, "drop short packet\n");
        return -1;
    }

    pkt->header.seq = ntohl(pkt->header.seq);
    pkt->header.ack = ntohl(pkt->header.ack);
    pkt->header.flags = ntohs(pkt->header.flags);
    pkt->header.len = ntohs(pkt->header.len);

    if (pkt->header.len > MAX_PAYLOAD ||
        n != (ssize_t)(sizeof(PacketHeader) + pkt->header.len)) {
        fprintf(stderr, "drop bad packet\n");
        return -1;
    }

    return n;
}

static int wait_ack(int fd, uint32_t seq) {
    fd_set rfds;
    FD_ZERO(&rfds);
    FD_SET(fd, &rfds);

    struct timeval tv;
    tv.tv_sec = RTO_MS / 1000;
    tv.tv_usec = (RTO_MS % 1000) * 1000;

    int ret = select(fd + 1, &rfds, NULL, NULL, &tv);
    if (ret < 0) {
        perror("select");
        return -1;
    }
    if (ret == 0) {
        return 0; // timeout
    }

    Packet pkt;
    struct sockaddr_in peer;
    socklen_t peer_len = sizeof(peer);

    if (recv_packet(fd, &pkt, &peer, &peer_len) < 0) {
        return 0;
    }

    if ((pkt.header.flags & FLAG_ACK) && pkt.header.ack == seq + 1) {
        return 1;
    }

    printf("ignore stale ack=%u, want=%u\n", pkt.header.ack, seq + 1);
    return 0;
}

static int send_reliably(int fd,
                         const struct sockaddr_in *peer,
                         socklen_t peer_len,
                         uint32_t seq,
                         const char *msg) {
    size_t len = strlen(msg);
    if (len > MAX_PAYLOAD) {
        fprintf(stderr, "message too large\n");
        return -1;
    }

    for (int retry = 0; retry < MAX_RETRY; ++retry) {
        printf("send seq=%u retry=%d data=%s\n", seq, retry, msg);

        if (send_packet(fd, peer, peer_len, seq, 0, FLAG_DATA,
                        msg, (uint16_t)len) < 0) {
            return -1;
        }

        int ok = wait_ack(fd, seq);
        if (ok == 1) {
            printf("acked seq=%u\n", seq);
            return 0;
        }
        if (ok < 0) {
            return -1;
        }

        printf("timeout seq=%u, retransmit\n", seq);
    }

    fprintf(stderr, "give up seq=%u\n", seq);
    return -1;
}

static int run_server(const char *port) {
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) {
        perror("socket");
        return 1;
    }

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons((uint16_t)atoi(port));

    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("bind");
        close(fd);
        return 1;
    }

    printf("server listen on udp:%s\n", port);

    uint32_t expected_seq = 0;

    for (;;) {
        Packet pkt;
        struct sockaddr_in peer;
        socklen_t peer_len = sizeof(peer);

        if (recv_packet(fd, &pkt, &peer, &peer_len) < 0) {
            continue;
        }

        if (!(pkt.header.flags & FLAG_DATA)) {
            continue;
        }

        char ip[INET_ADDRSTRLEN];
        inet_ntop(AF_INET, &peer.sin_addr, ip, sizeof(ip));

        if (pkt.header.seq == expected_seq) {
            printf("deliver seq=%u from %s:%d data=%.*s\n",
                   pkt.header.seq,
                   ip,
                   ntohs(peer.sin_port),
                   pkt.header.len,
                   pkt.payload);
            expected_seq++;
        } else {
            printf("duplicate/out-of-order seq=%u expected=%u\n",
                   pkt.header.seq, expected_seq);
        }

        // 无论是新包、重复包还是乱序包，都回当前累计 ACK。
        send_packet(fd, &peer, peer_len, 0, expected_seq, FLAG_ACK, NULL, 0);
    }

    close(fd);
    return 0;
}

static int run_client(const char *ip, const char *port, int argc, char **argv) {
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) {
        perror("socket");
        return 1;
    }

    struct sockaddr_in peer;
    memset(&peer, 0, sizeof(peer));
    peer.sin_family = AF_INET;
    peer.sin_port = htons((uint16_t)atoi(port));

    if (inet_pton(AF_INET, ip, &peer.sin_addr) != 1) {
        fprintf(stderr, "bad ip: %s\n", ip);
        close(fd);
        return 1;
    }

    uint32_t seq = 0;
    for (int i = 0; i < argc; ++i) {
        if (send_reliably(fd, &peer, sizeof(peer), seq, argv[i]) < 0) {
            close(fd);
            return 1;
        }
        seq++;
    }

    close(fd);
    return 0;
}

int main(int argc, char *argv[]) {
    if (argc >= 3 && strcmp(argv[1], "server") == 0) {
        return run_server(argv[2]);
    }

    if (argc >= 5 && strcmp(argv[1], "client") == 0) {
        return run_client(argv[2], argv[3], argc - 4, &argv[4]);
    }

    fprintf(stderr,
            "usage:\n"
            "  %s server <port>\n"
            "  %s client <ip> <port> <msg1> [msg2...]\n",
            argv[0],
            argv[0]);
    return 1;
}
```

这个例子和 TCP 的对应关系是：

| TCP 能力 | 这个例子的对应实现 |
| --- | --- |
| 序号 | `seq` |
| 累计确认 | `ack = expected_seq` |
| 超时重传 | `select()` 等待 `RTO_MS` |
| 去重 | `seq < expected_seq` 时不重复交付 |
| 按序交付 | 只交付 `seq == expected_seq` 的数据 |

它缺少的东西也很明显：

* 没有三次握手和四次挥手
* 没有滑动窗口，只能一个包一个包发
* 没有流量控制和拥塞控制
* 没有 RTT 估计，RTO 是固定值
* 服务端示例只维护了一个 `expected_seq`，没有按客户端地址区分 session

所以它的价值不是“能替代 TCP”，而是把 TCP 可靠性的最小骨架跑通。

### 9.1 加上滑动窗口控制

停等协议的问题是：一个包必须等 ACK 回来之后才能发下一个包，网络 RTT 稍微大一点，吞吐就会很差。

更接近 TCP 的做法是引入**滑动窗口**：

```text
send_base = 最早未确认的 seq
next_seq  = 下一个准备发送的 seq

只要 next_seq < send_base + window，就继续发送新包
收到累计 ACK 后，send_base 向右滑动
超时后，重传 [send_base, next_seq) 里的未确认包
```

下面这个版本增加了：

* 发送窗口 `SEND_WINDOW`
* 接收窗口 `RECV_WINDOW`
* ACK 中的窗口通告 `wnd`
* 接收端乱序缓存
* 发送端窗口内连续发送

```c
// reliable_udp_window.c
// gcc reliable_udp_window.c -o reliable_udp_window
//
// 终端 1:
// ./reliable_udp_window server 9999
//
// 终端 2:
// ./reliable_udp_window client 127.0.0.1 9999 a b c d e f g h

#include <arpa/inet.h>
#include <netinet/in.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#define MAX_PAYLOAD 1000
#define MAX_MESSAGES 1024
#define SEND_WINDOW 4
#define RECV_WINDOW 4
#define RTO_MS 500
#define MAX_RETRY 10

#define FLAG_DATA 0x01
#define FLAG_ACK  0x02

#pragma pack(push, 1)
typedef struct {
    uint32_t seq;      // 当前数据包序号
    uint32_t ack;      // 累计确认号：下一个期待收到的 seq
    uint16_t wnd;      // 接收端剩余窗口
    uint16_t flags;    // DATA / ACK
    uint16_t len;      // payload 长度
} PacketHeader;
#pragma pack(pop)

typedef struct {
    PacketHeader header;
    char payload[MAX_PAYLOAD];
} Packet;

typedef struct {
    uint32_t seq;
    const char *data;
    uint16_t len;
    int sent;
    int retry;
    long long last_send_ms;
} SendSlot;

typedef struct {
    int used;
    uint32_t seq;
    uint16_t len;
    char data[MAX_PAYLOAD];
} RecvSlot;

static long long now_ms(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return tv.tv_sec * 1000LL + tv.tv_usec / 1000;
}

static int send_packet(int fd,
                       const struct sockaddr_in *peer,
                       socklen_t peer_len,
                       uint32_t seq,
                       uint32_t ack,
                       uint16_t wnd,
                       uint16_t flags,
                       const void *data,
                       uint16_t len) {
    if (len > MAX_PAYLOAD) {
        fprintf(stderr, "payload too large: %u\n", len);
        return -1;
    }

    Packet pkt;
    memset(&pkt, 0, sizeof(pkt));
    pkt.header.seq = htonl(seq);
    pkt.header.ack = htonl(ack);
    pkt.header.wnd = htons(wnd);
    pkt.header.flags = htons(flags);
    pkt.header.len = htons(len);

    if (data != NULL && len > 0) {
        memcpy(pkt.payload, data, len);
    }

    size_t packet_len = sizeof(PacketHeader) + len;
    ssize_t n = sendto(fd, &pkt, packet_len, 0,
                       (const struct sockaddr *)peer, peer_len);
    if (n != (ssize_t)packet_len) {
        perror("sendto");
        return -1;
    }

    return 0;
}

static ssize_t recv_packet(int fd,
                           Packet *pkt,
                           struct sockaddr_in *peer,
                           socklen_t *peer_len) {
    ssize_t n = recvfrom(fd, pkt, sizeof(*pkt), 0,
                         (struct sockaddr *)peer, peer_len);
    if (n < 0) {
        perror("recvfrom");
        return -1;
    }

    if (n < (ssize_t)sizeof(PacketHeader)) {
        fprintf(stderr, "drop short packet\n");
        return -1;
    }

    pkt->header.seq = ntohl(pkt->header.seq);
    pkt->header.ack = ntohl(pkt->header.ack);
    pkt->header.wnd = ntohs(pkt->header.wnd);
    pkt->header.flags = ntohs(pkt->header.flags);
    pkt->header.len = ntohs(pkt->header.len);

    if (pkt->header.len > MAX_PAYLOAD ||
        n != (ssize_t)(sizeof(PacketHeader) + pkt->header.len)) {
        fprintf(stderr, "drop bad packet\n");
        return -1;
    }

    return n;
}

static int count_recv_buffer(const RecvSlot *slots) {
    int count = 0;
    for (int i = 0; i < RECV_WINDOW; ++i) {
        if (slots[i].used) {
            count++;
        }
    }
    return count;
}

static int transmit_slot(int fd,
                         const struct sockaddr_in *peer,
                         socklen_t peer_len,
                         SendSlot *slot,
                         int retransmit) {
    printf("%s seq=%u retry=%d data=%s\n",
           retransmit ? "retransmit" : "send",
           slot->seq,
           slot->retry,
           slot->data);

    if (send_packet(fd, peer, peer_len, slot->seq, 0, 0, FLAG_DATA,
                    slot->data, slot->len) < 0) {
        return -1;
    }

    slot->sent = 1;
    slot->last_send_ms = now_ms();
    if (retransmit) {
        slot->retry++;
    }

    return 0;
}

static int poll_ack(int fd, uint32_t *acked, uint16_t *peer_wnd) {
    fd_set rfds;
    FD_ZERO(&rfds);
    FD_SET(fd, &rfds);

    struct timeval tv;
    tv.tv_sec = 0;
    tv.tv_usec = 100 * 1000;

    int ret = select(fd + 1, &rfds, NULL, NULL, &tv);
    if (ret < 0) {
        perror("select");
        return -1;
    }
    if (ret == 0) {
        return 0;
    }

    Packet pkt;
    struct sockaddr_in peer;
    socklen_t peer_len = sizeof(peer);

    if (recv_packet(fd, &pkt, &peer, &peer_len) < 0) {
        return 0;
    }

    if (pkt.header.flags & FLAG_ACK) {
        *acked = pkt.header.ack;
        *peer_wnd = pkt.header.wnd;
        return 1;
    }

    return 0;
}

static int retransmit_window(int fd,
                             const struct sockaddr_in *peer,
                             socklen_t peer_len,
                             SendSlot *slots,
                             uint32_t send_base,
                             uint32_t next_seq) {
    long long now = now_ms();
    SendSlot *base = &slots[send_base];

    if (!base->sent || now - base->last_send_ms < RTO_MS) {
        return 0;
    }

    printf("timeout at seq=%u, retransmit current window\n", send_base);

    for (uint32_t seq = send_base; seq < next_seq; ++seq) {
        SendSlot *slot = &slots[seq];
        if (slot->retry >= MAX_RETRY) {
            fprintf(stderr, "give up seq=%u\n", seq);
            return -1;
        }
        if (transmit_slot(fd, peer, peer_len, slot, 1) < 0) {
            return -1;
        }
    }

    return 0;
}

static int run_server(const char *port) {
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) {
        perror("socket");
        return 1;
    }

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons((uint16_t)atoi(port));

    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("bind");
        close(fd);
        return 1;
    }

    printf("server listen on udp:%s\n", port);

    uint32_t expected_seq = 0;
    RecvSlot slots[RECV_WINDOW];
    memset(slots, 0, sizeof(slots));

    for (;;) {
        Packet pkt;
        struct sockaddr_in peer;
        socklen_t peer_len = sizeof(peer);

        if (recv_packet(fd, &pkt, &peer, &peer_len) < 0) {
            continue;
        }

        if (!(pkt.header.flags & FLAG_DATA)) {
            continue;
        }

        if (pkt.header.seq < expected_seq) {
            printf("duplicate seq=%u expected=%u\n",
                   pkt.header.seq, expected_seq);
        } else if (pkt.header.seq >= expected_seq + RECV_WINDOW) {
            printf("outside recv window seq=%u expected=%u\n",
                   pkt.header.seq, expected_seq);
        } else {
            RecvSlot *slot = &slots[pkt.header.seq % RECV_WINDOW];
            if (!slot->used || slot->seq != pkt.header.seq) {
                slot->used = 1;
                slot->seq = pkt.header.seq;
                slot->len = pkt.header.len;
                memcpy(slot->data, pkt.payload, pkt.header.len);
                printf("buffer seq=%u\n", pkt.header.seq);
            }

            for (;;) {
                RecvSlot *head = &slots[expected_seq % RECV_WINDOW];
                if (!head->used || head->seq != expected_seq) {
                    break;
                }

                printf("deliver seq=%u data=%.*s\n",
                       head->seq,
                       head->len,
                       head->data);

                head->used = 0;
                expected_seq++;
            }
        }

        uint16_t wnd = (uint16_t)(RECV_WINDOW - count_recv_buffer(slots));

        // ack 是累计确认号，wnd 是当前还能缓存多少个乱序包。
        send_packet(fd, &peer, peer_len, 0, expected_seq, wnd, FLAG_ACK,
                    NULL, 0);
    }

    close(fd);
    return 0;
}

static int run_client(const char *ip, const char *port, int argc, char **argv) {
    if (argc > MAX_MESSAGES) {
        fprintf(stderr, "too many messages, max=%d\n", MAX_MESSAGES);
        return 1;
    }

    SendSlot slots[MAX_MESSAGES];
    memset(slots, 0, sizeof(slots));

    for (int i = 0; i < argc; ++i) {
        size_t len = strlen(argv[i]);
        if (len > MAX_PAYLOAD) {
            fprintf(stderr, "message too large: %s\n", argv[i]);
            return 1;
        }

        slots[i].seq = (uint32_t)i;
        slots[i].data = argv[i];
        slots[i].len = (uint16_t)len;
    }

    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) {
        perror("socket");
        return 1;
    }

    struct sockaddr_in peer;
    memset(&peer, 0, sizeof(peer));
    peer.sin_family = AF_INET;
    peer.sin_port = htons((uint16_t)atoi(port));

    if (inet_pton(AF_INET, ip, &peer.sin_addr) != 1) {
        fprintf(stderr, "bad ip: %s\n", ip);
        close(fd);
        return 1;
    }

    uint32_t total = (uint32_t)argc;
    uint32_t send_base = 0;
    uint32_t next_seq = 0;
    uint16_t peer_wnd = RECV_WINDOW;

    while (send_base < total) {
        uint32_t effective_window = SEND_WINDOW;
        if (peer_wnd < effective_window) {
            effective_window = peer_wnd;
        }

        while (next_seq < total &&
               next_seq < send_base + effective_window) {
            if (transmit_slot(fd, &peer, sizeof(peer),
                              &slots[next_seq], 0) < 0) {
                close(fd);
                return 1;
            }
            next_seq++;
        }

        uint32_t acked = send_base;
        int ack_ret = poll_ack(fd, &acked, &peer_wnd);
        if (ack_ret < 0) {
            close(fd);
            return 1;
        }

        if (ack_ret == 1) {
            if (acked > send_base && acked <= total) {
                printf("ack=%u, window slide %u -> %u, peer_wnd=%u\n",
                       acked, send_base, acked, peer_wnd);
                send_base = acked;
                continue;
            }

            printf("ignore stale/bad ack=%u send_base=%u peer_wnd=%u\n",
                   acked, send_base, peer_wnd);
        }

        if (retransmit_window(fd, &peer, sizeof(peer), slots,
                              send_base, next_seq) < 0) {
            close(fd);
            return 1;
        }
    }

    printf("all messages acked\n");

    close(fd);
    return 0;
}

int main(int argc, char *argv[]) {
    if (argc >= 3 && strcmp(argv[1], "server") == 0) {
        return run_server(argv[2]);
    }

    if (argc >= 5 && strcmp(argv[1], "client") == 0) {
        return run_client(argv[2], argv[3], argc - 4, &argv[4]);
    }

    fprintf(stderr,
            "usage:\n"
            "  %s server <port>\n"
            "  %s client <ip> <port> <msg1> [msg2...]\n",
            argv[0],
            argv[0]);
    return 1;
}
```

这个窗口版和 TCP 的对应关系是：

| TCP 能力 | 这个例子的对应实现 |
| --- | --- |
| 发送窗口 | `send_base + SEND_WINDOW` 限制最多在途包 |
| 接收窗口 | 服务端缓存 `[expected_seq, expected_seq + RECV_WINDOW)` |
| 窗口通告 | ACK 包里的 `wnd` |
| 累计确认 | `ack = expected_seq` |
| 超时重传 | `RTO_MS` 到期后重传当前未确认窗口 |
| 按序交付 | 只有连续数据都到达时才向上层交付 |

发送端能否继续发新包，本质上就是这个判断：

```c
next_seq < send_base + min(SEND_WINDOW, peer_wnd)
```

收到累计 ACK 后：

```c
send_base = ack;
```

这就是滑动窗口“向右滑”的动作。

这个版本仍然没有实现完整 TCP：

* 没有三次握手和四次挥手
* 没有拥塞控制，`SEND_WINDOW` 是固定值
* 没有 RTT 估计，RTO 是固定值
* 没有 SACK，丢包时会重传整个未确认窗口
* 服务端示例只维护了一个接收窗口，没有按客户端地址区分 session

---

## 10. 真正落地时的几个关键取舍

### 10.1 先做“可靠消息”，再做“可靠字节流”

如果目标是游戏状态同步、命令包、RPC：

* 做**可靠消息协议**通常更简单

如果非要完全模拟 TCP 的“字节流语义”，复杂度会显著上升，因为你还要处理：

* 流式重组
* 半关闭
* 更复杂的缓冲管理

### 10.2 不要一开始就试图复刻内核 TCP

更现实的路线是：

1. 先做连接 + seq + ack + 重传
2. 再做乱序缓存 + 滑动窗口
3. 再补 RTT / RTO
4. 最后再考虑拥塞控制

否则很容易一上来就把实现写散。

### 10.3 现代工程更常见的是“在 UDP 上做定制协议”

很多时候我们并不是要“重新发明 TCP”，而是要：

* 保留 UDP 的低时延和灵活性
* 只补自己需要的那部分可靠性

例如：

* 关键帧可靠重传
* 状态包不重传，只发送最新值
* 控制消息必须有 ACK

这比完整复刻 TCP 更符合实时系统的实际需求。

---

## 11. 小结

可以把 UDP 记成一句话：

> UDP 提供的是“轻量发报文”的能力，可靠、有序、流控、拥塞控制都要你自己决定要不要补。

如果要用 UDP 实现类似 TCP 的能力，最关键不是 API，而是这几个机制：

* 序号 `seq`
* 确认 `ack`
* 超时重传
* 滑动窗口
* 按序交付
* 流控 / 拥塞控制

把这些拆开理解之后，“UDP 实现 TCP”就不再神秘，本质上就是：

* **在用户态自己维护传输状态机**

---

## 参考

* [Linux网络基础——传输层协议 UDP 与 TCP](https://www.cnblogs.com/yangykaifa/p/19447080)
* RFC 768: UDP
* RFC 793: TCP
