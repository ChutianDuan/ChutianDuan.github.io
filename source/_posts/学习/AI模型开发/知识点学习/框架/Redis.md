---
title: "Redis 学习笔记"
date: 2026-05-03 16:14:45
updated: 2026-05-03 16:14:45
categories:
  - "学习"
  - "AI模型开发"
  - "知识点学习"
  - "框架"
permalink: /notes/ai模型开发/知识点学习/框架/redis/
---

# Redis 学习笔记

## 1. Redis 是什么

Redis 是一个高性能的内存型键值数据库，常被用来做：

- 缓存
- 会话存储
- 计数器
- 排行榜
- 消息队列
- 分布式锁
- Celery 的 Broker / Result Backend

先把分工记住：MySQL 更适合放长期、结构化、需要稳定查询的数据，Redis 更适合放高频访问、生命周期短、对速度敏感的数据。

## 2. 为什么项目里经常会有 Redis

很多系统里都会遇到这些问题：

- 某些数据访问特别频繁
- 接口需要很快返回
- 需要临时状态，不想每次都查数据库
- 需要做限流、验证码、会话缓存
- 需要一个轻量消息通道

这时候 Redis 很适合。

因为它的特点是：

- 读写快
- 支持多种数据结构
- 支持过期时间
- 支持原子操作
- 既能做缓存，也能做简单消息系统

## 3. 在 AI 项目里 Redis 常见用法

在 AI 模型开发场景里，Redis 很常见：

- 缓存热点查询结果
- 缓存用户会话上下文
- 给 Celery 当 Broker
- 给 Celery 当任务结果存储
- 存任务状态、进度、短期中间结果
- 做限流
- 用 Streams 传递流式输出 token

和你前面整理的两份笔记连起来理解：

- FastAPI：接请求
- Redis：缓存 / 排队 / 状态层
- Celery：异步处理后台任务

## 4. Redis 和 MySQL 的区别

可以这样对比理解：

| 维度 | Redis | MySQL |
| --- | --- | --- |
| 数据类型 | 键值型，支持多种结构 | 关系型表结构 |
| 访问速度 | 很快，主要基于内存 | 相对慢一些，主要基于磁盘 |
| 适合场景 | 缓存、短期状态、计数、队列 | 长期存储、强结构化数据 |
| 查询方式 | 按 key 取值为主 | SQL 查询 |
| 持久化重点 | 可选持久化，但常用于高频临时数据 | 天生适合长期持久化 |

简单理解：

- 用户资料、订单、文档元数据更适合 MySQL
- 验证码、登录态、缓存结果、限流计数更适合 Redis

## 5. 安装和启动

如果本地已经装好了 Redis，可以直接启动服务。

常见方式：

```bash
redis-server
```

如果只是临时学习，也可以用 Docker：

```bash
docker run -d --name redis -p 6379:6379 redis:7
```

测试服务是否正常：

```bash
redis-cli ping
```

如果返回：

```text
PONG
```

说明 Redis 正常启动。

## 6. Python 连接 Redis

Python 项目里最常用的是 `redis-py`。

安装：

```bash
pip install redis
```

最基础的连接方式：

```python
import redis

r = redis.Redis(
    host="127.0.0.1",
    port=6379,
    db=0,
    decode_responses=True,
)

r.set("name", "tom")
print(r.get("name"))
```

说明：

- `db=0` 表示使用第 0 个逻辑库
- `decode_responses=True` 表示自动把结果解码为字符串

如果不加 `decode_responses=True`，很多结果会是 `bytes`。

## 7. Redis 的基本概念

Redis 里最核心的概念就是：

- key
- value

所有数据都以 `key -> value` 的形式存储。

例如：

```text
user:1:name -> tom
task:123:status -> SUCCESS
cache:article:100 -> {...}
```

实际项目里非常重要的一点是：

> key 命名要有规则。

常见命名方式：

- `user:1001`
- `session:token:abc123`
- `task:ingest:001`
- `cache:query:hash_xxx`

这样后续排查和维护会清晰很多。

### 7.1 逻辑库 `db`

Redis 默认会提供多个逻辑库，常见写法里的：

- `db=0`
- `redis://127.0.0.1:6379/1`
- `redis://127.0.0.1:6379/2`

这里最后的数字就是逻辑库编号。

它常用于做基础隔离，例如：

- `0`：普通缓存
- `1`：Celery broker
- `2`：Celery backend

不过要注意：

> 逻辑库只是“轻隔离”，不是严格意义上的多实例隔离。

如果项目越来越复杂，真正需要资源隔离、权限隔离、性能隔离时，通常还是会考虑拆 Redis 实例。

## 8. 常用通用命令

### 8.1 设置和获取

```bash
SET name tom
GET name
```

### 8.2 判断是否存在

```bash
EXISTS name
```

### 8.3 删除

```bash
DEL name
```

### 8.4 查看过期时间

```bash
TTL name
```

### 8.5 给 key 设置过期

```bash
EXPIRE name 60
```

表示 60 秒后过期。

### 8.6 直接带过期时间写入

```bash
SET code 123456 EX 300
```

表示写入验证码，并在 300 秒后自动过期。

### 8.7 查看库里的 key

学习阶段常见命令：

```bash
KEYS *
```

但要注意：

> `KEYS *` 适合本地调试，不适合在线上大库里频繁使用。

更稳妥的方式通常是：

```bash
SCAN 0 MATCH user:* COUNT 100
```

`SCAN` 更适合在数据量较大时逐步遍历。

## 9. Redis 的核心数据结构

Redis 不只是简单字符串，它支持很多数据结构。这个是 Redis 很有价值的地方。

最常用的有：

- String
- Hash
- List
- Set
- Sorted Set
- Stream

## 10. String

这是 Redis 最基础、最常用的数据类型。

适合：

- 普通缓存
- 验证码
- token
- JSON 字符串
- 计数器

### 10.1 基本命令

```bash
SET username alice
GET username
```

### 10.2 自增计数

```bash
SET page_views 0
INCR page_views
INCRBY page_views 5
```

这类操作很适合：

- 接口访问次数统计
- 点赞数
- 限流计数

### 10.3 Python 示例

```python
import redis

r = redis.Redis(host="127.0.0.1", port=6379, db=0, decode_responses=True)

r.set("article:1:title", "Redis Intro")
title = r.get("article:1:title")

r.set("counter:views", 0)
r.incr("counter:views")
```

## 11. Hash

Hash 就是一个 key 下挂多组 field-value。

适合：

- 用户对象
- 配置项
- 文档元信息
- 任务状态对象

### 11.1 基本命令

```bash
HSET user:1 name tom age 18 city shanghai
HGET user:1 name
HGETALL user:1
```

### 11.2 为什么 Hash 很常用

因为很多业务对象天然就是字段结构，比如：

```text
user:1
  name -> tom
  age -> 18
  city -> shanghai
```

相比把整个对象都塞进一个 JSON 字符串里，Hash 在局部更新字段时更方便。

### 11.3 Python 示例

```python
r.hset("user:1", mapping={"name": "tom", "age": 18, "city": "shanghai"})
user = r.hgetall("user:1")
```

## 12. List

List 是有序列表。

适合：

- 简单消息队列
- 待处理任务列表
- 最近操作记录

### 12.1 基本命令

```bash
LPUSH queue:tasks task1
LPUSH queue:tasks task2
RPOP queue:tasks
```

直观一点看，就是：

- 左边入队
- 右边出队

### 12.2 阻塞读取

```bash
BLPOP queue:tasks 0
```

表示如果队列为空就阻塞等待。

这可以做一个很简单的消费者模型，但它更适合轻量场景，不适合复杂消费确认机制。

### 12.3 使用建议

List 可以做简单队列，但如果项目要：

- 消费组
- 确认机制
- 多消费者协作
- 更强的消息语义

通常会考虑：

- Redis Streams
- RabbitMQ
- Kafka

## 13. Set

Set 是无序且元素唯一的集合。

适合：

- 去重
- 标签集合
- 记录某用户已点赞哪些内容
- 共同好友 / 共同标签等集合计算

### 13.1 基本命令

```bash
SADD tags:article:1 redis python database
SMEMBERS tags:article:1
SISMEMBER tags:article:1 redis
```

### 13.2 集合运算

```bash
SADD set1 a b c
SADD set2 b c d
SINTER set1 set2
SUNION set1 set2
SDIFF set1 set2
```

这对“标签交集、权限集合、去重集合”这类场景非常方便。

## 14. Sorted Set

Sorted Set 是带分数、可排序的集合。

适合：

- 排行榜
- 按时间排序的数据
- 按热度排序的数据

### 14.1 基本命令

```bash
ZADD ranking 100 tom 95 alice 88 bob
ZRANGE ranking 0 -1
ZREVRANGE ranking 0 -1
ZSCORE ranking tom
```

这里每个成员都有一个 score。

### 14.2 场景理解

例如文章热度榜：

- `article:100 -> 200`
- `article:101 -> 150`
- `article:102 -> 320`

就可以按 score 排序快速拿到前 N 名。

## 15. Stream

Streams 是 Redis 较强的一类消息结构。

适合：

- 事件流
- 多消费者消费
- 流式 token 传递
- 日志型消息

在 AI 项目里，它很适合做：

- Worker 持续写出 token
- Gateway / FastAPI 持续消费 token
- 流式返回给前端

### 15.1 基本命令

写入：

```bash
XADD chat:stream:1 * token hello
```

读取：

```bash
XREAD COUNT 10 STREAMS chat:stream:1 0
```

### 15.2 消费组

如果是多个消费者协作，可以用消费组：

```bash
XGROUP CREATE chat:stream:1 group1 0 MKSTREAM
XREADGROUP GROUP group1 consumer1 COUNT 10 STREAMS chat:stream:1 >
```

### 15.3 为什么 Streams 比 List 更适合流式场景

因为它支持：

- 消息 ID
- 消费组
- 待确认消息
- 更像日志流的结构

如果后面你做：

- SSE
- token 流输出
- 异步处理链路

Streams 会比简单 List 更稳一些。

## 16. 过期时间和 TTL

Redis 很核心的一点就是支持 key 过期。

这在缓存场景里非常重要。

### 16.1 设置过期

```bash
SET session:token:abc user_1 EX 3600
```

表示 1 小时后自动过期。

### 16.2 查看剩余时间

```bash
TTL session:token:abc
```

### 16.3 为什么过期时间很重要

因为很多数据本来就不该永久保存，例如：

- 登录态
- 验证码
- 缓存结果
- 限流计数
- 任务中间状态

如果不设置过期时间，Redis 很容易越堆越大。

## 17. 持久化

Redis 虽然主要是内存数据库，但也支持持久化。

常见方式：

- RDB
- AOF

### 17.1 RDB

它更像是按时间点保存一份内存快照。

特点：

- 文件紧凑
- 恢复快
- 更适合定期备份

### 17.2 AOF

它的思路是把写命令按顺序追加记录下来。

特点：

- 数据恢复通常更完整
- 文件可能更大
- 更强调操作日志式恢复

### 17.3 怎么理解

如果 Redis 里只是放缓存，丢了还能重建，那持久化要求没那么高。

如果 Redis 里存了：

- 任务状态
- 流式消息
- 某些关键临时业务状态

那就要更认真考虑持久化策略。

## 18. Pub/Sub

Redis 还支持发布订阅。

基本命令：

```bash
SUBSCRIBE news
PUBLISH news "hello"
```

适合：

- 简单实时通知
- 临时消息广播

但它有一个明显特点：

> 如果订阅者不在线，消息一般不会帮你补回来。

所以在很多需要“可回放、可追踪”的场景里，Streams 通常比 Pub/Sub 更合适。

## 19. 事务和 Lua

Redis 也支持事务和 Lua 脚本。

### 19.1 事务

基本写法：

```bash
MULTI
SET key1 value1
INCR counter
EXEC
```

适合把一组命令放在一起执行。

### 19.2 Lua 脚本

Lua 常用于：

- 多命令原子操作
- 分布式锁安全释放
- 把多个步骤封装成一个服务端操作

在实际项目里，Lua 经常是为了解决“先判断再删除”这种竞态问题。

## 20. 分布式锁

Redis 常被用来做分布式锁。

最常见写法是：

```bash
SET lock:task_1 request_abc NX EX 30
```

含义：

- `NX`：只有 key 不存在时才设置成功
- `EX 30`：30 秒后自动过期

如果返回成功，就表示拿到了锁。

### 20.1 为什么需要过期时间

因为如果加锁后进程挂了，没有过期时间的话，锁就可能一直不释放。

### 20.2 为什么不能直接 `DEL`

因为可能出现这种情况：

1. 线程 A 拿到锁
2. 锁过期
3. 线程 B 拿到同名新锁
4. 线程 A 这时候再执行 `DEL`
5. 把线程 B 的锁删掉了

所以更安全的做法是：

- 加锁时写入唯一值
- 解锁时先判断 value 是否还是自己的
- 判断和删除要放在一个原子操作里，通常用 Lua

### 20.3 Python 示例

```python
import uuid

import redis

r = redis.Redis(host="127.0.0.1", port=6379, db=0, decode_responses=True)

lock_key = "lock:task:1"
lock_value = str(uuid.uuid4())

locked = r.set(lock_key, lock_value, nx=True, ex=30)

if locked:
    try:
        print("do something")
    finally:
        unlock_script = """
        if redis.call('GET', KEYS[1]) == ARGV[1] then
            return redis.call('DEL', KEYS[1])
        else
            return 0
        end
        """
        r.eval(unlock_script, 1, lock_key, lock_value)
```

## 21. 缓存是 Redis 最常见的用途

### 21.1 最简单的缓存思路

先查 Redis：

- 有数据就直接返回
- 没数据再查数据库或调用模型服务
- 查到结果后再写回 Redis

这就是最常见的缓存模式。

### 21.2 Python 示例

```python
import json

import redis

r = redis.Redis(host="127.0.0.1", port=6379, db=0, decode_responses=True)

def get_article(article_id: int):
    cache_key = f"article:{article_id}"
    cached = r.get(cache_key)
    if cached:
        return json.loads(cached)

    data = {"id": article_id, "title": "Redis Intro"}
    r.set(cache_key, json.dumps(data), ex=300)
    return data
```

### 21.3 缓存设计里要注意什么

- 一定要设计 TTL
- 不要无脑缓存超大对象
- key 命名要稳定
- 更新数据库时要考虑缓存同步

## 22. 缓存穿透、击穿、雪崩

这是 Redis 学习里很常见的三个词。

### 22.1 缓存穿透

请求的数据本来就不存在：

- Redis 没有
- 数据库也没有
- 每次都打到后端

常见处理：

- 参数校验
- 对空结果也做短期缓存
- 布隆过滤器

### 22.2 缓存击穿

某个热点 key 失效瞬间，大量请求同时打到后端。

常见处理：

- 热点 key 不要同时过期
- 加锁重建缓存
- 提前刷新

### 22.3 缓存雪崩

大量 key 在同一时间过期，导致后端压力暴涨。

常见处理：

- TTL 加随机值
- 分批过期
- 多级缓存

## 23. 限流

Redis 很适合做接口限流，因为：

- `INCR` 是原子操作
- 配合 TTL 很方便

### 23.1 最简单的固定窗口限流

思路：

1. 某个用户请求一次就 `INCR`
2. 第一次请求时设置过期时间
3. 超过阈值就拒绝

Python 示例：

```python
import redis

r = redis.Redis(host="127.0.0.1", port=6379, db=0, decode_responses=True)

def allow_request(user_id: str, limit: int = 10, window: int = 60) -> bool:
    key = f"rate_limit:{user_id}"
    current = r.incr(key)
    if current == 1:
        r.expire(key, window)
    return current <= limit
```

这个模式在：

- 登录接口
- 短信发送
- AI 推理调用

都很常见。

## 24. Session / 登录态

Redis 也经常用来存登录态或短期会话。

例如：

```text
session:token:abc123 -> user_id=1001
```

然后设置：

```bash
EXPIRE session:token:abc123 3600
```

这样用户 1 小时不活跃就自动失效。

## 25. FastAPI 里怎么用 Redis

FastAPI 项目里，Redis 常见用途有：

- 缓存接口结果
- 存验证码
- 存 session
- 做限流
- 存短期任务状态

### 25.1 一个简单缓存例子

这里用 `redis.asyncio` 更符合 FastAPI 的异步风格。

```python
import json

from fastapi import FastAPI
from redis.asyncio import Redis

app = FastAPI()

redis_client = Redis(
    host="127.0.0.1",
    port=6379,
    db=0,
    decode_responses=True,
)

@app.get("/articles/{article_id}")
async def get_article(article_id: int):
    cache_key = f"article:{article_id}"
    cached = await redis_client.get(cache_key)
    if cached:
        return json.loads(cached)

    data = {"id": article_id, "title": "Redis Intro"}
    await redis_client.set(cache_key, json.dumps(data), ex=300)
    return data
```

补充：

- `redis.asyncio` 更适合异步接口
- 正式项目里通常会统一封装 Redis 客户端
- 服务关闭时最好把客户端连接关闭掉

### 25.2 一个简单限流例子

```python
from fastapi import FastAPI, HTTPException, Request
from redis.asyncio import Redis

app = FastAPI()
redis_client = Redis(host="127.0.0.1", port=6379, db=0, decode_responses=True)

@app.get("/infer")
async def infer(request: Request):
    client_ip = request.client.host
    key = f"rate_limit:{client_ip}"

    current = await redis_client.incr(key)
    if current == 1:
        await redis_client.expire(key, 60)

    if current > 20:
        raise HTTPException(status_code=429, detail="too many requests")

    return {"message": "ok"}
```

### 25.3 生命周期里管理 Redis 客户端

如果项目规模再大一点，通常会把 Redis 放到 FastAPI 生命周期里初始化和关闭。

```python
from contextlib import asynccontextmanager

from fastapi import FastAPI
from redis.asyncio import Redis

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.redis = Redis(
        host="127.0.0.1",
        port=6379,
        db=0,
        decode_responses=True,
    )
    yield
    await app.state.redis.aclose()

app = FastAPI(lifespan=lifespan)
```

这样做的好处：

- 连接初始化位置统一
- 更方便复用
- 关闭服务时能正常释放资源

## 26. Celery 为什么经常配 Redis

你在 `Celery.md` 里已经接触到了这一点。

Redis 在 Celery 里通常可以做两件事：

- Broker：存待执行任务消息
- Result Backend：存任务状态和结果

示例：

```python
from celery import Celery

app = Celery(
    "demo",
    broker="redis://127.0.0.1:6379/1",
    backend="redis://127.0.0.1:6379/2",
)
```

这里通常会把逻辑库分开：

- `/1`：Broker
- `/2`：Backend

这样排查和清理都更方便。

### 26.1 为什么很多人喜欢 Redis + Celery

因为它足够简单：

- 环境轻
- 容易本地启动
- Python 项目接入快

但也要注意：

- 不要无限保存任务结果
- 大结果不要直接堆 Redis
- 任务状态和业务长期数据要区分

## 27. AI / RAG 项目里 Redis 的几个实用位置

如果你做的是 RAG 或模型服务，Redis 常放在这些位置：

### 27.1 热点缓存

例如：

- 相同 query 的检索结果缓存
- embedding 结果缓存
- 频繁访问的文档元数据缓存

### 27.2 会话上下文缓存

例如：

- 最近 N 轮聊天记录
- 临时上下文摘要
- 会话状态

### 27.3 任务状态层

例如：

- `task:123:status`
- `task:123:progress`
- `task:123:result_ref`

### 27.4 流式输出通道

例如：

- Worker 生成 token 后写入 `chat:stream:{task_id}`
- Gateway 或 API 服务持续消费
- 对外通过 SSE 返回

这个设计非常适合“生成过程持续输出”的场景。

## 28. Redis Streams 在流式输出里的思路

一个简化流程可以这样理解：

1. FastAPI 收到对话请求
2. 把任务提交给 Celery
3. Worker 调模型生成 token
4. 每生成一段 token 就 `XADD` 到某个 Stream
5. Gateway 或 API 层 `XREAD` / `XREADGROUP`
6. 持续把内容推给前端

例如 Stream key：

```text
chat:stream:task_1001
```

这个模式的好处：

- 推理和对外接口解耦
- 可以观察中间过程
- 可以做断线恢复或补读

## 29. key 设计建议

Redis 真正到了项目里，key 设计非常重要。

建议：

- 带业务前缀
- 带对象类型
- 带唯一 ID
- 必要时带版本

例如：

- `user:1001`
- `session:token:abc123`
- `cache:article:100`
- `task:ingest:001:status`
- `chat:stream:task_1001`

不要这样写：

- `a`
- `test`
- `temp1`

这种 key 后期几乎不可维护。

## 30. Redis 内存管理要有意识

Redis 很快，但它是以内存为核心的，所以内存管理很重要。

需要注意：

- 大 key 会拖慢操作
- 无过期时间的缓存容易无限增长
- Stream、List、Set 如果不清理会不断膨胀
- 不要把超大模型结果直接塞进去

对 AI 项目尤其重要：

- 大文本结果建议存数据库或文件
- Redis 里尽量存引用、状态、索引、小块结果

### 30.1 排查时少用危险大命令

实际项目里还要注意一些“能用，但别乱用”的命令。

例如：

- `KEYS *`
- `FLUSHDB`
- `FLUSHALL`

其中：

- `KEYS *` 在大库里可能带来明显扫描压力
- `FLUSHDB` 会清空当前库
- `FLUSHALL` 会清空整个 Redis 所有库

本地学习可以用，但线上环境要非常谨慎。

## 31. 常见坑

### 31.1 把 Redis 当永久数据库

Redis 可以持久化，但它更常见的定位还是：

- 缓存
- 状态层
- 高速临时存储

长期核心业务数据还是更适合数据库。

### 31.2 忘记设置 TTL

这是最常见的问题之一。

很多缓存、验证码、限流 key 如果没有 TTL，会一直堆着不清。

### 31.3 一个 Redis 库里什么都混着放

例如：

- 缓存
- Celery broker
- Celery backend
- 会话
- 任务流

全部都混在同一个逻辑库里，会让排查和维护变得很乱。

至少应该在命名和逻辑库上做一定隔离。

### 31.4 把超大对象直接塞进 Redis

例如：

- 整篇长文档
- 大块模型输出
- 大量 embedding

这些会明显增加内存压力，也会拖慢网络传输。

### 31.5 分布式锁写得不安全

只会 `SETNX` 或只会 `DEL`，但没有考虑：

- 锁超时
- 唯一 value
- 原子释放

这种写法在并发场景里容易出问题。

### 31.6 用 Pub/Sub 做必须可靠消费的任务

Pub/Sub 更像广播，不是强消息队列。

如果你要求：

- 消息可追踪
- 消费可确认
- 掉线后能补读

Streams 通常更合适。

## 32. 面试常问知识点

### 32.1 Redis 为什么快

常见回答角度：

- 数据主要在内存里，少了磁盘随机 IO
- 核心命令执行模型简单，数据结构专门为内存访问优化
- 单线程执行命令，避免大量线程切换和锁竞争
- 使用 IO 多路复用处理大量连接

注意这里的“单线程”主要指命令执行路径。Redis 在持久化、异步删除、网络 IO 等方面也会用到后台线程。

### 32.2 Redis 单线程为什么还能扛高并发

因为 Redis 的瓶颈通常不在 CPU，而在网络和内存访问。

它用一个主线程顺序执行命令，可以减少锁竞争；同时用 IO 多路复用同时管理很多连接，所以能处理大量短平快的请求。

但如果出现：

- 大 key
- 慢命令
- Lua 脚本执行太久
- 一次性返回大量数据

仍然会阻塞其他请求。

### 32.3 常见数据结构怎么选

可以按场景回答：

| 场景 | 数据结构 |
| --- | --- |
| 普通缓存、验证码、计数器 | String |
| 用户对象、任务状态对象 | Hash |
| 简单队列、最近记录 | List |
| 去重、标签、集合计算 | Set |
| 排行榜、按分数排序 | Sorted Set |
| 消息流、多消费者、流式输出 | Stream |

面试里重点不是背命令，而是能把业务场景和数据结构对应起来。

### 32.4 缓存穿透、击穿、雪崩怎么区分

- 穿透：查一个根本不存在的数据，每次都打到数据库
- 击穿：一个热点 key 过期，大量请求同时打到数据库
- 雪崩：大量 key 同时过期，数据库瞬间被打满

常见解决：

- 穿透：参数校验、缓存空值、布隆过滤器
- 击穿：互斥锁重建缓存、热点 key 提前刷新
- 雪崩：TTL 加随机值、分批过期、多级缓存

### 32.5 Redis 的过期删除和内存淘汰

Redis key 到期后，不一定会在那一瞬间立刻删除。

常见机制：

- 惰性删除：访问 key 时发现过期，再删除
- 定期删除：后台定期抽样检查一部分过期 key
- 内存淘汰：内存达到上限时，根据淘汰策略清理 key

所以面试里要区分：

- 过期删除：处理已经设置 TTL 的 key
- 内存淘汰：内存不够时按策略腾空间

### 32.6 RDB 和 AOF 怎么选

简单理解：

- RDB：定期快照，文件小，恢复快，但可能丢失最近一段时间数据
- AOF：记录写命令，数据更完整，但文件更大，恢复可能更慢

如果 Redis 只是缓存，持久化要求可以低一些。

如果 Redis 里放任务状态、消息流等比较重要的数据，就要认真考虑 AOF、备份和恢复策略。

### 32.7 Redis 事务和 MySQL 事务有什么不同

Redis 的事务主要是：

- `MULTI` 开始
- 命令排队
- `EXEC` 一次性执行

它保证一组命令按顺序连续执行，但不像 MySQL 那样强调复杂的回滚、隔离级别和 MVCC。

如果需要把“读取、判断、修改”做成严格原子操作，通常会用 Lua 脚本。

### 32.8 分布式锁面试怎么回答

基础写法：

```bash
SET lock:xxx unique_value NX EX 30
```

要点：

- `NX` 保证只有不存在时才能加锁
- `EX` 防止进程挂掉后锁永远不释放
- value 要唯一，避免误删别人的锁
- 解锁时“判断 value + 删除 key”要原子执行，通常用 Lua

实际项目里还要关注锁超时、业务执行时间、锁续期和异常释放。

### 32.9 Redis 高可用常见方案

面试常见层次：

- 主从复制：读写分离、数据副本
- Sentinel：监控主节点，故障时自动选主
- Cluster：分片存储，适合更大数据量和更高吞吐

简单项目里一个 Redis 实例就够用；线上核心系统通常要考虑高可用、备份、监控和容量规划。

## 33. 一套比较实用的学习顺序

建议按这个顺序掌握：

1. 先学会连接 Redis 和 `redis-cli`
2. 掌握 String、Hash、List、Set、Sorted Set
3. 学会 TTL 和过期机制
4. 学会缓存和限流
5. 学会分布式锁的基本思路
6. 再看 Pub/Sub 和 Streams
7. 最后再把 Redis 接到 FastAPI 和 Celery

## 34. 总结

Redis 的核心价值可以概括成几句话：

- 它很快，适合高频读写
- 它支持多种数据结构，不只是一个简单缓存
- 它天然适合存“短期状态”和“可过期数据”
- 它很适合做 FastAPI 和 Celery 之间的中间层

在你这套 AI 模型开发学习链路里，可以这样理解它的位置：

- FastAPI：提供接口
- Redis：缓存、状态、消息中间层
- Celery：执行后台异步任务
- MySQL：长期结构化数据存储

如果后面你继续往“RAG 系统、推理服务、异步任务平台”方向走，Redis 几乎一定会成为一个基础组件。

## 35. 参考

- Redis Docs: https://redis.io/docs/
- Redis Data Types: https://redis.io/docs/latest/develop/data-types/
- Redis Commands: https://redis.io/docs/latest/commands/
- Redis EXPIRE: https://redis.io/docs/latest/commands/expire/
- Redis TTL: https://redis.io/docs/latest/commands/ttl/
- Redis Streams: https://redis.io/docs/latest/develop/data-types/streams/
- redis-py Guide: https://redis.io/docs/latest/develop/clients/redis-py/
