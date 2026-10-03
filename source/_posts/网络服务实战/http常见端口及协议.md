---
title: "443 端口已经连通，为什么 HTTPS 仍然失败？别把端口、TLS 和 HTTP 混成一层"
date: 2026-07-13 17:51:05
updated: 2026-07-13 17:51:05
categories:
  - "学习"
  - "网络服务实战"
permalink: /notes/网络服务实战/http常见端口及协议/
series: "网络服务实战"
---

线上接口访问失败时，经常能看到这样的排查过程：

```text
$ nc -vz api.example.com 443
Connection to api.example.com port 443 [tcp/https] succeeded!

$ curl -v https://api.example.com/v1/tasks
...
HTTP/1.1 404 Not Found
```

第一条命令明明成功了，第二条为什么还是 404？换一种情况，TCP 443 可以连接，curl 却可能报证书域名不匹配、TLS 握手失败或 `502 Bad Gateway`。这些结果并不矛盾，因为每条命令只验证了网络链路中的一部分：

```text
DNS -> TCP 或 QUIC -> TLS -> HTTP -> Gateway -> 业务应用
```

端口连通，只能证明传输层端点在当前条件下可达；它不能证明对方说的是 HTTPS，不能证明证书正确，也不能证明 HTTP 路径和业务状态正确。

本文不把端口号写成一张需要死记的电话簿，而是围绕一个更实用的问题展开：一次 Web 请求究竟在哪一层失败，怎样用最小实验确认？读完后，你应当能解释为什么 HTTPS 可以运行在 8443、为什么 TCP 443 与 UDP 443 是两个端点，以及为什么 `ping`、`nc` 和 `curl` 的成功含义完全不同。

## 1. `nc` 成功到底证明了什么？

先把常见观察结果放回各自的协议层：

| 观察结果 | 已经证明 | 仍未证明 |
| --- | --- | --- |
| DNS 返回 IP | 名称解析得到结果 | IP 可达、端口开放、结果就是期望服务 |
| `ping` 收到响应 | 当前网络允许相应 ICMP 往返 | TCP/UDP 端口、TLS、HTTP 正常 |
| `nc` 连接 TCP 443 成功 | TCP 三次握手完成 | 对端讲 TLS、证书正确、HTTP 路由存在 |
| TLS 握手成功 | 密钥协商完成，证书检查结果取决于客户端参数 | HTTP 方法、Host、路径、鉴权正确 |
| HTTP 返回 404 | 已收到一个 HTTP 响应 | 请求路径存在、虚拟主机选对、业务资源存在 |
| HTTP 返回 502 | 已连到 Gateway | Gateway 能正常访问它的上游 |

`Connection refused` 与 `Connection timed out` 也不等价。前者通常表示目标主机或中间设备明确拒绝了连接，常见原因是无人监听；后者更可能涉及路由、防火墙静默丢弃、丢包或目标长期无响应。它们都是线索，不是脱离环境就能百分之百确定根因的诊断书。

排错的核心原则是：从下层向上层验证。TCP 尚未建立时，反复修改 JSON body 没有意义；TLS 证书还没通过时，也不该先怀疑业务状态码。

## 2. 端口是协议吗？

不是。端口是传输协议用来区分通信端点的 16 位编号，范围为 `0` 到 `65535`。IANA 对服务名与端口进行登记，但登记表达的是约定，不会强制某个进程必须在该端口运行某种协议。

例如，下面两个地址不是同一个端点：

```text
TCP  203.0.113.10:443
UDP  203.0.113.10:443
```

常见 HTTPS 部署可能同时使用它们：HTTP/1.1 和 HTTP/2 通常经 TLS 运行在 TCP 443；HTTP/3 经 QUIC 运行在 UDP 443。防火墙只开放 TCP 443 时，基于 TCP 的 HTTPS 可能正常，而 HTTP/3 不可用。

对 TCP 而言，一条连接通常由下面的信息区分：

```text
传输协议 + 源 IP + 源端口 + 目标 IP + 目标端口
```

客户端访问服务端 443 时，本机还会分配一个临时源端口：

```text
192.168.1.20:53124  --TCP-->  203.0.113.10:443
```

所以成千上万个客户端可以同时访问同一个服务端端口。服务端的 443 是稳定入口，客户端的 53124 通常只是这次连接的临时端点。

IANA 将端口号分为三个范围：

| 范围 | IANA 名称 | 应怎样理解 |
| ---: | --- | --- |
| `0–1023` | System Ports | 许多基础服务的登记端口；端口 0 被保留 |
| `1024–49151` | User Ports | 可登记给应用服务 |
| `49152–65535` | Dynamic/Private Ports | 不由 IANA 分配，常用于临时或私有用途 |

操作系统实际选择临时端口的范围可能由平台和系统配置决定，不能只凭上表推断。程序把监听端口指定为 0 时，操作系统通常会选择一个当前可用端口，这在自动化测试里非常有用。

更重要的是，IANA 也明确提醒：流量经过某个登记端口，不代表它一定属于登记的服务，更不代表它安全。识别协议要看服务配置、握手和实际报文，而不是只看数字。

## 3. 最小可运行实验：让 HTTP 跑在随机端口上

下面的程序只使用 Python 3 标准库。它让操作系统分配一个随机 TCP 端口，启动只处理一次请求的 HTTP/1.1 服务，然后由同一进程的客户端访问并退出。

```python
import json
import threading
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, HTTPServer

class HealthHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        if self.path != "/health?verbose=1":
            self.send_error(404)
            return

        body = json.dumps(
            {
                "client_source_port": self.client_address[1],
                "host": self.headers.get("Host"),
                "protocol": self.request_version,
                "status": "ok",
            },
            sort_keys=True,
        ).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        # 示例自己输出关键信息，不打印默认访问日志。
        pass

def main() -> None:
    server = HTTPServer(("127.0.0.1", 0), HealthHandler)
    server.timeout = 2
    host, port = server.server_address
    print(f"server_listen={host}:{port}")

    thread = threading.Thread(target=server.handle_request)
    thread.start()

    connection = HTTPConnection(host, port, timeout=2)
    try:
        connection.request(
            "GET",
            "/health?verbose=1",
            headers={"Host": f"demo.local:{port}"},
        )
        response = connection.getresponse()
        payload = json.loads(response.read())
        print(f"status={response.status}")
        print(f"request_protocol={payload['protocol']}")
        print(f"request_host={payload['host']}")
        print(f"client_source_port={payload['client_source_port']}")
    finally:
        connection.close()
        thread.join(timeout=3)
        server.server_close()

    if thread.is_alive():
        raise RuntimeError("server did not finish in time")

if __name__ == "__main__":
    main()
```

保存为 `port_demo.py` 后运行：

```bash
python3 port_demo.py
```

一次可能的输出如下，两个端口会随运行环境变化：

```text
server_listen=127.0.0.1:52341
status=200
request_protocol=HTTP/1.1
request_host=demo.local:52341
client_source_port=52342
```

这个实验说明了三件事。

第一，52341 没有“变成 HTTP 标准端口”。服务端与客户端都按照 HTTP 语法交换字节，所以 HTTP 可以在该端口正常工作。第二，服务端监听端口与客户端临时源端口各有职责。第三，非默认端口会出现在 Host 中，服务端可以同时使用目标 IP、端口与 Host 选择虚拟站点。

如果客户端改用 HTTPS 连接这个纯 HTTP 服务，TLS 客户端发出的握手字节会被 HTTP 解析器当成无效请求。失败原因不是“端口不支持 HTTPS”，而是这个端口背后的进程没有进行 TLS 握手。

## 4. URL 里的 scheme 和 port 分别决定什么？

观察这个 URL：

```text
https://api.example.com:8443/v1/chat?stream=true#result
```

| 部分 | 示例 | 作用 |
| --- | --- | --- |
| scheme | `https` | 要求按 HTTPS 语义访问 |
| host | `api.example.com` | 用于解析目标、证书校验和虚拟主机选择 |
| port | `8443` | 显式指定目标传输端口 |
| path | `/v1/chat` | 目标资源路径 |
| query | `stream=true` | 发送给服务端的查询部分 |
| fragment | `result` | 由客户端解释，不会作为 HTTP 请求目标发给服务端 |

没有显式端口时，scheme 提供默认端口：

```text
http://example.com     等价目标端口为 TCP 80
https://example.com    等价目标端口通常为 443
```

显式端口会覆盖默认值，但不会改变 scheme：

```text
https://example.com:8443  -> 仍然先执行 HTTPS/TLS，只是连接 8443
https://example.com:80    -> 尝试在 80 上执行 TLS，并不会自动退化为 HTTP
http://example.com:443    -> 尝试向 443 发送明文 HTTP，并不会自动升级为 HTTPS
```

后两种请求只有在服务端恰好按对应方式配置时才会成功。端口数字不会替客户端纠正协议。

HTTPS 虚拟主机还涉及两个容易混淆的名称：TLS 握手阶段通常通过 Server Name Indication（SNI）告诉服务端要访问的域名，以选择证书；HTTP 阶段再通过 HTTP/1.1 的 `Host` 或 HTTP/2、HTTP/3 的 `:authority` 表达目标 authority。二者属于不同协议阶段，配置错误时会分别表现为证书错误、错误站点或 HTTP 404。

## 5. 从域名到响应，一次 HTTPS 请求经历了什么？

以 `https://api.example.com/v1/tasks` 为例，可以把链路拆成五道门：

```text
1. DNS
   api.example.com -> IPv4/IPv6
        |
2. 传输连接
   TCP（HTTP/1.1、HTTP/2）或 QUIC/UDP（HTTP/3）
        |
3. 安全握手
   TLS 证书、密钥、SNI、应用协议协商
        |
4. HTTP
   method、authority、path、header、body
        |
5. 应用与上游
   路由、鉴权、数据库、内部服务
```

DNS 只负责把名称解析为地址。A 记录给出 IPv4，AAAA 给出 IPv6，CNAME 表示别名；解析成功不代表地址可达，也不代表服务正在监听。

HTTP/1.1 与 HTTP/2 的常见 HTTPS 部署先建立 TCP 连接，再进行 TLS 握手。TLS 负责加密、完整性和对端身份验证，并可通过 Application-Layer Protocol Negotiation（ALPN）协商 `http/1.1` 或 `h2`。证书校验通常涉及信任链、有效期和域名匹配。

HTTP/3 的结构不同：它映射到 QUIC，QUIC 运行在 UDP 之上并集成 TLS 1.3 的握手。不能把它理解成“UDP 本身突然变可靠”，可靠交付、拥塞控制、多路复用和加密由 QUIC 实现。

只有前面的连接与安全阶段成功后，HTTP 请求语义才真正进入排查范围。此时 400、401、403、404、429 等状态码才有意义。

## 6. HTTP/1.1、HTTP/2 和 HTTP/3 与端口是什么关系？

HTTP 各版本共享 method、状态码和字段等核心语义，但在线上的编码和传输不同：

| 版本 | 常见传输 | 线上表示 | 关键特征 |
| --- | --- | --- | --- |
| HTTP/1.1 | TCP；HTTPS 时外层为 TLS | 文本头部与消息体 framing | 持久连接、Host、chunked |
| HTTP/2 | TCP；公开 Web 常配合 TLS | 二进制帧、HPACK | 一个连接并发多个 stream |
| HTTP/3 | QUIC/UDP，集成 TLS 1.3 | QUIC stream、QPACK | 避免不同 QUIC stream 之间的 TCP 级队头阻塞 |

443 只是 HTTPS 默认端口，并不唯一对应某个 HTTP 版本。一个站点可以在 TCP 443 上通过 ALPN 同时支持 HTTP/1.1 和 HTTP/2，并在 UDP 443 上支持 HTTP/3。

HTTP/2 也存在明文 `h2c` 使用方式，但主流浏览器访问公开网站时通常使用 TLS 上的 HTTP/2。具体客户端、服务端与代理是否支持 h2c，需要结合版本和配置验证。

客户端也不是看到 `https://` 就凭空知道服务器支持 HTTP/3。常见部署通过既有连接上的 `Alt-Svc` 或相应 DNS HTTPS 记录等机制发现 HTTP/3 可用入口；客户端能力和策略仍会影响是否尝试以及是否回退。

代理还必须尊重版本差异。`Connection`、`Keep-Alive`、`Transfer-Encoding` 和 `Upgrade` 等连接级字段不能跨不同连接机械透传，HTTP/2 和 HTTP/3 也不使用 HTTP/1.1 的 chunked 编码。转发时应让框架重新建立正确的消息边界。

## 7. 哪些端口值得记，哪些只是开发习惯？

真正需要记住的是“常见默认值 + 必须核对实际配置”，而不是把端口当协议识别器。

### 7.1 Web 链路常见端口

| 端口 | 常见传输 | 常见用途 | 边界说明 |
| ---: | --- | --- | --- |
| `53` | UDP、TCP | DNS | 普通查询常用 UDP，但 DNS 并非只使用 UDP |
| `80` | TCP | HTTP 默认端口 | 也常用于跳转到 HTTPS 或 ACME 校验 |
| `443` | TCP | HTTPS、HTTP/1.1、HTTP/2 | 具体版本通常由 ALPN 等机制协商 |
| `443` | UDP | HTTP/3 over QUIC | 与 TCP 443 是不同端点 |
| `853` | TCP | DNS over TLS | DNS over HTTPS 通常仍走 HTTPS/443 |
| `8080` | TCP | 代理、备用或开发 HTTP | 是常见约定，不保证服务一定讲 HTTP |
| `8443` | TCP | 备用或开发 HTTPS | 不是 `https` scheme 的默认端口 |

### 7.2 项目内部经常看到的端口

| 端口 | 常见服务 | 实践提醒 |
| ---: | --- | --- |
| `22` | SSH、SFTP、SCP | SFTP 是 SSH 子系统，不是“加密版 FTP” |
| `3306` | MySQL | 不应因为是默认端口就直接暴露公网 |
| `5432` | PostgreSQL | 实际监听地址、TLS 与认证均由配置决定 |
| `6379` | Redis | 默认缺乏公网暴露所需的完整安全边界 |
| `5672` | AMQP | RabbitMQ 等常见非 TLS AMQP 入口 |
| `9092` | Kafka broker | 常见默认值，生产环境经常重新配置 |

`3000`、`5000`、`8000`、`8888`、`9000` 等在开发工具中很常见，但没有“看到 8000 就一定是 FastAPI”这种规则。最终证据来自启动配置和实际监听状态。

## 8. 为什么服务启动了，别的机器仍访问不到？

端口号之外，监听地址同样重要：

```text
127.0.0.1:8000  -> 只接受本机 IPv4 回环访问
0.0.0.0:8000    -> 监听本机所有 IPv4 接口
[::1]:8000      -> 只接受本机 IPv6 回环访问
[::]:8000       -> 监听所有 IPv6 接口；是否同时接收 IPv4 取决于系统配置
```

开发服务器只绑定 `127.0.0.1` 时，本机 curl 正常，局域网和容器外部却无法连接。这时继续开放云安全组也不会让进程突然监听外部网卡。

容器还多一层端口映射：

```bash
docker run --publish 8080:8000 my-api
```

它表达的是：宿主机 8080 接收流量，再转发到容器 8000。容器内应用仍然监听 8000；若它只绑定容器自己的 `127.0.0.1`，发布端口通常也无法把请求交给它。

对外监听 `0.0.0.0` 不是安全策略本身。还需要结合主机防火墙、云安全组、容器网络、服务认证和是否确实需要公网暴露来判断。数据库、Redis 和管理接口通常应留在受控内部网络。

## 9. 到达 HTTP 层后，应检查哪些语义？

HTTP/1.1 请求可以直观看到 method、request target、Host 与 body：

```http
POST /v1/tasks?async=true HTTP/1.1
Host: api.example.com
Authorization: Bearer <token>
Content-Type: application/json
Accept: application/json
Content-Length: 20

{"name":"index-docs"}
```

服务端可能返回：

```http
HTTP/1.1 202 Accepted
Content-Type: application/json
Location: /v1/tasks/t-123
Content-Length: 34

{"id":"t-123","status":"pending"}
```

`202 Accepted` 表示请求已接收处理，但异步任务尚未保证完成；客户端还需要任务 ID 或状态查询地址。

排障时，下面几组概念比背诵全部字段更重要：

| 概念 | 正确理解 | 常见错误 |
| --- | --- | --- |
| `Content-Type` / `Accept` | 前者描述当前 body，后者表达希望接收的类型 | 把 Accept 当请求 body 类型 |
| `401` / `403` | 401 通常是凭证缺失或无效；403 是拒绝授权 | 把所有权限问题都返回 401 |
| `404` / `405` | 前者目标资源或路由不存在；后者路由存在但方法不允许 | 只检查 path，不检查 method |
| `502` / `503` / `504` | 无效上游响应；服务暂不可用；等待上游超时 | 全部映射成当前服务的 500 |
| `Content-Length` / framing | 用来界定 HTTP/1.1 消息体 | 代理同时制造冲突的长度与 Transfer-Encoding |
| `Authorization` / Cookie | 表达凭证或状态 | 把完整 token、Cookie 写入日志 |

GET 的内容没有通用定义的语义。与其记成“协议语法绝对禁止 GET body”，不如记住工程事实：许多客户端、缓存、代理和框架不能一致处理它。普通查询放 query，复杂搜索可设计为 POST 接口。

跨域资源共享（CORS）也只是在浏览器中约束跨源脚本怎样读取响应，不是服务端认证或防火墙。curl、移动应用和其他服务端程序不会因为浏览器 CORS 策略而失去访问能力。

## 10. Gateway 为什么会让外部端口和内部端口不同？

常见部署会在入口终止 TLS，再访问内部服务：

```text
Browser / App
      |
      | HTTPS, TCP/UDP 443
      v
Nginx / C++ Gateway
      |
      | internal HTTP, TCP 8000
      v
FastAPI
      |
      +--> Redis 6379
      +--> PostgreSQL 5432
```

客户端访问 443，不代表 FastAPI 也监听 443。Gateway 创建的是一条新的上游连接，它可以重写 path、Host 和身份字段，也可以在外部使用 HTTP/2、内部使用 HTTP/1.1。

这两段链路需要分别诊断：

```text
client -> Gateway 正常 + Gateway -> upstream 失败 = 502/503/504 等网关错误
```

`502 Bad Gateway` 常表示连接上游失败、上游提前关闭或返回无效响应；`504 Gateway Timeout` 表示 Gateway 等待上游超过期限；`503 Service Unavailable` 常用于过载、维护或主动拒绝服务。具体错误映射属于项目约定，但必须稳定，并在内部日志保留 request ID 和真实上游原因。

代理不能相信外部客户端自己提交的 `X-Forwarded-For` 或内部用户身份字段。应清除不可信值，再由可信入口注入。`Connection` 还可以动态声明其他仅当前连接有效的字段，不能只过滤一个固定名单后就复制剩余全部 Header。

内部 HTTP 不等于天然安全。是否为内部链路启用 TLS，应根据网络边界、跨主机通信、合规要求和威胁模型决定。

## 11. 怎样按层排查，而不是反复试端口？

下面命令以 macOS 和常见 Linux 环境为例。不同系统自带的 `curl`、`nc`、OpenSSL/LibreSSL 选项可能不同，先查看本机帮助和版本；所有测试都应设置合理超时。

### 第一步：确认 DNS 结果

```bash
HOST='example.com'
dig A "$HOST"
dig AAAA "$HOST"
```

如果没有 `dig`，可以使用系统已有的 `nslookup`。解析出多个地址时，应记录客户端实际尝试的是 IPv4 还是 IPv6。

### 第二步：确认本机到底监听在哪里

macOS：

```bash
lsof -nP -iTCP -sTCP:LISTEN
lsof -nP -iTCP:8000 -sTCP:LISTEN
```

常见 Linux：

```bash
ss -lntp
ss -lnup
```

除了端口，还要看监听地址是回环地址、指定网卡还是所有接口。

### 第三步：只测试 TCP 连接

```bash
HOST='example.com'
PORT='443'
nc -vz -w 3 "$HOST" "$PORT"
```

成功只代表 TCP 建连。UDP 是无连接协议，`nc -u` 没有报错通常也不能像 TCP 三次握手那样证明远端应用已经正常响应。

### 第四步：单独观察 TLS

```bash
HOST='example.com'
PORT='443'
openssl s_client \
  -connect "${HOST}:${PORT}" \
  -servername "$HOST" \
  -alpn 'h2,http/1.1' \
  </dev/null
```

`-servername` 发送 SNI；`-alpn` 请求协商应用协议。输出要结合证书链、校验结果和协商协议阅读，不能只看到“有证书文本”就判断成功。

### 第五步：观察完整 HTTP 过程

```bash
curl --connect-timeout 3 --max-time 10 -v \
  https://example.com/
```

`-v` 会展示名称解析、连接地址、TLS 与 HTTP Header。`-k` 会跳过证书校验，只适合临时区分“证书校验失败”与其他问题，不能作为生产修复。

若要固定目标 IP，同时保留正确 Host 和 SNI，可使用：

```bash
HOST='api.example.com'
TARGET_IP='203.0.113.10'
curl --connect-timeout 3 --max-time 10 -v \
  --resolve "${HOST}:443:${TARGET_IP}" \
  "https://${HOST}/health"
```

`203.0.113.10` 是文档示例地址，实际执行前必须替换成待测服务器 IP。

### 第六步：验证 HTTP 版本和流式行为

```bash
curl -v --http1.1 https://example.com/
curl -v --http2 https://example.com/
curl -v --http3 https://example.com/
```

本机 curl 是否支持 HTTP/2、HTTP/3 取决于编译选项，可先运行 `curl --version`。SSE 等流式接口还应使用 `-N` 关闭 curl 输出缓冲：

```bash
curl -N --max-time 30 \
  -H 'Accept: text/event-stream' \
  https://api.example.com/v1/events
```

最后把每层观察结果与同一个 request ID、Gateway 日志和上游日志对齐。命令输出解决的是“在哪一层失败”，应用日志才能进一步回答“为什么失败”。

## 12. 常见误区：一句顺口溜为什么会误导排障？

### 误区一：端口号就等于协议

80、443 是默认约定，不是协议检测器。HTTP 可以运行在随机端口，443 也可以被错误配置成明文服务。应查看配置并完成相应握手。

### 误区二：能 ping 通，Web 服务就正常

ping 使用 ICMP，没有 TCP/UDP 端口。主机可能允许 ICMP 却阻断 443，也可能禁用 ICMP 但正常提供 HTTPS。

### 误区三：TCP 443 能连，HTTPS 就正常

TCP 成功之后仍有 TLS、SNI、证书、ALPN、Host、path、鉴权和业务处理。`nc` 无法替代 `openssl s_client` 与 `curl`。

### 误区四：HTTPS 只能使用 443

HTTPS 可以监听 8443 或其他端口，只是 URL 必须显式携带端口。反过来，在 URL 中写 `https` 才要求 TLS；8443 这个数字本身不会自动启用加密。

### 误区五：HTTP/3 仍然走 TCP 443

HTTP/3 使用 QUIC/UDP。TCP 443 与 UDP 443 需要分别配置监听、负载均衡和防火墙策略。

### 误区六：CORS 拒绝了请求，所以后端已经安全

CORS 是浏览器执行的跨源读取策略，不能替代服务端认证、授权、CSRF 防护或网络访问控制。

### 误区七：开发端口只要映射出来就能从外部访问

容器映射、主机防火墙和应用监听地址缺一不可。只绑定回环地址的进程不会因为端口映射就自动对外服务。

### 误区八：所有接口失败都返回 HTTP 200，再看业务码

这会让代理、缓存、监控和通用客户端误判。HTTP 状态码表达协议层结果，响应 body 中的业务码可以继续描述更细的原因，两者并不冲突。

## 13. 什么时候应该看端口，什么时候不该继续看？

端口信息适合回答：进程监听在哪里、防火墙应允许哪种传输、容器怎样映射、客户端目标是否写错。它不适合单独回答：证书是否可信、HTTP 方法是否正确、用户是否有权限、Gateway 上游是否健康。

| 当前现象 | 下一步更有价值的检查 |
| --- | --- |
| 域名无法解析 | DNS 配置、记录、客户端 resolver |
| TCP refused/timeout | 监听地址、路由、防火墙、安全组 |
| TLS 握手或证书错误 | SNI、证书链、域名、时间、ALPN |
| HTTP 401/403/404 | 凭证、授权、Host、method、path |
| HTTP 502/504 | Gateway 上游地址、连接和超时日志 |
| SSE 最后一次性返回 | 客户端、Gateway、代理和压缩缓冲 |

一旦收到了 HTTP 状态码，说明至少已经有某个 HTTP 服务响应。此时继续重复 `ping` 或只看端口，信息增量通常很低，应转向请求语义、虚拟主机和服务日志。

## 14. 总结

443 连通而 HTTPS 仍失败，并不反直觉。端口只是某种传输协议上的目标端点，后面还有 TLS、HTTP、Gateway 和业务应用，每一层都有自己的成功条件。

最重要的结论可以压缩为四点：

1. TCP 443 与 UDP 443 是两个端点，HTTP/3 使用后者承载 QUIC；
2. scheme 决定客户端期望的协议，显式端口只改变连接目标；
3. 端口登记是约定，不是实际流量的协议或安全证明；
4. 排错应按 DNS、传输、TLS、HTTP、应用的顺序逐层收集证据。

下一次看到“端口已经通了”时，先问一句：通的是哪一种传输，它证明到哪一层？这比再换一个端口碰运气更接近真正的根因。

## 参考资料

- [IANA：Service Name and Transport Protocol Port Number Registry](https://www.iana.org/assignments/service-names-port-numbers/service-names-port-numbers.xhtml)
- [RFC 6335：Service Name and Transport Protocol Port Number Registry](https://www.rfc-editor.org/rfc/rfc6335)
- [RFC 9110：HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)
- [RFC 9112：HTTP/1.1](https://www.rfc-editor.org/rfc/rfc9112)
- [RFC 9113：HTTP/2](https://www.rfc-editor.org/rfc/rfc9113)
- [RFC 9114：HTTP/3](https://www.rfc-editor.org/rfc/rfc9114)
