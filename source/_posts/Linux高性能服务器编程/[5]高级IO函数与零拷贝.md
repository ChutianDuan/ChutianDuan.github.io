---
title: "`sendfile()` 返回成功，为什么客户端收到的文件仍可能不完整？"
date: 2026-07-13 14:54:42
updated: 2026-07-13 14:54:42
categories:
  - "学习"
  - "Linux 服务器编程"
permalink: /notes/linux高性能服务器编程/5-高级io函数与零拷贝/
series: "Linux 服务器编程"
series_order: 5
---

时间：2026/05/04

> 关键词：`sendfile`、部分写、零拷贝、`writev`、`mmap`、`splice`、`tee`、文件描述符

静态文件服务器的发送代码看起来可以非常简单：

```c
/* 存在隐患的写法 */
sendfile(client_fd, file_fd, NULL, file_size);
close(client_fd);
```

它没有用户态缓冲区，也只调用了一次系统调用，似乎已经完成了“零拷贝发送”。但文件稍大、socket 改成非阻塞，或发送过程被信号打断后，客户端可能只收到文件开头的一部分。

问题出在一个常见误解：

> `sendfile()` 返回正数只表示本次成功发送了这些字节，不保证等于请求的 `count`。

这和 `write()`、`writev()` 一样属于部分写（partial write）。零拷贝改变了数据经过的路径，却没有改变流式 I/O 必须处理进度、阻塞和错误的基本规则。

本文将从这个问题出发，回答：

1. “零拷贝”究竟减少了哪一次数据搬运？
2. 如何写出一个完整、不会静默截断文件的 `sendfile()` 循环？
3. 非阻塞 socket 遇到 `EAGAIN` 时为什么不能原地自旋？
4. `writev`、`mmap`、`splice` 和 `tee` 分别适合什么数据路径？
5. 怎样证明优化真的有效，而不是只换了一个更复杂的 API？

---

## 一、一次正数返回，为什么不代表整个文件发送完成？

Linux 的 `sendfile()` 原型是：

```c
#include <sys/sendfile.h>

ssize_t sendfile(int out_fd, int in_fd, off_t *offset, size_t count);
```

返回值与常见 I/O 系统调用保持一致：

| 返回值 | 含义 | 调用者应该做什么 |
| --- | --- | --- |
| `> 0` | 本次实际传输了这些字节 | 推进偏移，继续处理剩余部分 |
| `0` | 没有更多数据可读 | 判断是否确实到达预期文件末尾 |
| `-1, errno == EINTR` | 被信号中断 | 通常可以重试 |
| `-1, errno == EAGAIN` | 非阻塞输出暂时写不下 | 等待可写事件后继续 |
| 其他 `-1` | 发生错误 | 记录错误并结束本次传输 |

即使调用成功，返回值也可以小于 `count`。另外，Linux 每次 `sendfile()` 最多传输 `0x7ffff000` 字节；大文件从设计上就不能依赖单次调用。

`offset` 参数还决定了进度由谁保存：

- 传入非空指针：从 `*offset` 读取，返回时更新它，但不改变 `in_fd` 自身的文件偏移；
- 传入 `NULL`：使用并推进 `in_fd` 当前偏移。

服务器通常显式保存每个连接的 `offset`，因为同一文件 fd 可能被多个传输任务共享，也因为事件循环需要在 `EAGAIN` 后准确恢复。

---

## 二、“零拷贝”到底减少了什么？

传统的文件到 socket 发送通常写成：

```c
ssize_t n = read(file_fd, user_buffer, sizeof(user_buffer));
write(socket_fd, user_buffer, (size_t)n);
```

概念上的数据路径是：

```text
文件 / 磁盘
    ↓
内核页缓存
    ↓ copy_to_user
用户态 buffer
    ↓ copy_from_user
socket 发送路径
    ↓
网卡
```

`sendfile()` 让内核直接组织“文件描述符 → 输出描述符”的传输：

```text
文件 / 磁盘
    ↓
内核页缓存 ─────────────▶ socket 发送路径 ─▶ 网卡
                 不再经过应用的用户态数据缓冲区
```

它通常能减少用户态与内核态之间的复制、系统调用次数和 CPU cache 污染。但“零拷贝”是一个工程术语，不应理解为任何硬件和内核路径上都绝对没有字节复制。页缓存、socket 缓冲组织、DMA、校验和与网卡能力都会影响实际路径。

因此，`sendfile()` 解决的是“应用不需要亲自把文件读进用户缓冲区再写出”，并不解决：

- socket 背压；
- 部分写；
- 文件在传输过程中被修改；
- TLS、压缩或内容改写；
- 客户端是否真正收完并校验成功。

---

## 三、最小可运行版本：循环发送完整文件

下面的程序使用一个临时文件和一对本地流式 socket。发送端通过 `sendfile()` 把文件送入 socket，接收端再读取并打印。这样无需启动服务器，也不依赖外部网络。

运行条件：

- Linux；
- GCC 或 Clang；
- C11；
- 使用 Linux 版本的 `<sys/sendfile.h>`。

macOS、FreeBSD 等系统虽然也可能提供同名函数，但原型与语义不同，不能直接编译这份 Linux 代码。

```c
#define _GNU_SOURCE

#include <sys/sendfile.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void fail(const char *operation) {
    perror(operation);
    exit(EXIT_FAILURE);
}

static void write_all(int fd, const char *data, size_t length) {
    size_t written = 0;
    while (written < length) {
        ssize_t n = write(fd, data + written, length - written);
        if (n > 0) {
            written += (size_t)n;
        } else if (n < 0 && errno == EINTR) {
            continue;
        } else {
            fail("write");
        }
    }
}

static void send_file_all(int socket_fd, int file_fd, off_t file_size) {
    off_t offset = 0;

    while (offset < file_size) {
        size_t remaining = (size_t)(file_size - offset);
        ssize_t n = sendfile(socket_fd, file_fd, &offset, remaining);

        if (n > 0) {
            continue;  /* offset 已由 sendfile 更新 */
        }
        if (n < 0 && errno == EINTR) {
            continue;
        }
        if (n == 0) {
            errno = EIO;  /* 文件可能在传输途中被截短 */
        }
        fail("sendfile");
    }
}

int main(void) {
    static const char payload[] = "sendfile keeps its own progress\n";
    char path[] = "/tmp/sendfile-demo-XXXXXX";

    int file_fd = mkstemp(path);
    if (file_fd < 0) {
        fail("mkstemp");
    }
    if (unlink(path) < 0) {
        fail("unlink");
    }

    write_all(file_fd, payload, sizeof(payload) - 1);

    int sockets[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) < 0) {
        fail("socketpair");
    }

    send_file_all(sockets[0], file_fd, (off_t)(sizeof(payload) - 1));
    if (shutdown(sockets[0], SHUT_WR) < 0) {
        fail("shutdown");
    }

    char buffer[128];
    size_t used = 0;
    for (;;) {
        ssize_t n = read(sockets[1], buffer + used, sizeof(buffer) - used);
        if (n > 0) {
            used += (size_t)n;
            continue;
        }
        if (n == 0) {
            break;
        }
        if (errno != EINTR) {
            fail("read");
        }
    }

    printf("received %zu bytes: %.*s", used, (int)used, buffer);
    close(sockets[0]);
    close(sockets[1]);
    close(file_fd);
    return EXIT_SUCCESS;
}
```

编译运行：

```bash
cc -std=c11 -O2 -Wall -Wextra -Wpedantic \
  sendfile_demo.c -o sendfile_demo
./sendfile_demo
```

预期输出：

```text
received 32 bytes: sendfile keeps its own progress
```

这个示例的文件很小，目的只是验证正确性，不用于证明性能。真实基准测试需要更大的数据、可控的页缓存状态和重复测量。

---

## 四、代码中哪一步真正防止了文件截断？

关键不是调用 `sendfile()`，而是将发送进度保存在 `offset` 中：

```text
file_size = 32

第 1 次：offset 0  ──发送 12──▶ offset 12
第 2 次：offset 12 ──发送 15──▶ offset 27
第 3 次：offset 27 ──发送  5──▶ offset 32
                                     ↓
                                  发送完成
```

传入 `&offset` 后，内核会把它更新到已读数据之后的位置。循环条件 `offset < file_size` 则把“完成”的定义固定为已发送预期长度，而不是“某一次调用没有报错”。

如果传输途中源文件被截短，`sendfile()` 可能在 `offset` 尚未到达原始大小时返回 0。示例把这种情况作为 `EIO` 处理，避免将短文件误报为成功。

临时文件创建后立即 `unlink()`，文件名会消失，但打开的 fd 仍持有该文件，直到最后 `close()`。这只是让示例不留下临时文件，并不是 `sendfile()` 的必要条件。

---

## 五、非阻塞 socket 遇到 `EAGAIN`，为什么不能继续死循环？

生产服务器通常使用非阻塞 socket。发送缓冲区已满时，`sendfile()` 返回 `-1` 并设置 `errno = EAGAIN`。下面的处理是错误的：

```c
/* 错误示例：socket 不可写时占满 CPU */
while (sendfile(socket_fd, file_fd, &offset, remaining) < 0 &&
       errno == EAGAIN) {
}
```

socket 状态没有变化，立即重试只是在用户态空转。事件驱动服务器应该保存传输状态，然后等待 `EPOLLOUT`：

```c
struct file_transfer {
    int file_fd;
    off_t offset;
    off_t size;
};

enum transfer_result {
    TRANSFER_DONE,
    TRANSFER_WAIT_WRITABLE,
    TRANSFER_ERROR
};

static enum transfer_result continue_sendfile(
    int socket_fd, struct file_transfer *transfer) {
    while (transfer->offset < transfer->size) {
        size_t remaining = (size_t)(transfer->size - transfer->offset);
        ssize_t n = sendfile(socket_fd, transfer->file_fd,
                             &transfer->offset, remaining);
        if (n > 0) {
            continue;
        }
        if (n < 0 && errno == EINTR) {
            continue;
        }
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            return TRANSFER_WAIT_WRITABLE;
        }
        return TRANSFER_ERROR;
    }
    return TRANSFER_DONE;
}
```

调用者根据结果管理事件：

```text
TRANSFER_WAIT_WRITABLE → 注册或保留 EPOLLOUT，回到事件循环
EPOLLOUT 到达          → 使用同一个 offset 继续发送
TRANSFER_DONE          → 取消 EPOLLOUT，进入下一协议状态
TRANSFER_ERROR         → 记录错误并释放连接、文件资源
```

不要让所有连接长期监听 `EPOLLOUT`。TCP socket 大多数时间都可写，持续监听会产生大量无意义唤醒。通常只在确实遇到背压、还有待发送数据时启用，发送完成后立即取消。

一次回调也不应无限发送超大文件。给每个连接设置单轮字节预算，可以避免一个高速下载长期占用事件循环，让其他连接饥饿。

---

## 六、`sendfile()` 什么时候并不合适？

`sendfile()` 最擅长的是源内容已经存在于支持相应操作的文件中，并且输出端可以直接接收原始字节。以下情况要重新评估：

### 1. 内容需要用户态修改

模板渲染、压缩、字符集转换、脱敏和协议重写都需要读取并处理 payload。强行使用 `sendfile()` 可能反而增加旁路逻辑。

### 2. 使用普通用户态 TLS

数据通常要进入 TLS 库完成加密，再写入 socket，无法直接沿用普通明文 `sendfile()` 路径。kTLS 等内核能力可能改变数据路径，但可用性取决于内核、加密套件和库版本，需要结合部署环境验证。

### 3. 文件内容会被并发修改

Linux 手册要求：当输出是支持零拷贝的 socket 或 pipe 时，调用者应确保已传输的源文件区域在另一端消费前不被修改。静态文件服务常用不可变文件、版本化文件名或打开旧 inode 后原子替换目录项来管理这一点。

### 4. 目标平台不是 Linux

`sendfile()` 不是统一的 POSIX 接口。其他 Unix 的参数顺序、返回方式和能力可能不同，跨平台项目应封装平台实现或使用项目已有 I/O 库。

---

## 七、头部和正文不连续时，为什么更适合 `writev()`？

假设响应由内存中的协议头和动态正文组成。先拼接会多一次用户态复制：

```c
memcpy(buffer, header, header_length);
memcpy(buffer + header_length, body, body_length);
write(fd, buffer, header_length + body_length);
```

`writev()` 使用 iovec（I/O vector）描述多段内存，一次集中写（gather write）：

```c
#include <sys/uio.h>

struct iovec parts[] = {
    {.iov_base = header, .iov_len = header_length},
    {.iov_base = body,   .iov_len = body_length}
};

ssize_t n = writev(socket_fd, parts, 2);
```

它避免先拼成连续大缓冲，也可能减少系统调用次数。但 `writev()` 同样允许短写。假设头部 100 字节、正文 1000 字节，本次返回 160，则进度是：

```text
iov[0] 头部：100 字节全部完成
iov[1] 正文：完成前 60 字节，下一次从 body + 60 继续
```

因此非阻塞实现要同时推进 iovec 下标、当前段指针和剩余长度。还要遵守平台的 `IOV_MAX`；Linux 可通过 `sysconf(_SC_IOV_MAX)` 查询运行时限制。

`readv()` 进行相反的分散读（scatter read），例如把固定包头和后续缓冲放在不同内存区域。但 TCP 仍是字节流，一次 `readv()` 也不保证填满所有区域。

---

## 八、`mmap()` 为什么不是“更高级的 read”？

`mmap()` 把文件的一段映射到进程虚拟地址空间：

```c
void *mapping = mmap(NULL, length, PROT_READ, MAP_PRIVATE,
                     file_fd, offset);
if (mapping == MAP_FAILED) {
    /* 处理错误 */
}

/* 像访问内存一样读取 mapping */
munmap(mapping, length);
```

它适合随机访问、大型只读索引或多个进程共享页缓存的场景，却不是所有顺序 I/O 的通用加速器：

- 首次访问页面可能触发缺页异常，造成延迟抖动；
- 映射和解除映射有管理成本；
- 文件被截短后访问已超出新文件末尾的页面可能收到 `SIGBUS`；
- 把映射内存再 `write()` 到 socket，仍不等于文件到 socket 的 `sendfile()` 路径；
- 写映射还涉及 `MAP_SHARED`、同步和崩溃一致性。

如果任务只是顺序把静态文件发到 socket，先评估 `sendfile()`；如果业务需要频繁随机读取并处理内容，`mmap()` 才可能更自然。

---

## 九、`splice()` 和 `tee()` 解决的是哪种管线？

`splice()` 在内核对象之间移动数据，Linux 要求至少一个 fd 是 pipe。一个不解析内容的 TCP 转发器可以构造：

```text
socket A ──splice──▶ pipe ──splice──▶ socket B
```

这让数据无需进入普通用户态 payload 缓冲区。它适合透明代理或简单转发，但只要业务需要检查、解码或修改数据，用户态解析仍不可避免。

`tee()` 则在两个 pipe 之间复制数据引用，而且不消费输入 pipe：

```text
                     ┌──▶ pipe B ─▶ 主处理链
pipe A ──tee─────────┤
                     └──▶ pipe C ─▶ 旁路记录
```

这可用于流量复制或旁路处理。不过它们的组合、背压、错误传播和资源生命周期比 `read/write` 更复杂，普通业务不应仅因为“零拷贝”三个字就改写为 pipe 管线。

`splice()`、`tee()` 是 Linux 专属接口，通常需要在包含头文件前定义 `_GNU_SOURCE`。不同文件系统和 fd 组合的支持情况需要在目标环境验证。

---

## 十、`pipe`、`dup` 与 `fcntl` 为什么也属于高性能服务器基础？

它们不直接加快文件发送，却决定了 fd 能否被安全地组合和管理。

### `pipe`：有容量上限的单向字节流

```c
int pipe_fds[2];
pipe(pipe_fds);
```

`pipe_fds[0]` 是读端，`pipe_fds[1]` 是写端。写端全部关闭后，读端读到 EOF；读端全部关闭后继续写，进程可能收到 `SIGPIPE`，并得到 `EPIPE`。

管道容量有限，不能把它当成无限任务队列。Linux 新代码可用 `pipe2(O_NONBLOCK | O_CLOEXEC)` 在创建时原子设置标志，避免先创建、后设置之间的竞态。

### `dup2`：让两个 fd 编号引用同一打开文件描述

```c
int log_fd = open("server.log", O_WRONLY | O_CREAT | O_APPEND, 0644);
dup2(log_fd, STDOUT_FILENO);
close(log_fd);
```

之后标准输出指向日志文件。复制的是文件描述符引用，不是把文件内容复制一份；相关 fd 共享打开文件描述中的偏移和状态标志。

### `fcntl`：修改 fd 和打开文件状态

设置非阻塞时必须保留已有标志：

```c
int flags = fcntl(fd, F_GETFL, 0);
if (flags >= 0) {
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}
```

`FD_CLOEXEC` 则属于文件描述符标志：

```c
int flags = fcntl(fd, F_GETFD, 0);
if (flags >= 0) {
    fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
}
```

能在创建时使用 `O_CLOEXEC`、`SOCK_CLOEXEC`、`EPOLL_CLOEXEC` 或 `dup3(..., O_CLOEXEC)` 时应优先使用，以免多线程程序在 `open()` 与 `fcntl()` 之间恰好执行 `fork/exec`，泄漏不该继承的 fd。

---

## 十一、应该怎样选择数据路径？

| 当前数据形态与需求 | 优先评估 | 主要限制 |
| --- | --- | --- |
| 普通内存中的单段数据 | `write` / `send` | 处理部分写 |
| 多段内存组成一条输出 | `writev` | 推进多个 iovec |
| 不修改地发送普通文件 | `sendfile` | 平台差异、背压、文件一致性 |
| 随机访问文件内容 | `mmap` / `pread` | 缺页、映射生命周期 |
| 不解析的 Linux fd 转发 | `splice` + pipe | 至少一端是 pipe、组合受限 |
| 复制管道数据到旁路 | `tee` | 仅限 pipe、背压复杂 |
| 父子进程简单字节流 | `pipe` / `socketpair` | 容量有限、关闭语义 |
| 重定向描述符编号 | `dup2` / `dup3` | 共享打开文件描述 |
| 设置非阻塞或继承策略 | 创建时标志 / `fcntl` | 必须区分两类 flag |

选择顺序应是：先把正确性和背压处理好，再根据数据当前位于“文件、用户内存、socket 还是 pipe”选择能减少中转的接口。不要先决定使用零拷贝，再强迫数据模型迁就某个系统调用。

---

## 十二、如何验证“零拷贝”真的更快？

一次运行耗时更短不能证明优化有效。文件发送测试至少要控制：

- 冷页缓存还是热页缓存；
- 文件大小和并发连接数；
- 接收端消费速度与网络带宽；
- TLS、压缩和校验是否开启；
- 相同的编译优化、CPU 与内核版本；
- 是否正确处理短写，最终发送字节是否一致。

可组合使用：

```bash
strace -c ./server        # 系统调用次数与耗时概况
perf stat ./server        # CPU、上下文切换、缺页等指标
```

测试应使用接近生产的数据规模，预热与冷启动分别测量，多次运行并报告分布。若瓶颈本来就在磁盘、网络或 TLS 加密，减少一次用户态复制未必改善端到端吞吐。

---

## 十三、常见误区

### 误区 1：`sendfile()` 返回正数就能关闭连接

正数可能小于请求长度。必须比较累计偏移与预期文件大小。

### 误区 2：非阻塞 `EAGAIN` 应立即重试

socket 仍然不可写，循环只会烧 CPU。应保存 offset，等待可写事件。

### 误区 3：零拷贝意味着 CPU 完全不参与

协议栈、元数据、校验和与中断处理仍需资源。准确说法是减少特定路径上的数据复制和系统调用。

### 误区 4：`writev()` 保证写完所有 iovec

它只保证按 iovec 顺序处理，成功返回也可能只写一部分。非阻塞代码必须推进当前段。

### 误区 5：`mmap()` 一定比 `read()` 快

访问模式、缺页、TLB 和映射管理都会影响结果。顺序读、随机读和文件发送是不同问题。

### 误区 6：高级 API 可以替代背压设计

`sendfile`、`splice` 和 `writev` 都可能遇到输出端写不下。高性能首先意味着过载时仍能保持资源有界。

---

## 十四、总结

回到开头：客户端只收到半个文件，并不是 `sendfile()` 不可靠，而是调用者把“本次成功发送”误当成了“整个传输完成”。

最重要的结论是：

1. `sendfile()`、`writev()` 和 `splice()` 都必须处理部分传输、`EINTR` 与非阻塞 `EAGAIN`；
2. 零拷贝主要减少文件数据经过用户态缓冲区的中转，不代表绝对没有复制；
3. 非阻塞发送要保存 offset，并在真正遇到背压时等待 `EPOLLOUT`；
4. `writev`、`mmap`、`splice` 各自对应不同的数据形态，不能互相当作通用替代品；
5. 性能收益必须在相同数据量和正确结果下，通过重复测量与系统指标验证。

可以直接用于代码审查的一条规则是：**看到任何返回 `ssize_t` 的流式 I/O 调用，都先检查代码是否处理了短返回，再讨论它是不是“高性能”。**

---

## 参考资料

- [Linux `sendfile(2)` 手册](https://man7.org/linux/man-pages/man2/sendfile.2.html)
- [Linux `readv(2)` / `writev(2)` 手册](https://man7.org/linux/man-pages/man2/readv.2.html)
- [Linux `splice(2)` 手册](https://man7.org/linux/man-pages/man2/splice.2.html)
- [Linux `mmap(2)` 手册](https://man7.org/linux/man-pages/man2/mmap.2.html)
- [Linux `fcntl(2)` 手册](https://man7.org/linux/man-pages/man2/fcntl.2.html)
