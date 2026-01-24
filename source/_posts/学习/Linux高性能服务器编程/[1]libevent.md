---
title: "libevent"
date: 2026-01-07 10:41:29
tags:
  - "网络编程"
  - "libevent"
  - "Reactor"
categories:
  - "学习"
  - "Linux高性能服务器编程"
thumbnail: /img/covers/cover6.jpg
---
# libevent 笔记
## TCP evconnlistener
evconnlistener机制替代了之前socket bind listen 监听套字的创立

### 创建evconnlistener 接口
``` c++
struct evconnlistener *evconnlistener_new(struct event_base *base,
    evconnlistener_cb cb, void *ptr, unsigned flags, int backlog,
    evutil_socket_t fd);
struct evconnlistener *evconnlistener_new_bind(struct event_base *base,
    evconnlistener_cb cb, void *ptr, unsigned flags, int backlog,
    const struct sockaddr *sa, int socklen);
void evconnlistener_free(struct evconnlistener *lev);
```
evconnlistener_new和evconnlistener_new_bind都用于分配和返回一个新的用于监听连接的对象。 每个用于监听的对象都使用event_base来维护一个建立的连接。当有新的TCP 连接发生时，回调函数就会调用.

base： event_base对象。参考event_base。
cb： 回调函数， 当有新的TCP连接发生时，会唤醒回调函数。
ptr： 传递给回调函数的参数。
flags： 一些标志， 后面会进一步介绍。
backlog： 监听队列允许容纳的最大连接数。
fd： 函数evconnlistener_new假设我们已经绑定了套接字到要监听的端口上，fd参数就是我们已经绑定的socket套接字。
sa： evconnlistener_new_bind帮助我们绑定监听地址。sa就是传入的监听地址。
socklen： sa的长度。

一般通常情况下flags设置LEV_OPT_CLOSE_ON_FREE，LEV_OPT_REUSEABLE

### 回调函数
``` c++
typedef void (*evconnlistener_cb)(struct evconnlistener *listener,
    evutil_socket_t sock, struct sockaddr *addr, int len, void *ptr);
```

### 监听开启和关闭
``` c++
int evconnlistener_disable(struct evconnlistener *lev);
int evconnlistener_enable(struct evconnlistener *lev);
```

### 从enconnlistener 中获取信息
``` c++
// 获得一个evconnlistener对象的套接字
evutil_socket_t evconnlistener_get_fd(struct evconnlistener *lev);
// 获得一个evconnlistener对象event_base对象
evutil_socket_t evconnlistener_get_base(struct evconnlistener *lev);
```
### 完整示范
``` c++
#include <event2/listener.h>
#include <event2/bufferevent.h>
#include <event2/buffer.h>
 
#include <arpa/inet.h>
 
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <errno.h>
 
static void
echo_read_cb(struct bufferevent *bev, void *ctx)
{
        /*获取读入读出缓冲区*/
        struct evbuffer *input = bufferevent_get_input(bev);
        struct evbuffer *output = bufferevent_get_output(bev);
 
        /* 将输入缓冲区的内容添加到输出缓冲区，实现回声功能 */
        evbuffer_add_buffer(output, input);
}
 
static void
echo_event_cb(struct bufferevent *bev, short events, void *ctx)
{
        if (events & BEV_EVENT_ERROR)
                perror("Error from bufferevent");
        if (events & (BEV_EVENT_EOF | BEV_EVENT_ERROR)) {
                bufferevent_free(bev);
        }
}
 
static void
accept_conn_cb(struct evconnlistener *listener,
    evutil_socket_t fd, struct sockaddr *address, int socklen,
    void *ctx)
{
        struct event_base *base = evconnlistener_get_base(listener);//获取事件
        struct bufferevent *bev = bufferevent_socket_new(
                base, fd, BEV_OPT_CLOSE_ON_FREE);//建立连接
 
        bufferevent_setcb(bev, echo_read_cb, NULL, echo_event_cb, NULL);//设置read和错误回调函数，传入参数为0
 
        bufferevent_enable(bev, EV_READ|EV_WRITE);//设置出发条件，EV_READ 读入时触发，EV_WRITE 错误是触发
}
 
static void
accept_error_cb(struct evconnlistener *listener, void *ctx)
{
        struct event_base *base = evconnlistener_get_base(listener);
        int err = EVUTIL_SOCKET_ERROR();
        fprintf(stderr, "Got an error %d (%s) on the listener. "
                "Shutting down.\n", err, evutil_socket_error_to_string(err));
 
        event_base_loopexit(base, NULL);
}
 
int
main(int argc, char **argv)
{
        struct event_base *base;
        struct evconnlistener *listener;
        struct sockaddr_in sin;
 
        int port = 9876;
 
        if (argc > 1) {
                port = atoi(argv[1]);
        }
        if (port<=0 || port>65535) {
                puts("Invalid port");
                return 1;
        }
 
        base = event_base_new();
        if (!base) {
                puts("Couldn't open event base");
                return 1;
        }

        memset(&sin, 0, sizeof(sin));

        sin.sin_family = AF_INET;
        sin.sin_addr.s_addr = htonl(0);
        sin.sin_port = htons(port);
 
        listener = evconnlistener_new_bind(base, accept_conn_cb, NULL,
            LEV_OPT_CLOSE_ON_FREE|LEV_OPT_REUSEABLE, -1,
            (struct sockaddr*)&sin, sizeof(sin));
        if (!listener) {
                perror("Couldn't create listener");
                return 1;
        }
        evconnlistener_set_error_cb(listener, accept_error_cb);
 
        event_base_dispatch(base);
        return 0;
}
```

## bufferevents

bufferevent 由一个底层传输系统（比如socket），一个读缓冲区和一个写缓冲区组成

### bufferevent和evbuffers
每一个bufferevent 都有一个输入缓冲区和输出缓冲区， 这些缓冲区（buffer）都是struct evbuffer 类型


### 基于socket 的bufferevent

bufferevent_socket_new()
struct bufferevent *bufferevent_socket_new(
    struct event_base *base,
    evutil_socket_t fd,
    enum bufferevent_options options);


正常通过ip host进行访问 后续可以使用socket进行构建client客户端连接简化实现
int bufferevent_socket_connect(struct bufferevent *bev,
    struct sockaddr *address, int addrlen);
通过域名进行解析访问
 int bufferevent_socket_connect_hostname(struct bufferevent *bev,
    struct evdns_base *dns_base, int family, const char *hostname,
    int port);
int bufferevent_socket_get_dns_error(struct bufferevent *bev);

注：
bufferevent_socket_connect和evconnlistener_new_bind的区别
bufferevent_socket_connect：用于主动建立连接，即作为客户端去连接服务器。
evconnlistener_new_bind：用于被动接受连接，即作为服务器监听端口并接受客户端的连接。

### 回调函数 & 水位线操作
水位线设置
void bufferevent_setwatermark(struct bufferevent *bufev, short events,
    size_t lowmark, size_t highmark);
events参数传入决定设置不同的水危险
EV_WRITE、 EV_READ

读、写、报错回调函数调用
void bufferevent_setcb(struct bufferevent *bufev,
    bufferevent_data_cb readcb, bufferevent_data_cb writecb,
    bufferevent_event_cb eventcb, void *cbarg);


``` c++
#include <event2/event.h>
#include <event2/bufferevent.h>
#include <event2/buffer.h>
#include <event2/util.h>

#include <stdlib.h>
#include <errno.h>
#include <string.h>

struct info {
    const char *name;
    size_t total_drained;
};

void read_callback(struct bufferevent *bev, void *ctx)
{
    struct info *inf = ctx;
    struct evbuffer *input = bufferevent_get_input(bev);
    size_t len = evbuffer_get_length(input);
    if (len) {
        inf->total_drained += len;
        evbuffer_drain(input, len);// 和evbuffer_remove()操作类似，但不执行copy工作仅删除长度len的缓冲
        printf("Drained %lu bytes from %s\n",
             (unsigned long) len, inf->name);
    }
}

void event_callback(struct bufferevent *bev, short events, void *ctx)
{
    struct info *inf = ctx;
    struct evbuffer *input = bufferevent_get_input(bev);
    int finished = 0;

    if (events & BEV_EVENT_EOF) {
        size_t len = evbuffer_get_length(input);
        printf("Got a close from %s.  We drained %lu bytes from it, "
            "and have %lu left.\n", inf->name,
            (unsigned long)inf->total_drained, (unsigned long)len);
        finished = 1;
    }
    if (events & BEV_EVENT_ERROR) {
        printf("Got an error from %s: %s\n",
            inf->name, evutil_socket_error_to_string(EVUTIL_SOCKET_ERROR()));
        finished = 1;
    }
    if (finished) {
        free(ctx);
        bufferevent_free(bev);
    }
}

struct bufferevent *setup_bufferevent(void)
{
    struct bufferevent *b1 = NULL;
    struct info *info1;

    info1 = malloc(sizeof(struct info));
    info1->name = "buffer 1";
    info1->total_drained = 0;

    /* ... Here we should set up the bufferevent and make sure it gets
       connected... */

    /* Trigger the read callback only whenever there is at least 128 bytes
       of data in the buffer. */
    bufferevent_setwatermark(b1, EV_READ, 128, 0);

    bufferevent_setcb(b1, read_callback, NULL, event_callback, info1);

    bufferevent_enable(b1, EV_READ); /* Start reading. */
    return b1;
}
```
### bufferevent中的数据操作

获取不同缓冲区的evbuffer描述符
struct evbuffer *bufferevent_get_input(struct bufferevent *bufev);
struct evbuffer *bufferevent_get_output(struct bufferevent *bufev);


写入读入操作
int  bufferevent_write(struct  bufferevent *bufev,  const  void*data,  size_t  size);
int  bufferevent_write_buffer(struct  bufferevent *bufev,  struct  evbuffer*buf);


size_t bufferevent_read(struct bufferevent *bufev, void *data, size_t size);
int bufferevent_read_buffer(struct bufferevent *bufev,
    struct evbuffer *buf);


### 程序自我通信
int bufferevent_pair_new(struct event_base *base, int options,
    struct bufferevent *pair[2]);

pair[0]和pair[1] 设置为一对相互连接的bufferevent


## evbuffer缓冲IO的实用功能
创建和释放
struct evbuffer *evbuffer_new(void);
void evbuffer_free(struct evbuffer *buf);

