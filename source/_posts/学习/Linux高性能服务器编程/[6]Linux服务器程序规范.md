---
title: "Linux 服务器程序规范"
date: 2026-05-04 15:17:10
updated: 2026-05-04 15:17:10
categories:
  - "学习"
  - "Linux高性能服务器编程"
permalink: /notes/linux高性能服务器编程/6-linux服务器程序规范/
---

# Linux 服务器程序规范

时间：2026/05/04

> 关键词：日志、syslog、UID、GID、进程组、会话、资源限制、daemon、chroot、pidfile
> 核心目标：理解一个服务端程序从“能跑”到“像服务一样运行”需要补齐哪些工程规范。

---

## 1. 为什么服务器程序需要规范

练习程序只要能在终端跑起来就行。
真正的服务器程序还要回答：

* 日志写到哪里
* 以什么用户权限运行
* 文件描述符上限是多少
* 崩溃后谁拉起
* 工作目录和根目录是什么
* 如何后台化
* 如何优雅退出和重载配置

这些不是性能细节，而是服务端稳定运行的基本前提。

---

## 2. 日志：不要只靠 `printf`

服务端日志至少应该包含：

* 时间
* 级别
* 线程/进程 id
* 连接 id 或请求 id
* 关键错误码
* 必要上下文

常见级别：

| 级别 | 用途 |
| --- | --- |
| DEBUG | 开发和临时排障 |
| INFO | 关键生命周期和业务摘要 |
| WARN | 可恢复异常 |
| ERROR | 请求失败、连接异常 |
| FATAL | 服务无法继续运行 |

日志要避免：

* I/O 线程同步刷盘
* 每个包都打大量日志
* 缺少请求 id，导致无法串联链路

---

## 3. `syslog`

Linux 提供系统日志接口：

```c
#include <syslog.h>

openlog("myserver", LOG_PID | LOG_NDELAY, LOG_DAEMON);
syslog(LOG_INFO, "server started");
syslog(LOG_ERR, "listen failed: %m");
closelog();
```

`%m` 会展开当前 `errno` 对应的错误描述。

适合：

* daemon 启动、退出、严重错误
* 和系统日志体系集成

但高频业务日志通常会用专门日志库或异步日志系统。

---

## 4. 用户、组与最小权限

进程有：

* UID：真实用户 id
* EUID：有效用户 id，决定权限检查
* GID：真实组 id
* EGID：有效组 id

服务端常见启动方式：

1. root 启动，完成绑定低端口等特权操作
2. 切换到低权限用户
3. 正常处理业务

示意：

```c
setgid(gid);
setuid(uid);
```

原则：

> 只有必须使用 root 的短阶段才用 root，业务运行阶段尽量降权。

降权前要先完成：

* bind 低端口
* 打开必要文件
* 设置资源限制
* 初始化 chroot 或目录权限

---

## 5. 进程组与会话

几个概念：

| 概念 | 含义 |
| --- | --- |
| 进程组 | 一组相关进程，常用于信号分发 |
| 会话 | 一个或多个进程组的集合 |
| 控制终端 | 会话可能关联的终端 |

daemon 后台化通常会调用：

```c
setsid();
```

作用：

* 创建新会话
* 成为会话首进程
* 脱离原控制终端

这样服务不会因为终端关闭而跟着退出。

---

## 6. 资源限制

服务端最常碰到的是文件描述符限制。

查看：

```bash
ulimit -n
```

程序内查看/设置：

```c
#include <sys/resource.h>

struct rlimit rl;
getrlimit(RLIMIT_NOFILE, &rl);

rl.rlim_cur = 65535;
setrlimit(RLIMIT_NOFILE, &rl);
```

常见资源：

| 限制 | 说明 |
| --- | --- |
| `RLIMIT_NOFILE` | 最大 fd 数 |
| `RLIMIT_CORE` | core dump 大小 |
| `RLIMIT_NPROC` | 用户可创建进程数 |
| `RLIMIT_AS` | 进程地址空间 |

高并发服务端必须把 fd 上限纳入部署清单，而不是等 `EMFILE` 出现再排查。

---

## 7. 工作目录、根目录与文件路径

`chdir()` 改变工作目录：

```c
chdir("/");
```

daemon 常会切到根目录，避免占住某个挂载目录。

`chroot()` 改变进程看到的根目录：

```c
chroot("/var/empty/myserver");
```

它能限制进程可见文件系统范围，但不是完整安全沙箱。
使用时要准备好必要的库、设备、配置和权限。

工程建议：

* 配置文件用绝对路径
* 日志路径明确
* pidfile 路径明确
* 不依赖启动目录

---

## 8. daemon 后台化基本步骤

经典 daemon 化大致包括：

1. `fork()`，父进程退出
2. 子进程 `setsid()` 创建新会话
3. 可选再次 `fork()`，避免重新获得控制终端
4. `chdir("/")`
5. 设置 `umask`
6. 关闭或重定向标准输入输出错误
7. 写 pidfile
8. 初始化日志

示意：

```c
int fd = open("/dev/null", O_RDWR);
dup2(fd, STDIN_FILENO);
dup2(fd, STDOUT_FILENO);
dup2(fd, STDERR_FILENO);
if (fd > STDERR_FILENO) {
    close(fd);
}
```

现代部署中，systemd、supervisord、容器运行时常负责守护进程管理。
这种情况下不一定要自己 daemonize，前台运行反而更利于日志和生命周期管理。

---

## 9. pidfile

pidfile 常用于记录服务主进程 pid：

```text
/run/myserver.pid
```

用途：

* 防止重复启动
* 管理脚本发送信号
* 排障时快速定位进程

要注意：

* 写 pidfile 前最好加锁
* 退出时清理
* 崩溃后可能残留，要能识别 pid 是否仍是当前服务

systemd 环境下，pidfile 的重要性会降低，但传统服务仍常见。

---

## 10. 信号约定

服务器常见信号约定：

| 信号 | 常见语义 |
| --- | --- |
| `SIGTERM` | 优雅退出 |
| `SIGINT` | 前台运行时退出 |
| `SIGHUP` | 重载配置或重开日志 |
| `SIGCHLD` | 子进程状态变化 |
| `SIGPIPE` | 向关闭连接写数据 |

信号处理函数里不要做复杂逻辑。
常见做法是：

* 写 pipe / eventfd
* 使用 `signalfd`
* 在事件循环里统一处理

---

## 11. 优雅退出

收到退出信号后，服务端应该按状态机退出：

1. 停止接受新连接
2. 通知业务线程停止取新任务
3. 尽量处理完已有请求
4. 给长时间未完成任务设 deadline
5. flush 日志和监控
6. 关闭 fd，释放资源

不要直接在信号处理函数里 `exit()`。
那会让连接、日志、共享资源处于不可控状态。

---

## 12. 常见坑

### 12.1 root 权限跑完整业务

攻击面和误操作风险都更大。

### 12.2 日志同步写在 I/O 线程

磁盘抖动会直接拖高网络延迟。

### 12.3 忘记设置 fd 上限

高并发服务端很容易撞到 `EMFILE`。

### 12.4 daemon 化和 systemd 混用不清

systemd 管理的服务通常更适合前台运行，把日志交给 stdout/stderr 或 journald。

### 12.5 信号处理函数里做复杂事

很多函数不是 async-signal-safe，容易引入诡异 bug。

---

## 13. 一页总结

服务器程序规范最值得记住的是：

1. 日志要可定位、可控量、避免阻塞 I/O 线程
2. 服务应尽量以低权限用户运行
3. fd 上限、core dump、进程数等资源限制要显式管理
4. daemon 化要处理会话、目录、标准 fd 和 pidfile
5. 信号只做通知，复杂逻辑放回事件循环
6. 优雅退出是一条正式流程，不是直接 kill

如果只记一句：

> 服务端不是“main 函数跑起来”就完了，它还要像一个可管理、可排障、可安全运行的系统服务。

---

## 14. 参考资料

1. Linux man-pages: syslog
   <https://man7.org/linux/man-pages/man3/syslog.3.html>

2. Linux man-pages: setrlimit
   <https://man7.org/linux/man-pages/man2/setrlimit.2.html>

3. Linux man-pages: setsid
   <https://man7.org/linux/man-pages/man2/setsid.2.html>

4. Linux man-pages: daemon
   <https://man7.org/linux/man-pages/man3/daemon.3.html>
