---
title: "Drogon 学习笔记"
date: 2026-04-20 09:03:11
updated: 2026-04-20 09:03:11
categories:
  - "学习"
  - "AI模型开发"
  - "知识点学习"
  - "框架"
permalink: /notes/ai模型开发/知识点学习/框架/drogon/
---

# Drogon 学习笔记

## 1. Drogon 是什么

Drogon 是一个基于 C++ 的现代 Web 应用框架，适合用来开发：

- 高性能 HTTP API 服务
- C++ 网关服务
- 需要低延迟的业务接口
- WebSocket 服务
- 需要接 MySQL / PostgreSQL / Redis 的后端系统

它的几个核心特点：

- 性能高，底层是非阻塞 IO
- 支持异步编程
- 支持路由、控制器、过滤器、中间件
- 支持数据库、Redis、Session、文件上传
- 支持 HTTP Client，也能调用其他内部服务
- 支持 C++20 协程

如果先抓核心区别，可以这样记：FastAPI 更偏 Python 生态里的高效 API 框架，Drogon 则更像适合高性能 C++ 服务的全功能 Web 框架。

## 2. 为什么很多后端项目会用 Drogon

如果你的系统有这些特点：

- 接口并发高
- 对延迟敏感
- 业务层想用 C++ 实现
- 需要把网络、数据库、缓存、会话统一放在一个服务里

那 Drogon 会很合适。

尤其是在你现在这类 AI 项目架构里，Drogon 很适合承担：

- 对外 API 网关
- 会话和鉴权层
- 请求转发层
- MySQL 持久化层
- Redis 状态层

而 Python 生态仍然更适合承担：

- 模型推理
- 文档解析
- RAG 流程
- Celery 异步任务

因此，很多混合架构会拆成：

- Drogon：对外服务、状态治理、性能敏感层
- FastAPI：内部模型服务、任务接口
- Celery：后台异步执行

## 3. 安装和工程初始化

Drogon 的安装方式比 FastAPI 重一些，因为它是 C++ 框架，需要编译环境和依赖。

常见方式有：

- `vcpkg`
- 源码编译
- Docker

如果你想先快速上手，最常见的是源码安装：

```bash
git clone https://github.com/drogonframework/drogon.git
cd drogon
git submodule update --init
mkdir build
cd build
cmake ..
make -j4
sudo make install
```

安装完成后，通常还会有一个命令行工具：

```bash
drogon_ctl
```

它常用来：

- 创建项目骨架
- 创建 Controller
- 创建 Filter
- 生成 ORM Model

例如创建一个项目：

```bash
drogon_ctl create project demo
```

## 4. 最小可运行示例

和 FastAPI 的 `main.py` 一样，Drogon 也可以先从一个最小服务开始。

### 4.1 `CMakeLists.txt`

```cmake
cmake_minimum_required(VERSION 3.16)
project(drogon_demo)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Drogon CONFIG REQUIRED)

add_executable(${PROJECT_NAME} main.cc)
target_link_libraries(${PROJECT_NAME} PRIVATE Drogon::Drogon)
```

### 4.2 `main.cc`

```cpp
#include <drogon/drogon.h>

using namespace drogon;

int main()
{
    app().registerHandler(
        "/",
        [](const HttpRequestPtr &req,
           std::function<void(const HttpResponsePtr &)> &&callback) {
            Json::Value json;
            json["message"] = "hello drogon";
            callback(HttpResponse::newHttpJsonResponse(json));
        },
        {Get});

    app().addListener("0.0.0.0", 8080);
    app().setThreadNum(1);
    app().run();
}
```

编译和运行：

```bash
cmake -S . -B build
cmake --build build
./build/drogon_demo
```

访问：

- `http://127.0.0.1:8080/`

如果对照 FastAPI，可以这样看：

- `app = FastAPI()` 对应 `app()`
- `@app.get("/")` 对应 `registerHandler("/", ...)`
- `return {...}` 对应 `callback(HttpResponse::newHttpJsonResponse(...))`

## 5. Drogon 的基本工作方式

可以把一次请求理解成下面这条链路：

1. 客户端发来 HTTP 请求
2. Drogon 根据路径和方法匹配路由
3. 先经过中间件和过滤器
4. 进入 Handler 或 Controller 方法
5. 业务代码处理请求
6. 构造 `HttpResponse`
7. 通过 `callback` 返回给客户端

和 FastAPI 很像，但有一个非常重要的区别：

> Drogon 不会像 FastAPI 那样自动把 Python 函数返回值转成 JSON，你需要更显式地构造响应对象。

## 6. 直接注册 Handler

最简单的方式就是直接在 `main()` 里注册路由。

```cpp
app().registerHandler(
    "/health",
    [](const HttpRequestPtr &req,
       std::function<void(const HttpResponsePtr &)> &&callback) {
        Json::Value json;
        json["status"] = "ok";
        callback(HttpResponse::newHttpJsonResponse(json));
    },
    {Get});
```

适合：

- 学习阶段
- 很小的 demo
- 临时测试接口

但项目一大，通常更推荐 Controller。

## 7. 三种常见 Controller

Drogon 常见的控制器主要有三类：

- `HttpSimpleController`
- `HttpController`
- `WebSocketController`

### 7.1 `HttpSimpleController`

适合单个简单接口。

```cpp
#include <drogon/HttpSimpleController.h>

class Ping : public drogon::HttpSimpleController<Ping>
{
  public:
    PATH_LIST_BEGIN
    PATH_ADD("/ping", drogon::Get);
    PATH_LIST_END

    void asyncHandleHttpRequest(
        const drogon::HttpRequestPtr &req,
        std::function<void(const drogon::HttpResponsePtr &)> &&callback) override
    {
        Json::Value json;
        json["message"] = "pong";
        callback(drogon::HttpResponse::newHttpJsonResponse(json));
    }
};
```

### 7.2 `HttpController`

适合一组 REST 风格接口，功能更完整。

```cpp
#include <drogon/HttpController.h>

namespace api::v1
{
class User : public drogon::HttpController<User>
{
  public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(User::getUser, "/api/v1/users/{id}", drogon::Get);
    ADD_METHOD_TO(User::createUser, "/api/v1/users", drogon::Post);
    METHOD_LIST_END

    void getUser(
        const drogon::HttpRequestPtr &req,
        std::function<void(const drogon::HttpResponsePtr &)> &&callback,
        int id) const
    {
        Json::Value json;
        json["id"] = id;
        callback(drogon::HttpResponse::newHttpJsonResponse(json));
    }

    void createUser(
        const drogon::HttpRequestPtr &req,
        std::function<void(const drogon::HttpResponsePtr &)> &&callback) const
    {
        auto jsonPtr = req->getJsonObject();

        Json::Value json;
        json["name"] = jsonPtr ? (*jsonPtr)["name"].asString() : "";
        callback(drogon::HttpResponse::newHttpJsonResponse(json));
    }
};
}  // namespace api::v1
```

### 7.3 `WebSocketController`

适合：

- 实时聊天
- 实时协作
- 推送类业务

如果你后面要做双向实时通信，可以重点看这一类；如果只是 AI 输出流式结果，很多时候 SSE 就够了，不一定非要 WebSocket。

## 8. 路径参数、查询参数、JSON 请求体

这部分可以类比 FastAPI 的：

- 路径参数
- 查询参数
- 请求体

### 8.1 路径参数

在 Drogon 里，路径参数可以直接映射到函数参数。

```cpp
ADD_METHOD_TO(BookController::getBook, "/api/v1/books/{book_id}", drogon::Get);
```

对应的处理函数：

```cpp
void getBook(
    const drogon::HttpRequestPtr &req,
    std::function<void(const drogon::HttpResponsePtr &)> &&callback,
    int bookId) const;
```

放到 FastAPI 的语境里，大致对应：

```python
@app.get("/books/{book_id}")
def get_book(book_id: int):
    ...
```

### 8.2 查询参数

查询参数通常从 `req` 里读取：

```cpp
auto keyword = req->getParameter("keyword");
auto page = req->getParameter("page");
```

例如：

```text
/api/v1/search?keyword=llm&page=1
```

### 8.3 JSON 请求体

如果客户端发的是 JSON，请求体常见写法是：

```cpp
auto jsonPtr = req->getJsonObject();
if (!jsonPtr)
{
    auto resp = drogon::HttpResponse::newHttpResponse();
    resp->setStatusCode(drogon::k400BadRequest);
    callback(resp);
    return;
}

std::string name = (*jsonPtr)["name"].asString();
```

结论：

- 路径参数：函数参数映射
- 查询参数：`req->getParameter()`
- JSON 请求体：`req->getJsonObject()`

## 9. JSON 响应和状态码

Drogon 里最常见的响应方式是手动构造 JSON。

```cpp
Json::Value json;
json["message"] = "created";
json["id"] = 1001;

auto resp = drogon::HttpResponse::newHttpJsonResponse(json);
resp->setStatusCode(drogon::k201Created);
callback(resp);
```

这和 FastAPI 的差异在于：

- FastAPI 更自动
- Drogon 更显式

显式的好处是：

- 更清楚知道返回了什么
- 更方便做细粒度控制
- 更符合 C++ 项目风格

## 10. 配置文件 `config.json`

很多 Drogon 项目不会把所有配置都写死在 `main()` 里，而是放到配置文件。

最常见的主程序写法是：

```cpp
#include <drogon/drogon.h>

int main()
{
    drogon::app().loadConfigFile("config.json");
    drogon::app().run();
}
```

一个简化版配置示意：

```json
{
  "listeners": [
    {
      "address": "0.0.0.0",
      "port": 8080
    }
  ],
  "db_clients": [
    {
      "name": "default",
      "rdbms": "mysql",
      "host": "127.0.0.1",
      "port": 3306,
      "dbname": "demo",
      "user": "root",
      "passwd": "123456",
      "is_fast": false,
      "number_of_connections": 4
    }
  ],
  "redis_clients": [
    {
      "name": "default",
      "host": "127.0.0.1",
      "port": 6379,
      "number_of_connections": 2
    }
  ],
  "app": {
    "number_of_threads": 4,
    "enable_session": true,
    "upload_path": "uploads",
    "client_max_body_size": "50M"
  }
}
```

这里最重要的点是：

- `listeners`：监听地址和端口
- `db_clients`：数据库连接
- `redis_clients`：Redis 连接
- `app`：线程数、Session、上传路径等全局设置

## 11. 过滤器和中间件

这部分很像 FastAPI 的依赖、鉴权逻辑、中间件，但 Drogon 拆得更明确。

简单理解：

- Filter：更像“接口前置校验”
- Middleware：更像“围绕请求处理链做前后处理”

例如做一个简单鉴权 Filter：

```cpp
#include <drogon/HttpFilter.h>

class AuthFilter : public drogon::HttpFilter<AuthFilter>
{
  public:
    void doFilter(const drogon::HttpRequestPtr &req,
                  FilterCallback &&fcb,
                  FilterChainCallback &&fccb) override
    {
        auto token = req->getHeader("x-api-key");
        if (token != "secret")
        {
            Json::Value json;
            json["error"] = "unauthorized";

            auto resp = drogon::HttpResponse::newHttpJsonResponse(json);
            resp->setStatusCode(drogon::k401Unauthorized);
            fcb(resp);
            return;
        }

        fccb();
    }
};
```

挂到某个接口上：

```cpp
ADD_METHOD_TO(User::getUser, "/api/v1/users/{id}", drogon::Get, "AuthFilter");
```

适合抽出来做的逻辑通常有：

- 登录校验
- API Key 校验
- 频率限制
- 内网访问限制
- 统一日志

## 12. Session

Drogon 内置了 Session 支持，但默认不是强制开启的。

它适合做：

- 登录态
- 短期会话数据
- 访问频率控制
- 一些轻量服务端状态

开启方式可以在配置文件里写：

```json
{
  "app": {
    "enable_session": true
  }
}
```

或者代码里显式开启：

```cpp
drogon::app().enableSession(1200);
```

使用示例：

```cpp
req->session()->insert("user_id", 1001);

if (req->session()->find("user_id"))
{
    auto userId = req->session()->get<int>("user_id");
}
```

注意：

> Session 依赖 Cookie。如果客户端不保存 Cookie，每次请求都可能被当成新会话。

## 13. 文件上传

在 AI 项目里，文件上传非常常见，比如：

- 上传 PDF
- 上传图片
- 上传音频
- 上传数据文件

Drogon 常用 `MultiPartParser` 来处理 multipart 上传。

```cpp
#include <drogon/drogon.h>

void upload(const drogon::HttpRequestPtr &req,
            std::function<void(const drogon::HttpResponsePtr &)> &&callback)
{
    drogon::MultiPartParser parser;
    if (parser.parse(req) != 0 || parser.getFiles().empty())
    {
        Json::Value json;
        json["error"] = "no file";

        auto resp = drogon::HttpResponse::newHttpJsonResponse(json);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    auto file = parser.getFiles()[0];
    file.save("./uploads");

    Json::Value json;
    json["filename"] = file.getFileName();
    auto resp = drogon::HttpResponse::newHttpJsonResponse(json);
    callback(resp);
}
```

实际项目里要特别注意：

- 不要直接信任原始文件名
- 要限制文件大小
- 要校验扩展名和 MIME 类型
- 最好自己生成保存文件名

对于 AI 系统，更推荐的流程通常是：

1. Drogon 接收上传
2. 保存到磁盘或对象存储
3. 写一条数据库记录
4. 调内部 FastAPI / Celery 提交处理任务

## 14. 数据库访问：`DbClient` 和 ORM

Drogon 自带数据库支持，常见关系型数据库包括：

- MySQL
- PostgreSQL
- SQLite3

最常见的是通过 `DbClient` 执行 SQL。

```cpp
auto client = drogon::app().getDbClient();

client->execSqlAsync(
    "select id, name from users where id = ?",
    [callback](const drogon::orm::Result &result) {
        Json::Value json;

        if (result.empty())
        {
            json["error"] = "not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(json);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }

        json["id"] = result[0]["id"].as<int>();
        json["name"] = result[0]["name"].as<std::string>();
        callback(drogon::HttpResponse::newHttpJsonResponse(json));
    },
    [callback](const drogon::orm::DrogonDbException &e) {
        Json::Value json;
        json["error"] = e.base().what();
        auto resp = drogon::HttpResponse::newHttpJsonResponse(json);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    },
    1001);
```

要点：

- MySQL 占位符通常用 `?`
- PostgreSQL 占位符通常用 `$1`、`$2`
- 异步接口更符合 Drogon 的整体风格
- 不要在回调里做很重的阻塞操作

如果你不想手写太多 SQL，还可以用 `drogon_ctl` 根据表结构生成 ORM Model。

适合：

- 表结构比较稳定
- 想减少手写样板代码
- 想把数据库访问写得更结构化

## 15. Redis 支持

Drogon 也支持 Redis，而且同样是异步风格。

如果已经在 `config.json` 里配置了 `redis_clients`，运行后就可以获取客户端：

```cpp
auto redisClient = drogon::app().getRedisClient();
```

执行命令示例：

```cpp
redisClient->execCommandAsync(
    [](const drogon::nosql::RedisResult &r) {
        LOG_INFO << "redis ok: " << r.asString();
    },
    [](const std::exception &err) {
        LOG_ERROR << "redis error: " << err.what();
    },
    "get session:%s",
    "1001");
```

它适合做：

- 缓存
- 任务状态存储
- 限流计数器
- 会话辅助状态
- 流式输出中间层

如果把你现在的整条链路连起来理解，就是：

- Drogon：对外接口
- Redis：缓存 / 状态 / 消息中间层
- FastAPI / Celery：后台处理

## 16. C++20 协程 `Task<>`

如果你用的是较新的编译器，Drogon 支持协程，这可以让异步代码更接近同步写法。

例如数据库查询可以写成：

```cpp
#include <drogon/drogon.h>

drogon::Task<drogon::HttpResponsePtr> getUserCoro(int userId)
{
    auto db = drogon::app().getDbClient();

    try
    {
        auto result = co_await db->execSqlCoro(
            "select id, name from users where id = ?",
            userId);

        Json::Value json;
        json["id"] = result[0]["id"].as<int>();
        json["name"] = result[0]["name"].as<std::string>();
        co_return drogon::HttpResponse::newHttpJsonResponse(json);
    }
    catch (const drogon::orm::DrogonDbException &e)
    {
        Json::Value json;
        json["error"] = e.base().what();
        auto resp = drogon::HttpResponse::newHttpJsonResponse(json);
        resp->setStatusCode(drogon::k500InternalServerError);
        co_return resp;
    }
}
```

它的好处是：

- 少写回调嵌套
- 控制流更清晰
- 复杂异步逻辑更好维护

但你要注意：

- 需要合适的编译器和 C++20 支持
- 协程让代码更好写，不代表可以随便阻塞线程

## 17. Drogon 和 FastAPI 怎么选

这两个框架不是简单的“谁替代谁”，而是各自适合不同层。

| 维度 | Drogon | FastAPI |
| --- | --- | --- |
| 语言 | C++ | Python |
| 性能 | 更高，适合性能敏感层 | 足够高，开发更快 |
| 开发效率 | 相对慢一些 | 很高 |
| 参数校验 | 需要自己控制更多细节 | 自动化更强 |
| 生态 | 系统层、服务层强 | AI、数据、模型生态强 |
| 适合位置 | 网关、核心服务、低延迟接口 | 模型服务、管理后台、内部 API |

如果只抓结论，可以这样选：

- 想更快把模型接口和内部服务跑起来，用 FastAPI
- 想把网关、状态治理和性能敏感层放在 C++ 里，用 Drogon

## 18. Drogon + FastAPI + Celery 的典型配合方式

这是你当前项目最值得掌握的一块。

一个典型流程可以这样拆：

1. 客户端请求先到 Drogon
2. Drogon 做鉴权、Session、参数检查、落库
3. Drogon 调用内部 FastAPI 接口提交任务
4. FastAPI 再把重任务交给 Celery
5. Celery Worker 真正处理文档、推理、索引构建
6. 结果写回 MySQL / Redis
7. Drogon 再把状态或结果返回给前端

你可以把它们理解成固定分工：

- Drogon：网关和业务编排层
- FastAPI：Python 服务入口
- Celery：后台任务执行层
- Redis：状态、缓存、队列中间层
- MySQL：长期持久化

这套架构特别适合：

- 文档上传处理
- RAG 建库
- 长耗时模型推理
- 流式输出聊天系统

## 19. 一个比较常见的项目结构

如果用 Drogon 做 C++ 网关，一个比较实用的结构可以是：

```text
cpp_gateway/
├── CMakeLists.txt
├── config.json
├── main.cc
├── controllers/
│   ├── HealthController.h
│   ├── HealthController.cc
│   ├── DocumentsController.h
│   └── DocumentsController.cc
├── filters/
│   ├── AuthFilter.h
│   └── AuthFilter.cc
├── services/
│   ├── TaskService.h
│   ├── TaskService.cc
│   ├── PythonClient.h
│   └── PythonClient.cc
├── repositories/
│   ├── DocumentRepo.h
│   └── DocumentRepo.cc
└── models/
```

建议职责划分：

- `controllers/`：只处理 HTTP 层
- `filters/`：鉴权、限流、前置校验
- `services/`：业务编排、调内部服务
- `repositories/`：数据库读写
- `models/`：ORM 生成模型或业务数据结构

也就是说：

> 不要把所有逻辑都堆在 Controller 里。

## 20. 常见坑

### 20.1 在 Handler 里做阻塞重活

例如：

- 大文件解析
- 模型推理
- 长时间等待第三方服务

这些都不应该直接堵在 Drogon 的请求处理线程里。

更合理的做法是：

- Drogon 负责接请求
- 重活交给 FastAPI / Celery

### 20.2 误以为性能高就应该把所有东西都写进 C++

不是。

对于 AI 项目：

- 模型生态、向量库、文档处理库，大部分都在 Python 侧更成熟
- Drogon 更适合做高性能 API 和状态治理

### 20.3 忽视文件上传安全

例如：

- 直接使用原始文件名保存
- 不限制 body 大小
- 不校验扩展名

这在上传接口里很危险。

### 20.4 Session 开了但客户端不带 Cookie

这样会导致服务端不断创建新 Session，白白浪费资源。

### 20.5 数据库回调里继续做阻塞操作

这会拖慢整个异步链路。

### 20.6 Controller 过胖

如果 Controller 里同时写：

- 参数解析
- SQL
- Redis
- 调内部 HTTP
- 业务编排

后面会非常难维护。

## 21. 一套比较实用的学习顺序

如果你是为了做 AI 项目里的 C++ 网关，推荐这样学：

1. 先跑通最小 Drogon 服务
2. 学会 `registerHandler()` 和 `HttpController`
3. 学会 JSON 请求和响应
4. 学会 `config.json`
5. 学会 Filter 和 Session
6. 学会文件上传
7. 学会 `DbClient` 和 Redis
8. 最后再接 FastAPI 和 Celery

## 22. 总结

Drogon 的核心价值在于：

- 用 C++ 写高性能 Web 服务
- 把 HTTP、数据库、Redis、Session、文件上传放到一套框架里
- 适合做网关层、业务层、低延迟接口层

对于 AI 项目，可以把它理解成：

- 对外 API 入口
- 会话治理层
- 状态协调层
- 数据持久化入口
- 调用 Python 服务的编排层

如果你把前面几份笔记连起来看，可以把它们理解成一条链：

- Drogon：对外网关 / C++ 服务层
- FastAPI：Python API 层
- Redis：缓存 / 状态 / 中间层
- Celery：后台异步任务层
- MySQL：持久化数据层

## 23. 参考

- Drogon GitHub: https://github.com/drogonframework/drogon
- Drogon Wiki: https://github.com/drogonframework/drogon/wiki
- Drogon Overview: https://github.com/drogonframework/drogon/wiki/ENG-01-Overview
- Drogon Installation: https://github.com/drogonframework/drogon/wiki/ENG-02-Installation
- Drogon HttpController: https://github.com/drogonframework/drogon/wiki/ENG-04-2-Controller-HttpController
- Drogon Middleware and Filter: https://github.com/drogonframework/drogon/wiki/ENG-05-Middleware-and-Filter
- Drogon Session: https://github.com/drogonframework/drogon/wiki/ENG-07-Session
- Drogon DbClient: https://github.com/drogonframework/drogon/wiki/ENG-08-1-Database-DbClient
- Drogon ORM: https://github.com/drogonframework/drogon/wiki/ENG-08-3-Database-ORM
- Drogon File Handler: https://github.com/drogonframework/drogon/wiki/ENG-09-1-File-Handler
- Drogon Configuration File: https://github.com/drogonframework/drogon/wiki/ENG-11-Configuration-File
- Drogon drogon_ctl: https://github.com/drogonframework/drogon/wiki/ENG-12-drogon_ctl-Command
- Drogon Coroutines: https://github.com/drogonframework/drogon/wiki/ENG-17-Coroutines
- Drogon Redis: https://github.com/drogonframework/drogon/wiki/ENG-18-Redis
