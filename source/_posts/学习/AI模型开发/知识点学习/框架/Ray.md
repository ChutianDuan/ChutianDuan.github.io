---
title: "Ray 学习笔记"
date: 2026-04-20 09:03:11
updated: 2026-04-20 09:03:11
categories:
  - "学习"
  - "AI模型开发"
  - "知识点学习"
  - "框架"
permalink: /notes/ai模型开发/知识点学习/框架/ray/
---

# Ray 学习笔记

截至 2026-03-30，这份笔记主要参考：

- Ray 官方文档 `2.54.x`
- Celery 官方稳定版文档 `5.6.x`

如果当前目标是做 AI 模型开发，可以先抓住这个区分：

> Celery 更像“任务队列和后台调度器”，Ray 更像“分布式计算和 GPU 资源调度层”。

---

## 1. Ray 是什么

Ray 是一个 Python 分布式计算框架，用来把普通 Python 代码扩展到：

- 多进程
- 多机
- 多 GPU
- 分布式训练
- 批量推理
- 在线推理服务

它的核心不是“消息队列”，而是“把 Python 函数和类，变成可调度的分布式任务”。

Ray 真正提供的是一套调度能力：普通的 Python 函数和类，加上 `@ray.remote` 之后，就能被当成分布式任务或远程 actor 来运行。

---

## 2. Ray 适合什么场景

Ray 典型适合这些场景：

- 批量 embedding 生成
- 多卡模型推理
- 大规模数据预处理
- 分布式训练
- 超参搜索
- 需要把模型常驻在 GPU 上的服务
- 复杂 Python 工作流并行化

如果只是这些场景，通常不一定要用 Ray：

- 发送短信、邮件、通知
- 定时任务
- 普通后台异步任务
- 只需要重试、延迟执行、任务链

这些更偏 Celery 的强项。

---

## 3. Ray 的核心概念

Ray 入门先掌握 4 个东西：

### 3.1 Task

Task 就是“远程函数”。

特点：

- 无状态
- 适合并行执行独立任务
- 用 `@ray.remote` 标记

### 3.2 Actor

Actor 就是“远程对象”。

特点：

- 有状态
- 适合模型常驻内存 / GPU
- 适合连接池、模型池、缓存、参数服务

### 3.3 ObjectRef

Ray 不会马上把结果返回给你，而是先返回一个“对象引用”。

- `xxx.remote()` 返回的通常是 `ObjectRef`
- 用 `ray.get()` 才真正取回结果

这点很像 `Future`。

### 3.4 Object Store

Ray 有自己的对象存储。

- task / actor 的返回值会放到对象存储里
- 大对象可以先 `ray.put()`
- 后续多个任务共享这个引用，避免重复拷贝

---

## 4. 最小入门示例

### 4.1 安装

```bash
pip install -U "ray[default]"
```

如果你还要用训练或数据处理：

```bash
pip install -U "ray[train]" "ray[data]" torch
```

### 4.2 启动本地 Ray

最简单的方式：

```python
import ray

ray.init()
```

说明：

- `ray.init()` 会连接已有本地 Ray，或者启动一个新的本地实例
- 如果你是 Celery worker 或生产环境进程，通常更建议显式连接已有集群：`ray.init(address="auto")`

### 4.3 第一个 Task

```python
import ray

ray.init()

@ray.remote
def square(x: int) -> int:
    return x * x

refs = [square.remote(i) for i in range(8)]
results = ray.get(refs)
print(results)
```

你要关注的是：

- `@ray.remote`：把普通函数变成远程函数
- `square.remote(i)`：不是本地调用，而是提交任务
- `ray.get(refs)`：拿回结果

### 4.4 第一个 Actor

```python
import ray

ray.init()

@ray.remote
class Counter:
    def __init__(self):
        self.value = 0

    def incr(self, n: int = 1):
        self.value += n
        return self.value

    def get(self):
        return self.value

counter = Counter.remote()

ray.get(counter.incr.remote())
ray.get(counter.incr.remote(10))
print(ray.get(counter.get.remote()))
```

什么时候该用 Actor：

- 模型加载很慢，不想每次任务都重新加载
- 需要在内存里保留状态
- 要做 GPU 常驻推理

### 4.5 共享大对象

```python
import numpy as np
import ray

ray.init()

@ray.remote
def compute_sum(arr):
    return arr.sum()

big_array_ref = ray.put(np.ones((10000, 1000)))
result = ray.get(compute_sum.remote(big_array_ref))
print(result)
```

经验：

- 小参数直接传
- 大对象尽量 `ray.put()`

---

## 5. Ray 常用 API

### 5.1 `ray.init()`

用于启动或连接 Ray。

常见写法：

```python
ray.init()
ray.init(address="auto")
ray.init(address="ray://<head-ip>:10001")
```

含义：

- `ray.init()`：本地开发最方便
- `address="auto"`：只连接已有集群，如果没集群会报错，适合生产环境
- `ray://...`：Ray Client 方式连接远端集群

### 5.2 `ray.get()`

取结果。

```python
value = ray.get(ref)
values = ray.get(refs)
```

### 5.3 `ray.wait()`

适合任务很多时，先消费一部分结果，避免一次性堆太多任务或结果。

```python
ready, pending = ray.wait(refs, num_returns=1)
result = ray.get(ready[0])
```

### 5.4 `ray.put()`

把大对象放进 Ray 对象存储。

```python
obj_ref = ray.put(big_object)
```

---

## 6. Task 和 Actor 怎么选

| 场景 | 更适合 |
| --- | --- |
| 每个任务彼此独立、无状态 | Task |
| 模型要常驻内存 / GPU | Actor |
| 批量推理 worker 池 | Actor |
| 简单 map 并行 | Task |
| 连接池 / 缓存 / 参数服务 | Actor |

最常见的 AI 场景经验是：

- CPU 并行清洗数据：Task
- 模型推理：Actor
- 分布式训练：优先用 Ray Train，而不是自己手搓 Ray Core

---

## 7. 从本地到集群

### 7.1 单机开发

直接：

```python
ray.init()
```

### 7.2 手动启动单机 / 多机集群

头节点：

```bash
ray start --head --port=6379
```

工作节点：

```bash
ray start --address=<head-node-ip>:6379
```

Python 里连接：

```python
import ray

ray.init(address="auto")
```

### 7.3 GPU 机器上限制可见显卡

如果你只想让 Ray 看到部分 GPU：

```bash
CUDA_VISIBLE_DEVICES=1,3 ray start --head --num-gpus=2
```

这在一台机器上做资源隔离时很有用。

---

## 8. 多张显卡怎么用

这部分是 Ray 很强的一块。

你先记住结论：

- 单个任务 / Actor 用几张卡，就声明几张
- 多个任务并行吃多卡，让 Ray 调度
- 训练任务优先用 Ray Train
- 批量推理优先用 Actor 池或 Ray Data

### 8.1 一张卡对应一个 Actor

这是最常见的“多卡推理”写法。

```python
import os
import ray

ray.init(num_gpus=4)

@ray.remote(num_gpus=1)
class GPUWorker:
    def info(self):
        return {
            "gpu_ids": ray.get_runtime_context().get_accelerator_ids()["GPU"],
            "cuda_visible_devices": os.environ.get("CUDA_VISIBLE_DEVICES"),
        }

workers = [GPUWorker.remote() for _ in range(4)]
print(ray.get([worker.info.remote() for worker in workers]))
```

效果：

- 每个 Actor 占 1 张 GPU
- Ray 会把不同 Actor 调度到不同卡
- 大多数深度学习框架会自动遵守 `CUDA_VISIBLE_DEVICES`

### 8.2 单个任务使用多张卡

如果一个任务本身就要吃多卡：

```python
import ray

ray.init(num_gpus=4)

@ray.remote(num_gpus=2)
def train_one_job():
    import os
    return os.environ.get("CUDA_VISIBLE_DEVICES")

print(ray.get(train_one_job.remote()))
```

这适合：

- 单个训练任务需要 2 卡 / 4 卡
- 单个推理进程要占多卡

### 8.3 分数 GPU

如果模型很小，也可以共享 GPU：

```python
import ray
import time

ray.init(num_gpus=1)

@ray.remote(num_gpus=0.25)
def small_infer(x):
    time.sleep(1)
    return x

print(ray.get([small_infer.remote(i) for i in range(4)]))
```

注意：

- 分数 GPU 只是“调度上的份额”
- 显存控制还是你自己负责
- 小模型、embedding、小批量推理更适合这样做

### 8.4 多卡训练优先用 Ray Train

如果你在做训练，不建议直接自己拼很多 `@ray.remote`。

更推荐：

```python
from ray.train import ScalingConfig
from ray.train.torch import TorchTrainer, get_device

def train_loop(config):
    import torch

    device = get_device()
    model = torch.nn.Linear(10, 1).to(device)
    x = torch.randn(32, 10, device=device)
    y = model(x)
    loss = y.mean()
    loss.backward()

trainer = TorchTrainer(
    train_loop,
    scaling_config=ScalingConfig(
        num_workers=4,
        use_gpu=True,
    ),
)

trainer.fit()
```

这表示：

- 4 个 worker
- 每个 worker 1 张 GPU
- 总共 4 张 GPU

### 8.5 一个 worker 吃多张卡

```python
from ray.train import ScalingConfig
from ray.train.torch import TorchTrainer, get_devices

def train_loop(config):
    import torch

    devices = get_devices()
    print(devices)

trainer = TorchTrainer(
    train_loop,
    scaling_config=ScalingConfig(
        num_workers=2,
        use_gpu=True,
        resources_per_worker={"GPU": 2},
    ),
)

trainer.fit()
```

这表示：

- 2 个 worker
- 每个 worker 2 张 GPU
- 总共 4 张 GPU

适合：

- 每个 worker 本身要做张量并行
- 每个训练进程要 2 卡或更多

### 8.6 需要成组预留资源时，用 Placement Group

有些任务需要“成组占住资源”，比如：

- 2 个 actor 必须同时启动
- 一个训练 job 要一次性拿到 `2 CPU + 2 GPU`
- 希望资源尽量在同一台机器

这时用 Placement Group。

```python
import ray
from ray.util.placement_group import placement_group
from ray.util.scheduling_strategies import PlacementGroupSchedulingStrategy

ray.init(num_gpus=2, num_cpus=8)

pg = placement_group(
    [{"CPU": 2, "GPU": 1}, {"CPU": 2, "GPU": 1}],
    strategy="STRICT_PACK",
)
ray.get(pg.ready())

@ray.remote(num_cpus=2, num_gpus=1)
class TrainerWorker:
    def ready(self):
        return "ok"

workers = [
    TrainerWorker.options(
        scheduling_strategy=PlacementGroupSchedulingStrategy(
            placement_group=pg,
            placement_group_bundle_index=i,
        )
    ).remote()
    for i in range(2)
]

print(ray.get([w.ready.remote() for w in workers]))
```

`STRICT_PACK` 的意思是：

- 所有 bundle 必须放在同一台节点上
- 如果放不下，就直接失败

这对多卡训练很常见。

---

## 9. AI 场景下更实用的写法

### 9.1 模型常驻 GPU 的 Actor

如果你做 embedding、rerank、分类、OCR、ASR，常见需求是：

- 模型初始化很慢
- 不想每个请求都重新加载模型
- 想让不同 worker 常驻不同 GPU

这时最实用的方案往往是：

```python
import ray

ray.init(num_gpus=2)

@ray.remote(num_gpus=1)
class EmbeddingWorker:
    def __init__(self, model_name: str):
        from sentence_transformers import SentenceTransformer

        self.model = SentenceTransformer(model_name, device="cuda")

    def encode(self, texts: list[str]):
        vectors = self.model.encode(texts, normalize_embeddings=True)
        return vectors.tolist()

workers = [
    EmbeddingWorker.remote("BAAI/bge-small-zh-v1.5")
    for _ in range(2)
]
```

优势：

- 模型只加载一次
- Ray 自动把 worker 分到不同 GPU
- 适合批量任务和服务化场景

### 9.2 批量推理更推荐 Ray Data

如果是大批量离线推理，比如：

- 给 100 万条文本做 embedding
- 大量图片跑分类 / OCR
- 多卡批量推理

Ray Data 一般比你自己手写 `for + remote()` 更省心。

```python
import pandas as pd
import ray

ray.init()

class EmbeddingPredictor:
    def __init__(self, model_name: str):
        from sentence_transformers import SentenceTransformer

        self.model = SentenceTransformer(model_name, device="cuda")

    def __call__(self, batch: pd.DataFrame) -> pd.DataFrame:
        batch = batch.copy()
        batch["embedding"] = self.model.encode(batch["text"].tolist()).tolist()
        return batch

ds = ray.data.from_items(
    [{"text": f"sample {i}"} for i in range(1000)]
)

result_ds = ds.map_batches(
    EmbeddingPredictor,
    fn_constructor_args=("BAAI/bge-small-zh-v1.5",),
    batch_size=64,
    batch_format="pandas",
    compute=ray.data.ActorPoolStrategy(size=4),
    num_gpus=1,
)

print(result_ds.take(2))
```

什么时候优先考虑 Ray Data：

- 数据量大
- 希望自动做并行读取和批处理
- 想用 actor pool 跑多卡离线推理

---

## 10. Ray 和 Celery 的区别

很多人第一次会问：

> 我已经有 Celery 了，还要不要 Ray？

答案通常是：

> 不是替代关系，而是职责不同。

### 10.1 一张表看区别

| 维度 | Celery | Ray |
| --- | --- | --- |
| 核心定位 | 分布式任务队列 | 分布式计算框架 |
| 擅长 | 异步任务、重试、延迟、队列路由 | 并行计算、状态 Actor、GPU 调度 |
| GPU 感知 | 很弱 | 很强 |
| 模型常驻 | 不擅长 | 很擅长 |
| 大对象共享 | 一般 | 很强 |
| 训练 / 多卡 / 集群算力 | 不擅长 | 强项 |
| 业务工作流编排 | 强 | 一般 |

### 10.2 什么时候只用 Celery

- 发通知
- 发邮件
- 定时任务
- 任务重试
- 后台轻量业务任务

### 10.3 什么时候只用 Ray

- 分布式训练
- 多 GPU 推理
- 批量 embedding
- 大规模离线数据处理
- 需要模型常驻内存 / GPU

### 10.4 什么时候 Ray + Celery 联合

这是很常见、也很推荐的工程做法：

- Celery 负责“接住业务异步任务”
- Ray 负责“真正吃 CPU / GPU 算力”

最典型架构：

```text
FastAPI / Django
    -> 提交 Celery 任务
    -> Celery worker 收到任务
    -> Celery worker 把重计算任务提交给 Ray
    -> Ray task / actor 在 CPU / GPU 上执行
    -> Celery 记录状态、重试、结果
```

这时职责很清晰：

- Celery：任务排队、重试、路由、延迟调度、业务集成
- Ray：并行计算、多机、多卡、模型常驻

---

## 11. Ray + Celery 推荐落地方式

这一节不是某个“官方一键集成组件”的说明，而是基于 Ray 官方能力和 Celery 官方能力整理出来的工程实践。

### 11.1 推荐原则

推荐这样设计：

- 不要让 Celery 自己直接“管理 GPU”
- 不要每个 Celery 任务里都临时启动一个 Ray 集群
- Celery worker 只负责连接已有 Ray 集群并下发任务
- 模型尽量放到 Ray Actor 里常驻

一句话：

> Celery 做任务层，Ray 做算力层。

### 11.2 最实用的方案：Celery 任务内部调用 Ray Actor

```python
from celery import Celery
import ray

celery_app = Celery(
    "demo",
    broker="redis://127.0.0.1:6379/1",
    backend="redis://127.0.0.1:6379/2",
)

def ensure_ray():
    if not ray.is_initialized():
        ray.init(address="auto", namespace="ml")

@ray.remote(num_gpus=1)
class EmbeddingWorker:
    def __init__(self, model_name: str):
        from sentence_transformers import SentenceTransformer

        self.model = SentenceTransformer(model_name, device="cuda")

    def encode(self, texts: list[str]):
        return self.model.encode(texts).tolist()

def get_embedding_worker():
    ensure_ray()
    try:
        return ray.get_actor("embedding_worker")
    except ValueError:
        return EmbeddingWorker.options(
            name="embedding_worker",
            lifetime="detached",
            get_if_exists=True,
        ).remote("BAAI/bge-small-zh-v1.5")

@celery_app.task(
    bind=True,
    autoretry_for=(Exception,),
    retry_backoff=True,
    max_retries=3,
)
def build_embeddings(self, texts: list[str]):
    worker = get_embedding_worker()
    ref = worker.encode.remote(texts)
    vectors = ray.get(ref)
    return {
        "count": len(vectors),
        "vectors": vectors,
    }
```

这套写法的好处：

- Celery 有重试和任务状态
- Ray Actor 让模型只加载一次
- GPU 真正由 Ray 调度
- Celery 不直接碰 `CUDA_VISIBLE_DEVICES`

### 11.3 为什么这里要用 Named Actor

Named Actor 很适合下面这种需求：

- 多个 Celery 任务都要访问同一个模型 worker
- 模型很大，不想重复加载
- 希望 worker 独立于单次任务生命周期存在

这里用到的 3 个点都很重要：

- `name="embedding_worker"`：给 actor 命名
- `get_if_exists=True`：如果已有就复用
- `lifetime="detached"`：Celery 任务结束后 actor 依然活着

补充：

- Detached Actor 不会自动回收
- 不再需要时要手动 `ray.kill(actor_handle)`，否则会一直占资源

### 11.4 如果要做多卡模型池

把一个 Named Actor 扩展成多个即可：

```python
workers = [
    EmbeddingWorker.options(
        name=f"embedding_worker_{i}",
        lifetime="detached",
        get_if_exists=True,
    ).remote("BAAI/bge-small-zh-v1.5")
    for i in range(4)
]
```

然后 Celery 里：

- 轮询选一个
- 按队列分流
- 或者再包一个调度 Actor

### 11.5 Celery 队列怎么配合

重任务建议单独队列，比如：

```python
build_embeddings.apply_async(args=[texts], queue="gpu")
```

对应 worker：

```bash
celery -A app worker -l info -Q gpu --concurrency=4
```

这样做的意义：

- 把 GPU 相关任务跟普通业务任务隔离
- Celery 侧也能做业务级限流

注意：

- Celery 的 `--concurrency` 不等于 GPU 数
- 真正的 GPU 分配还是 Ray 决定

---

## 12. 一个更合理的职责分层建议

如果你的项目同时有 Web、异步任务、模型推理，我更建议这样分：

| 层 | 推荐工具 |
| --- | --- |
| Web 接口层 | FastAPI / Django |
| 任务编排层 | Celery |
| 分布式算力层 | Ray |
| 在线模型服务层 | Ray Serve |

这意味着：

- 后台异步批处理：`Celery + Ray`
- 在线低延迟模型服务：优先 `Ray Serve`

如果你把“在线推理 API”也硬塞进 Celery，一般不是最优解。

---

## 13. 常见坑

### 13.1 不要在循环里一边提交一边 `ray.get()`

错误思路：

```python
for x in items:
    result = ray.get(task.remote(x))
```

这样会把并行写成串行。

更合理：

```python
refs = [task.remote(x) for x in items]
results = ray.get(refs)
```

### 13.2 任务别切得太细

如果单个任务非常轻，Ray 的调度开销会吃掉收益。

经验：

- 小任务尽量 batch 化
- 推理尽量做批处理

### 13.3 大对象别重复按值传

错误思路：

- 每个 task 都传一份很大的模型参数

更合理：

- `ray.put()`
- 或者放进 Actor

### 13.4 GPU task 默认可能不复用 worker

Ray 文档提到：

- 某些 GPU 任务可能会残留显存占用
- 为避免资源泄漏，Ray 默认不会复用执行过 GPU task 的 worker 进程

如果你遇到 GPU 调度开销偏大，需要再回头看 worker 复用策略。

如果你确认自己的任务不会泄漏 GPU 资源，可以显式开启复用：

```python
@ray.remote(num_gpus=1, max_calls=0)
def gpu_task():
    ...
```

### 13.5 Celery worker 不要偷偷起本地 Ray

在生产环境里，Celery 进程里更推荐：

```python
ray.init(address="auto")
```

而不是：

```python
ray.init()
```

原因：

- `ray.init()` 可能在没有集群时直接起一个本地 Ray
- 这样每台 Celery 机器都可能误起自己的小集群
- 排查起来很麻烦

---

## 14. 一个现实中的选型建议

如果你的任务是下面这些，我建议这样选：

### 14.1 批量 embedding / rerank / OCR / ASR

优先：

- `Celery + Ray Actor`
- 数据量特别大时用 `Ray Data`

### 14.2 分布式训练

优先：

- `Ray Train`

### 14.3 在线模型 API

优先：

- `Ray Serve`

### 14.4 只是后台异步业务

优先：

- `Celery`

---

## 15. 我建议你的学习顺序

如果你现在刚入门 Ray，可以按这个顺序学：

1. `ray.init()`、`@ray.remote`、`ray.get()`
2. Task 和 Actor 的区别
3. `ray.put()`、`ray.wait()`
4. GPU 调度：`num_gpus`
5. Named Actor / Detached Actor
6. Placement Group
7. Ray Data 批量推理
8. Ray Train 多卡训练
9. 再考虑和 Celery 联合

---

## 16. 官方文档和官方博客

下面这些我认为最值得先看。

### 16.1 Ray 官方文档

- Ray Core Walkthrough: <https://docs.ray.io/en/latest/ray-core/walkthrough.html>
- Starting Ray: <https://docs.ray.io/en/latest/ray-core/starting-ray.html>
- `ray.init` API: <https://docs.ray.io/en/latest/ray-core/api/doc/ray.init.html>
- Accelerator Support: <https://docs.ray.io/en/latest/ray-core/scheduling/accelerators.html>
- Placement Groups: <https://docs.ray.io/en/latest/ray-core/scheduling/placement-group.html>
- Named Actors: <https://docs.ray.io/en/latest/ray-core/actors/named-actors.html>
- Ray Train GPU Guide: <https://docs.ray.io/en/latest/train/user-guides/using-gpus.html>
- Ray Data `map_batches`: <https://docs.ray.io/en/latest/data/api/doc/ray.data.Dataset.map_batches.html>
- Offline Batch Inference: <https://docs.ray.io/en/latest/data/batch_inference.html>

### 16.2 Celery 官方文档

- Calling Tasks: <https://docs.celeryq.dev/en/stable/userguide/calling.html>
- Tasks: <https://docs.celeryq.dev/en/stable/userguide/tasks.html>
- Workers Guide: <https://docs.celeryq.dev/en/stable/userguide/workers.html>

### 16.3 官方博客 / 官方活动

- Scaling Model Batch Inference in Ray: <https://www.anyscale.com/blog/scaling-model-batch-inference-in-ray-using-actors-actorpool-and-ray-data>
- Ray Data: Scalable Data Processing for AI Workloads: <https://www.anyscale.com/blog/ray-data-scalable-data-processing-for-ai-workloads>
- Introduction to Ray Core and its Ecosystem: <https://www.anyscale.com/events/2022/02/03/introduction-to-ray-core-and-its-ecosystem>
- Ray Core Tutorial: <https://www.anyscale.com/events/2021/06/24/ray-core-tutorial>

---

## 17. 最后总结

你可以先把 Ray 理解成：

> 一个能把 Python 函数、对象、GPU、集群资源统一调度起来的分布式计算框架。

如果放到工程里：

- Celery 解决“任务怎么排队、重试、延迟、编排”
- Ray 解决“任务怎么真正并行地吃 CPU / GPU”

如果你后面是做 AI 系统，尤其是：

- 多卡推理
- 批量 embedding
- 大模型训练 / 推理

那 Ray 很值得认真学。

---

## 18. `FastAPI + Celery + Ray + 4 张 GPU` 最小可运行项目

下面给你一份“单机 4 张 GPU”的最小结构。

目标：

- FastAPI 负责接请求
- Celery 负责异步任务和状态查询
- Ray 负责 4 张 GPU 的模型调度
- 每张 GPU 常驻 1 个 embedding worker

### 18.1 适用场景

这个结构很适合：

- 批量生成 embedding
- OCR / ASR / rerank 这类 GPU 推理任务
- Web 请求不想阻塞
- 想把“业务异步”和“GPU 算力”分层

不太适合：

- 极低延迟在线推理

如果你追求在线低延迟，优先考虑 `Ray Serve`。

### 18.2 目录结构

```text
ray_embedding_demo/
├── app/
│   ├── __init__.py
│   ├── celery_app.py
│   ├── main.py
│   ├── ray_actors.py
│   ├── ray_runtime.py
│   └── tasks.py
└── requirements.txt
```

### 18.3 `requirements.txt`

```txt
fastapi
uvicorn[standard]
celery
redis
ray[default]
sentence-transformers
torch
numpy
```

### 18.4 `app/celery_app.py`

```python
from celery import Celery

celery_app = Celery(
    "ray_embedding_demo",
    broker="redis://127.0.0.1:6379/1",
    backend="redis://127.0.0.1:6379/2",
)

celery_app.conf.update(
    imports=("app.tasks",),
    task_track_started=True,
    task_default_queue="gpu",
    timezone="Asia/Shanghai",
)
```

### 18.5 `app/ray_runtime.py`

```python
import ray

RAY_NAMESPACE = "embedding-demo"

def ensure_ray():
    if not ray.is_initialized():
        ray.init(address="auto", namespace=RAY_NAMESPACE)
```

### 18.6 `app/ray_actors.py`

```python
from __future__ import annotations

import os

import ray

from app.ray_runtime import ensure_ray

MODEL_NAME = "BAAI/bge-small-zh-v1.5"
WORKER_COUNT = 4
WORKER_PREFIX = "embedding_worker"
ROUTER_NAME = "embedding_router"

def worker_name(worker_id: int) -> str:
    return f"{WORKER_PREFIX}_{worker_id}"

@ray.remote(num_gpus=1)
class EmbeddingWorker:
    def __init__(self, model_name: str, worker_id: int):
        from sentence_transformers import SentenceTransformer

        self.worker_id = worker_id
        self.model = SentenceTransformer(model_name, device="cuda")

    def encode(self, texts: list[str]) -> list[list[float]]:
        vectors = self.model.encode(
            texts,
            batch_size=32,
            normalize_embeddings=True,
        )
        return vectors.tolist()

    def info(self) -> dict:
        return {
            "worker_id": self.worker_id,
            "gpu_ids": ray.get_runtime_context().get_accelerator_ids()["GPU"],
            "cuda_visible_devices": os.environ.get("CUDA_VISIBLE_DEVICES"),
        }

@ray.remote
class EmbeddingRouter:
    def __init__(self, worker_names: list[str]):
        self.worker_names = worker_names
        self.index = 0

    def encode(self, texts: list[str]) -> list[list[float]]:
        current_name = self.worker_names[self.index]
        self.index = (self.index + 1) % len(self.worker_names)
        worker = ray.get_actor(current_name)
        return ray.get(worker.encode.remote(texts))

    def state(self) -> dict:
        return {
            "worker_names": self.worker_names,
            "next_index": self.index,
        }

def ensure_embedding_cluster():
    ensure_ray()

    worker_names = []
    for worker_id in range(WORKER_COUNT):
        name = worker_name(worker_id)
        EmbeddingWorker.options(
            name=name,
            lifetime="detached",
            get_if_exists=True,
        ).remote(MODEL_NAME, worker_id)
        worker_names.append(name)

    EmbeddingRouter.options(
        name=ROUTER_NAME,
        lifetime="detached",
        get_if_exists=True,
    ).remote(worker_names)

def get_router():
    ensure_embedding_cluster()
    return ray.get_actor(ROUTER_NAME)

def list_workers() -> list[dict]:
    ensure_embedding_cluster()
    handles = [ray.get_actor(worker_name(i)) for i in range(WORKER_COUNT)]
    return ray.get([handle.info.remote() for handle in handles])
```

说明：

- `EmbeddingWorker`：每个 actor 绑定 1 张 GPU
- `EmbeddingRouter`：做一个最简单的轮询分发
- `lifetime="detached"`：worker 不跟着单个任务退出
- `get_if_exists=True`：多进程启动时避免重复创建

### 18.7 `app/tasks.py`

```python
import ray

from app.celery_app import celery_app
from app.ray_actors import get_router

@celery_app.task(
    bind=True,
    autoretry_for=(Exception,),
    retry_backoff=True,
    retry_jitter=True,
    max_retries=3,
)
def build_embeddings(self, texts: list[str]) -> dict:
    router = get_router()
    vectors = ray.get(router.encode.remote(texts))

    return {
        "count": len(vectors),
        "dim": len(vectors[0]) if vectors else 0,
        "vectors": vectors,
    }
```

### 18.8 `app/main.py`

```python
from contextlib import asynccontextmanager

from celery.result import AsyncResult
from fastapi import FastAPI
from pydantic import BaseModel, Field

from app.celery_app import celery_app
from app.ray_actors import ensure_embedding_cluster, list_workers
from app.tasks import build_embeddings

@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_embedding_cluster()
    yield

app = FastAPI(lifespan=lifespan)

class EmbeddingRequest(BaseModel):
    texts: list[str] = Field(min_length=1)

@app.post("/embeddings/submit")
def submit_embeddings(payload: EmbeddingRequest):
    task = build_embeddings.apply_async(args=[payload.texts], queue="gpu")
    return {
        "task_id": task.id,
        "count": len(payload.texts),
        "status": "submitted",
    }

@app.get("/tasks/{task_id}")
def get_task_status(task_id: str):
    result = AsyncResult(task_id, app=celery_app)
    data = {
        "task_id": task_id,
        "status": result.status,
    }

    if result.successful():
        data["result"] = result.result
    elif result.failed():
        data["error"] = str(result.result)

    return data

@app.get("/ray/workers")
def get_ray_workers():
    return list_workers()
```

### 18.9 启动顺序

先安装依赖：

```bash
pip install -r requirements.txt
```

启动 Redis：

```bash
redis-server
```

启动 Ray 集群。

注意：

- Redis 默认也用 `6379`
- Ray head 默认端口也常见写成 `6379`
- 同机演示时最好显式给 Ray 换一个端口，避免冲突

```bash
ray stop
ray start --head --port=9339 --dashboard-port=8265 --num-gpus=4
```

启动 Celery worker：

```bash
celery -A app.celery_app:celery_app worker -l info -Q gpu --concurrency=4
```

启动 FastAPI：

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### 18.10 试一下

提交任务：

```bash
curl -X POST "http://127.0.0.1:8000/embeddings/submit" \
  -H "Content-Type: application/json" \
  -d '{
    "texts": ["你好", "Ray 和 Celery 可以联合使用", "多卡 embedding 服务"]
  }'
```

返回类似：

```json
{
  "task_id": "c9e2b7c1-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "count": 3,
  "status": "submitted"
}
```

查状态：

```bash
curl "http://127.0.0.1:8000/tasks/c9e2b7c1-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

查看 4 个 GPU worker：

```bash
curl "http://127.0.0.1:8000/ray/workers"
```

你应该能看到类似结果：

- `worker_id=0` 对应 1 张卡
- `worker_id=1` 对应 1 张卡
- `worker_id=2` 对应 1 张卡
- `worker_id=3` 对应 1 张卡

---

## 19. “4 张显卡做 embedding 服务” 应该怎么理解

上面的示例，实际做的是这件事：

```text
客户端请求
    -> FastAPI
    -> Celery 异步提交
    -> Celery 调用 Ray Router
    -> Router 把请求轮询发给 4 个 GPU Actor
    -> 对应 Actor 在各自 GPU 上推理
    -> Celery 返回任务结果
```

这意味着：

- 4 张卡不是给 Celery 的
- 4 张卡是给 Ray Actor 池的
- Celery 只是任务入口，不负责 GPU 资源分配

### 19.1 为什么是一张卡一个 Actor

这是最容易稳定运行的方式。

优点：

- 模型只加载一次
- 每张卡有自己的常驻进程
- 不容易互相抢显存
- 问题定位更清晰

适合：

- embedding
- rerank
- OCR
- 语音识别
- 图像分类

### 19.2 吞吐量怎么提高

如果你觉得吞吐还不够，优先调这几个地方：

1. 增大 `self.model.encode(..., batch_size=32)` 的 `batch_size`
2. 一次提交多条文本，而不是每次只送 1 条
3. 把路由器改成按“负载”调度，而不是简单轮询
4. 小模型场景下尝试分数 GPU，比如 `num_gpus=0.5`

最有效的通常不是“开更多 Celery 进程”，而是：

- 增大单次批量
- 让 GPU 更满

### 19.3 什么时候改成 `Ray Data`

如果你的场景从“在线异步任务”变成：

- 一次处理几十万条
- 离线批量跑 embedding
- 数据已经在文件、表、对象存储里

那通常不该继续走 `FastAPI -> Celery` 这条链路，而应该直接上：

- `Ray Data`
- `map_batches`
- actor pool

### 19.4 什么时候改成 `Ray Serve`

如果你的目标是：

- 每个请求都想低延迟返回
- 希望直接暴露模型 API
- 想做副本扩缩容
- 想配合在线服务治理

那比起 `FastAPI + Celery + Ray`，更适合直接用：

- `Ray Serve`

一句话：

- 批处理 / 后台任务：`Celery + Ray`
- 在线模型服务：`Ray Serve`

### 19.5 这个示例有哪些简化

为了易懂，这里故意省略了一些生产细节：

- 没有把结果写数据库
- 没有做请求级限流
- 没有做任务取消
- 没有做 GPU worker 健康检查和自动重建
- 没有做模型热更新

但核心链路已经是对的：

- Celery 编排任务
- Ray 管 GPU
- 模型常驻 Actor

### 19.6 真上生产时我建议再补 5 个点

1. 结果不要直接塞进 Celery backend，尤其是 embedding 向量很大时
2. 结果存数据库、对象存储或向量库，Celery 只回传元信息
3. 给不同模型建不同的 Ray Actor 池，不要混在一个池里
4. 给 GPU 任务单独 Celery 队列，避免和普通业务任务互相影响
5. 增加一个“模型路由层”，按模型名、batch 大小、GPU 余量去分配

### 19.7 如果从单机 4 卡扩到多机

这套代码基本不用大改。

你主要改的是部署：

头节点：

```bash
ray start --head --port=9339 --dashboard-port=8265
```

工作节点：

```bash
ray start --address=<head-ip>:9339 --num-gpus=4
```

Python 代码仍然可以继续用：

```python
ray.init(address="auto")
```

这也是 Ray 很实用的一点：

- 先单机写通
- 再平移到多机

---

## 20. 一份更现实的落地建议

如果你当前项目是 RAG 或 AI 应用后台，我建议优先这么落：

1. Web 请求进入 FastAPI
2. 文件解析、embedding、rerank 任务交给 Celery
3. Celery 只做任务编排和状态更新
4. 具体模型推理交给 Ray Actor 池
5. 大批量离线任务再单独引入 `Ray Data`

这个拆法的优点是：

- 业务代码和算力代码边界清晰
- GPU 不会被 Celery 乱占
- 后续扩展到多机、多模型也更稳
