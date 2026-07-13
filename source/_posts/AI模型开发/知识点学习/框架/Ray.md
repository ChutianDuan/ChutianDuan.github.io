---
title: "加上 Ray 后任务更多了，为什么批量 Embedding 反而更慢？"
date: 2026-07-13 19:09:20
updated: 2026-07-13 19:09:20
categories:
  - "学习"
  - "AI 模型开发"
  - "知识点学习"
  - "框架"
permalink: /notes/ai模型开发/知识点学习/框架/ray/
series: "AI 模型开发"
---

把普通函数加上 `@ray.remote`，再一次提交几万个任务，看起来就完成了“分布式改造”。实际运行后却可能出现：

- 单机 Python 10 分钟完成，Ray 跑了 20 分钟；
- GPU 利用率忽高忽低，对象存储却先爆内存；
- driver 一次 `ray.get()`，长时间没有任何结果；
- actor 重启后模型重新加载，内存状态全部消失；
- 任务自动重试，把同一批结果写进数据库两次；
- Celery worker 没连上集群，悄悄在本机启动了另一套 Ray。

这些问题不是 Ray “不够快”，而是把分布式调度当成了零成本函数调用。Ray 的价值在于跨进程、跨机器调度有意义的计算单元；如果每个任务只做几微秒工作，序列化、调度、对象传输和进程切换会比计算本身更贵。

本文以 Ray 2.55/2.56 文档为当前基线，围绕一个问题展开：**怎样把批量 Embedding 拆成能产生加速、又能在失败后安全重试的任务？**

## 一、先判断：当前问题真的需要 Ray 吗

Ray Core 提供三个核心原语：

```text
Task：   无状态远程函数
Actor：  有状态远程对象，固定在一个 worker 进程中
Object：分布式对象存储中的值，以 ObjectRef 引用
```

它适合：

- 多核/多机数据预处理；
- 多 GPU 批量推理；
- 模型常驻进程的 actor pool；
- 分布式训练和超参数搜索；
- 任务之间存在对象依赖的 Python 计算图。

它通常不是这些问题的第一选择：

- 发邮件、通知、定时任务；
- 只需要可靠队列、延迟执行和业务重试；
- 单机顺序任务已经足够快；
- 在线请求只需调用已有模型服务；
- 团队没有集群部署、观测和故障恢复能力。

Celery 更像持久后台任务队列，Ray 更像分布式计算运行时。两者可以配合，但同时引入会增加两个重试系统、两套状态和更复杂的故障边界。先用基准证明单机或现有 worker 不够，再引入 Ray。

## 二、最小心智模型：提交不等于执行完成

```python
import ray

ray.init()

@ray.remote
def square(value: int) -> int:
    return value * value

references = [square.remote(value) for value in range(8)]
results = ray.get(references)
print(results)

ray.shutdown()
```

`square.remote()` 立即返回 `ObjectRef`，表示未来结果。任务何时、在哪个 worker 执行，由调度器决定；`ray.get()` 才等待并把对象取到当前进程。

Ray task 和 actor 返回值会进入分布式对象存储。`ray.put()` 可以显式放入一个大对象，再把引用传给多个任务：

```python
shared_ref = ray.put(read_only_lookup_table)
refs = [work.remote(batch, shared_ref) for batch in batches]
```

这能避免 driver 对同一值重复序列化，但不是“完全零拷贝”的通用承诺。对象跨节点时仍要传输，反序列化和不同数据格式也可能复制。

## 三、反模式一：任务切得比调度开销还小

错误写法：一条短文本一个 task。

```python
@ray.remote
def normalize_one(text: str) -> str:
    return " ".join(text.split()).lower()

refs = [normalize_one.remote(text) for text in one_million_texts]
normalized = ray.get(refs)
```

每个任务都要经历提交、调度、参数序列化、worker 执行、结果存储和引用解析。工作太小时，Ray 官方也建议批处理。

先把数据分批：

```python
from collections.abc import Iterable, Iterator
from typing import TypeVar

T = TypeVar("T")

def batched(values: Iterable[T], size: int) -> Iterator[list[T]]:
    if size <= 0:
        raise ValueError("batch size must be positive")
    batch = []
    for value in values:
        batch.append(value)
        if len(batch) == size:
            yield batch
            batch = []
    if batch:
        yield batch
```

再让一次远程调用完成足够多工作：

```python
@ray.remote(num_cpus=1)
def normalize_batch(texts: list[str]) -> list[str]:
    return [" ".join(text.split()).lower() for text in texts]

refs = [normalize_batch.remote(batch) for batch in batched(texts, 1000)]
normalized_batches = ray.get(refs)
```

批大小没有通用答案。应该用真实数据测量：

```text
吞吐量 = 完成样本数 / 总时间
端到端延迟
任务调度耗时
序列化与对象传输
CPU/GPU 利用率
峰值对象存储与进程内存
失败后重算范围
```

批太小浪费调度，批太大又会增加尾延迟、OOM 风险和失败重算成本。

## 四、反模式二：一次提交所有任务

下面的写法会让 driver 保存大量 ObjectRef，并让待调度任务和结果持续堆积：

```python
refs = [embed.remote(batch) for batch in all_batches]
all_results = ray.get(refs)
```

更稳妥的做法是设置在途任务上限，用 `ray.wait()` 做背压：

```python
from collections.abc import Callable, Iterable, Iterator
from typing import Any

import ray

def bounded_map(
    remote_function: Any,
    inputs: Iterable[Any],
    max_in_flight: int,
) -> Iterator[Any]:
    if max_in_flight <= 0:
        raise ValueError("max_in_flight must be positive")

    iterator = iter(inputs)
    pending = []

    for item in iterator:
        pending.append(remote_function.remote(item))
        if len(pending) < max_in_flight:
            continue

        ready, pending = ray.wait(pending, num_returns=1)
        yield ray.get(ready[0])

    while pending:
        ready, pending = ray.wait(pending, num_returns=1)
        yield ray.get(ready[0])
```

使用：

```python
for result in bounded_map(embed_batch, batches, max_in_flight=16):
    persist_idempotently(result)
```

结果按完成顺序被消费，不一定与提交顺序相同。每个 batch 必须带稳定 ID，持久化时按 ID 对齐，不能依赖返回位置。

## 五、Task 与 Actor：模型要不要常驻

### 1. Task 适合无状态工作

```python
@ray.remote(num_cpus=2, max_retries=1)
def parse_documents(batch: list[dict]) -> list[dict]:
    return [parse_one(document) for document in batch]
```

Task worker 可以执行多个任务，但函数不应依赖某个进程内全局状态。大模型若在函数内每次加载，会反复支付加载成本。

### 2. Actor 适合昂贵状态常驻

```python
import ray

@ray.remote(
    num_cpus=2,
    num_gpus=1,
    max_restarts=1,
    max_task_retries=1,
)
class EmbeddingWorker:
    def __init__(self, model_name: str, revision: str) -> None:
        self.model_name = model_name
        self.revision = revision
        self.model = load_embedding_model(model_name, revision)

    def encode(self, batch_id: str, texts: list[str]) -> dict:
        vectors = self.model.encode(texts)
        return {
            "batch_id": batch_id,
            "model": self.model_name,
            "revision": self.revision,
            "vectors": vectors,
        }

workers = [
    EmbeddingWorker.remote("model-name", "model-revision")
    for _ in range(2)
]
refs = [
    workers[index % len(workers)].encode.remote(batch_id, texts)
    for index, (batch_id, texts) in enumerate(batches)
]
results = ray.get(refs)
```

每个 actor 是专用 worker 进程，方法默认串行执行，适合模型常驻。异步或 threaded actor 可以并发执行方法，但这会改变状态安全与完成顺序，不能只为“更快”打开并发。

Actor 构造函数在重启时会重新执行。`max_restarts` 只恢复进程，不会自动恢复应用状态；计数器、内存缓存和未持久化结果都会丢失。关键状态必须存外部可靠系统，或显式 checkpoint 并在构造时恢复。

## 六、资源声明是调度记账，不是硬隔离

```python
@ray.remote(num_cpus=2, num_gpus=0.5, memory=4 * 1024**3)
def infer(batch):
    ...
```

Ray 根据逻辑资源决定任务能否被调度。需要特别注意：

- `num_cpus` 通常是调度容量，不会自动限制函数内部线程数；
- `num_gpus` 帮助分配 GPU 可见性，但不保证模型只占指定比例显存；
- 分数 GPU 只适合实测后确认多个进程能安全共享的模型；
- 底层 BLAS、Tokenizer 或 DataLoader 还可能自行创建线程；
- 自定义资源只是标签与容量，不等于容器级安全隔离。

如果四个 `num_gpus=0.25` actor 各自加载一份占满显存的模型，调度器允许共存，CUDA 仍会 OOM。要用模型实际显存、KV Cache、batch 峰值和碎片情况做容量测试。

## 七、失败与重试：结果可能执行了，但调用方没看到

Ray 当前文档中的重要默认值：

- 普通 task 因 worker/节点故障，默认最多重试 3 次；
- actor 默认 `max_restarts=0`，不会自动重启；
- actor method 默认 `max_task_retries=0`；
- 用户代码抛出的异常默认不一定按系统故障重试，需要显式配置。

开启 actor method 重试后，可能出现：第一次其实已完成写入，但 actor 在回传确认前失败；重试又执行一次。因此所有有副作用的方法都要幂等：

```python
def persist_batch(connection, job_id: str, batch_id: str, vectors) -> None:
    connection.execute(
        """
        INSERT INTO embedding_batches (job_id, batch_id, payload)
        VALUES (%s, %s, %s)
        ON DUPLICATE KEY UPDATE batch_id = batch_id
        """,
        (job_id, batch_id, serialize(vectors)),
    )
```

真正的约束来自数据库唯一键 `(job_id, batch_id)`，不是“代码看起来只调用一次”。

不要为所有异常无差别无限重试：

- 输入格式错误重试仍会失败；
- 模型 OOM 可能需要减小 batch，而不是原样重试；
- 权限错误不能重试；
- 短暂网络错误可以有限退避重试；
- 重试次数、原因和最终状态必须记录。

## 八、一个完整的批量 Embedding 驱动器

下面把批处理、稳定 ID、背压和版本校验组合起来。模型 actor 仍使用上一节的 `EmbeddingWorker`。

```python
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import ray

@dataclass(frozen=True)
class Batch:
    batch_id: str
    texts: list[str]

def run_embedding_job(
    batches: list[Batch],
    workers: list[Any],
    expected_model: str,
    expected_revision: str,
    max_in_flight: int,
    save_result,
) -> None:
    if not workers:
        raise ValueError("at least one worker is required")
    if max_in_flight <= 0:
        raise ValueError("max_in_flight must be positive")

    batch_iter = iter(enumerate(batches))
    pending: dict[Any, str] = {}

    def submit_one() -> bool:
        try:
            index, batch = next(batch_iter)
        except StopIteration:
            return False
        worker = workers[index % len(workers)]
        reference = worker.encode.remote(batch.batch_id, batch.texts)
        pending[reference] = batch.batch_id
        return True

    while len(pending) < max_in_flight and submit_one():
        pass

    while pending:
        ready, _ = ray.wait(list(pending), num_returns=1)
        reference = ready[0]
        expected_batch_id = pending.pop(reference)
        result = ray.get(reference)

        if result["batch_id"] != expected_batch_id:
            raise ValueError("batch identity mismatch")
        if (result["model"], result["revision"]) != (
            expected_model,
            expected_revision,
        ):
            raise ValueError("embedding model version mismatch")

        save_result(result)  # 必须以 batch_id 幂等写入。
        submit_one()
```

这个驱动器仍有明确的简化：driver 崩溃后的恢复要从数据库查询已完成 `batch_id`；某个 batch 永久失败时要记录任务状态；大规模数据不应一次放进 `list[Batch]`。它的重点是把在途任务数与结果身份变成显式契约。

## 九、何时使用 Ray Data

当任务是“从数据源读取大量记录—批量转换—模型推理—写出结果”的离线流水线时，Ray Data 通常比手写几万个 Core task 更合适。

```python
import numpy as np
import ray

class Predictor:
    def __init__(self) -> None:
        self.model = load_model_once()

    def __call__(self, batch: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
        batch["embedding"] = self.model.encode(batch["text"])
        return batch

dataset = ray.data.read_parquet("trusted-input-path")
embedded = dataset.map_batches(
    Predictor,
    batch_format="numpy",
    batch_size=128,
    compute=ray.data.ActorPoolStrategy(size=2),
    num_gpus=1,
)
embedded.write_parquet("new-output-path")
```

可调用类让模型在 actor 中只加载一次；`num_gpus=1` 声明每个 actor 使用一张 GPU。batch 应从小值开始压测：官方示例也提醒，大行数据下默认或过大的 batch 可能导致 OOM。

Ray Data 当前还提供离线推理的 job-level checkpoint 能力，但它不能替代业务幂等和输出版本。恢复执行时仍要确认输入快照、模型 revision 和输出路径完全一致。

## 十、`ray.get()` 的四个常见反模式

### 1. 提交后立刻 get

```python
# 串行：下一项要等上一项完成后才提交。
results = [ray.get(work.remote(item)) for item in items]

# 并行提交，再消费。
refs = [work.remote(item) for item in items]
results = ray.get(refs)
```

大规模场景使用有界 `ray.wait()`，而不是第二种无限提交。

### 2. 在远程任务里对参数 `ray.get()`

直接把 ObjectRef 作为顶层 task 参数传入，Ray 会按依赖调度并解析。远程函数内部无必要地 `ray.get()` 会隐藏依赖并阻塞 worker。

### 3. 一次取回所有大对象

driver 内存可能承受不了全部结果。用 `ray.wait()` 增量消费并落盘/入库，处理后释放引用。

### 4. task 内返回 `ray.put()` 的 ObjectRef

直接返回对象通常更利于 Ray 追踪对象所有权和故障恢复；不要在 task 中多包一层 `ray.put()`，除非明确理解所有权与生命周期影响。

## 十一、Named Actor 与 Detached Actor 的风险

Named Actor 让不同 driver 在相同 namespace 中找到同一 actor：

```python
actor = EmbeddingWorker.options(
    name="embedding-v3-gpu-0",
    namespace="rag-production",
    lifetime="detached",
).remote("model-name", "revision")

handle = ray.get_actor(
    "embedding-v3-gpu-0",
    namespace="rag-production",
)
```

普通 actor 与创建者存在所有权关系；detached actor 没有 owner，会持续到被显式销毁或集群结束。它适合长期共享服务，但也容易形成“僵尸 GPU 进程”：旧模型 actor 没人引用却一直占卡。

需要明确：

- 谁负责唯一创建，如何处理同名竞争；
- 名称必须包含环境与模型版本；
- 谁负责健康检查、滚动切换和 `ray.kill()`；
- actor 重启后怎样恢复状态；
- 旧版本何时确认无流量并释放。

在线低延迟服务需要路由、扩缩容和滚动更新时，应评估 Ray Serve，而不是自己用 detached actor 拼一套不完整服务发现。

## 十二、Ray 与 Celery 怎样划边界

一种合理边界是：

```text
Celery task：业务任务生命周期、幂等键、状态、业务重试
     |
     v
Ray job/actor：有界批量计算、CPU/GPU 资源调度
     |
     v
MySQL/对象存储：版本化结果与最终状态
```

但要避免双重重试放大：Celery 重试整个作业时，Ray 内部可能已经重试部分 batch。每个 batch 必须以 `(job_id, batch_id, model_revision)` 幂等落地，作业恢复先读取完成集合。

生产进程连接已有集群时使用明确地址和 namespace。不要捕获连接失败后退化为无参 `ray.init()`：那可能在 Celery 或 Web 机器上启动本地 Ray，把任务跑在错误节点且难以察觉。连接失败应快速报错并由部署系统处理。

## 十三、测试与基准：先证明加速存在

引入 Ray 前后使用同一输入快照、同一模型和同一输出校验：

1. 单进程基线；
2. 本机多进程 Ray；
3. 目标集群与真实存储；
4. 不同 batch 和并发上限；
5. 注入 worker crash、节点丢失和 driver 重启。

结果至少记录：

```text
输入记录数与字节数
成功/失败/重复 batch 数
端到端吞吐和 P95 batch 延迟
模型加载时间
调度、等待和对象传输时间
CPU/GPU/显存利用率
对象存储峰值与 spill
重试、actor 重启和 OOM 次数
输出模型 revision 与内容校验
```

只比较模型 `encode()` 的耗时，会漏掉分布式系统真正昂贵的输入、调度和落地阶段。

## 十四、排查“Ray 为什么没加速”的顺序

1. task 是否小于调度与序列化开销？先增大 batch；
2. 是否在循环里提交一个就 `ray.get()`？
3. driver 是否一次提交或取回太多对象？加入背压；
4. 同一大参数是否反复按值传递？用一次 `ray.put()` 或 actor 常驻；
5. CPU、GPU 资源声明是否与真实线程/显存相符？
6. 模型是否每次任务都重新加载？改用 actor 或 Ray Data callable class；
7. 输入存储是否成为瓶颈？查看节点网络与本地性；
8. 对象存储是否频繁 spill 到磁盘？
9. 是否发生任务重试、actor 重启或 OOM？
10. 最终是否真的比单机基线更快、更便宜？

## 十五、上线检查清单

1. 是否有基准证明 Ray 的收益大于复杂度？
2. task 粒度和 batch 是否通过真实数据压测？
3. 是否限制在途任务与 driver 内存？
4. 结果是否携带稳定 batch ID、模型 revision 和输入版本？
5. 所有副作用是否幂等，重试是否按异常分类且有限？
6. actor 重启后状态能否从外部恢复？
7. 逻辑 CPU/GPU 声明是否符合真实线程和显存占用？
8. detached actor 是否有明确 owner、切换与清理流程？
9. Celery 与 Ray 是否避免双重无限重试？
10. 生产进程是否只连接指定集群，失败时不偷偷本地启动？
11. dashboard、job API 和集群端口是否受认证与网络访问控制？
12. 是否监控 pending task、对象存储、spill、重试和节点健康？

## 十六、总结

Ray 不是让 Python 函数自动变快的装饰器，而是一个有调度、序列化、对象所有权和故障语义的分布式运行时。要让批量 AI 计算真正受益：

- 只在单机或现有任务系统不足时引入 Ray；
- 把小工作合并成有意义的 batch；
- 用 `ray.wait()` 和在途上限建立背压；
- 无状态计算用 task，昂贵模型常驻用 actor；
- 把资源声明视为调度记账，显存与线程仍要实测；
- 假设任务可能重试、结果可能重复，按稳定 batch ID 幂等写入；
- actor 重启只恢复进程，业务状态必须外部持久化；
- 大规模离线推理优先评估 Ray Data；
- 用端到端吞吐、成本和故障恢复与单机基线比较。

当任务粒度、背压、版本和重试契约都明确后，Ray 才能把更多机器变成有效算力，而不是把一个简单循环变成更昂贵的分布式排队系统。

## 参考资料

- [Ray Core 核心概念](https://docs.ray.io/en/latest/ray-core/walkthrough.html)
- [Ray Task](https://docs.ray.io/en/latest/ray-core/tasks.html)
- [Ray Actor](https://docs.ray.io/en/latest/ray-core/actors.html)
- [Ray 设计模式与反模式](https://docs.ray.io/en/latest/ray-core/patterns/index.html)
- [Ray Task 故障恢复](https://docs.ray.io/en/latest/ray-core/fault_tolerance/tasks.html)
- [Ray Actor 故障恢复](https://docs.ray.io/en/latest/ray-core/fault_tolerance/actors.html)
- [Ray Data 批量推理](https://docs.ray.io/en/latest/data/batch_inference.html)
- [Ray Data `map_batches`](https://docs.ray.io/en/latest/data/api/doc/ray.data.Dataset.map_batches.html)
