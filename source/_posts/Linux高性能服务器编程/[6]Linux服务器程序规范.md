---
title: "程序在终端能跑，交给 systemd 后为什么反而启动失败？"
date: 2026-07-13 15:01:07
updated: 2026-07-13 15:01:07
categories:
  - "学习"
  - "Linux 服务器编程"
permalink: /notes/linux高性能服务器编程/6-linux服务器程序规范/
series: "Linux 服务器编程"
series_order: 6
---

时间：2026/05/04

> 关键词：systemd、前台运行、日志、信号、优雅退出、最小权限、资源限制、daemon

一个服务器在开发机上运行得很好：

```bash
./myserver
server started on port 8080
```

可把它交给 systemd 后，问题接连出现：服务刚启动就变成 inactive，`printf()` 日志找不到，读取相对路径配置失败，关闭服务时正在处理的请求被直接打断，高并发下还突然报 `Too many open files`。

这些问题看似无关，实际都来自同一个误区：

> “能从 `main()` 跑起来”只证明了业务路径可执行，并不代表程序已经具备受服务管理器管理的生命周期。

一个可运营的 Linux 服务必须与外部运行环境约定清楚：

- 谁负责让它后台运行和故障重启？
- 哪个 PID 才是主进程？
- 日志写到哪里？
- 收到停止信号后怎样退出？
- 使用什么用户和工作目录？
- 文件描述符与内存等资源上限是多少？

本文会用一个可运行的信号事件循环，演示现代 Linux 服务最关键的原则：程序保持前台，信号处理函数只负责通知，真正的重载和退出回到正常控制流中完成。

---

## 一、为什么“自己 daemonize”会和 systemd 打架？

经典 Unix daemon 通常会执行：

```text
fork，父进程退出
  → setsid，脱离控制终端
  → 可选再次 fork
  → chdir("/")
  → 重定向标准输入输出
  → 写 pidfile
```

这套做法诞生于没有现代服务管理器负责进程生命周期的环境。程序必须自行离开终端，并让调用它的 shell 尽快返回。

systemd、容器运行时或其他 supervisor 已经承担了这些职责。若程序启动后再次 fork 并让原进程退出，管理器可能看到它跟踪的进程已经结束；若日志又被重定向到 `/dev/null`，排障信息也会一同消失。

两种运行模型不能混为一谈：

| 模型 | 谁负责后台化 | 主进程如何识别 | 日志常见去向 |
| --- | --- | --- | --- |
| 传统自守护进程 | 程序自己 fork/setsid | pidfile 或父子关系 | syslog、日志文件 |
| systemd 管理服务 | systemd | `ExecStart` 启动的前台进程 | stdout/stderr、journal |
| 容器入口进程 | 容器运行时 | 容器内 PID 1 | stdout/stderr |

对于新写的 systemd 服务，优先提供一个“不 fork、不脱离、不吞掉标准输出”的前台模式。若还要兼容传统 init 脚本，可以显式提供 `--daemon` 选项，但不要让程序在所有环境下默认自守护。

---

## 二、日志为什么在终端可见，作为服务却消失？

日志至少经过三层：

```text
业务事件
  → 应用日志接口与缓冲
  → stdout/stderr、syslog 或日志文件
  → journald / 日志采集器 / 存储
```

终端上的 stdout 通常是行缓冲；重定向到 pipe 或文件后，C 标准 I/O 可能变成块缓冲。程序崩溃前尚未 flush 的日志看起来就像“没有打印”。

前台服务可以明确设置行缓冲：

```c
setvbuf(stdout, NULL, _IOLBF, 0);
```

更重要的是，日志本身要能回答“哪个请求、在哪个阶段、因为什么错误失败”。至少应包含时间、级别、请求或连接标识、错误码和必要上下文，同时避免在高频 I/O 回调中同步刷入慢磁盘。

传统 daemon 可以使用 syslog：

```c
#include <syslog.h>

openlog("myserver", LOG_PID | LOG_NDELAY, LOG_DAEMON);
syslog(LOG_ERR, "listen failed: %m");
closelog();
```

在 systemd 的常见配置下，stdout/stderr 会进入 journal；也可以在 unit 中显式声明。应用无需同时写三套相同日志，否则容易重复采集。高吞吐业务日志是否采用异步库，应根据丢失策略、磁盘延迟和现有日志基础设施决定。

绝对不要把密码、Token、完整会话凭据或个人敏感数据直接写入日志。

---

## 三、信号处理函数里直接清理资源，为什么不安全？

下面的代码直觉上很自然，却存在严重隐患：

```c
/* 错误示例：这些函数通常不能安全地在信号处理函数中调用 */
static void on_signal(int signal_number) {
    printf("stopping because of signal %d\n", signal_number);
    save_state_to_database();
    free_all_connections();
    exit(0);
}
```

信号可以在主线程执行 `malloc()`、`printf()` 或修改连接容器的任意时刻打断它。处理函数再次调用这些非异步信号安全（async-signal-safe）函数，可能重入尚未保持一致的内部状态，造成死锁、内存破坏或未定义行为。

更安全的思路是 self-pipe trick：

```text
SIGTERM 到达
    ↓
极短的 handler：设置 sig_atomic_t 标志，并 write 一个字节
    ↓
pipe 读端变为可读
    ↓
poll/epoll 正常事件循环被唤醒
    ↓
在普通代码中停止接入、清理资源、刷新日志
```

POSIX 将 `write()` 列为异步信号安全函数。处理函数仍应保存并恢复 `errno`，且 pipe 必须非阻塞，避免处理函数因管道已满而卡住。

---

## 四、最小可运行版本：把信号交回事件循环

下面的 C11 程序并不实现网络业务，只聚焦服务生命周期：

- `SIGHUP` 请求重载；
- `SIGTERM` 或 `SIGINT` 请求优雅退出；
- signal handler 不打印、不分配内存、不释放对象；
- 主循环通过 `poll()` 处理通知；
- `SIGPIPE` 被忽略，避免向已关闭连接写入时进程被默认终止。

运行条件：Linux、glibc、C11。代码使用 Linux 的 `pipe2()`；macOS 等平台需要改成 `pipe()` 后再通过 `fcntl()` 设置非阻塞和 close-on-exec。

```c
#define _GNU_SOURCE

#include <poll.h>
#include <signal.h>
#include <unistd.h>

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>

static int signal_pipe[2] = {-1, -1};
static volatile sig_atomic_t reload_requested = 0;
static volatile sig_atomic_t stop_requested = 0;

static void signal_handler(int signal_number) {
    int saved_errno = errno;

    if (signal_number == SIGHUP) {
        reload_requested = 1;
    } else if (signal_number == SIGTERM || signal_number == SIGINT) {
        stop_requested = 1;
    }

    unsigned char notification = (unsigned char)signal_number;
    ssize_t ignored = write(signal_pipe[1], &notification,
                            sizeof(notification));
    (void)ignored;
    errno = saved_errno;
}

static void fail(const char *operation) {
    perror(operation);
    exit(EXIT_FAILURE);
}

static void install_handler(int signal_number, void (*handler)(int)) {
    struct sigaction action = {0};
    sigemptyset(&action.sa_mask);
    action.sa_handler = handler;
    action.sa_flags = SA_RESTART;

    if (sigaction(signal_number, &action, NULL) < 0) {
        fail("sigaction");
    }
}

static void drain_signal_pipe(void) {
    unsigned char buffer[64];

    for (;;) {
        ssize_t n = read(signal_pipe[0], buffer, sizeof(buffer));
        if (n > 0) {
            continue;
        }
        if (n < 0 && errno == EINTR) {
            continue;
        }
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            return;
        }
        if (n == 0) {
            return;
        }
        fail("read(signal pipe)");
    }
}

int main(void) {
    setvbuf(stdout, NULL, _IOLBF, 0);

    if (pipe2(signal_pipe, O_NONBLOCK | O_CLOEXEC) < 0) {
        fail("pipe2");
    }

    install_handler(SIGHUP, signal_handler);
    install_handler(SIGTERM, signal_handler);
    install_handler(SIGINT, signal_handler);
    install_handler(SIGPIPE, SIG_IGN);

    printf("service ready, pid=%ld\n", (long)getpid());

    struct pollfd event = {
        .fd = signal_pipe[0],
        .events = POLLIN
    };

    while (!stop_requested) {
        int ready = poll(&event, 1, -1);
        if (ready < 0 && errno == EINTR) {
            continue;
        }
        if (ready < 0) {
            fail("poll");
        }
        if (event.revents & POLLIN) {
            drain_signal_pipe();
        }
        if (event.revents & (POLLERR | POLLHUP | POLLNVAL)) {
            fprintf(stderr, "signal pipe failed\n");
            break;
        }

        if (reload_requested) {
            reload_requested = 0;
            puts("reload requested: validate, then atomically replace config");
        }
    }

    puts("shutdown requested: stop accepting new work");
    puts("cleanup complete");
    close(signal_pipe[0]);
    close(signal_pipe[1]);
    return EXIT_SUCCESS;
}
```

编译：

```bash
cc -std=c11 -O2 -Wall -Wextra -Wpedantic \
  managed_service.c -o managed_service
```

在终端 A 运行：

```bash
./managed_service
```

它会打印 PID。然后在终端 B 分别发送信号：

```bash
kill -HUP <PID>
kill -TERM <PID>
```

预期输出类似：

```text
service ready, pid=12345
reload requested: validate, then atomically replace config
shutdown requested: stop accepting new work
cleanup complete
```

多次相同信号可能合并为一次状态变化，这是标准信号与布尔标志的预期语义。若业务必须逐个计数，应使用合适的队列或其他 IPC，而不是依赖标准信号次数。

---

## 五、为什么 self-pipe 不会因为通知写失败而丢失退出状态？

pipe 使用 `O_NONBLOCK`，所以 handler 中的 `write()` 在管道满时可能失败并返回 `EAGAIN`。示例故意忽略通知字节的写入结果，但先设置了 `sig_atomic_t` 标志：

```text
状态来源：reload_requested / stop_requested
唤醒来源：signal_pipe 中的任意字节
```

管道如果已满，本身就处于可读状态，事件循环会被唤醒并检查标志；因此字节只是唤醒提示，不是唯一状态存储。

处理函数保存并恢复 `errno`，避免信号恰好发生在主流程检查某个系统调用错误时，改变它看到的错误码。

`SA_RESTART` 会让部分被信号中断的系统调用自动重启，但不能假设所有调用都如此。主循环仍明确处理 `poll()` 的 `EINTR`。对于纯 Linux 应用，也可以在创建线程前阻塞相关信号，并使用 `signalfd()` 把信号直接变成 fd 事件；self-pipe 的优势是思路更接近 POSIX，可适配更多 Unix 系统。

---

## 六、优雅退出不是“收到 SIGTERM 后 sleep 几秒”

真实服务器收到停止请求后，通常按状态推进：

```text
RUNNING
  ↓ SIGTERM
DRAINING
  ├─ 停止 accept 新连接
  ├─ 拒绝或转移新任务
  ├─ 等待已有请求完成
  └─ 超过 deadline 后取消剩余任务
  ↓
STOPPED
```

退出策略至少需要明确：

- 哪些请求允许完成，哪些可立即取消？
- 长连接如何通知客户端？
- 工作线程如何停止取新任务并 `join`？
- 日志与监控最多允许 flush 多久？
- 超过关闭截止时间后怎样强制回收？

服务管理器通常也有停止超时。应用的内部 deadline 应短于外部 `TimeoutStopSec`，为最终清理留出余量。不要在 signal handler 中 `exit()`，也不要无期限等待一个永不结束的请求。

重载配置同样需要事务性：先把新配置读入临时对象并完整校验，成功后原子替换；失败则保留旧配置。直接逐字段修改全局配置，会让中途失败留下新旧混合状态。

---

## 七、最小 systemd unit 应该明确哪些契约？

下面是一份示意配置，不应不经检查地复制到生产。路径、用户、资源限制和强化选项都要与实际程序匹配：

```ini
[Unit]
Description=Example managed service
After=network.target

[Service]
Type=simple
ExecStart=/opt/myserver/bin/managed_service
User=myserver
Group=myserver
WorkingDirectory=/var/lib/myserver
RuntimeDirectory=myserver
LimitNOFILE=65536
Restart=on-failure
RestartSec=2s
TimeoutStopSec=30s
StandardOutput=journal
StandardError=journal
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

这里几个配置共同构成运行契约：

- `Type=simple`：`ExecStart` 进程保持前台，systemd 将其作为主进程；
- `User` / `Group`：业务阶段不使用 root 权限；
- `WorkingDirectory`：消除“从哪个目录启动”的不确定性；
- `RuntimeDirectory`：由 systemd 管理 `/run` 下的运行时目录；
- `LimitNOFILE`：显式设置文件描述符限制；
- `Restart=on-failure`：异常退出由管理器退避后重启，正常退出不盲目拉起；
- `TimeoutStopSec`：优雅退出有外部截止时间；
- stdout/stderr：交给 journal，而不是在程序里关掉。

`WorkingDirectory` 对应目录必须存在并允许该用户访问；`RuntimeDirectory` 只创建运行时目录，并不会替你创建所有数据和配置路径。`User=myserver` 也要求系统中存在该账户，且二进制、配置、证书和数据目录权限正确。

不同发行版携带的 systemd 版本不同。增加 `ProtectSystem`、`PrivateTmp`、`RestrictAddressFamilies` 等沙箱选项前，应逐项测试程序真正需要的文件系统、网络和系统调用权限，避免“安全配置看起来更强，服务却无法工作”。

---

## 八、为什么服务不应该长期以 root 运行业务？

进程的有效 UID（EUID）和有效 GID（EGID）参与大多数权限检查。服务若以 root 处理来自网络的复杂输入，一次内存破坏或路径处理漏洞就可能获得整台机器的高权限。

优先让服务从启动开始就由低权限账户运行。若确实需要绑定低于 1024 的端口，可考虑：

- 由反向代理或 socket activation 接收连接；
- 在部署层授予精确的 `CAP_NET_BIND_SERVICE`；
- 监听非特权端口，再由网络层转发。

传统程序也会 root 启动，完成特权操作后执行 `setgid()`、补充组清理和 `setuid()` 降权。但顺序、线程、已打开文件与 capability 处理很容易出错，能由服务管理器直接指定低权限身份时更简单。

最小权限不只是 UID：配置应只读，数据目录只开放必要写权限，密钥文件不应对无关用户可见，网络访问与 Linux capabilities 也应尽量收窄。

`chroot()` 可以改变进程看到的根目录，但不是完整安全沙箱。进程能力、已打开 fd、内核攻击面和错误准备的设备或库仍可能突破预期边界。现代隔离通常还会结合 namespace、capability、seccomp、只读挂载或容器策略。

---

## 九、`RLIMIT_NOFILE` 为什么不是简单地改成 65535？

`RLIMIT_NOFILE` 表示进程可获得的最大 fd 编号加一。超过限制的 `open()`、`socket()`、`accept()`、`pipe()` 等操作会失败并设置 `EMFILE`。

查看当前进程限制：

```bash
cat /proc/<PID>/limits
```

程序内可读取软、硬限制：

```c
#include <sys/resource.h>

struct rlimit limit;
if (getrlimit(RLIMIT_NOFILE, &limit) == 0) {
    printf("soft=%llu hard=%llu\n",
           (unsigned long long)limit.rlim_cur,
           (unsigned long long)limit.rlim_max);
}
```

软限制是内核当前执行的限制，硬限制是非特权进程可提高软限制的上限。无权限进程不能随意把硬限制调高，所以部署层的 `LimitNOFILE` 往往比程序启动后盲目 `setrlimit()` 更可控。

容量估算不能只数客户端连接：

```text
监听 socket
+ 每个客户端连接
+ 日志、配置与数据库文件
+ epoll、eventfd、timerfd、pipe
+ DNS、上游连接与监控 fd
+ 故障时的临时余量
```

提高限制也不代表服务器就能承受同等连接数。每连接内存、线程数、队列容量和内核参数仍可能先成为瓶颈。若程序仍使用 `select()`，还要注意 `FD_SETSIZE` 的表达能力，不能只提高 fd 上限。

高并发服务还应为 `EMFILE` 设计可观测的过载处理，而不是在 accept 失败后无日志高速重试。

---

## 十、相对路径、工作目录与 pidfile 为什么经常出错？

下面的代码依赖调用者当前目录：

```c
fopen("config/server.conf", "r");
```

从源码目录运行可能成功，systemd 使用另一个工作目录时就失败。解决方法不是让程序猜测路径，而是把路径契约显式化：命令行参数、明确的配置目录或 unit 的 `WorkingDirectory`。

运行时状态应放在合适位置：短生命周期 PID 或 socket 通常位于 `/run`，持久数据位于专门的数据目录，配置与日志遵循发行版和部署约定。不要把实验机器的绝对用户名路径硬编码进程序。

传统 daemon 的 pidfile 用于防止重复启动和让脚本找到主进程，但它存在陈旧文件、PID 重用和锁竞争问题。写 pidfile 应持锁，并验证进程身份；在 systemd 以前台主进程管理服务时，通常不再需要应用自己维护 pidfile。

经典 daemon 调用 `chdir("/")` 是为了不占住某个可卸载目录。现代服务如果明确设置 `WorkingDirectory`，则应保证该目录生命周期与服务匹配，而不是启动后悄悄改变它。

---

## 十一、常见误区

### 误区 1：服务器必须自己 double-fork 才专业

自守护适合传统运行模型；systemd 和容器通常希望主程序保持前台。关键是匹配管理环境，而不是固定套用仪式。

### 误区 2：收到 SIGTERM 直接 `exit()` 就是优雅退出

直接退出没有停止接入、排空任务和截止时间管理。优雅退出是一套状态迁移，而不是某一个 API。

### 误区 3：signal handler 中只打印一行不会有事

`printf()` 等 stdio 函数不是异步信号安全函数。处理函数应只做极少的安全操作，并把工作交回正常线程。

### 误区 4：systemd 会自动找到程序需要的相对路径

服务的工作目录和终端启动环境可能完全不同。路径必须通过配置或 unit 明确。

### 误区 5：把 `ulimit -n` 调大就解决了高并发

shell 中的限制未必等于 systemd unit 的限制；而 fd 只是容量的一部分。应检查目标进程的 `/proc/<PID>/limits` 和实际资源模型。

### 误区 6：使用低权限用户就已经完成安全隔离

低权限很重要，但不能替代目录权限、capability、系统调用限制、网络边界和输入校验。

---

## 十二、什么时候仍需要传统 daemon 化？

以下场景可能仍需要自守护模式：

- 目标系统没有 systemd 或其他 supervisor；
- 必须兼容既有 SysV init 脚本；
- 程序作为传统第三方组件被旧管理工具调用。

这时应完整处理 `fork()`、`setsid()`、可能的第二次 fork、`umask`、工作目录、标准 fd、pidfile 锁、日志初始化和继承 fd，而不是只调用一次 `daemon()` 就认为生命周期完整。

如果部署环境已经提供进程监督，首选前台运行。它让主 PID、退出状态、日志、资源限制和重启策略保持在同一个管理边界中，也更容易在容器和开发终端中复现。

---

## 十三、总结

回到开头：程序交给 systemd 后出现启动、日志、路径和退出问题，并不是 systemd 让程序变得不稳定，而是原程序隐含依赖了终端环境，却没有定义服务运行契约。

最重要的结论是：

1. systemd 或容器管理的服务通常应保持前台，不要默认自行 daemonize；
2. signal handler 只负责安全地记录状态和唤醒事件循环，复杂清理回到正常控制流；
3. `SIGTERM` 应触发有 deadline 的排空流程，而不是立即退出或无限等待；
4. 用户、目录、日志去向和资源限制都要在部署配置中显式声明；
5. `RLIMIT_NOFILE` 要根据完整 fd 模型估算，并在目标进程上验证；
6. 经典 daemon、pidfile 与 `chroot()` 仍有适用场景，但不是现代服务的默认答案。

可以直接用于上线检查的一条建议是：**先在前台用目标低权限用户、目标工作目录和目标资源限制运行同一二进制，再交给 systemd；这样多数“服务环境特有问题”会在部署前暴露。**

---

## 参考资料

- [Linux `signal-safety(7)`：异步信号安全函数](https://man7.org/linux/man-pages/man7/signal-safety.7.html)
- [Linux `sigaction(2)` 手册](https://man7.org/linux/man-pages/man2/sigaction.2.html)
- [Linux `getrlimit(2)` / `setrlimit(2)` 手册](https://man7.org/linux/man-pages/man2/getrlimit.2.html)
- [Linux `setsid(2)` 手册](https://man7.org/linux/man-pages/man2/setsid.2.html)
- [systemd 官方源码与手册仓库](https://github.com/systemd/systemd)
