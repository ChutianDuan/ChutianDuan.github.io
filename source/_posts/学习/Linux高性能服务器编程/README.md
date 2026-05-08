---
title: "Linux 高性能服务器编程"
date: 2026-05-04 15:17:57
updated: 2026-05-04 15:17:57
categories:
  - "学习"
  - "Linux高性能服务器编程"
permalink: /notes/linux高性能服务器编程/
---

# Linux 高性能服务器编程

时间：2026/05/04

> 这组笔记参考《Linux 高性能服务器编程》的公开目录主线整理，并按自己的语言重写成复习笔记。
> 阅读时可以沿着“协议基础 -> 网络 API -> 高级 I/O -> 服务器框架 -> 并发模型 -> 调试监测”的顺序推进。

---

## 目录

### 1. [TCP/IP 协议族、IP 与 TCP 协议详解](/notes/linux高性能服务器编程/4-tcpip协议族-ip与tcp协议详解/)

内容重点：

* TCP/IP 分层、以太网、ARP、IP、ICMP
* TCP 头部、三次握手、四次挥手
* TCP 状态、`TIME_WAIT`、`CLOSE_WAIT`
* 滑动窗口、拥塞控制、Nagle 与延迟 ACK
* 从访问 Web 服务器理解完整链路

这是理解 socket 行为、抓包结果和线上连接状态的协议基础。

### 2. [Socket 基础与 TCP 编程](/notes/linux高性能服务器编程/3-socket基础与tcp编程/)

内容重点：

* TCP 服务端 `socket/bind/listen/accept`
* TCP 客户端 `connect/send/recv`
* 地址、端口、网络字节序
* TCP 字节流、粘包/半包和协议边界
* 非阻塞 socket、常见错误码和 socket options

这是学习 libevent、`epoll` 和 Reactor 前最应该打牢的 API 基础。

### 3. [UDP 通信](/notes/linux高性能服务器编程/udp/)

内容重点：

* UDP 与 TCP 的语义差异
* Linux 下的常用 UDP 接口
* UDP 服务端的基本工作流
* 在 UDP 上实现类似 TCP 的可靠传输思路

适合用来理解报文边界、丢包 / 乱序 / 重复，以及可靠性到底由谁负责。

### 4. [高级 I/O 函数与零拷贝](/notes/linux高性能服务器编程/5-高级io函数与零拷贝/)

内容重点：

* `pipe`、`dup/dup2`
* `readv/writev`
* `sendfile`
* `mmap/munmap`
* `splice`、`tee`
* `fcntl`、非阻塞与 close-on-exec

更偏“如何减少系统调用和数据复制”。

### 5. [Linux 服务器程序规范](/notes/linux高性能服务器编程/6-linux服务器程序规范/)

内容重点：

* 日志与 `syslog`
* 用户、组和最小权限
* 进程组、会话与后台化
* 资源限制、工作目录、根目录
* pidfile、信号约定和优雅退出

更偏“让服务像服务一样稳定运行”。

### 6. [[1]libevent.md](/notes/linux高性能服务器编程/1-libevent/)

内容重点：

* `event_base` 事件循环
* `evconnlistener` 与 TCP 监听
* `bufferevent` 与 `evbuffer`
* 完整 echo server 示例
* 半包解析、水位线、超时和服务端背压

更偏服务端事件驱动入门。

### 7. [[2]libevent.md](/notes/linux高性能服务器编程/2-libevent/)

内容重点：

* `bufferevent_socket_new`
* `bufferevent_socket_connect`
* 异步 DNS
* 回调、水位、超时、输出缓冲
* 重连策略和客户端状态机

更偏“如何基于 libevent 发起连接并管理 I/O”。

### 8. [多进程、多线程与进程池线程池](/notes/linux高性能服务器编程/7-多进程-多线程与进程池线程池/)

内容重点：

* `fork`、`exec` 和僵尸进程
* pipe、共享内存、消息队列、fd 传递
* pthread、互斥锁、条件变量和信号量
* 进程池、线程池、半同步半反应堆
* 队列上限、连接归属和优雅退出

更偏并发模型和池化架构。

### 9. [高性能服务器编程笔记一](/notes/linux高性能服务器编程/高性能服务器编程笔记一/)

内容重点：

* `epoll` 的 LT / ET 与 Reactor
* 非阻塞 socket 的常见错误处理
* `timerfd` / `eventfd` / `signalfd`
* 线程池与 I/O 线程分层
* HTTP 解析与应用层协议设计
* Linux 网络调优参数与排障方法

更偏“把一个事件驱动服务端补成可落地工程模型”。

### 10. [服务器调试、测试与系统监测](/notes/linux高性能服务器编程/8-服务器调试-测试与系统监测/)

内容重点：

* 最大文件描述符数和内核参数
* gdb 调试多进程 / 多线程
* 压力测试关注指标
* `tcpdump`、`lsof`、`nc`、`strace`
* `ss`、`vmstat`、`mpstat`、`ifstat`

更偏线上排障和压测闭环。

---

## 建议阅读顺序

1. `[4]TCPIP协议族、IP与TCP协议详解.md`
2. `[3]Socket基础与TCP编程.md`
3. `UDP.md`
4. `[5]高级IO函数与零拷贝.md`
5. `[6]Linux服务器程序规范.md`
6. `[1]libevent.md`
7. `[2]libevent.md`
8. `[7]多进程、多线程与进程池线程池.md`
9. `高性能服务器编程笔记一.md`
10. `[8]服务器调试、测试与系统监测.md`

这条顺序基本对应《Linux 高性能服务器编程》的公开章节主线，但把你已有的 libevent 和综合工程笔记放进了更自然的位置。

---

## 已覆盖的书中主线

* TCP/IP 协议族、IP、TCP 与 Web 访问链路
* Linux 网络编程基础 API
* 高级 I/O 函数和零拷贝
* Linux 服务器程序规范
* 高性能服务器框架、Reactor、I/O 复用、信号和定时器
* libevent 服务端与客户端
* 多进程、多线程、进程池和线程池
* 服务器调试、压力测试和系统监测工具

---

## 后续仍可补的主题

* `SO_REUSEPORT`、RSS / RPS / XPS 与多队列
* `io_uring` 与传统 Reactor 的差异
* TLS / OpenSSL 与 libevent 的整合
* 负载均衡服务器案例
* 数据库 / 缓存 / RPC 接入后的背压治理
