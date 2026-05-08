---
title: "高级 I/O 函数与零拷贝"
date: 2026-05-04 15:17:10
updated: 2026-05-04 15:17:10
categories:
  - "学习"
  - "Linux高性能服务器编程"
permalink: /notes/linux高性能服务器编程/5-高级io函数与零拷贝/
---

# 高级 I/O 函数与零拷贝

时间：2026/05/04

> 关键词：`pipe`、`dup`、`readv/writev`、`sendfile`、`mmap`、`splice`、`tee`、`fcntl`、零拷贝
> 核心目标：理解 Linux 服务端里常见高级 I/O 函数的适用场景，知道什么时候能减少数据拷贝和系统调用次数。

---

## 1. 为什么需要高级 I/O 函数

最基本的 I/O 是：

```c
read(fd, buf, size);
write(fd, buf, size);
```

但高性能服务端经常面对：

* 文件直接发给 socket
* 多段内存一次性发送
* 进程间传递数据
* 避免用户态和内核态之间反复拷贝
* 修改 fd 属性，如非阻塞、close-on-exec

高级 I/O 函数就是为这些场景准备的。

---

## 2. `pipe`：最基础的进程间字节流

```c
#include <unistd.h>

int pipefd[2];
pipe(pipefd);
```

得到两个 fd：

* `pipefd[0]`：读端
* `pipefd[1]`：写端

常见用途：

* 父子进程通信
* shell 管道
* 老式 Reactor 里的自唤醒
* 把信号处理转换成 fd 可读事件

注意：

* 管道是单向的
* 管道缓冲区有限
* 写端全关闭后，读端读到 EOF
* 读端全关闭后，继续写可能触发 `SIGPIPE`

现代 Linux 中，线程唤醒更常用 `eventfd`，但理解 pipe 仍然很重要。

---

## 3. `dup` 和 `dup2`：复制文件描述符

```c
#include <unistd.h>

int newfd = dup(oldfd);
dup2(oldfd, targetfd);
```

它们复制的是文件描述符，使多个 fd 指向同一个打开文件描述。

常见用途：

* 重定向标准输入输出
* CGI 子进程把 socket 变成 `STDOUT_FILENO`
* daemon 把标准输入输出重定向到 `/dev/null`

例子：

```c
int fd = open("/tmp/out.log", O_WRONLY | O_CREAT | O_APPEND, 0644);
dup2(fd, STDOUT_FILENO);
close(fd);
```

之后 `printf()` 的输出会写到文件。

---

## 4. `readv` / `writev`：分散读和集中写

`writev` 可以把多段内存一次写出去：

```c
#include <sys/uio.h>

struct iovec iov[2];
iov[0].iov_base = header;
iov[0].iov_len = header_len;
iov[1].iov_base = body;
iov[1].iov_len = body_len;

writev(fd, iov, 2);
```

适合：

* HTTP 响应头 + 文件内容描述
* 协议头 + body
* 避免先把多段数据拼成一个大 buffer

注意：

* 非阻塞 fd 上 `writev` 也可能部分写成功
* 必须能根据返回字节数推进多个 `iovec`

`readv` 则可以把一次读取分散到多段内存。

---

## 5. `sendfile`：文件到 socket 的经典零拷贝

```c
#include <sys/sendfile.h>

ssize_t n = sendfile(out_fd, in_fd, &offset, count);
```

常见用法：

* `in_fd` 是普通文件
* `out_fd` 是 socket

它能避免传统路径：

```text
read(file -> user buffer)
write(user buffer -> socket)
```

带来的用户态中转。

适合：

* 静态文件服务器
* 下载服务
* 反向代理发送本地缓存文件

注意：

* 非阻塞 socket 上也要处理 `EAGAIN`
* 大文件要循环发送
* 发送动态生成内容时，`sendfile` 不一定适合

---

## 6. `mmap` / `munmap`：把文件映射到内存

```c
#include <sys/mman.h>

void *p = mmap(NULL, len, PROT_READ, MAP_PRIVATE, fd, 0);
munmap(p, len);
```

`mmap` 让文件内容像内存一样访问。

适合：

* 读取大文件中的随机位置
* 多进程共享同一份只读文件映射
* 构建内存索引

不适合：

* 简单顺序发送文件时无脑替代 `sendfile`
* 文件很小但映射/解映射非常频繁
* 不处理页错误带来的延迟抖动

工程上要注意：

* 文件被截断后访问映射区可能触发 `SIGBUS`
* 映射长度和页边界有关
* 写映射要考虑同步和一致性

---

## 7. `splice`：在内核对象之间搬数据

```c
#define _GNU_SOURCE
#include <fcntl.h>

ssize_t splice(int fd_in, loff_t *off_in,
               int fd_out, loff_t *off_out,
               size_t len, unsigned int flags);
```

`splice` 可以在两个 fd 之间移动数据，但至少一端通常要是 pipe。

典型代理思路：

```text
socket A -> pipe -> socket B
```

这样可以减少数据进入用户态的次数。

适合：

* TCP 转发
* 简单代理
* 文件/管道/socket 间数据搬运

限制：

* 接口语义比 `read/write` 复杂
* 并不是所有 fd 组合都支持
* 业务需要解析数据时，仍然要进用户态

---

## 8. `tee`：复制管道数据

```c
ssize_t tee(int fd_in, int fd_out, size_t len, unsigned int flags);
```

`tee` 在两个 pipe 之间复制数据，通常不消耗输入 pipe 中的数据。

适合：

* 流量复制
* 日志旁路
* 把同一份数据送到多个后续处理链路

它比较底层，普通业务代码很少直接用，但在理解 Linux 零拷贝管线时很有帮助。

---

## 9. `fcntl`：fd 控制中心

常见用途：

### 9.1 设置非阻塞

```c
int flags = fcntl(fd, F_GETFL, 0);
fcntl(fd, F_SETFL, flags | O_NONBLOCK);
```

### 9.2 设置 close-on-exec

```c
int flags = fcntl(fd, F_GETFD);
fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
```

这能避免 `exec` 后把不该继承的 fd 泄漏给子进程。

现代创建 fd 时，也常直接使用：

* `SOCK_CLOEXEC`
* `O_CLOEXEC`
* `EPOLL_CLOEXEC`

减少先创建、再设置之间的竞态窗口。

---

## 10. 什么叫零拷贝

传统文件发送路径大致是：

```text
磁盘 -> 内核页缓存 -> 用户缓冲区 -> socket 内核缓冲 -> 网卡
```

零拷贝优化的目标是减少：

* 用户态和内核态之间的数据拷贝
* 系统调用次数
* CPU cache 污染

但“零拷贝”不是绝对不拷贝，而是减少不必要的数据搬运。
不同硬件、内核版本、文件系统、网卡 offload 能力都会影响实际效果。

---

## 11. 怎么选择

| 场景 | 优先考虑 |
| --- | --- |
| 发送静态文件 | `sendfile` |
| 发送 header + body 多段数据 | `writev` |
| 进程内或父子进程简单通信 | `pipe` / `socketpair` |
| 文件随机读取或共享映射 | `mmap` |
| TCP 纯转发代理 | `splice` |
| 修改 fd 属性 | `fcntl` |

实践顺序：

1. 先用简单 `read/write` 做对
2. 确认瓶颈在数据拷贝或系统调用
3. 再换 `writev/sendfile/splice`
4. 用压测和 `perf/strace` 验证收益

---

## 12. 常见坑

### 12.1 非阻塞下忘记处理部分写

`writev/sendfile/splice` 都可能只完成一部分。

### 12.2 以为 `mmap` 一定更快

`mmap` 可能引入页错误、TLB 压力和生命周期复杂度。

### 12.3 零拷贝和协议解析冲突

如果业务必须检查或修改 payload，数据通常还是要进入用户态。

### 12.4 忘记 close-on-exec

服务端 fork/exec 子进程时，fd 泄漏可能导致端口、连接、文件长期不释放。

---

## 13. 一页总结

高级 I/O 函数最值得记住的是：

1. `pipe` 是基础进程间字节流
2. `dup/dup2` 常用于重定向
3. `writev` 能减少拼包和系统调用
4. `sendfile` 适合文件到 socket
5. `mmap` 适合文件映射，不是通用加速器
6. `splice/tee` 适合更底层的内核态数据管线
7. `fcntl` 是设置非阻塞和 close-on-exec 的常用入口

如果只记一句：

> 高级 I/O 优化不是炫 API，而是减少不必要的数据复制、系统调用和 fd 管理错误。

---

## 14. 参考资料

1. Linux man-pages: sendfile
   <https://man7.org/linux/man-pages/man2/sendfile.2.html>

2. Linux man-pages: splice
   <https://man7.org/linux/man-pages/man2/splice.2.html>

3. Linux man-pages: mmap
   <https://man7.org/linux/man-pages/man2/mmap.2.html>

4. Linux man-pages: readv/writev
   <https://man7.org/linux/man-pages/man2/readv.2.html>
