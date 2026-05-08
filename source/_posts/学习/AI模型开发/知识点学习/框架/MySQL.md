---
title: "MySQL 学习笔记"
date: 2026-05-03 16:14:45
updated: 2026-05-03 16:14:45
categories:
  - "学习"
  - "AI模型开发"
  - "知识点学习"
  - "框架"
permalink: /notes/ai模型开发/知识点学习/框架/mysql/
---

# MySQL 学习笔记

## 1. MySQL 是什么

MySQL 是一个关系型数据库，用来存储：

- 用户信息
- 订单数据
- 文档元数据
- 任务记录
- 聊天记录
- 各种需要长期保存的结构化数据

先抓住它和 Redis 的分工差异：

> MySQL 更适合存“长期、结构化、可查询的数据”，Redis 更适合存“高频、临时、快速访问的数据”。

## 2. 为什么项目里经常会有 MySQL

因为很多业务数据都需要：

- 长期保存
- 有明确字段结构
- 支持条件查询
- 支持关联查询
- 保证数据一致性

例如：

- 一个用户有哪些会话
- 一个文档属于哪个用户
- 一条任务记录当前是什么状态
- 某段时间创建了多少条消息

这些都很适合用 MySQL 来存。

## 3. 在 AI 项目里 MySQL 常见用法

在 AI 模型开发场景里，MySQL 常见用途有：

- 存用户表
- 存会话表
- 存消息表
- 存文档表
- 存任务记录表
- 存模型调用日志
- 存权限和配置

放回整套系统里看，各组件的分工大致是：

- FastAPI / Drogon：接请求
- Redis：做缓存、状态层、中间层
- Celery：处理后台任务
- MySQL：存长期结构化数据

## 4. MySQL 和 Redis 的区别

| 维度 | MySQL | Redis |
| --- | --- | --- |
| 数据模型 | 关系型表结构 | 键值型 |
| 持久化 | 强，适合长期存储 | 可持久化，但常用于短期数据 |
| 查询能力 | 强，支持 SQL | 主要按 key 操作 |
| 适合场景 | 用户、订单、文档、消息 | 缓存、计数器、会话、队列 |
| 事务 | 支持 | 支持有限的原子操作，不是传统关系事务 |

简单理解：

- 用户资料、文档记录、消息历史更适合 MySQL
- 缓存结果、限流计数、短期任务状态更适合 Redis

## 5. 安装和启动

如果本地已经装好了 MySQL，可以直接启动服务。

如果只是临时学习，Docker 会更省事：

```bash
docker run -d \
  --name mysql8 \
  -p 3306:3306 \
  -e MYSQL_ROOT_PASSWORD=123456 \
  -e MYSQL_DATABASE=demo \
  mysql:8
```

进入 MySQL：

```bash
mysql -h 127.0.0.1 -P 3306 -u root -p
```

查看数据库：

```sql
SHOW DATABASES;
```

选择数据库：

```sql
USE demo;
```

## 6. Python 连接 MySQL

Python 项目里很常见的是 `pymysql`。

安装：

```bash
pip install pymysql
```

最基础的连接方式：

```python
import pymysql

conn = pymysql.connect(
    host="127.0.0.1",
    port=3306,
    user="root",
    password="123456",
    database="demo",
    charset="utf8mb4",
    autocommit=False,
)
```

几个常见参数：

- `host`：数据库地址
- `port`：端口，MySQL 默认通常是 `3306`
- `user` / `password`：用户名密码
- `database`：要连接的库
- `charset="utf8mb4"`：推荐写上，避免中文和 emoji 编码问题
- `autocommit=False`：默认手动提交事务

## 7. 连接和游标 `cursor`

你原来笔记里提到“游标对象的具体作用是什么”，可以这样理解：

> 连接 `conn` 负责连数据库，游标 `cursor` 负责执行 SQL 和取结果。

最常见写法：

```python
cursor = conn.cursor()
```

更推荐：

```python
with conn.cursor() as cursor:
    cursor.execute("SELECT 1")
    result = cursor.fetchone()
```

`cursor` 主要负责：

- 执行 SQL
- 传递参数
- 获取查询结果
- 提供 `lastrowid`、`rowcount` 等信息

常见方法：

- `cursor.execute()`：执行一条 SQL
- `cursor.executemany()`：批量执行
- `cursor.fetchone()`：取一条
- `cursor.fetchmany(n)`：取前 `n` 条
- `cursor.fetchall()`：取全部

如果你希望查询结果按字典返回，而不是元组，可以这样写：

```python
import pymysql.cursors

conn = pymysql.connect(
    host="127.0.0.1",
    user="root",
    password="123456",
    database="demo",
    charset="utf8mb4",
    cursorclass=pymysql.cursors.DictCursor,
)
```

这样查出来的数据会更接近：

```python
{"id": 1, "name": "tom"}
```

## 8. 建表和常见字段类型

MySQL 最基础的 SQL 之一就是建表。

示例：

```sql
CREATE TABLE users (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(100) NOT NULL UNIQUE,
    email VARCHAR(200) DEFAULT NULL,
    age INT DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

常见字段类型：

- `INT`：整数
- `BIGINT`：更大的整数
- `VARCHAR(n)`：变长字符串
- `TEXT`：长文本
- `DATETIME`：日期时间
- `DATE`：日期
- `DECIMAL(10,2)`：精确小数
- `BOOLEAN`：布尔，底层通常可看成 `TINYINT`

常见约束：

- `PRIMARY KEY`：主键
- `AUTO_INCREMENT`：自增
- `NOT NULL`：不能为空
- `UNIQUE`：唯一
- `DEFAULT`：默认值
- `FOREIGN KEY`：外键

## 9. 表结构相关 SQL

这部分在实际开发里很常用。

### 9.1 创建表

```sql
CREATE TABLE users (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL
);
```

### 9.2 如果表已存在就跳过

你前面提到的“表已存在怎么办”，对应的就是这个场景。

如果担心“已经有同名表，再创建会报错”，可以写：

```sql
CREATE TABLE IF NOT EXISTS users (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL
);
```

这样当表已存在时，会直接跳过，不会因为同名表报错。

### 9.3 修改表

```sql
ALTER TABLE users ADD COLUMN email VARCHAR(200);
```

### 9.4 删除表

```sql
DROP TABLE users;
```

如果担心表不存在报错：

```sql
DROP TABLE IF EXISTS users;
```

### 9.5 查看建表语句

```sql
SHOW CREATE TABLE users;
```

这个命令非常实用，因为它能直接看到当前表的真实结构、索引、字符集等信息。

## 10. 插入数据 `INSERT`

最基础的插入写法：

```sql
INSERT INTO users (username, email, age)
VALUES ('tom', 'tom@example.com', 18);
```

在 Python 里更推荐参数化写法：

```python
with conn.cursor() as cursor:
    sql = """
    INSERT INTO users (username, email, age)
    VALUES (%s, %s, %s)
    """
    cursor.execute(sql, ("tom", "tom@example.com", 18))
    conn.commit()
```

插入后拿自增主键：

```python
user_id = cursor.lastrowid
```

## 11. 查询数据 `SELECT`

### 11.1 查全部字段

```sql
SELECT * FROM users;
```

### 11.2 只查部分字段

```sql
SELECT id, username FROM users;
```

### 11.3 带条件查询

```sql
SELECT id, username
FROM users
WHERE age >= 18;
```

### 11.4 排序

```sql
SELECT id, username
FROM users
ORDER BY created_at DESC;
```

### 11.5 分页

```sql
SELECT id, username
FROM users
ORDER BY id DESC
LIMIT 10 OFFSET 0;
```

也常写成：

```sql
LIMIT 0, 10;
```

## 12. 更新数据 `UPDATE`

```sql
UPDATE users
SET email = 'new@example.com'
WHERE id = 1;
```

一定要注意：

> `UPDATE` 不写 `WHERE`，会更新整张表。

Python 示例：

```python
with conn.cursor() as cursor:
    sql = "UPDATE users SET email = %s WHERE id = %s"
    affected_rows = cursor.execute(sql, ("new@example.com", 1))
    conn.commit()
    print(affected_rows)
```

## 13. 删除数据 `DELETE`

```sql
DELETE FROM users
WHERE id = 1;
```

同样要注意：

> `DELETE` 不写 `WHERE`，会删整张表的数据。

如果你是想删整张表但保留结构，也可以：

```sql
TRUNCATE TABLE users;
```

## 14. 条件查询、排序、分组

这些是 SQL 里非常高频的能力。

### 14.1 `WHERE`

```sql
SELECT * FROM users WHERE age >= 18;
```

### 14.2 `ORDER BY`

```sql
SELECT * FROM users ORDER BY id DESC;
```

### 14.3 `LIMIT`

```sql
SELECT * FROM users LIMIT 20;
```

### 14.4 `GROUP BY`

```sql
SELECT status, COUNT(*) AS total
FROM tasks
GROUP BY status;
```

### 14.5 `HAVING`

`HAVING` 通常配合分组结果使用：

```sql
SELECT status, COUNT(*) AS total
FROM tasks
GROUP BY status
HAVING total > 10;
```

## 15. JOIN 关联查询

这是关系型数据库最重要的优势之一。

假设：

- `users` 表存用户
- `documents` 表存文档

查询“每篇文档属于哪个用户”：

```sql
SELECT d.id, d.title, u.username
FROM documents d
JOIN users u ON d.user_id = u.id;
```

常见 JOIN：

- `JOIN` / `INNER JOIN`：两边都能匹配到才返回
- `LEFT JOIN`：左表全部保留，右表匹配不到则为 `NULL`

例如：

```sql
SELECT u.id, u.username, d.title
FROM users u
LEFT JOIN documents d ON u.id = d.user_id;
```

## 16. 索引 `INDEX`

索引的作用可以粗暴理解成：

> 让查询更快，但会增加写入成本和占用空间。

例如给用户名加索引：

```sql
CREATE INDEX idx_users_username ON users(username);
```

适合加索引的字段通常有：

- 经常出现在 `WHERE` 里的字段
- 经常用于排序的字段
- 经常用于 JOIN 的字段
- 唯一约束字段

常见误区：

- 不是索引越多越好
- 很小的表不一定需要索引
- 更新频繁的字段加太多索引会拖慢写入

## 17. 外键 `FOREIGN KEY`

外键用于表达表和表之间的引用关系。

例如：

```sql
CREATE TABLE documents (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT NOT NULL,
    title VARCHAR(200) NOT NULL,
    CONSTRAINT fk_documents_user
        FOREIGN KEY (user_id) REFERENCES users(id)
);
```

它的作用是：

- 保证引用关系合法
- 避免出现“文档指向一个不存在用户”的情况

但很多实际项目里，也会选择在业务层保证关系，而不是强依赖数据库外键。

## 18. 事务 `commit` 和 `rollback`

你原来的笔记里提到“事务提交”，这部分非常重要。

事务适合用于：

- 多条 SQL 必须一起成功
- 中间某一步失败时要整体撤回

示例：

```python
try:
    with conn.cursor() as cursor:
        cursor.execute(
            "INSERT INTO accounts (name, balance) VALUES (%s, %s)",
            ("alice", 1000),
        )
        cursor.execute(
            "INSERT INTO accounts (name, balance) VALUES (%s, %s)",
            ("bob", 500),
        )
    conn.commit()
except Exception:
    conn.rollback()
    raise
```

常见规则：

- 成功后 `conn.commit()`
- 失败时 `conn.rollback()`

如果连接时配置：

```python
autocommit=True
```

就表示每条 SQL 默认自动提交。

学习阶段可以用，但项目里要清楚：

> 一旦涉及多步写操作，通常还是要认真控制事务边界。

## 19. 查询结果获取

这是你原来笔记里已经提到的内容，这里整理成更清晰的版本。

### 19.1 `fetchone()`

只取一条：

```python
row = cursor.fetchone()
```

### 19.2 `fetchmany(n)`

取前 `n` 条：

```python
rows = cursor.fetchmany(10)
```

### 19.3 `fetchall()`

取全部：

```python
rows = cursor.fetchall()
```

### 19.4 `lastrowid`

拿最后插入的自增 ID：

```python
new_id = cursor.lastrowid
```

### 19.5 `rowcount`

看本次 SQL 影响了多少行：

```python
count = cursor.rowcount
```

## 20. `execute()` 和 `executemany()`

### 20.1 `execute()`

执行一条 SQL：

```python
cursor.execute(
    "INSERT INTO users (username, age) VALUES (%s, %s)",
    ("tom", 18),
)
```

### 20.2 `executemany()`

批量执行：

```python
data = [
    ("tom", 18),
    ("alice", 20),
    ("bob", 22),
]

cursor.executemany(
    "INSERT INTO users (username, age) VALUES (%s, %s)",
    data,
)
```

适合：

- 批量插入
- 批量更新同类数据

## 21. 一段比较完整的 PyMySQL 示例

```python
import pymysql
import pymysql.cursors

conn = pymysql.connect(
    host="127.0.0.1",
    port=3306,
    user="root",
    password="123456",
    database="demo",
    charset="utf8mb4",
    cursorclass=pymysql.cursors.DictCursor,
    autocommit=False,
)

try:
    with conn.cursor() as cursor:
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id BIGINT PRIMARY KEY AUTO_INCREMENT,
                username VARCHAR(100) NOT NULL UNIQUE,
                age INT NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        cursor.execute(
            "INSERT INTO users (username, age) VALUES (%s, %s)",
            ("tom", 18),
        )

        new_id = cursor.lastrowid

        cursor.execute(
            "SELECT id, username, age FROM users WHERE id = %s",
            (new_id,),
        )
        row = cursor.fetchone()
        print(row)

    conn.commit()
except Exception:
    conn.rollback()
    raise
finally:
    conn.close()
```

## 22. FastAPI 里怎么用 MySQL

在 FastAPI 项目里，MySQL 常见用途有：

- 存用户
- 存任务记录
- 存会话和消息
- 存文档元数据

最简单的同步示例：

```python
import pymysql
from fastapi import FastAPI

app = FastAPI()

def get_conn():
    return pymysql.connect(
        host="127.0.0.1",
        user="root",
        password="123456",
        database="demo",
        charset="utf8mb4",
    )

@app.get("/users/{user_id}")
def get_user(user_id: int):
    conn = get_conn()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT id, username FROM users WHERE id = %s",
                (user_id,),
            )
            row = cursor.fetchone()
        return {"data": row}
    finally:
        conn.close()
```

不过实际项目里通常会再往前走一步：

- 使用连接池
- 抽 Repository / Service 层
- 使用 SQLAlchemy 等更完整的数据库层

## 23. AI 项目里比较常见的表设计

如果你在做文档问答、RAG、聊天系统，常见会有这些表：

- `users`
- `sessions`
- `messages`
- `documents`
- `document_chunks`
- `tasks`

例如：

- `documents`：存文档标题、路径、状态、所属用户
- `tasks`：存异步任务 ID、状态、错误信息
- `messages`：存对话消息和角色

也就是说：

> MySQL 更适合存“事实记录”和“长期业务数据”，不适合拿来做高频缓存层。

## 24. 常见坑

### 24.1 用字符串拼 SQL

错误示例：

```python
sql = f"SELECT * FROM users WHERE username = '{username}'"
```

这会有 SQL 注入风险。

正确做法：

```python
cursor.execute(
    "SELECT * FROM users WHERE username = %s",
    (username,),
)
```

### 24.2 忘记提交事务

执行了 `INSERT` / `UPDATE` / `DELETE` 之后，如果没有 `commit()`，数据可能不会真正写入。

### 24.3 `UPDATE` / `DELETE` 不带 `WHERE`

这会影响整张表。

### 24.4 滥用 `SELECT *`

开发初期问题不大，但项目里更推荐明确字段，避免：

- 取了不需要的数据
- 表结构变动后影响接口
- 传输和解析成本增加

### 24.5 不建索引或乱建索引

都不对。

应该根据查询模式来设计索引。

### 24.6 字符集没统一

推荐统一使用：

- 数据库字符集：`utf8mb4`
- Python 连接：`charset="utf8mb4"`

### 24.7 把 MySQL 当缓存用

这会让数据库承担不适合它的高频压力。

## 25. 面试常问知识点

### 25.1 MySQL 的事务 ACID

事务的四个核心特性：

- 原子性：要么都成功，要么都失败
- 一致性：事务前后数据要保持业务规则正确
- 隔离性：并发事务之间互不干扰到一定程度
- 持久性：提交后的数据要可靠保存

实际回答时可以结合转账例子：扣钱和加钱必须放在同一个事务里。

### 25.2 常见事务隔离级别

从低到高可以这样记：

| 隔离级别 | 可能问题 |
| --- | --- |
| READ UNCOMMITTED | 脏读、不可重复读、幻读 |
| READ COMMITTED | 不可重复读、幻读 |
| REPEATABLE READ | 理论上可能幻读，MySQL InnoDB 会通过 MVCC 和锁机制处理很多场景 |
| SERIALIZABLE | 隔离最强，并发性能最低 |

常见概念：

- 脏读：读到别人还没提交的数据
- 不可重复读：同一事务里两次读同一行，结果不同
- 幻读：同一事务里两次按条件查询，结果集行数不同

### 25.3 InnoDB 和 MyISAM 的区别

面试里最常回答：

| 对比点 | InnoDB | MyISAM |
| --- | --- | --- |
| 事务 | 支持 | 不支持 |
| 行级锁 | 支持 | 主要是表级锁 |
| 外键 | 支持 | 不支持 |
| 崩溃恢复 | 更强 | 相对弱 |
| 常见程度 | 现在默认常用 | 老项目里可能遇到 |

实际项目里一般优先选择 InnoDB。

### 25.4 索引为什么能加快查询

MySQL InnoDB 的常见索引结构是 B+ 树。

它的好处：

- 树高度低，磁盘 IO 次数少
- 叶子节点有序，适合范围查询
- 查询可以从全表扫描变成按索引定位

但索引不是越多越好，因为写入、更新、删除时也要维护索引。

### 25.5 聚簇索引和非聚簇索引

InnoDB 里：

- 聚簇索引：主键索引，叶子节点存整行数据
- 非聚簇索引：普通二级索引，叶子节点通常存主键值

所以通过普通索引查到主键后，如果还需要其他字段，可能要再回到主键索引查一次，这叫“回表”。

如果查询字段都在索引里，可以直接从索引拿到结果，这叫“覆盖索引”。

### 25.6 联合索引和最左前缀原则

例如有联合索引：

```sql
CREATE INDEX idx_user_status_time ON messages(user_id, status, created_at);
```

它比较适合：

```sql
WHERE user_id = ?
WHERE user_id = ? AND status = ?
WHERE user_id = ? AND status = ? ORDER BY created_at
```

但如果只查：

```sql
WHERE status = ?
```

通常就用不上这个联合索引的完整能力，因为没有从最左边的 `user_id` 开始。

### 25.7 哪些情况容易导致索引失效

常见情况：

- 在索引列上做函数计算
- 对索引列做隐式类型转换
- `LIKE '%xxx'` 这种前缀不确定的模糊查询
- 联合索引不符合最左前缀原则
- 条件选择性太差，优化器判断走全表扫描更划算

真实排查时不要只靠猜，要看 `EXPLAIN`。

### 25.8 `EXPLAIN` 主要看什么

常看这些字段：

- `type`：访问类型，通常希望至少到 `range`、`ref`、`const`
- `key`：实际使用了哪个索引
- `rows`：预估扫描多少行
- `Extra`：是否有 `Using filesort`、`Using temporary`

它的作用是帮助判断 SQL 有没有走索引、扫描范围大不大、排序和临时表成本高不高。

### 25.9 MVCC 是什么

MVCC 可以理解成“多版本并发控制”。

它让读操作在很多场景下不用阻塞写操作，写操作也不用阻塞普通一致性读，从而提高并发性能。

在 InnoDB 里，MVCC 和 undo log、Read View 等机制有关。面试里如果只是基础回答，能说明它解决的是“并发读写时的一致性和性能问题”就够了。

### 25.10 慢查询一般怎么优化

常见步骤：

1. 先用慢查询日志或监控找到慢 SQL
2. 用 `EXPLAIN` 看执行计划
3. 检查 `WHERE`、`JOIN`、`ORDER BY` 是否有合适索引
4. 避免一次查太多字段和太多行
5. 必要时优化表结构、拆分大查询、引入缓存

不要一上来就说“加索引”，要先看 SQL 的真实访问路径。

## 26. 一套比较实用的学习顺序

建议这样学：

1. 先学会创建库、建表、插入、查询、更新、删除
2. 学会 `WHERE`、`ORDER BY`、`LIMIT`
3. 学会 `GROUP BY` 和 `JOIN`
4. 学会索引和事务
5. 学会用 PyMySQL 连接和执行参数化 SQL
6. 最后再接入 FastAPI、Celery、Redis

## 27. 总结

MySQL 的核心价值在于：

- 存长期结构化数据
- 支持 SQL 查询
- 支持关联查询
- 支持事务
- 适合承载业务主数据

对于 AI 项目，可以把它理解成：

- 用户数据存储层
- 会话和消息持久化层
- 文档元数据层
- 任务记录层

如果把你前面几份笔记连起来看，可以把它们理解成一条链：

- FastAPI / Drogon：接请求
- Redis：缓存 / 状态 / 中间层
- Celery：后台异步任务
- MySQL：长期持久化数据

## 28. 参考

- MySQL Official Docs: https://dev.mysql.com/doc/
- PyMySQL Docs: https://pymysql.readthedocs.io/
- SQL Syntax Reference: https://dev.mysql.com/doc/refman/8.0/en/sql-statements.html
