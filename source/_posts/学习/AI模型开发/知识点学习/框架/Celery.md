---
title: "Celery 学习笔记"
date: 2026-04-20 09:03:11
updated: 2026-04-20 09:03:11
categories:
  - "学习"
  - "AI模型开发"
  - "知识点学习"
  - "框架"
permalink: /notes/ai模型开发/知识点学习/框架/celery/
---

# Celery 学习笔记

## 1. Celery 是什么

Celery 是一个基于 Python 的分布式任务队列，用来把“耗时任务”从主业务流程里拆出去异步执行。

典型场景：

- 发送邮件、短信、消息通知
- 文件转码、图片处理、PDF 解析
- 大模型推理、批量数据处理
- 定时任务、周期性任务
- 需要失败重试的后台任务

先记住最实用的分工：FastAPI 负责接请求和返回结果，Celery 负责把耗时任务放到后台慢慢执行。

## 2. 为什么要用 Celery

如果一个接口内部要做很久的事情，比如：

- 调第三方接口要 10 秒
- 处理一批文件要 2 分钟
- 模型推理要占满 CPU / GPU

那就不适合一直阻塞 HTTP 请求。更合理的做法是：

1. FastAPI 收到请求
2. 把任务丢给 Celery
3. 立刻返回一个 `task_id`
4. 前端或调用方再通过 `task_id` 查询执行结果

这样接口响应会更快，系统也更容易扩展。

## 3. Celery 核心架构

Celery 主要由 3 个角色组成：

### 3.1 Broker

消息中间件，负责存放“待执行任务”。

常见选择：

- Redis
- RabbitMQ

它就是任务排队和等待消费的地方。

### 3.2 Worker

执行任务的工作进程。

它会不断从 Broker 中取任务，然后真正执行 Python 函数。

### 3.3 Result Backend

结果存储，用来保存任务状态和返回值。

常见选择：

- Redis
- Database
- RPC

如果你只关心“任务有没有执行”，不关心返回结果，也可以不配置结果后端；但实际项目里通常还是会配置，方便查状态。

## 4. 工作流程

Celery 的完整链路可以这样理解：

1. 客户端或 FastAPI 调用一个 Celery 任务
2. 任务消息被发送到 Broker
3. Worker 从 Broker 取出任务
4. Worker 执行任务函数
5. 执行结果和状态写入 Result Backend
6. 业务侧通过 `task_id` 查询任务状态和结果

对应的状态通常有：

- `PENDING`：任务还没开始，或者还查不到
- `STARTED`：任务已开始执行
- `SUCCESS`：执行成功
- `FAILURE`：执行失败
- `RETRY`：正在重试
- `REVOKED`：任务被撤销

说明：

- 默认不一定会看到 `STARTED`
- 如果想更明确地看到运行中状态，可以开启 `task_track_started=True`

## 5. 安装

```bash
pip install celery redis
```

如果使用 Redis 作为 Broker 和 Result Backend，需要先启动 Redis。

## 6. 最小可运行示例

### 6.1 编写 Celery 应用

文件：`celery_app.py`

```python
from celery import Celery

app = Celery(
    "demo",
    broker="redis://127.0.0.1:6379/1",
    backend="redis://127.0.0.1:6379/2",
)

app.conf.update(
    task_track_started=True,
    timezone="Asia/Shanghai",
)
```

说明：

- `/1` 表示 Redis 的第 1 个逻辑库，用来当 Broker
- `/2` 表示 Redis 的第 2 个逻辑库，用来存任务结果
- Broker 和 Backend 分开写更清晰，排查问题也更方便

### 6.2 定义任务

文件：`tasks.py`

```python
import time

from celery_app import app

@app.task
def add(a: int, b: int) -> int:
    time.sleep(3)
    return a + b
```

这里的 `add` 虽然是普通 Python 函数，但加了 `@app.task` 之后，它就成了 Celery 任务。

### 6.3 启动 Worker

```bash
celery -A tasks worker -l info
```

含义：

- `-A tasks`：表示 Celery 应用和任务定义在 `tasks.py`
- `worker`：启动 worker 进程
- `-l info`：日志级别为 `info`

### 6.4 提交任务

```python
from tasks import add

result = add.delay(3, 5)
print(result.id)
```

注意：

- `delay()` 只是“提交任务”
- 它不会在当前进程里同步执行
- 返回的是 `AsyncResult`
- 真正执行任务的是独立的 Worker

### 6.5 查询任务结果

```python
from celery.result import AsyncResult

from celery_app import app

task = AsyncResult("任务ID", app=app)

print(task.status)
print(task.successful())

if task.successful():
    print(task.get())
```

常用属性和方法：

- `task.id`：任务 ID
- `task.status`：任务状态
- `task.successful()`：是否执行成功
- `task.failed()`：是否执行失败
- `task.ready()`：任务是否结束
- `task.get()`：获取结果，可能会阻塞

## 7. `delay()` 和 `apply_async()` 的区别

### 7.1 `delay()`

最简单的调用方式，其实就是 `apply_async()` 的简写。

```python
add.delay(3, 5)
```

适合：

- 普通异步提交
- 不需要额外参数时

### 7.2 `apply_async()`

更灵活，支持倒计时、定时执行、路由到指定队列等。

```python
add.apply_async(args=[3, 5], countdown=10)
```

常见参数：

- `args` / `kwargs`：任务参数
- `countdown=10`：10 秒后执行
- `eta=...`：指定某个时间点执行
- `expires=60`：60 秒后任务过期
- `queue="email"`：指定进入哪个队列
- `routing_key="task.email"`：指定路由键

结论：

- 简单任务用 `delay()`
- 有调度需求时用 `apply_async()`

## 8. 任务重试

很多后台任务依赖外部资源，比如：

- 第三方 API
- 数据库
- 对象存储
- 模型服务

这些服务不稳定时，直接失败往往不合理，更适合自动重试。

```python
from celery_app import app

@app.task(bind=True, max_retries=3, default_retry_delay=5)
def fetch_remote_data(self, url: str):
    try:
        # 这里假设会调用外部接口
        raise RuntimeError("temporary error")
    except Exception as exc:
        raise self.retry(exc=exc)
```

说明：

- `bind=True` 后，任务第一个参数会变成 `self`
- `self.retry(...)` 可以重新入队
- `max_retries=3` 表示最多重试 3 次
- `default_retry_delay=5` 表示默认每次间隔 5 秒

适合有“短暂失败可能恢复”的任务，不适合参数本身就错误的任务。

## 9. 队列与路由

当任务类型越来越多时，通常不会把所有任务都丢到一个队列里。

常见拆法：

- `default`：普通任务
- `email`：发邮件
- `file`：文件处理
- `gpu`：模型推理

这样可以让不同 Worker 只处理自己擅长的任务。

```python
from celery import Celery
from kombu import Exchange, Queue

app = Celery("demo")

app.conf.task_queues = (
    Queue("default", Exchange("default"), routing_key="default"),
    Queue("file", Exchange("file"), routing_key="file.process"),
    Queue("gpu", Exchange("gpu"), routing_key="gpu.infer"),
)

app.conf.task_routes = {
    "tasks.process_pdf": {
        "queue": "file",
        "routing_key": "file.process",
    },
    "tasks.run_inference": {
        "queue": "gpu",
        "routing_key": "gpu.infer",
    },
}
```

启动指定队列的 Worker：

```bash
celery -A tasks worker -Q file -l info
celery -A tasks worker -Q gpu -l info
```

这样做的好处：

- 避免耗时任务阻塞普通任务
- 可以按机器能力拆分 Worker
- GPU 任务和 CPU 任务可以隔离

## 10. 定时任务

Celery 可以配合 `celery beat` 做周期任务。

例如：

- 每天凌晨清理临时文件
- 每小时刷新缓存
- 每 10 分钟同步一次数据

```python
from celery.schedules import crontab

app.conf.beat_schedule = {
    "cleanup-temp-files": {
        "task": "tasks.cleanup_temp_files",
        "schedule": crontab(hour=3, minute=0),
    },
}
```

启动：

```bash
celery -A tasks beat -l info
```

如果要实际执行任务，除了 `beat` 还要有 `worker` 在跑。

## 11. FastAPI 和 Celery 怎么配合

最常见的配合方式是：

1. FastAPI 暴露 HTTP 接口
2. 接口中调用 Celery 提交任务
3. Celery Worker 在后台执行
4. 再通过一个查询接口返回任务状态/结果

### 11.1 什么时候用 `BackgroundTasks`，什么时候用 Celery

FastAPI 自带 `BackgroundTasks`，但它和 Celery 不是一类东西。

`BackgroundTasks` 更适合：

- 很轻量的后台操作
- 跟当前服务进程强绑定
- 不要求失败重试
- 不要求多机器扩展

Celery 更适合：

- 任务耗时长
- 任务量大
- 需要重试
- 需要队列隔离
- 需要多个 Worker 扩展
- 需要独立于 Web 进程运行

一句话：

> 轻任务用 `BackgroundTasks`，重任务用 Celery。

## 12. FastAPI + Celery 案例 1：提交任务并查询状态

这是最常见的模式。

### 12.1 目录结构

```text
project/
├── main.py
├── celery_app.py
└── tasks.py
```

### 12.2 `celery_app.py`

```python
from celery import Celery

celery_app = Celery(
    "fastapi_demo",
    broker="redis://127.0.0.1:6379/1",
    backend="redis://127.0.0.1:6379/2",
)

celery_app.conf.update(
    task_track_started=True,
    result_expires=3600,
)
```

### 12.3 `tasks.py`

```python
import time

from celery_app import celery_app

@celery_app.task(name="tasks.long_time_add")
def long_time_add(a: int, b: int) -> int:
    time.sleep(10)
    return a + b
```

### 12.4 `main.py`

```python
from fastapi import FastAPI
from celery.result import AsyncResult

from celery_app import celery_app
from tasks import long_time_add

app = FastAPI()

@app.post("/tasks/add")
def create_add_task(a: int, b: int):
    task = long_time_add.delay(a, b)
    return {
        "message": "task submitted",
        "task_id": task.id,
    }

@app.get("/tasks/{task_id}")
def get_task_result(task_id: str):
    task = AsyncResult(task_id, app=celery_app)

    response = {
        "task_id": task.id,
        "status": task.status,
    }

    if task.successful():
        response["result"] = task.result
    elif task.failed():
        response["error"] = str(task.result)

    return response
```

### 12.5 启动方式

启动 FastAPI：

```bash
uvicorn main:app --reload
```

启动 Worker：

```bash
celery -A tasks worker -l info
```

请求流程：

1. 调 `POST /tasks/add?a=3&b=5`
2. 接口立即返回 `task_id`
3. 再调 `GET /tasks/{task_id}`
4. 看任务是 `PENDING`、`STARTED` 还是 `SUCCESS`

这个模式非常适合前后端分离项目。

## 13. FastAPI + Celery 案例 2：文件处理任务

这个场景很常见，比如：

- 上传 PDF 后做文本提取
- 上传图片后做缩略图
- 上传音频后做转写

### 13.1 设计原则

不要把 `UploadFile`、数据库连接、请求对象直接传给 Celery。

原因：

- Celery 任务参数通常需要能序列化
- 这些对象往往不能直接被序列化
- 跨进程后对象本身也失效了

正确做法：

1. FastAPI 先把文件保存到磁盘或对象存储
2. 把 `file_path` 或 `file_url` 传给 Celery
3. Worker 根据路径再去处理文件

### 13.2 示例

```python
from pathlib import Path
import shutil
import uuid

from fastapi import FastAPI, File, UploadFile

from tasks import process_pdf

app = FastAPI()

UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)

@app.post("/files/pdf")
def upload_pdf(file: UploadFile = File(...)):
    file_id = f"{uuid.uuid4()}_{file.filename}"
    save_path = UPLOAD_DIR / file_id

    with save_path.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    task = process_pdf.delay(str(save_path))

    return {
        "file_path": str(save_path),
        "task_id": task.id,
    }
```

对应的 Celery 任务：

```python
from celery_app import celery_app

@celery_app.task(name="tasks.process_pdf")
def process_pdf(file_path: str):
    # 这里做 PDF 文本抽取、切分、向量化等操作
    return {
        "file_path": file_path,
        "message": "processed",
    }
```

这个思路很适合 AI 项目里的文档解析链路。

## 14. FastAPI + Celery 案例 3：模型推理任务

对于 AI 模型开发，这个场景更有代表性。

例如：

- 文本摘要
- 图片分类
- 批量 embedding
- 长文本抽取

### 14.1 为什么适合 Celery

因为模型推理通常具备这些特点：

- 耗时不稳定
- 资源消耗高
- 可能需要排队
- 可能要分 CPU / GPU Worker

### 14.2 一个简化版例子

```python
from fastapi import FastAPI

from tasks import run_inference

app = FastAPI()

@app.post("/infer")
def create_inference_task(text: str):
    task = run_inference.apply_async(
        kwargs={"text": text},
        queue="gpu",
        routing_key="gpu.infer",
    )
    return {"task_id": task.id}
```

对应任务：

```python
import time

from celery_app import celery_app

@celery_app.task(name="tasks.run_inference")
def run_inference(text: str):
    time.sleep(5)
    return {
        "text": text,
        "label": "positive",
        "score": 0.98,
    }
```

这里的重点不在模型代码本身，而在架构思路：

- API 层只负责接收请求
- 推理层在 Worker 中执行
- GPU 任务路由到专门队列
- 可以单独扩容推理 Worker

如果将来一张 GPU 卡只跑一个 Worker，也很好管理。

## 15. 实战里很重要的细节

### 15.1 任务参数尽量简单

建议只传这些：

- 字符串
- 数字
- 布尔值
- 列表 / 字典
- 文件路径
- 数据库主键 ID

不建议直接传：

- 数据库 Session
- 请求对象 `Request`
- `UploadFile`
- 大模型实例
- 打开的文件句柄

原则：

> 任务参数最好是“可序列化、可重建、可追踪”的。

### 15.2 任务尽量幂等

幂等的意思是：同一个任务重复执行多次，结果最好一致，或者至少不会造成严重副作用。

因为这些情况都可能导致重复执行：

- Worker 崩溃
- 消息重复投递
- 任务重试
- 手动补偿

例如发通知、写数据库、扣费等场景，幂等性非常重要。

### 15.3 不要在 API 进程里执行重活

FastAPI 本身应该尽量保持：

- 响应快
- 逻辑薄
- 只做参数校验、鉴权、任务分发

重计算、长耗时 IO、批处理，尽量放 Worker。

### 15.4 结果不是必须永久保存

很多项目会犯一个问题：任务结果一直存 Redis，时间一久就堆积很多垃圾数据。

可以设置：

- `result_expires`
- 任务完成后主动清理
- 只保留必要结果，不保留大对象

如果结果很大，不要直接把大块内容塞进 Redis，建议落库或存文件，再返回引用地址。

### 15.5 错误处理不要只靠日志

建议至少做到：

- 任务失败后能看到 `FAILURE`
- 能根据 `task_id` 查到失败原因
- 关键任务开启自动重试
- 必要时记录业务日志或落库

### 15.6 CPU / GPU / IO 任务分开

这点在 AI 项目里尤其重要。

建议：

- 文件下载、上传、请求第三方 API 放一个队列
- CPU 预处理放一个队列
- GPU 推理放一个队列

这样不会出现“一个长推理任务把所有普通任务都堵住”的问题。

### 15.7 Worker 并发要按任务类型调

Celery 的并发不是越大越好，要看任务类型。

一般经验：

- IO 密集型任务可以适当提高并发
- CPU 密集型任务并发通常不要超过 CPU 核心数太多
- GPU 推理任务通常一个 Worker 进程绑定一张卡，甚至一个队列只开 `--concurrency=1`

例如 GPU Worker 常见写法：

```bash
celery -A tasks worker -Q gpu --concurrency=1 -l info
```

如果推理模型本身已经很吃显存，再盲目开高并发，反而容易把机器打爆。

## 16. 常见坑

### 16.1 任务提交成功，但一直不执行

通常排查：

- Redis 是否启动
- Worker 是否启动
- `-A` 指向的模块是否正确
- 任务有没有注册到当前 Worker
- 是否路由到了某个没人消费的队列

### 16.2 能查到任务 ID，但拿不到结果

通常是：

- 没配置 `backend`
- `task_id` 查错了
- 结果过期被清掉了

### 16.3 任务函数里引用了 Web 层对象

比如：

- 直接把 `Request` 传进任务
- 把 SQLAlchemy Session 传进任务
- 把上传文件对象传进任务

这类设计一般都会有问题。任务应该依赖“可序列化参数”，不要依赖当前请求上下文。

### 16.4 把 Celery 当成同步 RPC 用

有些人虽然用了 Celery，但提交完任务后立刻 `.get()` 等待结果，这样就又退回同步调用了。

如果接口本身必须立刻拿到结果，那就要重新评估：

- 这个任务是否真的适合放到 Celery
- 是否应该走同步推理接口
- 是否应该拆成“提交任务 + 轮询结果”

## 17. 一套比较实用的学习顺序

建议按这个顺序掌握：

1. 先跑通最小示例
2. 理解 `delay()`、`AsyncResult`
3. 学会查任务状态
4. 学会重试
5. 学会队列与路由
6. 再接入 FastAPI
7. 最后再做定时任务、监控、扩容

## 18. 总结

Celery 的本质就是：

- 把耗时任务从主线程 / 主服务里剥离出去
- 通过消息队列异步执行
- 通过 Worker 扩展执行能力
- 通过结果后端查询状态和结果

对于 FastAPI 项目，可以把它理解成一组固定分工：

- FastAPI：对外提供 API
- Redis / RabbitMQ：负责排队
- Celery Worker：真正执行任务
- Result Backend：保存状态和结果

如果项目里已经出现“接口慢、任务重、需要重试、需要排队、需要异步处理”的问题，那 Celery 基本就是很自然的选择。

## 19. 参考

- Celery First Steps: https://docs.celeryq.dev/en/main/getting-started/first-steps-with-celery.html
- Celery Calling Tasks: https://docs.celeryq.dev/en/main/userguide/calling.html
- Celery Tasks Guide: https://docs.celeryq.dev/en/main/userguide/tasks.html
- Celery Routing Tasks: https://docs.celeryq.dev/en/main/userguide/routing.html
- Celery Configuration: https://docs.celeryq.dev/en/main/userguide/configuration.html
- FastAPI Background Tasks: https://fastapi.tiangolo.com/tutorial/background-tasks/
