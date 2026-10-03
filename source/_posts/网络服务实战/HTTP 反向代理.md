---
title: "请求已经转发成功，query 和用户身份为什么还是错了？HTTP 反向代理的边界"
date: 2026-07-13 17:35:34
updated: 2026-07-13 17:35:34
categories:
  - "学习"
  - "网络服务实战"
permalink: /notes/网络服务实战/http-反向代理/
series: "网络服务实战"
---

一个 Gateway 收到：

```http
GET /v1/tasks?page=1&page_size=20 HTTP/1.1
Host: api.example.com
Authorization: Bearer external-token
Connection: keep-alive, X-Debug-Only
X-Debug-Only: secret
```

最直觉的代理代码是：把 path 前面换成 `/internal`，复制全部 header 和 body，再把上游响应原样返回。请求可能得到 200，但已经埋下几个问题：query 容易在路径重写时丢失；外部 Authorization 或伪造的内部身份可能被上游误信；`X-Debug-Only` 虽不在常见固定黑名单里，却被 `Connection` 动态声明为只对当前连接有效；Host、Content-Length 和 Transfer-Encoding 也不能跨两条连接机械复用。

反向代理不是“把两个 socket 接起来复制字符串”。对普通 HTTP 请求，它终止一条下游 HTTP 消息，再根据明确策略创建一条新的上游 HTTP 消息。路径、字段、身份、超时和消息边界都属于安全边界。

本文以 **C++20 + Drogon Gateway → FastAPI/internal service** 为背景。HTTP 语义以 RFC 9110、HTTP/1.1 消息边界以 RFC 9112 为依据；Drogon API 会随版本演进，集成代码必须结合项目锁定版本和对应头文件验证。

## 1. 反向代理真正承担了哪两条连接？

普通 HTTP 代理链路可以画成：

```text
Client ── downstream HTTP ──> Gateway
                                  │
                                  └── upstream HTTP ──> Internal Service
```

Gateway 对客户端是服务器，对内部服务又是客户端。两侧可能使用不同连接、Host、HTTP 版本和消息分帧方式：下游请求使用 chunked，并不意味着上游也必须 chunked；上游可以返回 HTTP/2，Gateway 再向 HTTP/1.1 客户端生成 Content-Length 或 chunked 响应。

因此需要区分三类信息：

| 信息 | 示例 | 处理原则 |
| --- | --- | --- |
| 表示元数据 | Content-Type、Accept、Content-Encoding | 理解语义后选择性转发 |
| 当前连接控制 | Connection、Keep-Alive、Transfer-Encoding | 消费或重建，不机械转发 |
| 信任/路由元数据 | Host、Authorization、Forwarded、内部用户 ID | 在信任边界重新验证或生成 |

只有 CONNECT 隧道、WebSocket Upgrade 等明确切换协议的场景，才更接近双向字节转发；它们需要专门处理，不能混进普通 JSON 代理函数。

## 2. 为什么一个固定 hop-by-hop 黑名单仍然不够？

常见教程会过滤：

```text
Connection, Keep-Alive, Proxy-Authenticate, Proxy-Authorization,
TE, Trailer, Transfer-Encoding, Upgrade
```

这些名字确实需要特殊处理，但 RFC 9110 还要求代理先解析 `Connection` 字段。发送方可以列出额外的 connection-option：

```http
Connection: keep-alive, X-Debug-Only
X-Debug-Only: secret
```

此时代理必须同时移除 `Connection` 和 `X-Debug-Only`。只写固定八项黑名单会漏掉动态选项。

过滤也不能只做请求方向。上游响应中的 hop-by-hop 字段同样只属于 Gateway ↔ upstream 连接，不能原样交给客户端。生产实现应让请求和响应共享同一套字段规范化策略，并对 HTTP/2/3 禁止的 connection-specific 字段做版本适配。

## 3. 最小可运行版本：安全地重写 target 和 header

下面的标准库程序不发送网络请求，只实现代理中最容易独立测试、也最容易出错的 policy layer（策略层）：

- `/v1` 必须按路径段匹配，不能把 `/v10` 当成合法前缀；
- 保留原始 query，避免重复 decode/encode；
- 过滤固定和 `Connection` 动态声明的 hop-by-hop 字段；
- 不把外部 Authorization 与伪造内部身份交给上游；
- 由 Gateway 注入可信 request ID、用户 ID 和客户端地址。

```cpp
#include <algorithm>
#include <cassert>
#include <cctype>
#include <iostream>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_set>
#include <utility>
#include <vector>

struct Header {
    std::string name;
    std::string value;
};

struct Request {
    std::string method;
    std::string target;  // path + 原始 query
    std::vector<Header> headers;
    std::string body;
};

std::string LowerAscii(std::string_view text) {
    std::string result;
    result.reserve(text.size());
    for (const unsigned char ch : text) {
        result.push_back(static_cast<char>(std::tolower(ch)));
    }
    return result;
}

std::string TrimAscii(std::string_view text) {
    while (!text.empty() && std::isspace(static_cast<unsigned char>(text.front()))) {
        text.remove_prefix(1);
    }
    while (!text.empty() && std::isspace(static_cast<unsigned char>(text.back()))) {
        text.remove_suffix(1);
    }
    return std::string(text);
}

std::vector<std::string> SplitConnectionOptions(std::string_view value) {
    std::vector<std::string> result;
    while (!value.empty()) {
        const std::size_t comma = value.find(',');
        const std::string token = TrimAscii(value.substr(0, comma));
        if (!token.empty()) result.push_back(LowerAscii(token));
        if (comma == std::string_view::npos) break;
        value.remove_prefix(comma + 1);
    }
    return result;
}

std::optional<std::string> RewriteTarget(std::string_view target) {
    const std::size_t queryStart = target.find('?');
    const std::string_view path = target.substr(0, queryStart);
    const std::string_view query = queryStart == std::string_view::npos
        ? std::string_view{}
        : target.substr(queryStart);  // 保留 '?' 和原始编码

    if (path != "/v1" && !path.starts_with("/v1/")) {
        return std::nullopt;
    }

    std::string rewritten = "/internal";
    rewritten += path.size() == 3 ? "/" : std::string(path.substr(3));
    rewritten += query;
    return rewritten;
}

std::optional<std::string> HeaderValue(
    const std::vector<Header>& headers,
    std::string_view wanted
) {
    const std::string lowerWanted = LowerAscii(wanted);
    for (const Header& header : headers) {
        if (LowerAscii(header.name) == lowerWanted) return header.value;
    }
    return std::nullopt;
}

std::optional<Request> BuildUpstreamRequest(
    const Request& incoming,
    std::string_view authenticatedUser,
    std::string_view peerIp
) {
    const auto target = RewriteTarget(incoming.target);
    if (!target) return std::nullopt;

    std::unordered_set<std::string> blocked{
        "connection", "keep-alive", "proxy-authenticate",
        "proxy-authorization", "proxy-connection", "te", "trailer",
        "transfer-encoding", "upgrade", "host", "content-length",
        "authorization", "x-internal-user-id", "x-forwarded-for"
    };

    for (const Header& header : incoming.headers) {
        if (LowerAscii(header.name) != "connection") continue;
        for (std::string option : SplitConnectionOptions(header.value)) {
            blocked.insert(std::move(option));
        }
    }

    const std::unordered_set<std::string> allowed{
        "accept", "accept-language", "content-type", "content-encoding",
        "user-agent", "x-request-id", "traceparent", "tracestate"
    };

    Request upstream{incoming.method, *target, {}, incoming.body};
    for (const Header& header : incoming.headers) {
        const std::string name = LowerAscii(header.name);
        if (!blocked.contains(name) && allowed.contains(name)) {
            upstream.headers.push_back({name, header.value});
        }
    }

    if (!HeaderValue(upstream.headers, "x-request-id")) {
        upstream.headers.push_back({"x-request-id", "req-generated-42"});
    }
    upstream.headers.push_back({"x-internal-user-id", std::string(authenticatedUser)});
    upstream.headers.push_back({"x-forwarded-for", std::string(peerIp)});
    return upstream;
}

int main() {
    Request incoming{
        "GET",
        "/v1/tasks?page=1&page_size=20",
        {
            {"Host", "api.example.com"},
            {"Authorization", "Bearer external-token"},
            {"Connection", "keep-alive, X-Debug-Only"},
            {"X-Debug-Only", "secret"},
            {"X-Internal-User-Id", "attacker"},
            {"Accept", "application/json"},
        },
        ""
    };

    const auto upstream = BuildUpstreamRequest(incoming, "user-7", "203.0.113.10");
    assert(upstream);

    const bool debugForwarded = HeaderValue(upstream->headers, "x-debug-only").has_value();
    const bool authForwarded = HeaderValue(upstream->headers, "authorization").has_value();
    const auto internalUser = HeaderValue(upstream->headers, "x-internal-user-id");
    const bool invalidPrefixRejected =
        !RewriteTarget("/v10/tasks?x=1").has_value();

    std::cout << "target=" << upstream->target << '\n'
              << std::boolalpha
              << "x_debug_forwarded=" << debugForwarded << '\n'
              << "authorization_forwarded=" << authForwarded << '\n'
              << "internal_user=" << internalUser.value_or("missing") << '\n'
              << "invalid_prefix_rejected=" << invalidPrefixRejected << '\n';

    assert(upstream->target == "/internal/tasks?page=1&page_size=20");
    assert(!debugForwarded);
    assert(!authForwarded);
    assert(internalUser == "user-7");
    assert(invalidPrefixRejected);
}
```

在 macOS 或 Linux 上使用 Clang 编译：

```bash
clang++ -std=c++20 -O2 -Wall -Wextra -Wpedantic \
  proxy_policy.cpp -o proxy_policy
./proxy_policy
```

预期输出：

```text
target=/internal/tasks?page=1&page_size=20
x_debug_forwarded=false
authorization_forwarded=false
internal_user=user-7
invalid_prefix_rejected=true
```

这个程序没有假装实现完整 HTTP parser。它验证的是代理策略：哪些信息可以跨边界，哪些必须由 HTTP 库或 Gateway 重新生成。真正的网络层应交给经过测试的 HTTP 实现处理部分读写、chunked、连接复用和 TLS。

## 4. 为什么 `/v1` 的 `starts_with` 会误匹配 `/v10`？

原笔记直接判断：

```cpp
path.starts_with("/v1")
```

这会同时接受 `/v1/chat`、`/v10/chat` 和 `/v1evil`。路由前缀必须按 segment（路径段）判断：path 等于 `/v1`，或者下一字符是 `/`。

Query 也应该保留其原始编码。假设客户端发送：

```text
/v1/search?q=a%2Fb&q=c+d
```

代理若先解析成 map 再拼接，可能丢失重复参数、改变顺序，或把 `+`、`%20`、`%2F` 重新编码成不同形式。除非代理确实要修改 query，最安全的策略是把原始 `?` 后内容附到重写后的 path，并让上游框架按自己的语义解析。

路径改写还要明确这些边界：`..`、重复斜线、百分号编码、空 path 和 fragment。HTTP 请求目标通常不发送 URI fragment；若入口框架已经规范化 path，需要知道规范化发生在路由前还是后，防止 Gateway 与上游对同一字符串做出不同解释。

## 5. Drogon 集成层怎样调用这个策略？

Drogon controller handler 通过 callback 异步交付响应。普通 JSON 代理的骨架可以写成：

```cpp
// 集成示意：需要结合项目锁定的 Drogon 版本、路由和错误类型验证。
void proxyJson(
    const drogon::HttpRequestPtr& request,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const drogon::HttpClientPtr& upstreamClient
) {
    auto upstream = drogon::HttpRequest::newHttpRequest();
    upstream->setMethod(request->method());
    upstream->setPath(buildValidatedUpstreamTarget(request));
    upstream->setBody(std::string(request->body()));
    copyNormalizedRequestHeaders(request, upstream);

    upstreamClient->sendRequest(
        upstream,
        [callback = std::move(callback)](
            drogon::ReqResult result,
            const drogon::HttpResponsePtr& response
        ) mutable {
            if (result != drogon::ReqResult::Ok || !response) {
                callback(makeGatewayError(result));
                return;
            }
            callback(buildNormalizedDownstreamResponse(response));
        },
        5.0
    );
}
```

这段代码不能在当前笔记工作区独立编译，因为没有项目 CMake、Drogon 版本和辅助函数；它只标出所有权与控制流。完整实现必须保证：每条成功/失败路径恰好调用一次 callback；请求结束前异步回调所需对象仍然存活；不能在 I/O 线程中同步等待 future 或执行阻塞文件操作。

也不应为每个请求无条件创建新的 HttpClient 和连接。连接复用、DNS、线程归属和 TLS 配置应集中管理，但具体 HttpClient 是否可跨任意线程共享要以所用 Drogon 版本文档与源码为准。无法确认时，使用框架推荐的每事件循环客户端或明确连接池，不要猜测线程安全。

## 6. Header 策略为什么优先白名单，而不是“除黑名单外都转发”？

Gateway 面向外部时，header 是输入接口的一部分。白名单能让新增外部字段默认不进入可信内网，更适合身份和安全边界。

### 6.1 Host 必须按上游 authority 重建

外部 Host 指向 Gateway，内部 Host 指向 upstream。HTTP client 通常会根据目标 URL 自动生成；若手工设置，也必须来自配置的 upstream authority，不能信任客户端 Host。否则可能造成错误虚拟主机路由或 host header injection。

### 6.2 Authorization 与内部身份不是同一个字段

Gateway 应验证外部 token，再注入内部身份，例如 `x-internal-user-id`。必须先删除客户端同名字段，防止攻击者自报用户。是否向上游透传原始 Authorization 取决于架构：若内部服务需要独立验证，可以转发或换发内部 token；若内部服务只信任 Gateway，就不要同时留下两个冲突身份来源。

### 6.3 X-Forwarded-For 不能盲目追加

在互联网信任边界，客户端可以自己发送 X-Forwarded-For。Gateway 应先清除不可信值，再用 socket peer 地址生成；若 Gateway 前还有受信任负载均衡器，则只信任配置中的代理网段并按链解析。`Forwarded`、`X-Forwarded-Proto` 和 `Via` 也需要一致策略。

### 6.4 响应字段也必须规范化

除了 hop-by-hop 字段，还要考虑：Location 是否暴露内网域名，Set-Cookie 的 Domain/Path/Secure 是否适合外部入口，缓存字段是否允许共享，CORS 是否由哪一层负责。不能只复制 status/body，再认为代理语义完整。

## 7. Content-Length 与 Transfer-Encoding 为什么不能照抄？

它们定义当前 HTTP/1.1 消息的边界。Gateway 读取完下游请求后，通常已经得到解码后的 body；创建上游请求时，应让 HTTP client 根据新 body 重新生成 Content-Length 或 framing。

若入口同时出现 Transfer-Encoding 和 Content-Length，解析差异可能形成 request smuggling（请求走私）。RFC 9112 要求严格处理这种歧义；代理不能把两者原样交给下游，希望上游“自己理解”。同理，收到非法 Content-Length 的上游响应时，代理应丢弃该响应并向客户端返回 502，而不是猜测 body 边界后复用连接。

这也是手写 `recv` → 找 `\r\n\r\n` → 转发剩余字节的代理不可靠的原因。完整 HTTP/1.1 还要处理：

- body 的 Content-Length/chunked/无 body 状态码规则；
- HEAD、1xx、204、304、CONNECT 的特殊语义；
- trailer；
- `Expect: 100-continue`；
- keep-alive 上连续多条消息；
- 不完整 body 与半关闭连接；
- HTTP/2/3 不同 framing。

使用 Drogon 这样的框架不是为了少写几个 socket 调用，而是复用经过测试的 HTTP 状态机。Gateway 仍需为框架设置一致的 parser/body/header 限制。

## 8. 2 MiB 检查为什么可能已经太晚？

在 controller 中执行：

```cpp
if (request->body().size() > 2 * 1024 * 1024) { ... }
```

可以防止继续转发大 body，却不一定防止入口服务器已经把它完整读入内存。真正的资源边界应尽可能在 HTTP parser 或 listener 配置层限制 header/body 大小，并在业务 handler 再做第二层语义检查。

JSON 代理复制 `request->body()` 又可能产生额外内存副本。2 MiB 尚可接受，数百 MiB 上传则不能沿用同一路径。

上传通常有三种策略：

| 策略 | 优点 | 代价 |
| --- | --- | --- |
| Gateway 流式转发 | 少落盘、延迟低 | 需要双向背压、取消和超时 |
| Gateway 临时落盘/对象存储 | 可扫描、重试、异步处理 | 生命周期、配额、清理与权限 |
| 客户端直传对象存储 | Gateway 带宽压力小 | 需要签名 URL 与上传完成校验 |

如果 Gateway 落盘，不应把任意客户端文件名拼进路径；要生成服务端对象 ID，限制总量，验证真实内容而不是只看扩展名，并定义失败/任务完成后的清理。把本机路径直接发给另一个容器也不一定可用，除非双方共享受控卷或对象存储命名空间。

## 9. 超时为什么不能只有一个 `5.0`？

普通示例里的 `sendRequest(..., 5.0)` 能提供一个上限，但生产代理至少要区分：

| 超时 | 防止什么 |
| --- | --- |
| 连接/DNS/TLS 超时 | 上游根本建立不了连接 |
| 响应头超时 | 连接成功但上游迟迟不开始响应 |
| body idle timeout | 流中间长期无任何字节 |
| total deadline | 请求整体占用资源过久 |

不同接口需要不同策略：短 JSON 查询可以有紧 total deadline；上传需要允许较长 body 传输但限制空闲时间和速率；SSE 可能持续数分钟，不能用普通 5 秒总超时，却仍需要心跳和 idle timeout。

HTTP 错误映射也要保留层次：

- 客户端请求不合法：400/413/415；
- 未认证与无权限：分别使用 401/403；
- Gateway 限流：429；
- 无法连接、DNS/TLS/协议错误：通常 502；
- 上游在 deadline 内未响应：504；
- 上游返回合法 4xx/5xx：按 API 契约透传或规范化，不能一律改成 500。

具体 `ReqResult` 枚举到 502/504 的映射需要按所用 Drogon 版本验证。错误响应应保持稳定 JSON 结构和 request ID，但不能泄露内网地址、异常栈或 token。

## 10. SSE 为什么不能走普通 JSON 代理函数？

普通 `HttpClient::sendRequest` 回调通常在完整响应可用后交付 body。对 JSON 这是期望行为；对 `text/event-stream`，等待完整 body 等于等连接结束，客户端看不到任何流式事件。

SSE 代理必须建立增量链路：

```text
上游产生一段事件
      ↓ 不等待完整响应
Gateway 读取 chunk/stream callback
      ↓ 处理背压、断线和心跳
下游立即 flush
```

同时要关闭中间缓冲、保留事件边界、定义客户端断开是否取消上游任务，并设置适合长连接的超时。具体 Drogon streaming API 与版本相关，应单独实现并做断线测试，不能在普通 JSON handler 上增加一个 Content-Type 就宣称支持 SSE。

WebSocket 与 CONNECT 更不同：它们涉及协议升级或隧道，必须专门处理双向生命周期。

## 11. Callback、取消和背压怎样影响资源上限？

Drogon handler 是异步接口，callback 可以稍后调用，但并不意味着资源无限。Gateway 至少要限制：

- 总并发请求与每用户并发；
- 上游连接数与等待队列；
- 请求/响应 body 缓冲；
- 上传和 SSE 活跃连接；
- 客户端断开后是否取消上游；
- 慢客户端导致的下游发送积压。

如果上游比客户端快，流式响应必须有有界缓冲或暂停读取；如果客户端已经断开，继续生成昂贵 RAG/LLM 结果可能浪费资源。取消能否传播到 FastAPI、Celery 或模型服务，需要一条显式协议，不能只销毁 C++ callback。

普通 JSON 请求同样需要背压。一个“全异步” Gateway 仍可以因为无限排队而耗尽内存；异步只是避免线程阻塞，不自动提供容量控制。

## 12. 日志和指标怎样帮助区分 Gateway 慢还是 upstream 慢？

每次请求至少关联一个不可伪造或经过验证的 request ID，并记录：

```text
method, normalized_route, user_id, upstream_service,
downstream_status, upstream_status, request_bytes, response_bytes,
queue_ms, connect_ms, upstream_ttfb_ms, upstream_total_ms,
gateway_total_ms, error_class
```

不要把完整 query、Authorization、Cookie 或上传文件名无脑写入日志。路由使用规范化模板（如 `/v1/tasks/:id`），避免高基数 path 把指标系统撑爆。

关键指标可以包括：

- 按 route/status/upstream 分类的请求量和延迟分布；
- 连接失败、超时、协议错误与上游 5xx；
- 当前上游连接、排队请求、SSE 和上传数；
- 请求/响应字节与被拒绝的大 body；
- callback 未完成、取消和下游断开。

端到端时间减去 upstream_total 并不总等于 Gateway CPU 时间，其中还可能包括队列和下游发送。只有拆分阶段计时，才能定位瓶颈。

## 13. 常见误区

### 13.1 误区：反向代理就是复制 method、URL、header、body

普通代理需要重建两侧 HTTP 消息。Host、framing、Connection、身份和 Forwarded 字段必须按信任策略处理。

### 13.2 误区：删除固定八个 hop-by-hop header 就完成了

还必须解析 Connection 动态列出的字段，并在响应方向执行同样策略。

### 13.3 误区：路径 `starts_with("/v1")` 就足够

它会匹配 `/v10`。需要路径段边界，并保留原始 query 编码。

### 13.4 误区：上游 5xx 都应该改成 502

合法上游 5xx 表示应用服务失败；502 更适合 Gateway 无法得到合法上游响应。是否包装取决于公开 API 契约，但不能丢失可观测分类。

### 13.5 误区：异步回调不会拖垮线程池

回调不阻塞 I/O 线程只是第一步。无限并发、body 缓冲、慢客户端和无界队列仍会耗尽内存与连接。

### 13.6 误区：扩展名和 Content-Type 能证明上传文件安全

两者都由客户端控制。需要内容嗅探、格式解析沙箱、配额、扫描和安全存储策略，具体强度取决于威胁模型。

## 14. 什么时候应该自己写 Gateway，什么时候使用成熟代理？

当入口需要与 C++ 业务状态紧密结合的鉴权、协议适配、任务编排或低延迟自定义逻辑时，Drogon Gateway 有价值。但 TLS 终止、通用负载均衡、标准重试、HTTP/2/3、压缩和成熟观测通常更适合交给 Nginx、Envoy、HAProxy 或云负载均衡器。

常见架构是成熟边缘代理负责证书、连接和基础防护，C++ Gateway 负责业务级身份与路由。不要为了证明“会写网络”而重新实现完整 HTTP parser，也不要在没有业务需求时堆叠两层功能相同的代理。

## 15. 总结：代理成功返回 200，不代表语义没有被改坏

开头请求的问题不在 socket 是否连通，而在两条 HTTP 消息之间缺少明确转换策略。可靠反向代理应做到：

1. 按路径段重写 target，并保留原始 query 语义。
2. 解析 Connection 动态选项，双向过滤 hop-by-hop 与重建 framing。
3. 在信任边界验证外部凭据，删除伪造内部字段，再注入可信身份。
4. 对 body、超时、并发和流式响应设置分层资源边界。
5. 用 request ID、阶段延迟和错误分类证明问题发生在客户端、Gateway 还是 upstream。

最直接的实践建议是为每条代理路由写一份 contract：允许的方法、目标路径规则、query 策略、请求/响应 header 白名单、body 上限、超时、错误映射和是否支持 streaming。没有 contract 的“透明转发”，通常只是在透明地传播风险。

## 16. 参考资料

- [RFC 9110：HTTP Semantics](https://datatracker.ietf.org/doc/html/rfc9110)
- [RFC 9112：HTTP/1.1](https://www.rfc-editor.org/rfc/rfc9112.html)
- [Drogon 官方仓库](https://github.com/drogonframework/drogon)
- [Drogon Controller 官方 Wiki](https://github.com/drogonframework/drogon/wiki/ENG-04-0-Controller-Introduction)
