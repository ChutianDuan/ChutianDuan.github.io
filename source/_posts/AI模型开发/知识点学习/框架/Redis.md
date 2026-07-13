---
title: "Redis 缓存命中了，为什么 RAG 仍返回旧答案，甚至串了租户？"
date: 2026-07-13 19:12:16
updated: 2026-07-13 19:12:16
categories:
  - "学习"
  - "AI 模型开发"
  - "知识点学习"
  - "框架"
permalink: /notes/ai模型开发/知识点学习/框架/redis/
series: "AI 模型开发"
---

缓存命中通常被当成好消息：不用查数据库，不用重新检索，接口更快。但如果 key 只写成：

```text
rag:answer:sha256(question)
```

两个租户提出相同问题，就可能共享同一条答案；知识库更新到新索引后，旧结果仍会继续命中；`top_k`、权限过滤或 embedding 模型变化，也可能读到与当前请求不一致的值。

Redis 没有“返回错数据”。它只是准确返回了这个 key 下的 value。真正错误的是应用把不同语义的请求映射成了同一个 key。

本文围绕一个核心目标展开：**怎样让 Redis 提速，同时保证缓存、限流、锁和消息都不会成为新的事实源？**

## 一、先划清 Redis 的职责

在 RAG 系统中，一个清晰分工是：

```text
MySQL：用户、权限、文档、任务和索引版本的权威状态
FAISS：某个版本的向量索引
Redis：可丢失缓存、短期协调、限流和短期事件流
Celery：后台任务投递和执行生命周期
```

Redis 可以启用持久化和高可用，但“可以持久化”不等于所有数据都适合只放 Redis。先问一个问题：

> 这个 key 被淘汰、过期或暂时不可用后，系统能否从权威数据恢复？

如果答案是否定的，就不能只按“缓存”方式设计它。任务最终状态、账务、权限和文档关系应有可靠事实源。

## 二、缓存 key 是接口契约，不是随手拼的字符串

一次 RAG 检索结果至少受这些输入影响：

- 租户与用户权限范围；
- 知识库 ID；
- 当前索引版本；
- embedding 模型及 revision；
- 标准化后的问题；
- `top_k`、阈值和过滤器；
- reranker 版本；
- 响应/缓存 schema 版本。

缺少任意一个，都可能产生语义碰撞。

### 1. 构造不泄露原文的稳定 key

```python
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass

@dataclass(frozen=True)
class RetrievalKeyInput:
    tenant_id: int
    user_scope_version: str
    knowledge_base_id: int
    index_version: str
    embedding_revision: str
    reranker_revision: str
    question: str
    top_k: int
    score_threshold: float

def normalize_question(question: str) -> str:
    return " ".join(question.strip().split())

def build_retrieval_cache_key(value: RetrievalKeyInput) -> str:
    if value.tenant_id <= 0 or value.knowledge_base_id <= 0:
        raise ValueError("tenant and knowledge base IDs must be positive")
    if value.top_k <= 0:
        raise ValueError("top_k must be positive")

    payload = asdict(value)
    payload["question"] = normalize_question(value.question)
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    digest = hashlib.sha256(canonical).hexdigest()
    return (
        f"rag:retrieval:v2:t{value.tenant_id}:"
        f"kb{value.knowledge_base_id}:{digest}"
    )
```

key 中只保留不可逆摘要，不暴露问题原文。租户和知识库仍显式出现，便于按前缀观测；权限变化通过 `user_scope_version` 使旧缓存自然失效。

规范化必须保守。“Redis”和“redis”是否等价、中文全半角是否等价，要由业务和模型验证，不能为了提高命中率随意改写问题。

### 2. 为什么直接用 Python `hash()` 不行

Python 内置 `hash()` 不适合作为跨进程、跨重启的持久 key 摘要。使用 SHA-256 这类稳定算法，并固定 JSON 字段、排序与分隔符，才能让不同进程得到相同结果。

## 三、完整 cache-aside：缓存值也需要 schema

下面的示例只依赖 redis-py 常见的 `get`/`set` 接口。权威查询由 `loader` 注入。

```python
from __future__ import annotations

import json
import random
from dataclasses import asdict, dataclass
from typing import Any, Callable, Protocol

class RedisStrings(Protocol):
    def get(self, key: str) -> str | None: ...
    def set(self, key: str, value: str, *, ex: int) -> Any: ...

@dataclass(frozen=True)
class Hit:
    chunk_id: int
    score: float

@dataclass(frozen=True)
class CacheEnvelope:
    schema_version: int
    index_version: str
    embedding_revision: str
    hits: list[dict[str, Any]]

def load_retrieval_with_cache(
    redis: RedisStrings,
    key: str,
    index_version: str,
    embedding_revision: str,
    loader: Callable[[], list[Hit]],
    base_ttl_seconds: int = 300,
) -> list[Hit]:
    cached = redis.get(key)
    if cached is not None:
        try:
            envelope = CacheEnvelope(**json.loads(cached))
            if envelope.schema_version != 1:
                raise ValueError("unsupported cache schema")
            if (envelope.index_version, envelope.embedding_revision) != (
                index_version,
                embedding_revision,
            ):
                raise ValueError("cache version mismatch")
            return [Hit(**item) for item in envelope.hits]
        except (TypeError, ValueError, json.JSONDecodeError):
            # 缓存损坏按 miss 处理，并记录指标；不要让可丢失缓存拖垮主流程。
            pass

    hits = loader()
    envelope = CacheEnvelope(
        schema_version=1,
        index_version=index_version,
        embedding_revision=embedding_revision,
        hits=[asdict(hit) for hit in hits],
    )
    jitter = random.randint(0, max(1, base_ttl_seconds // 5))
    redis.set(
        key,
        json.dumps(asdict(envelope), ensure_ascii=False, separators=(",", ":")),
        ex=base_ttl_seconds + jitter,
    )
    return hits
```

这段代码有几个容易忽略的细节：

- `cached is not None` 能正确命中缓存的空列表；`if cached` 容易混淆空字符串；
- value 带 schema 与版本，能发现错误 key 或旧格式；
- 解码失败退化为 miss，并应记录 `cache_decode_error`；
- TTL 加随机抖动，降低大量 key 同时过期；
- 缓存写失败是否降级，需要根据 Redis 客户端异常策略显式处理。

空结果可以短 TTL 缓存，缓解恶意或高频不存在查询穿透，但必须区分“确定没有结果”和“下游暂时失败”。绝不能把超时异常缓存成“没有文档”。

## 四、更新数据时，优先版本化而不是大范围删除

传统 cache-aside 更新顺序通常是：

```text
更新数据库 -> 删除缓存
```

但知识库检索缓存数量巨大，很难精确列出所有相关 question key；用 `KEYS rag:*` 再删除会阻塞大 keyspace。

索引本来就应不可变发布，因此可以把 `index_version` 放进 key 输入：

```text
v1 请求 -> rag:retrieval:...digest(v1,...)
切换 current_index_version=v2
v2 请求 -> rag:retrieval:...digest(v2,...)
```

切换后新请求不会再命中 v1。旧 key 由 TTL 慢慢回收，不需要全库扫描。这种版本化失效非常适合模型、Prompt、权限和索引升级。

要保证查询在一次请求中固定版本：先从权威配置读取 `index_version`，随后加载对应索引、查数据库和构建缓存都使用这个值。不要中途再次读取“当前版本”，否则切换瞬间可能混用两个版本。

## 五、穿透、击穿、雪崩到底是什么

| 问题 | 表现 | 常见处理 |
|---|---|---|
| 穿透 | 请求的数据本来不存在，每次都打到权威存储 | 参数校验、短期负缓存、布隆过滤器 |
| 击穿 | 单个热点 key 过期，大量请求同时重建 | single-flight、提前刷新、旧值短暂服务 |
| 雪崩 | 大量 key 同时过期或 Redis 整体故障 | TTL 抖动、多级降级、容量与故障演练 |

TTL 抖动只能缓解集中到期，不能解决 Redis 整体不可用。应用必须明确：缓存失败时是回源、限流、返回旧值，还是快速失败。无限回源可能把一次缓存故障放大成数据库雪崩。

## 六、用锁减少重复重建，但不要把锁当正确性证明

单实例常见加锁：

```text
SET lock:cache:<digest> <unique-token> NX PX 10000
```

`NX` 保证 key 不存在时才设置，`PX` 防止持有者崩溃后永久占锁。释放不能直接 `DEL`，因为租约可能已过期并被别人重新获得。

兼容广泛版本的 compare-and-delete Lua：

```lua
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
end
return 0
```

Python 最小封装：

```python
from __future__ import annotations

import secrets
from dataclasses import dataclass
from typing import Any

UNLOCK_SCRIPT = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
"""

@dataclass(frozen=True)
class Lease:
    key: str
    token: str

def try_acquire(redis: Any, key: str, ttl_ms: int) -> Lease | None:
    if ttl_ms <= 0:
        raise ValueError("ttl_ms must be positive")
    token = secrets.token_hex(16)
    acquired = redis.set(key, token, nx=True, px=ttl_ms)
    return Lease(key, token) if acquired else None

def release(redis: Any, lease: Lease) -> bool:
    return bool(redis.eval(UNLOCK_SCRIPT, 1, lease.key, lease.token))
```

即使这样，锁也不是永久互斥证明：

1. A 获取 10 秒租约；
2. A 因 GC、网络或模型调用停顿超过 10 秒；
3. B 获取新租约并开始工作；
4. A 恢复后继续执行；
5. A、B 同时产生副作用。

因此缓存重建锁只用于减少重复计算，重复重建通常无害。若操作涉及扣款、发布索引或不可逆写入，需要数据库唯一约束、状态机、幂等键或 fencing token；不能仅靠 Redis 锁声称业务正确。

Redis 官方还描述了多实例 Redlock，但它的适用保证、时钟和故障模型必须结合业务评估。优先使用经过验证的客户端库，不要随手自创分布式锁协议。

## 七、原子命令、Pipeline、事务和 Lua 不要混为一谈

### 1. 单条命令

`INCR`、`SET NX EX` 等单条命令具有原子执行语义，优先使用原生命令。

### 2. Pipeline

Pipeline 主要减少网络往返：

```python
with redis.pipeline(transaction=False) as pipe:
    for key in keys:
        pipe.get(key)
    values = pipe.execute()
```

它不自动让“先读后判断再写”成为一个原子操作。pipeline 太大还会占用客户端、网络和服务端缓冲。

### 3. `MULTI`/`EXEC`

Redis 事务把命令排队后连续执行，但与 MySQL 事务不同：不能把它理解为拥有相同隔离和任意运行时错误回滚语义。需要乐观并发控制时可使用 `WATCH`，但冲突后应用要重试。

### 4. Lua/Functions

服务器端脚本可把多步读写原子执行，适合短小的限流、条件更新和 compare-and-delete。脚本执行期间会占用 Redis 执行路径，不能做长循环、扫描大集合或复杂计算。

在 Redis Cluster 中，多 key 原子脚本通常要求相关 key 位于同一 hash slot，可用谨慎设计的 hash tag：

```text
rate:{tenant-42}:tokens
rate:{tenant-42}:timestamp
```

花括号内容决定 slot。过度使用同一个 tag 会制造热点，设计前要结合访问分布。

## 八、限流：固定窗口的边界突刺

最小固定窗口通常是 `INCR`，首次写入时设置 TTL。但在一个窗口结束前后，客户端可能短时间获得接近两倍额度。

下面的 Lua 使用 Redis 服务端时间实现简化令牌桶，读、补充、消费和过期在一次脚本内完成：

```lua
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local requested = tonumber(ARGV[3])
local ttl_ms = tonumber(ARGV[4])

local now_parts = redis.call("TIME")
local now = now_parts[1] * 1000 + math.floor(now_parts[2] / 1000)
local values = redis.call("HMGET", key, "tokens", "updated_at")
local tokens = tonumber(values[1]) or capacity
local updated_at = tonumber(values[2]) or now

tokens = math.min(capacity, tokens + (now - updated_at) * refill_per_ms)
local allowed = 0
if tokens >= requested then
    tokens = tokens - requested
    allowed = 1
end

redis.call("HSET", key, "tokens", tokens, "updated_at", now)
redis.call("PEXPIRE", key, ttl_ms)
return {allowed, tostring(tokens)}
```

key 至少包含租户/用户和接口策略版本。按 IP 限流要正确处理可信代理，否则攻击者可能伪造转发头；共享出口也可能误伤大量用户。

限流 Redis 不可用时选择 fail-open 还是 fail-closed，取决于接口风险。登录、防刷和高成本模型接口通常不能无条件放行；健康检查等低风险接口可以有不同策略。

## 九、Streams、Pub/Sub 和任务队列的区别

### Pub/Sub

Pub/Sub 是实时广播。订阅者断线期间的消息不会为它保留，不适合必须可靠处理的任务或唯一 token 通道。

### Streams

Stream 是追加日志，支持 ID、范围读取、裁剪和 consumer group。组内消息需要 `XACK`，未确认消息保存在 Pending Entries List，可以检查并重新认领。

```text
XGROUP CREATE rag:events workers 0 MKSTREAM
XADD rag:events MAXLEN ~ 100000 * job_id 7 event chunk_ready
XREADGROUP GROUP workers worker-1 COUNT 10 BLOCK 5000 STREAMS rag:events >
XACK rag:events workers <message-id>
```

消费流程必须是：

```text
读取 -> 幂等处理 -> 权威结果提交成功 -> XACK
```

消费者在提交后、`XACK` 前崩溃，消息可能再次交付。因此 `(consumer_operation, message_id)` 或业务幂等键必须有唯一约束。

Streams 还需要：

- 唯一 consumer 名称；
- pending 数量与最长 idle 监控；
- `XAUTOCLAIM` 等超时认领策略；
- 最大长度/时间保留策略；
- poison message 的有限重试与死信处理；
- 多 consumer group 下删除与裁剪的协调。

较新 Redis 版本持续增强 Stream 的 ack、删除和幂等生产能力，但项目必须以实际部署版本为准，不能复制新版本命令到旧集群。

### Celery

已有 Celery 时，业务任务优先使用其成熟的任务生命周期，而不是又用 Stream 实现一套半成品队列。Stream 更适合短期有序事件、可重放通知或服务间日志式数据。

## 十、数据结构按访问模式选择

| 需求 | 结构 | 注意事项 |
|---|---|---|
| JSON/短缓存、计数、租约 | String | 单 value 不宜过大 |
| 对象少量字段读写 | Hash | 大 hash 也是热点 key |
| 唯一成员与集合关系 | Set | 大集合运算可能阻塞 |
| 排名、时间/优先级范围 | Sorted Set | score 是浮点数，精度要评估 |
| 追加事件与消费组 | Stream | 必须裁剪和处理 pending |
| 简单队列 | List | 缺少 Stream 的消费跟踪能力 |

Redis 新版本还包含更多数据类型与扩展能力，但不要只因为“Redis 支持”就把全文检索、向量库和任务系统全部迁进去。先看数据规模、过滤、更新、一致性和团队运维能力。

## 十一、TTL、过期和淘汰是三件事

- TTL：应用声明 key 的生命周期；
- 过期删除：Redis 清理已到期 key；
- 淘汰：达到 `maxmemory` 后，按策略移除 key 或拒绝写入。

常见策略包括 `noeviction`、`allkeys-lru`、`allkeys-lfu` 和只针对带 TTL key 的 `volatile-*`。具体选择取决于实例中的数据性质。

把普通缓存、Celery broker、任务结果和限流放在同一个实例，会产生策略冲突：纯缓存适合淘汰，队列消息却不能因内存压力静默消失。真正需要可靠性和资源隔离时，应拆实例或服务，而不是仅用不同逻辑 DB。

逻辑 DB 共享同一个进程、内存上限和故障域；Redis Cluster 也主要使用 DB 0。它不是租户安全边界。

## 十二、持久化和高可用不等于零数据丢失

RDB 是周期快照，AOF 记录写操作并可按策略刷盘。复制通常也存在异步窗口。故障切换、进程崩溃和磁盘损坏下能丢多少数据，取决于具体配置和拓扑。

如果 Redis 只存可重建缓存，目标是快速恢复和保护权威存储；如果承载消息或短期状态，就必须明确：

- RPO/RTO；
- AOF fsync 与重写策略；
- 副本和故障切换行为；
- 备份与恢复演练；
- 淘汰策略；
- 客户端超时、重试和重复写语义。

客户端重试一个超时写操作时，第一次可能已在服务端成功。计数、队列和有副作用操作要按“结果未知、可能重复”设计。

## 十三、连接池、超时和大命令

redis-py 通常通过连接池复用连接。生产代码要配置连接、socket 读取和池获取超时，并按同步/异步框架选择对应客户端。

避免线上危险操作：

- `KEYS *` 扫描整个 keyspace；
- 对超大 hash/list/set 一次取全部元素；
- 大范围 `DEL` 同步释放内存；
- 长 Lua 脚本；
- 无上限 pipeline；
- 把大模型、长文档或巨型 JSON 当普通 cache value。

运维遍历使用 `SCAN`，但要知道它是增量游标：遍历期间 keyspace 变化时可能重复返回，不能保证事务快照。删除大量 key 时应限速，必要时评估异步 `UNLINK`，并监控延迟与内存释放。

## 十四、缓存故障时的观测指标

至少记录：

```text
按 cache namespace 的 hit/miss/error
回源 QPS、耗时和失败率
key/value 字节分布
过期与淘汰数量
used_memory、碎片率、maxmemory
连接池等待、命令 P95/P99
hot key 与 slowlog
锁获取失败、租约超时与重复重建
Stream 长度、pending、idle、claim 和死信
缓存 schema/index/model version
```

命中率高不一定好。若命中的是旧版本或越权值，高命中率只是更快地返回错误结果。应同时监控版本不匹配、解码错误和最终业务正确率。

## 十五、常见错误与修正

### 1. key 里只有 query

加入 tenant、权限范围版本、知识库、索引/模型/reranker 版本和所有检索参数，再对规范化结构做稳定摘要。

### 2. 更新后扫描删除所有相关 key

优先把不可变资源版本放入 key，让旧缓存 TTL 回收；避免 `KEYS` 和大范围同步删除。

### 3. 缓存没有 TTL

缓存默认应有 TTL。没有 TTL 的 key 必须能解释 owner、容量和显式清理路径。

### 4. 只用 `SETNX` 加锁、任意 `DEL` 解锁

使用 `SET ... NX PX`、唯一 token 和原子 compare-delete；同时承认租约过期后的并发执行，业务写入仍需幂等。

### 5. Pipeline 被当作事务

Pipeline 是减少往返；条件原子更新使用单条命令、Lua/Function 或正确的 `WATCH`/`MULTI` 协议。

### 6. Pub/Sub 承担可靠任务

断线消息会丢。按需求选择 Streams、Celery 或其他可靠消息系统，并实现幂等消费。

## 十六、上线检查清单

1. 每类 key 是否有 owner、schema、版本和 TTL？
2. key 是否包含全部语义输入且不泄露原文/凭证？
3. 权限变化与索引升级是否会自然切换到新 key？
4. 缓存 miss/error 时是否有受限回源和降级策略？
5. 空结果与下游故障是否被正确区分？
6. 锁是否只减少重复工作，业务正确性是否由幂等/约束保证？
7. Lua 与多 key 操作是否短小，并符合 Cluster slot 规则？
8. 限流故障时 fail-open/fail-closed 是否按风险定义？
9. Stream 是否有 ack、pending reclaim、裁剪与死信策略？
10. 缓存、broker 和重要状态是否隔离淘汰策略与故障域？
11. 是否配置内存上限、淘汰、连接池与命令超时？
12. 是否有 Redis 整体不可用和缓存冷启动演练？

## 十七、总结

Redis 最容易用，也最容易让临时状态悄悄变成业务事实。可靠使用它需要记住：

- cache key 是完整语义契约，不只是 query 摘要；
- 使用稳定规范化和 SHA-256，避免原文泄露与进程不一致；
- value 也要带 schema、索引与模型版本；
- 利用不可变版本自然失效，减少全库扫描删除；
- TTL、过期和 maxmemory 淘汰分别设计；
- 锁是有期限的协调工具，不能替代幂等、唯一约束和状态机；
- Pipeline、事务和 Lua 解决的问题不同；
- Streams 默认要按可能重复交付设计消费者；
- 缓存、队列和关键状态不要混用同一淘汰与故障域；
- 缓存故障时要限制回源，避免把 Redis 故障放大到权威存储。

当 key、版本、TTL 和失败语义都明确后，Redis 才是可安全丢弃并重建的加速层，而不是一份比数据库更快、也更难发现错误的旧数据副本。

## 参考资料

- [Redis 数据类型](https://redis.io/docs/latest/develop/data-types/)
- [Redis `SET` 命令](https://redis.io/docs/latest/commands/set/)
- [Redis 分布式锁模式](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/)
- [Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/)
- [Redis Streaming 使用场景](https://redis.io/docs/latest/develop/use-cases/streaming/)
- [Redis 内存淘汰](https://redis.io/docs/latest/develop/reference/eviction/)
- [redis-py 指南](https://redis.io/docs/latest/develop/clients/redis-py/)
- [Redis `SCAN`](https://redis.io/docs/latest/commands/scan/)
