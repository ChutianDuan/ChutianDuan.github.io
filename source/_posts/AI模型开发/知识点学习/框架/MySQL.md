---
title: "MySQL 已提交、FAISS 也已保存，为什么 RAG 仍会读到错版本？"
date: 2026-07-13 19:02:31
updated: 2026-07-13 19:02:31
categories:
  - "学习"
  - "AI 模型开发"
  - "知识点学习"
  - "框架"
permalink: /notes/ai模型开发/知识点学习/框架/mysql/
series: "AI 模型开发"
---

AI 项目里很容易把 MySQL 当成“保存用户、文档和任务的地方”，把 FAISS 当成“保存向量的地方”。两个组件单独看都工作正常，组合后却可能出现一种危险故障：

```text
MySQL 中 chunk 已经更新为 v2
FAISS 查询进程仍加载 v1
Top-K 返回 chunk_id=101
业务数据库却按 v2 解释 101
最终引用指向了另一段文本
```

MySQL 事务只能保证数据库内部修改的原子性，不能自动把数据库提交与外部索引文件、对象存储或模型服务组成一个事务。解决问题的关键不是“再加一次 `commit()`”，而是设计明确的数据不变量和发布状态机。

本文以 MySQL 8.4 LTS、InnoDB 为基线，从 RAG 元数据建模出发，讲清事务、索引、锁、分页和慢查询。目标不是背 SQL，而是回答：**怎样让数据库在并发和故障下仍能证明当前读到的是同一版数据？**

## 一、MySQL 在 AI 系统里的职责

一个常见的分工是：

```text
MySQL：用户、权限、文档、chunk 元数据、任务、索引版本
Redis：缓存、限流计数、短期状态
FAISS：向量与 int64 chunk_id 的近邻索引
对象存储：原始文档、构建产物
任务系统：解析、embedding、索引构建
```

MySQL 擅长持久结构化数据、约束、事务和条件查询。它不应被当作每个 token 的临时缓冲区，也不能替 FAISS 做高维近邻搜索。

InnoDB 是 MySQL 8.4 默认存储引擎，支持事务、崩溃恢复、行级锁和一致性读。本文所有并发行为都以 InnoDB 为前提。

## 二、先定义不变量，再建表

RAG 元数据至少需要维护这些不变量：

1. 一个 chunk 只能属于一个文档；
2. 同一文档版本中，chunk 序号不能重复；
3. chunk 使用的 embedding 模型和索引版本必须可追踪；
4. 查询只读取已经完整发布的索引版本；
5. FAISS 返回的 `chunk_id` 必须能在同版本元数据中找到；
6. 软删除文档不能再向未授权用户返回原文。

没有这些规则时，代码“成功执行”并不代表数据正确。

## 三、一套面向版本发布的最小表结构

下面的表不是通用平台模板，只保留知识库、文档、chunk、索引版本和任务五个当前需要的对象。

### 1. 知识库与文档

```sql
CREATE DATABASE IF NOT EXISTS rag_demo
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_0900_ai_ci;

USE rag_demo;

CREATE TABLE knowledge_bases (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    owner_user_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(200) NOT NULL,
    current_index_version VARCHAR(64) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uk_kb_owner_name (owner_user_id, name)
) ENGINE = InnoDB;

CREATE TABLE documents (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    knowledge_base_id BIGINT UNSIGNED NOT NULL,
    source_name VARCHAR(500) NOT NULL,
    content_sha256 BINARY(32) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'processing',
    deleted_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uk_document_content (knowledge_base_id, content_sha256),
    KEY idx_document_list (
        knowledge_base_id, status, created_at DESC, id DESC
    ),
    CONSTRAINT fk_document_kb FOREIGN KEY (knowledge_base_id)
        REFERENCES knowledge_bases (id) ON DELETE RESTRICT,
    CONSTRAINT chk_document_status
        CHECK (status IN ('processing', 'ready', 'failed', 'deleted'))
) ENGINE = InnoDB;
```

`content_sha256` 用 `BINARY(32)` 保存摘要原始字节，而不是 64 字符十六进制文本。显示时可用 `HEX(content_sha256)`，写入时可用 `UNHEX(?)`。

状态与 `deleted_at` 同时存在，是为了让查询方便并保留删除时间；应用要保证二者同步。也可以只保留一个事实源，但不要让多个字段表达矛盾状态。

### 2. 索引版本与 chunk

```sql
CREATE TABLE index_versions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    knowledge_base_id BIGINT UNSIGNED NOT NULL,
    version VARCHAR(64) NOT NULL,
    state VARCHAR(20) NOT NULL DEFAULT 'building',
    embedding_model VARCHAR(255) NOT NULL,
    embedding_revision VARCHAR(128) NOT NULL,
    dimension INT UNSIGNED NOT NULL,
    metric VARCHAR(32) NOT NULL,
    vector_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
    artifact_sha256 BINARY(32) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    activated_at DATETIME(6) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_index_version (knowledge_base_id, version),
    KEY idx_index_state (knowledge_base_id, state, created_at DESC),
    CONSTRAINT fk_index_kb FOREIGN KEY (knowledge_base_id)
        REFERENCES knowledge_bases (id) ON DELETE RESTRICT,
    CONSTRAINT chk_index_dimension CHECK (dimension > 0),
    CONSTRAINT chk_index_state
        CHECK (state IN ('building', 'ready', 'active', 'retired', 'failed'))
) ENGINE = InnoDB;

CREATE TABLE chunks (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    document_id BIGINT UNSIGNED NOT NULL,
    index_version_id BIGINT UNSIGNED NOT NULL,
    ordinal_no INT UNSIGNED NOT NULL,
    content TEXT NOT NULL,
    token_count INT UNSIGNED NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uk_chunk_position (
        document_id, index_version_id, ordinal_no
    ),
    KEY idx_chunk_index (index_version_id, id),
    CONSTRAINT fk_chunk_document FOREIGN KEY (document_id)
        REFERENCES documents (id) ON DELETE RESTRICT,
    CONSTRAINT fk_chunk_index FOREIGN KEY (index_version_id)
        REFERENCES index_versions (id) ON DELETE RESTRICT,
    CONSTRAINT chk_chunk_token_count CHECK (token_count > 0)
) ENGINE = InnoDB;
```

这里允许同一文档在多个索引版本下拥有不同 chunk，因为切分策略或 embedding 模型升级可能导致边界变化。FAISS 保存 `chunks.id` 作为稳定 `int64` ID。

`TEXT` 不会自动进入所有查询。向量检索返回 ID 后，再按主键批量取原文：

```sql
SELECT c.id, c.content, c.ordinal_no, d.id AS document_id, d.source_name
FROM chunks AS c
JOIN documents AS d ON d.id = c.document_id
WHERE c.index_version_id = ?
  AND c.id IN (?, ?, ?, ?)
  AND d.status = 'ready'
  AND d.deleted_at IS NULL;
```

结果集顺序不保证与 `IN` 参数一致，应用应按 FAISS 返回的 ID 顺序重新排列，并过滤数据库没有返回的 ID。

### 3. 构建任务

```sql
CREATE TABLE ingestion_jobs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    document_id BIGINT UNSIGNED NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
    error_code VARCHAR(64) NULL,
    available_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    started_at DATETIME(6) NULL,
    finished_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uk_job_idempotency (idempotency_key),
    KEY idx_job_claim (status, available_at, id),
    CONSTRAINT fk_job_document FOREIGN KEY (document_id)
        REFERENCES documents (id) ON DELETE RESTRICT,
    CONSTRAINT chk_job_status
        CHECK (status IN ('pending', 'running', 'succeeded', 'failed'))
) ENGINE = InnoDB;
```

唯一幂等键保证客户端重试创建请求时，不会产生两份相同任务。它不能单独保证下游 embedding 或索引发布幂等，worker 的每一步仍要使用任务 ID 或版本号去重。

## 四、跨 MySQL 与 FAISS，为什么不能用一个事务

错误流程常写成：

```text
BEGIN
INSERT chunks
COMMIT
faiss.write_index(...)
```

如果提交后、写文件前进程崩溃，数据库已经指向新 chunk，索引却没生成。反过来先写文件再提交，也可能留下数据库不知道的新索引。

更可靠的发布流程是不可变版本 + 状态机：

```text
1. MySQL 创建 index_versions(state='building')
2. 在短事务中批量写入该版本 chunks
3. 事务外计算 embedding、构建不可变 FAISS 产物
4. 校验向量数、维度、模型 revision、文件哈希
5. MySQL 将该版本置为 ready
6. 查询进程完整加载并自检 ready 产物
7. 短事务内锁定 knowledge_bases 行，切换 current_index_version
8. 新版本置 active，旧版本置 retired
```

关键点是：任何时刻，读路径只认 `current_index_version` 指向的完整版本。`building` 目录即使存在，也不会被在线查询使用。

激活事务可以写成：

```sql
START TRANSACTION;

SELECT current_index_version
FROM knowledge_bases
WHERE id = ?
FOR UPDATE;

SELECT id, state
FROM index_versions
WHERE knowledge_base_id = ? AND version = ?
FOR UPDATE;

-- 应用确认目标版本当前为 ready。
UPDATE index_versions
SET state = 'retired'
WHERE knowledge_base_id = ? AND state = 'active';

UPDATE index_versions
SET state = 'active', activated_at = CURRENT_TIMESTAMP(6)
WHERE knowledge_base_id = ? AND version = ? AND state = 'ready';

UPDATE knowledge_bases
SET current_index_version = ?
WHERE id = ?;

COMMIT;
```

每条 `UPDATE` 后都要检查受影响行数。应用加载新版本失败时不能执行激活事务；事务失败必须 `ROLLBACK`。

这仍不是分布式事务。查询进程如何收到版本切换、旧版本何时释放、发布服务崩溃怎样恢复，都需要额外协议。但状态机让每个中间状态可识别、可重试，而不是假设所有步骤永不失败。

## 五、事务边界：短、小、只包含数据库工作

事务适合维护数据库内的不变量：

```python
from __future__ import annotations

from typing import Any

def create_job(
    connection: Any,
    document_id: int,
    idempotency_key: str,
) -> int:
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO ingestion_jobs (document_id, idempotency_key)
                VALUES (%s, %s)
                ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)
                """,
                (document_id, idempotency_key),
            )
            job_id = int(cursor.lastrowid)
        connection.commit()
        return job_id
    except Exception:
        connection.rollback()
        raise
```

参数化查询不仅防 SQL 注入，也正确处理引号和编码。表名、列名不能通过 `%s` 参数化；需要动态标识符时，只能从代码内白名单选择。

不要在事务中调用 embedding、LLM、HTTP API 或读取大文件：

```text
BEGIN
锁住 document
调用模型 30 秒       <- 锁和连接被白白占用
UPDATE
COMMIT
```

应在事务外完成耗时计算，事务内只验证前置状态并写入结果。若计算期间数据可能变化，使用版本号或条件更新防止旧结果覆盖新结果：

```sql
UPDATE documents
SET status = 'ready', updated_at = CURRENT_TIMESTAMP(6)
WHERE id = ? AND status = 'processing' AND updated_at = ?;
```

受影响行数为 0 表示状态已变化，调用方应放弃旧结果，而不是无条件覆盖。

## 六、隔离级别、MVCC 与锁定读

MySQL 8.4 InnoDB 默认隔离级别是 `REPEATABLE READ`。普通 `SELECT` 通常是一致性读：根据 Read View 读取合适版本，不因为另一事务持有行锁就总是等待。

如果业务逻辑是“读当前状态，随后根据它更新”，普通快照读可能不够，应使用锁定读：

```sql
START TRANSACTION;

SELECT status
FROM ingestion_jobs
WHERE id = ?
FOR UPDATE;

UPDATE ingestion_jobs
SET status = 'running', started_at = CURRENT_TIMESTAMP(6)
WHERE id = ? AND status = 'pending';

COMMIT;
```

`FOR UPDATE` 锁住搜索扫描遇到的索引记录，锁在提交或回滚时释放。索引设计会影响扫描和锁范围：缺少合适索引时，语句可能扫描并锁住远多于预期的记录。

### `SKIP LOCKED` 只适合队列式领取

多个 worker 从表中领取任务时，可以：

```sql
START TRANSACTION;

SELECT id, document_id
FROM ingestion_jobs
WHERE status = 'pending'
  AND available_at <= CURRENT_TIMESTAMP(6)
ORDER BY available_at, id
LIMIT 1
FOR UPDATE SKIP LOCKED;

-- 若找到任务，在同一短事务中将其改为 running。
UPDATE ingestion_jobs
SET status = 'running',
    attempt_count = attempt_count + 1,
    started_at = CURRENT_TIMESTAMP(6)
WHERE id = ?;

COMMIT;
```

`SKIP LOCKED` 不等待被其他事务锁住的行，因此会返回不一致视图。官方明确指出它不适合一般事务查询，但可用于多个会话竞争的队列表。若项目已经使用 Celery/Redis 队列，通常不应再无必要地用 MySQL 实现第二套调度系统。

## 七、死锁不是“数据库坏了”，应用必须能处理

典型死锁：

```text
事务 A：先锁 document 1，再等 document 2
事务 B：先锁 document 2，再等 document 1
```

InnoDB 通常会检测死锁并回滚一个受害事务。即使设计合理，应用也必须处理事务被回滚的情况。

降低死锁概率：

- 所有代码按相同顺序锁表和行，例如始终按主键升序；
- 事务保持短小，不在其中做外部 I/O；
- 为 `UPDATE ... WHERE` 和锁定读提供合适索引；
- 一次修改尽量少的行；
- 只对确认可幂等重试的整个事务做有限重试，并加入随机退避。

排查最近一次死锁：

```sql
SHOW ENGINE INNODB STATUS;
```

还可通过 Performance Schema 的 `data_locks` 和 `data_lock_waits` 查看谁持锁、谁等待。不要只延长 `innodb_lock_wait_timeout`，那通常只是让请求等得更久。

## 八、索引应从查询形状倒推

索引不是“某列常用就给某列加一个”。要观察完整查询的等值条件、范围、排序和返回字段。

文档列表查询：

```sql
SELECT id, source_name, status, created_at
FROM documents
WHERE knowledge_base_id = ?
  AND status = 'ready'
  AND deleted_at IS NULL
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

前面的索引：

```sql
KEY idx_document_list (
    knowledge_base_id, status, created_at DESC, id DESC
)
```

可利用最左前缀先定位知识库和状态，再按索引顺序读取。但 `deleted_at IS NULL` 没在索引里，仍需回表过滤。是否把它纳入索引，要看删除比例、读写频率、索引体积和实测计划，不能只凭直觉。

InnoDB 二级索引叶子通常包含主键。主键过宽会放大所有二级索引；因此内部关联常用紧凑的数值主键，把 UUID 作为唯一业务键单独索引。

索引的代价包括：

- 插入、更新、删除时都要维护；
- 占用磁盘和 Buffer Pool；
- 重复或前缀重叠索引增加优化器选择和运维成本；
- 低选择性单列索引不一定减少足够扫描。

## 九、不要用深 `OFFSET` 分页

下面的查询即使有索引，也要跳过大量行：

```sql
SELECT id, source_name, created_at
FROM documents
WHERE knowledge_base_id = ? AND status = 'ready'
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET 100000;
```

键集分页使用上一页最后一项作为游标：

```sql
SELECT id, source_name, created_at
FROM documents
WHERE knowledge_base_id = ?
  AND status = 'ready'
  AND (created_at, id) < (?, ?)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

`id` 作为并列排序键非常重要：多条记录可能拥有相同 `created_at`。第一页不带游标条件，下一页传入上一页最后一条的 `(created_at, id)`。

键集分页不能随意跳到第 5000 页，但 API 列表和无限滚动通常不需要随机页码。若业务确实需要随机跳页，要单独设计统计、缓存或搜索方案。

## 十、慢查询：先测访问路径，再改结构

优化顺序：

1. 从慢查询日志或 tracing 得到真实 SQL、参数形状和耗时分布；
2. 确认等待的是 CPU、磁盘、锁还是连接池；
3. 使用 `EXPLAIN` 查看估算计划；
4. 在安全的测试环境用 `EXPLAIN ANALYZE` 查看实际执行时间和行数；
5. 对照估算行数与实际行数，检查统计信息和数据倾斜；
6. 修改查询、索引或数据模型后重新测量。

```sql
EXPLAIN ANALYZE
SELECT id, source_name, created_at
FROM documents
WHERE knowledge_base_id = 42
  AND status = 'ready'
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

`EXPLAIN ANALYZE` 会真实执行语句。不要对生产中的破坏性 DML 或不可控大查询随手执行。排查时重点看：

- 选择了哪个索引；
- 每个节点估算与实际处理多少行；
- 是否出现全表扫描、额外排序或临时结果；
- 哪个节点耗时最高；
- 是否因为类型转换、函数或通配符前缀无法有效利用索引。

“走了索引”也不等于快。如果索引读取了表中大部分记录，再大量回表，可能比顺序扫描更慢。

## 十一、连接池与 Web 服务

每个请求新建 TCP 连接会增加握手和认证开销；生产服务通常使用连接池。但连接池不是越大越好：

```text
总潜在连接数 ≈ 实例数 × 每实例 worker 数 × 每 worker 池上限
```

如果 10 个实例、每个 4 个 worker、每池 20 个连接，理论上可达到 800 个。数据库能否承受，必须结合查询耗时、CPU、内存和 `max_connections` 评估。

使用连接时要遵守：

- 从池中借连接后总是归还；
- 异常时显式回滚，避免把未结束事务放回池；
- 配置连接、查询和获取连接的超时；
- 不跨并发请求共享同一个连接或游标；
- 避免事务空闲；
- 对断开连接使用驱动/池提供的健康检查。

FastAPI 的 `async def` 不会让同步 PyMySQL 变成异步。可以使用普通 `def` 路由让框架在线程池调用同步驱动，或选用项目已验证的异步驱动；无论哪种，连接池容量和事务边界都不会自动解决。

## 十二、JSON 什么时候适合用

MySQL 的 `JSON` 类型会验证写入值是合法 JSON，适合保存不同模型提供商返回的少量可变附加信息：

```sql
ALTER TABLE ingestion_jobs
ADD COLUMN details JSON NULL;
```

但经常过滤、排序、关联或受约束的字段应建成明确列。例如任务状态若藏在 `details->'$.status'`，索引、约束和迁移都会更复杂。

一个简单判断：如果产品已经要求“按它筛选、做唯一约束或统计”，它大概率不该只存在 JSON 中。确需查询 JSON 路径时，可评估生成列和索引，但先用真实查询验证收益。

## 十三、字符集、时间和金额

- 数据库、表、连接都统一使用 `utf8mb4`；
- 排序规则会影响大小写、重音与唯一性，选定后用样例验证；
- 服务间统一以 UTC 存储时间，展示层再转换时区；
- 需要时区语义时，单独保存时区或偏移上下文；
- 金额使用 `DECIMAL` 或最小货币单位整数，不用浮点；
- 不依赖空字符串、`0` 和 `NULL` 混合表达同一种缺失状态。

`DATETIME` 与 `TIMESTAMP` 的范围、时区转换行为不同，选型要结合业务和驱动配置；不能只凭字段名判断存进去的一定是 UTC。

## 十四、常见错误与修正

### 1. 字符串拼 SQL

```python
# 错误：既有注入风险，也容易破坏引号和编码。
sql = f"SELECT id FROM documents WHERE source_name = '{name}'"

# 正确：值参数交给驱动绑定。
cursor.execute(
    "SELECT id FROM documents WHERE source_name = %s",
    (name,),
)
```

### 2. `UPDATE`/`DELETE` 缺少边界

重要写操作同时使用主键、租户或预期旧状态，并检查 `rowcount`。数据库账号也应最小权限，迁移账号与应用账号分开。

### 3. `SELECT *`

显式列出字段能减少网络和反序列化开销，也避免新增敏感列后被接口意外返回。

### 4. 外键与软删除混用不清

外键保证引用存在，不保证租户权限，也不会理解软删除。若文档软删除，读取 chunk 时仍要检查文档状态；不能因为外键存在就跳过授权。

### 5. 看到慢就加单列索引

先看真实查询形状和执行计划。多个单列索引不一定能替代顺序正确的复合索引，反而增加写放大。

## 十五、上线检查清单

1. 所有表是否明确使用 InnoDB、`utf8mb4` 和合适排序规则？
2. 业务不变量是否由主键、唯一键、外键或 `CHECK` 尽可能约束？
3. FAISS ID 是否是稳定 `BIGINT`，并与索引版本绑定？
4. 查询是否只读取 `active` 版本，发布是否可恢复、可回滚？
5. 外部模型和文件操作是否移出数据库事务？
6. 所有 SQL 值是否参数化，动态标识符是否来自白名单？
7. 复合索引是否对应等值、范围和排序的真实顺序？
8. 列表是否用稳定排序与键集分页？
9. 应用是否处理死锁和锁等待，重试是否有限且幂等？
10. 连接池总规模是否按实例和 worker 汇总计算？
11. 慢查询是否用真实参数和 `EXPLAIN ANALYZE` 验证？
12. 备份是否做过恢复演练，而不只是“有备份任务”？

## 十六、总结

MySQL 的价值不只是把对象“存下来”，而是用约束、事务、锁和索引维持可证明的数据关系。对 RAG 项目尤其要记住：

- 数据库事务无法自动覆盖 FAISS 文件和模型服务；
- 用不可变索引版本与状态机协调跨系统发布；
- 用稳定 chunk ID 和版本字段防止引用错配；
- 事务保持短小，外部 I/O 放在事务之外；
- 锁住的是扫描到的索引范围，索引也影响并发；
- `SKIP LOCKED` 适合队列领取，不适合普通一致性查询；
- 索引从查询形状倒推，慢查询以实际计划为证据；
- 多实例连接池、死锁重试和软删除都必须在应用层明确处理。

当数据库中每个状态都能解释、每次切换都能恢复时，MySQL 才真正成为 AI 系统的一致性核心，而不是一个“能执行 CRUD 的长期缓存”。

## 参考资料

- [MySQL 8.4：InnoDB 简介](https://dev.mysql.com/doc/refman/8.4/en/innodb-introduction.html)
- [MySQL 8.4：事务的 START、COMMIT 与 ROLLBACK](https://dev.mysql.com/doc/refman/8.4/en/commit.html)
- [MySQL 8.4：InnoDB 锁类型](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html)
- [MySQL 8.4：锁定读与 SKIP LOCKED](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html)
- [MySQL 8.4：InnoDB 死锁](https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks.html)
- [MySQL 8.4：JSON 类型](https://dev.mysql.com/doc/refman/8.4/en/json.html)
- [MySQL 8.4：CHECK 约束](https://dev.mysql.com/doc/refman/8.4/en/create-table-check-constraints.html)
- [MySQL 8.4：SELECT 语句](https://dev.mysql.com/doc/refman/8.4/en/select.html)
