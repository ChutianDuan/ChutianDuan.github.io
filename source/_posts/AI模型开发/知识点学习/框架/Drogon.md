---
title: "Drogon 性能很高，为什么一个慢请求仍能拖垮服务？异步 C++ Web 实战"
date: 2026-07-13 18:48:23
updated: 2026-07-13 18:48:23
categories:
  - "学习"
  - "AI 模型开发"
  - "知识点学习"
  - "框架"
permalink: /notes/ai模型开发/知识点学习/框架/drogon/
series: "AI 模型开发"
---

Drogon 是支持 C++14/17/20 的异步 Web 框架，提供 HTTP、WebSocket、数据库、Redis、过滤器、中间件、文件处理与协程等能力。它能用少量 I/O 线程承载大量连接，但“使用高性能框架”不等于业务代码自动非阻塞。

如果 handler 中执行同步模型推理、读取大文件、等待没有 timeout 的上游请求，event loop 仍会被占住；一个慢请求就可能让同一线程上的其他连接一起变慢。

本文围绕这个问题讲清：

1. Drogon 的 callback 异步模型怎样工作；
2. 如何写可编译、可测试的 JSON API；
3. 数据库、Redis、HTTP 上游和 CPU 重活应放在哪里；
4. 做 AI 网关时如何处理超时、上传、SSE 与客户端断连。

## 一、先理解 Drogon 为什么快

典型请求链路是：

```text
socket event
  -> I/O event loop
  -> route / middleware / filter
  -> handler 发起异步操作
  -> handler 立即把线程还给 event loop
  -> 数据库或上游完成
  -> callback 返回 HttpResponse
```

核心不是 C++ 语法，而是 handler 等待 I/O 时不占住线程。官方接口把 response callback 作为参数，就是让函数可以在异步操作完成后再响应。

### 三条必须遵守的规则

1. callback 最终应被调用一次；
2. 发起异步 I/O 后立即返回，不在 event loop 忙等；
3. callback 捕获的对象必须活到异步完成，避免悬空引用。

调用两次 callback 可能产生重复响应；忘记调用会让连接一直等待；用 `[&]` 捕获局部变量，函数返回后异步回调再访问，就会触发未定义行为。

## 二、最小可运行项目

沿用 CMake，不要求全局安装新工具。若项目已经通过 vcpkg、Conan、系统包或源码子模块提供 Drogon，应继续使用原方式。

```text
drogon_demo/
├── CMakeLists.txt
└── main.cc
```

### `CMakeLists.txt`

```cmake
cmake_minimum_required(VERSION 3.16)
project(drogon_demo LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(Drogon CONFIG REQUIRED)

add_executable(drogon_demo main.cc)
target_link_libraries(drogon_demo PRIVATE Drogon::Drogon)

if(MSVC)
    target_compile_options(drogon_demo PRIVATE /W4)
else()
    target_compile_options(drogon_demo PRIVATE -Wall -Wextra -Wpedantic)
endif()
```

### `main.cc`

```cpp
#include <drogon/drogon.h>

#include <charconv>
#include <functional>
#include <string>
#include <string_view>
#include <system_error>

namespace
{
using Callback =
    std::function<void(const drogon::HttpResponsePtr &)>;

drogon::HttpResponsePtr jsonError(
    drogon::HttpStatusCode status,
    std::string_view code,
    std::string_view message)
{
    Json::Value body;
    body["error"]["code"] = std::string{code};
    body["error"]["message"] = std::string{message};

    auto response = drogon::HttpResponse::newHttpJsonResponse(body);
    response->setStatusCode(status);
    return response;
}

bool parseInt(std::string_view text, int &value)
{
    if (text.empty())
    {
        return false;
    }
    const auto *begin = text.data();
    const auto *end = begin + text.size();
    const auto [next, error] = std::from_chars(begin, end, value);
    return error == std::errc{} && next == end;
}
}  // namespace

int main()
{
    using namespace drogon;

    app().registerHandler(
        "/health",
        [](const HttpRequestPtr &, Callback &&callback) {
            Json::Value body;
            body["status"] = "ok";
            callback(HttpResponse::newHttpJsonResponse(body));
        },
        {Get});

    app().registerHandler(
        "/api/v1/sum?left={left}&right={right}",
        [](const HttpRequestPtr &,
           Callback &&callback,
           const std::string &leftText,
           const std::string &rightText) {
            int left = 0;
            int right = 0;
            if (!parseInt(leftText, left) || !parseInt(rightText, right))
            {
                callback(jsonError(
                    k400BadRequest,
                    "INVALID_INTEGER",
                    "left and right must be integers"));
                return;
            }

            Json::Value body;
            body["left"] = left;
            body["right"] = right;
            body["result"] = left + right;
            callback(HttpResponse::newHttpJsonResponse(body));
        },
        {Get});

    app().addListener("127.0.0.1", 8080)
        .setThreadNum(2)
        .run();
}
```

这个示例刻意做了几件工程化小事：

- 默认只监听回环地址，避免学习服务意外暴露到局域网；
- 使用 `std::from_chars` 严格校验整数，`12x` 不会被当成 12；
- 所有错误采用同一 JSON 结构；
- 提前返回保证错误分支不会继续调用 callback；
- 编译器警告保持开启。

配置、构建和运行：

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel 2
./build/drogon_demo
```

最小验证：

```bash
curl -i http://127.0.0.1:8080/health
curl -i 'http://127.0.0.1:8080/api/v1/sum?left=3&right=5'
curl -i 'http://127.0.0.1:8080/api/v1/sum?left=3x&right=5'
```

构建命令限制并行度，避免在小机器上无界并行。若 Drogon 不在默认 CMake 搜索路径，应按项目现有包管理器传 toolchain/prefix，不要直接修改系统目录。

## 三、直接 handler 还是 Controller

`registerHandler()` 适合健康检查和很小的 demo。接口增多后使用 Controller 能把路由与实现分开。

### `HttpSimpleController`

适合单个或少量固定路径：

```cpp
#pragma once

#include <drogon/HttpSimpleController.h>

class PingController final
    : public drogon::HttpSimpleController<PingController>
{
  public:
    PATH_LIST_BEGIN
    PATH_ADD("/ping", drogon::Get);
    PATH_LIST_END

    void asyncHandleHttpRequest(
        const drogon::HttpRequestPtr &,
        std::function<void(const drogon::HttpResponsePtr &)> &&callback)
        override
    {
        Json::Value body;
        body["message"] = "pong";
        callback(drogon::HttpResponse::newHttpJsonResponse(body));
    }
};
```

### `HttpController`

适合一组 REST 接口：

```cpp
#pragma once

#include <drogon/HttpController.h>

namespace api::v1
{
class Users final : public drogon::HttpController<Users>
{
  public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(Users::getOne, "/api/v1/users/{id}", drogon::Get);
    METHOD_LIST_END

    void getOne(
        const drogon::HttpRequestPtr &,
        std::function<void(const drogon::HttpResponsePtr &)> &&callback,
        int userId) const
    {
        Json::Value body;
        body["id"] = userId;
        callback(drogon::HttpResponse::newHttpJsonResponse(body));
    }
};
}  // namespace api::v1
```

Controller 只应负责 HTTP 解析、调用 service、映射结果。SQL、上游重试、复杂事务和模型逻辑堆进 Controller，会让测试与错误处理迅速失控。

一个够用的目录结构是：

```text
src/
├── main.cc
├── controllers/
├── filters/
├── services/
└── repositories/
```

不要为了形式提前制造接口、工厂和适配器。只有业务确实变复杂时再分层。

## 四、什么代码会阻塞 event loop

下面的 handler 看起来简单，却会让当前 I/O 线程停 5 秒：

```cpp
app().registerHandler(
    "/bad",
    [](const drogon::HttpRequestPtr &,
       std::function<void(const drogon::HttpResponsePtr &)> &&callback) {
        std::this_thread::sleep_for(std::chrono::seconds{5});
        callback(drogon::HttpResponse::newHttpResponse());
    },
    {drogon::Get});
```

同类阻塞还包括：

- 同步 HTTP/SDK 调用；
- 大文件同步读写；
- 同步数据库驱动；
- `.get()` 等待 future；
- 大量压缩、图片解码和 PDF 解析；
- 本地模型推理；
- 长循环或锁竞争。

处理方式按任务类型选择：

- 数据库：用 Drogon async/coroutine API；
- HTTP 上游：用异步 `HttpClient`；
- 小型 CPU 工作：放到有界工作线程池，完成后回调；
- 重型/长任务：交给独立 worker 或模型服务，返回 202 + job ID；
- 交互式 LLM：调用支持动态 batching 与取消的专用推理服务。

把线程数从 4 调到 100 只会掩盖阻塞，还会增加内存与上下文切换，不是根治。

## 五、JSON 请求体必须做字段级校验

`getJsonObject()` 成功只代表 JSON 能解析，不代表业务合法：

```cpp
void createDocument(
    const drogon::HttpRequestPtr &request,
    std::function<void(const drogon::HttpResponsePtr &)> &&callback)
{
    const auto json = request->getJsonObject();
    if (!json || !json->isMember("title") || !(*json)["title"].isString())
    {
        callback(jsonError(
            drogon::k400BadRequest,
            "INVALID_BODY",
            "title must be a string"));
        return;
    }

    const auto title = (*json)["title"].asString();
    if (title.empty() || title.size() > 200)
    {
        callback(jsonError(
            drogon::k422UnprocessableEntity,
            "INVALID_TITLE",
            "title length must be between 1 and 200 bytes"));
        return;
    }

    Json::Value body;
    body["title"] = title;
    auto response = drogon::HttpResponse::newHttpJsonResponse(body);
    response->setStatusCode(drogon::k201Created);
    callback(response);
}
```

这里按 byte 限制只是示例。若产品要求“200 个 Unicode 字符”，需要明确 UTF-8 code point 或 grapheme 语义，不能把 `std::string::size()` 当成人类字符数。

还应限制 body 大小、数组长度、嵌套深度和未知字段策略。反序列化之后才拒绝超大请求，可能已经消耗大量内存，网关/框架层要先设置总体上限。

## 六、数据库查询应保持参数化和异步

不要拼接用户输入：

```cpp
const auto sql = "SELECT id, name FROM users WHERE id = " + userInput;
```

使用参数占位和 async callback：

```cpp
auto database = drogon::app().getDbClient();
auto respond = std::make_shared<
    std::function<void(const drogon::HttpResponsePtr &)>>(std::move(callback));
database->execSqlAsync(
    "SELECT id, name FROM users WHERE id = ?",
    [respond](const drogon::orm::Result &result) {
        if (result.empty())
        {
            (*respond)(jsonError(
                drogon::k404NotFound,
                "USER_NOT_FOUND",
                "user does not exist"));
            return;
        }

        Json::Value body;
        body["id"] = result[0]["id"].as<int>();
        body["name"] = result[0]["name"].as<std::string>();
        (*respond)(drogon::HttpResponse::newHttpJsonResponse(body));
    },
    [respond](const drogon::orm::DrogonDbException &error) {
        LOG_ERROR << "database query failed: " << error.base().what();
        (*respond)(jsonError(
            drogon::k500InternalServerError,
            "DATABASE_ERROR",
            "database operation failed"));
    },
    userId);
```

生产响应不应把 `error.base().what()` 原样返回给客户端，避免泄露 SQL、表结构和连接信息；详细错误写结构化日志，客户端拿稳定错误码和 request ID。

MySQL/MariaDB 与 PostgreSQL 的占位符风格可能不同，应按当前 Drogon database backend 文档使用。事务中的每一步也要使用同一 client/transaction 对象，不能在异步回调中随意换连接。

### 协程并不会让阻塞代码自动异步

C++20 `Task<>` 与 `execSqlCoro()` 能把回调写成顺序控制流，可读性更好。但在协程中调用同步文件 I/O 或 `sleep_for`，仍然会阻塞执行它的线程。协程是组织异步的语法，不是线程池。

## 七、异步代理上游服务

Drogon 做网关时，可用异步 `HttpClient` 调用 FastAPI 或模型服务：

```cpp
void proxyRequest(
    const drogon::HttpRequestPtr &request,
    std::function<void(const drogon::HttpResponsePtr &)> &&callback)
{
    auto client = drogon::HttpClient::newHttpClient(
        "http://127.0.0.1:8000");
    auto upstream = drogon::HttpRequest::newHttpRequest();
    upstream->setPath("/internal/tasks");
    upstream->setMethod(drogon::Post);
    upstream->setContentTypeCode(drogon::CT_APPLICATION_JSON);
    upstream->setBody(std::string{request->body()});

    client->sendRequest(
        upstream,
        [callback = std::move(callback)](
            drogon::ReqResult result,
            const drogon::HttpResponsePtr &response) mutable {
            if (result != drogon::ReqResult::Ok || !response)
            {
                callback(jsonError(
                    drogon::k502BadGateway,
                    "UPSTREAM_ERROR",
                    "upstream service is unavailable"));
                return;
            }
            callback(response);
        },
        5.0);
}
```

`sendRequest` 最后的 timeout 及具体重载应按项目锁定的 Drogon 版本核对。上游连接失败通常映射 502，网关等待超时映射 504；上游返回的 4xx/5xx 是否透传，应由明确协议决定。

### 代理时不能无脑复制一切

- 不转发 hop-by-hop header；
- 重新生成或传递受控的 request/trace ID；
- 只向可信上游传递必要身份信息；
- 限制请求/响应体；
- 设连接、读取和总 deadline；
- 重试只用于幂等请求或带幂等键的操作；
- 不把内部错误栈直接暴露给外部。

若网关、FastAPI 和模型服务各自都重试三次，一次请求可能放大为 27 次调用。应统一 retry budget，并把总 deadline 向下游传递。

## 八、上传文件最大的风险不是解析失败

使用 `MultiPartParser` 前先设计：

- 总 body 和单文件大小上限；
- 文件数量上限；
- 允许的 MIME/扩展名组合；
- 服务端生成的 object key；
- 路径规范化，禁止 `../`；
- 内容哈希与幂等键；
- 恶意文件扫描和隔离区；
- 上传中断后的临时文件清理；
- 谁能读取、删除和重新处理。

不要直接用 `getFileName()` 作为保存路径。原始文件名只适合经过转义后作为展示元数据。

AI 文档处理推荐流程：

```text
Drogon 接收并流式保存
  -> 写 document/job 业务记录
  -> 返回 202 + job_id
  -> 后台 worker 解析 / chunk / embedding
  -> 结果写业务存储
  -> 客户端查询或订阅状态
```

大 PDF 解析和 embedding 不应在上传 handler 里完成。

## 九、Filter、Middleware 与业务鉴权的边界

Filter 适合路由前拒绝请求，Middleware 适合围绕处理链统一观察或修改。常见职责：

- 身份认证；
- request ID 与结构化访问日志；
- CORS 与安全 header；
- body/速率限制；
- 统一错误映射；
- 延迟指标。

不要把 API key 写成源码常量。鉴权代码应读取安全配置，并使用项目的安全比较函数：

```cpp
const auto providedKey = request->getHeader("x-api-key");
if (secureCompare(providedKey, configuredApiKey))
{
    // 继续处理请求。
}
```

凭证应来自安全配置，日志中脱敏，比较方式与轮换策略按鉴权方案实现。Filter 通过后，业务层仍要做对象级授权，例如 tenant A 不能凭一个合法 token 读取 tenant B 的文档。

Session 依赖 Cookie，适合传统浏览器会话；水平扩容时要确认 session store、Cookie 的 Secure/HttpOnly/SameSite、过期和密钥轮换。无状态 API 常使用经过验证的 token，但同样需要撤销、权限与过期策略。

## 十、Redis 适合缓存，不应成为所有状态的替代品

Drogon 的异步 Redis client 可用于缓存、限流和短期状态。需要注意：

- key 要包含租户和版本；
- 设置 TTL 并定义缓存失效；
- cache miss 时防止大量请求击穿后端；
- 多命令原子性需要事务或 Lua；
- Redis 失败时明确 fail-open 还是 fail-closed；
- 不把长期审计和唯一事实只放缓存。

回调中同样不能执行重 CPU 工作。Redis 快不代表网络永远不超时，也应有错误指标和降级策略。

## 十一、SSE 代理为什么比普通 HTTP 代理难

LLM 常返回：

```text
data: {"delta":"hello"}

data: {"delta":" world"}

data: [DONE]

```

网关若先聚合完整 response 再返回，用户会一直看不到 token，还会让网关为每个请求缓存整段输出。

正确的流式代理需要：

1. 尽早返回 `text/event-stream` header；
2. 上游每到一块就写入下游并 flush；
3. 不对 SSE 做普通响应缓存或整包压缩缓冲；
4. 正确处理不完整 UTF-8、SSE 行与 JSON 跨 chunk；
5. 客户端断开时取消上游生成；
6. 设置 idle timeout、总 deadline 和心跳；
7. 处理背压，慢客户端不能无限积压内存。

Drogon 的 streaming API 在版本间可能变化，必须按项目当前版本的 response stream 示例实现并测试生命周期。不要把普通 `sendRequest()` 的完整响应回调误当作增量上游流。

### TCP chunk 不等于 SSE event

一次网络回调可能只含半个 `data:` 行，也可能包含多个 event。代理若需要解析或审计 SSE，必须维护增量 buffer；若只是透明转发，也要确保不会破坏字节顺序和取消语义。

## 十二、客户端断连后为什么必须取消上游

浏览器关闭页面后，如果网关仍让模型生成 2000 token：

- GPU 继续计费和占 KV Cache；
- 网关继续接收数据；
- 最终写入一个无人读取的连接；
- 高并发下形成“幽灵请求”。

应把下游连接生命周期与上游请求/任务的 cancellation 绑定。取消是协作式的：网关停止读取不一定让模型立即停止，内部协议要支持 request ID 与 cancel endpoint/信号。

## 十三、配置文件与敏感信息

配置文件适合 listeners、线程数、日志、连接池名称和非敏感上限：

```json
{
  "listeners": [
    {"address": "127.0.0.1", "port": 8080}
  ],
  "app": {
    "number_of_threads": 4,
    "client_max_body_size": "10M",
    "upload_path": "./runtime/uploads"
  }
}
```

数据库密码、Redis 凭证和 API key 不应提交进仓库。如何把秘密注入 Drogon 要遵循项目部署系统；不要为了方便把 `.env` 内容复制到 `config.json`。

配置加载失败应让服务启动失败，而不是使用不安全默认值。启动时记录配置版本和非敏感摘要，不打印凭证。

## 十四、Drogon 与 FastAPI/Celery 怎样分工

不必为了性能强行增加 Drogon。一个清晰的决策是：

| 场景 | 更自然的选择 |
| --- | --- |
| Python 模型/数据原型和内部 API | FastAPI |
| 长耗时、可重试后台任务 | Celery 或专用 worker |
| C++ 业务已有大量库、低延迟入口 | Drogon |
| 动态 batching 的 LLM 推理 | vLLM/SGLang 等专用服务 |
| 网关已有成熟 Envoy/Nginx/API Gateway | 优先复用，不必重写 |

当确实采用混合架构时：

```text
Client
  -> Drogon：TLS 后的入口治理、鉴权、限流、上传、流式代理
  -> FastAPI：Python 业务/模型接口
  -> Celery：文档处理、批量 embedding、离线任务
  -> Model Server：在线推理
```

每多一层都会增加延迟、故障点、协议和部署成本。只有职责与收益清晰时才引入，不要因为“C++ 更快”把简单系统拆成三套框架。

## 十五、错误码与 deadline 应端到端一致

网关常见映射：

| 情况 | HTTP 状态 |
| --- | ---: |
| 身份缺失/无效 | 401 |
| 已认证但无权限 | 403 |
| 请求体或参数非法 | 400 / 422 |
| body 超限 | 413 |
| 限流 | 429 |
| 上游连接/协议错误 | 502 |
| 上游超过 deadline | 504 |
| 服务主动过载 | 503 |

错误响应保持稳定：

```json
{
  "error": {
    "code": "UPSTREAM_TIMEOUT",
    "message": "upstream did not respond before the deadline",
    "request_id": "req-..."
  }
}
```

总 deadline 应由入口创建并逐层缩短。网关 5 秒、FastAPI 10 秒、模型服务 30 秒会导致网关放弃后下游仍做无用工作。

## 十六、测试不应只访问 `/health`

最小测试矩阵：

- 正常与非法路径/查询/JSON；
- 超大 body、多个文件和中断上传；
- 数据库/Redis 连接失败；
- 上游连接拒绝、超时、慢响应和非法响应；
- callback 各分支恰好返回一次；
- 客户端断连是否取消上游；
- SSE 半行、多事件、慢客户端和 `[DONE]`；
- 目标并发下 P50/P95/P99、错误率和内存；
- 服务停止时连接 drain 与未完成请求。

压测要同时观察 event loop 延迟、CPU、连接池等待和上游耗时。总延迟高不一定是 Drogon 慢，可能是连接池耗尽或上游排队。

## 十七、常见症状与排查

### 并发一高，所有接口一起慢

检查 handler/filter/middleware 是否有同步 I/O、CPU 重活、锁或 `.get()`；再看数据库/HTTP 连接池等待。不要先无脑加线程。

### 偶发崩溃，栈在异步 callback

检查捕获的局部引用、`this` 生命周期、callback move/copy 和跨线程对象安全。优先按值捕获小对象、用智能指针表达共享生命周期。

### 客户端一直 pending

检查某个错误分支是否忘记 callback、异常是否越过响应逻辑，以及上游请求是否没有 timeout。

### 返回过两次或出现奇怪连接错误

检查成功/失败回调是否都可能触发，是否调用 callback 后缺少 `return`，以及 timeout 与完成回调是否竞态。

### 上传把磁盘写满

检查 body/file 限制、临时文件清理、配额、对象存储失败补偿和无人认领文件扫描。

### SSE 首 token 很慢

确认网关没有缓冲完整响应，代理/压缩层未聚合，header 已及时发送；同时拆分上游 TTFT 与网关排队。

## 十八、一条务实的学习与落地路线

1. 用本文最小项目跑通 CMake、路由和 JSON；
2. 熟悉 Controller、参数校验和统一错误；
3. 用 async DbClient/HttpClient，禁止 event loop 阻塞；
4. 加 request ID、结构化日志、deadline 和指标；
5. 做上传大小/路径/权限安全；
6. 用故障注入验证上游超时和 callback 生命周期；
7. 真有流式需求再实现 SSE，并测试断连与背压；
8. 根据压测决定线程、连接池和是否需要 C++ 网关；
9. 重任务交给 worker，模型推理交给专用服务；
10. 保持架构最小，收益不足就不要增加一层。

## 官方资料

- [Drogon 官方仓库与 Quick Start](https://github.com/drogonframework/drogon)
- [Drogon Wiki](https://github.com/drogonframework/drogon/wiki)
- [Drogon：Installation](https://github.com/drogonframework/drogon/wiki/ENG-02-Installation)
- [Drogon：HttpController](https://github.com/drogonframework/drogon/wiki/ENG-04-2-Controller-HttpController)
- [Drogon：Middleware and Filter](https://github.com/drogonframework/drogon/wiki/ENG-05-Middleware-and-Filter)
- [Drogon：DbClient](https://github.com/drogonframework/drogon/wiki/ENG-08-1-Database-DbClient)
- [Drogon：Coroutines](https://github.com/drogonframework/drogon/wiki/ENG-17-Coroutines)
- [Drogon：Redis](https://github.com/drogonframework/drogon/wiki/ENG-18-Redis)

## 总结

Drogon 的高性能建立在异步 I/O 和 event loop 不被阻塞的前提上。真正可靠的 C++ Web 服务，不是把所有逻辑塞进 handler，而是严格控制 callback 生命周期、参数与 body、数据库和上游 deadline、上传安全、流式背压与客户端取消。

在 AI 系统中，Drogon 适合承担确有价值的 C++ 网络入口；文档处理交给后台 worker，在线模型交给专用 serving，Python 业务保留在 Python 生态。

一句话记住：

> 框架负责让等待变得异步，业务代码负责不把阻塞、失控生命周期和无界资源重新带回 event loop。
