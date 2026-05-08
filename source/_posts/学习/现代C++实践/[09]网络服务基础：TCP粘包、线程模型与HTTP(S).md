---
title: "网络服务基础：TCP 粘包、线程模型与 HTTP(S)"
date: 2026-05-08 14:36:46
updated: 2026-05-08 14:36:46
categories:
  - "学习"
  - "现代C++实践"
permalink: /notes/现代c-实践/09-网络服务基础-tcp粘包-线程模型与http-s/
---

# 网络服务基础：TCP 粘包、线程模型与 HTTP(S)

时间：2026/04/09

> 关键词：TCP stream、粘包拆包、长度前缀、分隔符、线程池、epoll、TLS、wrk
> 核心目标：建立服务端编程的基本工程直觉，先把“消息边界、并发模型、协议分层”分清楚。

---

## 1. TCP 为什么会有“粘包”问题

因为 TCP 是**字节流**，不是消息流。

这意味着：

* 发送端发了两次 `send`
* 接收端不一定就对应收到两次 `recv`

接收端看到的只是连续字节流，所以必须自己定义消息边界。

---

## 2. 两种最常见的拆包方案

### 2.1 长度前缀

格式示例：

```text
[4字节长度][payload]
```

接收端流程：

1. 先读够头部
2. 解析长度
3. 再继续读够 payload

这通常是最通用、最可靠的做法。

### 2.2 分隔符协议

例如按 `\n` 分隔：

```text
hello\nworld\n
```

优点：

* 简单直观

缺点：

* payload 中若可能出现分隔符，需要转义或编码

---

## 3. 长度前缀接收缓冲的核心思路

接收端通常需要一个累积缓冲区：

```cpp
std::vector<std::uint8_t> inbuf;
```

每次 `recv` 到数据后：

* 先追加到 `inbuf`
* 再循环解析完整包

关键不是“每次只解析一个包”，而是：

* 一次 `recv` 可能带来 0.5 个包、1 个包、或者多个包

---

## 4. 为什么不能假设一次 `recv` 就是一条完整消息

因为可能出现：

* 半包
* 多包合并
* 多次拆散

所以网络编程第一条纪律就是：

> 任何协议都必须先定义并实现消息 framing。

---

## 5. 线程模型的几种常见选择

### 5.1 每连接一个线程

优点：

* 思维简单

缺点：

* 连接数一大就撑不住

### 5.2 单线程事件循环

优点：

* 资源利用率高

缺点：

* 业务阻塞会拖住整个 loop

### 5.3 Reactor + 线程池

常见工程做法：

* I/O 线程负责收发和事件分发
* 工作线程池处理业务

这样可以同时兼顾：

* 网络扩展性
* 业务并发

---

## 6. `epoll` / `kqueue` / IOCP` 在解决什么问题

这些机制本质上都在解决：

* 如何高效等待大量连接上的 I/O 事件

Linux 上最常见的是：

* `epoll`

它不是协议，也不是线程池，而是：

* 一个事件通知机制

---

## 7. HTTP 和 HTTPS 不要混成一层

### 7.1 HTTP

应用层协议，定义：

* 请求行
* 头部
* body

### 7.2 HTTPS

可以粗略理解成：

* HTTP over TLS

也就是：

* 先做 TLS 加密通道
* 再在其上跑 HTTP

所以 HTTPS 的复杂度不仅来自 HTTP，还来自：

* 握手
* 证书
* 加解密

---

## 8. 一个服务端最基础的工程分层

可以先按这几层理解：

1. socket 层
2. 缓冲区与 framing 层
3. 协议解析层
4. 业务处理层
5. 线程模型 / 调度层

很多初学者的问题是把所有逻辑都揉进一次 `recv` 回调里，后期几乎无法维护。

---

## 9. 线程池在网络服务里的角色

网络服务中，线程池通常不应该负责：

* 直接阻塞式读写所有 socket

更常见的是负责：

* 处理业务任务
* 数据库访问
* CPU 密集计算
* 日志/异步处理

也就是说：

* I/O 线程负责“把事情收进来”
* 线程池负责“把事情做完”

---

## 10. TLS / HTTPS 的最小认知

只要记住这几点就够做入门框架理解：

* TLS 负责加密通道
* 证书用于身份认证
* HTTPS 不是“新的 HTTP 消息格式”，而是多了一层安全传输

工程上常见做法是：

* 直接用成熟库处理 TLS
* 不自己从零实现加密协议

---

## 11. 压测为什么重要

服务端“能跑”不等于“能扛”。
至少要关注：

* QPS
* 延迟
* P99
* 错误率
* CPU / 内存占用

`wrk` 是一个常用 HTTP 压测工具，适合快速做吞吐和延迟观察。

---

## 12. 常见坑

### 12.1 把 TCP 当消息协议

这会直接导致粘包拆包错误。

### 12.2 收到数据就立刻假设包完整

半包是常态，不是例外。

### 12.3 网络线程直接做重业务

会拖慢整个事件循环。

### 12.4 自己手写 TLS 协议栈

不现实，也没必要。

---

## 13. 参考实例：长度前缀拆包器

TCP 是字节流，所以接收缓冲里可能一次来半包、多包或任意切分。
下面是一个最小长度前缀协议解析器：前 4 字节是大端 payload 长度。

```cpp
#include <cstdint>
#include <cstddef>
#include <optional>
#include <span>
#include <stdexcept>
#include <vector>

class FrameDecoder {
public:
    void append(std::span<const std::byte> bytes) {
        buffer_.insert(buffer_.end(), bytes.begin(), bytes.end());
    }

    std::optional<std::vector<std::byte>> next_frame() {
        if (buffer_.size() < header_size) {
            return std::nullopt;
        }

        std::uint32_t len = read_u32_be(buffer_.data());
        if (len > max_frame_size) {
            throw std::runtime_error("frame too large");
        }

        const std::size_t total = header_size + len;
        if (buffer_.size() < total) {
            return std::nullopt;
        }

        std::vector<std::byte> payload(
            buffer_.begin() + header_size,
            buffer_.begin() + static_cast<std::ptrdiff_t>(total)
        );

        buffer_.erase(
            buffer_.begin(),
            buffer_.begin() + static_cast<std::ptrdiff_t>(total)
        );

        return payload;
    }

private:
    static constexpr std::size_t header_size = 4;
    static constexpr std::uint32_t max_frame_size = 1024 * 1024;

    static std::uint32_t read_u32_be(const std::byte* p) {
        return (std::uint32_t(std::to_integer<unsigned char>(p[0])) << 24) |
               (std::uint32_t(std::to_integer<unsigned char>(p[1])) << 16) |
               (std::uint32_t(std::to_integer<unsigned char>(p[2])) << 8)  |
                std::uint32_t(std::to_integer<unsigned char>(p[3]));
    }

    std::vector<std::byte> buffer_;
};
```

使用方式通常是：

```cpp
FrameDecoder decoder;

// 每次 recv 得到一段 bytes 后：
decoder.append(bytes);

while (auto frame = decoder.next_frame()) {
    handle_message(*frame);
}
```

关键点：

* `append()` 不假设一次收到完整消息
* `next_frame()` 可能返回空，表示还需要更多字节
* 解出一帧后要从缓冲区移除已经消费的数据
* 必须限制最大包大小，避免恶意长度导致内存暴涨

---

## 14. 一页总结

服务端编程最重要的理解链是：

1. TCP 只有字节流，没有消息边界
2. 所以必须先做 framing
3. 高并发服务通常要把 I/O 与业务处理分层
4. HTTPS = HTTP + TLS，不是单纯“更安全的 socket”

如果只记一句：

> 网络服务首先是“协议边界和并发模型”问题，其次才是 API 调用问题。
