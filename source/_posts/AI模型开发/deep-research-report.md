---
title: "RAG Gateway Stack 运行与验收：LanceDB、Agent 与 SSE 续传"
date: 2026-07-13 18:04:10
updated: 2026-10-03 12:00:00
categories:
  - "学习"
  - "AI 模型开发"
permalink: /notes/ai模型开发/deep-research-report/
series: "AI 模型开发"
series_order: 22
description: "以已发布实现为准，说明 RAG 服务依赖、启动入口、外部 API、引用回查、续传与关键失败路径。"
---

本篇将早期八周规划改为 RAG Gateway Stack 的运行与验收笔记。目标是让文档进入知识库后，一次普通 RAG 或 Agent 问答能够返回答案、保存引用，并暴露可以复查的执行过程。

内容于 **2026-10-03** 对照 [已发布提交 0771a82](https://github.com/ChutianDuan/Repo/blob/0771a82d698eb155b110653dc5e97831ef3ca46e/README.md) 核对。命令描述仓库当前入口，不表示已经在这次博客维护中运行数据库、GPU 模型或整栈测试。

## 1. 准备运行依赖

### 1.1 服务和职责

| 组件 | 职责 | 默认访问入口 |
| --- | --- | --- |
| Drogon Gateway | 外部 API、上传、鉴权、限流和 SSE 代理 | `127.0.0.1:8080` |
| FastAPI | 文档、检索、会话、Chat、Agent 与 Trace | `127.0.0.1:8000`，内部入口 |
| Celery / Redis | 异步解析、向量化和非流式 Chat | broker / worker |
| MySQL | 正文、来源、消息、引用、任务与 Trace | `.env` 中配置 |
| LanceDB | 可重建的 chunk 向量索引 | `data/lancedb` |
| React Workbench | 文档、执行流程、回答与 Trace | `127.0.0.1:5173` |

当前检索链路是 **LanceDB 召回 → MySQL 回表 → CrossEncoder 重排**。MySQL 保存正文与业务真相，Redis 主要承担任务传递与短期状态；不要把早期 FAISS 文件或 Redis Streams 的设计示例当成这版服务的实际恢复机制。

### 1.2 安装与初始化

在项目根目录执行；运行前准备好 MySQL、Redis，以及 C++17、CMake、Drogon、CURL、JsonCpp 和 Drogon 的数据库依赖。

```bash
cp .env.example .env
conda create -n rag-api python=3.10
conda activate rag-api
pip install -r python_rag/requirements.txt
pip install -r python_rag/requirements-dev.txt

cd frontend
npm install
cd ..
bash scripts/init_db.sh
```

`.env` 中填写实际数据库、Redis 与模型入口。默认采用远端 OpenAI-compatible LLM；embedding 与 rerank 在 Python 服务 / Worker 中加载，模型需要预先可访问。

```bash
# 默认 API 模式，只检查模型入口
bash scripts/start_vllm.sh

# 需要本地模型时，在独立终端显式启动
LLM_RUNTIME=local_vllm bash scripts/start_vllm.sh
```

本地 vLLM 的模型路径和设备由环境变量控制。不要把开发机器上的物理 GPU 编号当成所有部署环境的默认值。

## 2. 用统一入口管理进程

```bash
START_FRONTEND=true bash scripts/start_all.sh start
bash scripts/start_all.sh status
bash scripts/start_all.sh logs worker
bash scripts/start_all.sh restart api
bash scripts/start_all.sh stop
```

统一脚本在 Gateway 二进制缺失时构建 C++ 服务，以独立进程组启动 API、Worker、Gateway 和可选的前端；PID 写入 `.run/`，日志进入 `logs/`。停止时处理完整进程组，避免遗留子进程。

### 2.1 存活、依赖与业务路径分别检查

```bash
curl http://127.0.0.1:8000/internal/health
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/v1/monitor/overview
```

HTTP 端口响应只能证明对应检查覆盖的状态。完整验收仍要验证 Worker 能消费任务、文档进入 indexed 范围、真实模型返回答案，并能从 MySQL 回查引用。LanceDB 没有独立健康入口，工作台不能仅凭页面加载就标为健康。

## 3. 先完成一条文档入库路径

### 3.1 文件上传与网页导入

```bash
curl -X POST http://127.0.0.1:8080/v1/documents   -F 'user_id=1'   -F 'file=@./day7_demo.md'

curl -X POST http://127.0.0.1:8080/v1/documents/web   -H 'Content-Type: application/json'   -d '{"user_id":1,"url":"https://example.com/page"}'
```

使用上传响应中的实际 `task_id` 查询 `/v1/tasks/{task_id}`，再检查文档索引状态。网页响应可能给出内部 `status_url`，浏览器应走 Gateway 的外部任务入口。

### 3.2 逐阶段观察失败

解析与 embedding 分成两个任务。文件创建成功、Celery 已接收任务、chunk 写入成功、向量索引就绪是不同阶段。出现 Failed 时，需要关联文档 ID、任务 ID、阶段与 worker 日志，而不是只重试问答。

embedding 模型切换后重建索引，避免把不同向量空间混合检索。删除、重建和正文回表的逻辑以 MySQL 文档状态为准。

## 4. 普通 RAG 与 Agent 使用不同的请求字段

先创建会话，并使用响应里的实际 `session_id`。以下 `3` 仅为示例标识。

```bash
curl -X POST http://127.0.0.1:8080/v1/sessions   -H 'Content-Type: application/json'   -d '{"user_id":1,"title":"工程验收"}'

curl -N -D /tmp/rag-chat-headers.txt   http://127.0.0.1:8080/v1/chat/stream   -H 'Content-Type: application/json'   -d '{"session_id":3,"content":"总结知识库中的系统架构","top_k":5}'

curl -N http://127.0.0.1:8080/v1/agent/chat/stream   -H 'Content-Type: application/json'   -d '{"session_id":3,"message":"根据知识库说明核心链路","trace_id":"review-agent-001"}'
```

普通 Chat 使用 `content`；Agent 使用 `message` 和稳定的 `trace_id`。每次新 Agent 运行生成新的 trace ID，同一次运行的重连复用原值。

### 4.1 什么才算问答成功

- 普通 RAG 完成召回、回表、重排与答案生成。
- Agent 的工具结果明确成功或失败，Trace 能回查；失败工具的数据不作为成功证据使用。
- assistant message 与 citations 已持久化，再发送 `done`。
- `GET /v1/sessions/{id}/messages` 能读取消息与引用，来源文档和 chunk 可定位。

没有提供逐句 span 的引用是消息级证据，不等于每句话都被准确支持。评估时仍需固定问题、人工核对和 bad case。

## 5. 验证断线续传不会重复生成

### 5.1 普通 Chat

首次响应的 `X-User-Message-ID` 与 SSE `id` 是恢复所需信息。重连移除原始内容，示例中的 `21` 和 `18` 必须替换为本次实际值。

```bash
curl -N http://127.0.0.1:8080/v1/chat/stream   -H 'Content-Type: application/json'   -H 'Last-Event-ID: 18'   -d '{"session_id":3,"user_message_id":21,"top_k":5}'
```

重发原始 `content` 会创建新用户消息。验证应比较断线前后的用户消息、assistant message 与引用数量，确认恢复的是同一条流。

### 5.2 Agent 与保留期限

Agent 重连携带相同的 session、`trace_id` 与 `Last-Event-ID`。续传状态默认在运行完成后保留 15 分钟，存在于进程内；它不提供进程重启后的持久化恢复。状态过期时应看到明确 `error`，而不是另一次静默执行。

当前 Agent 步骤通过 SSE 到达，最终答案在 Agent 完成后一次性输出；不要把步骤事件误读成模型 token 正在逐字实时生成。

## 6. 按验证层次保存结果

```bash
# 逻辑、接口和源码检查
python -m pytest
python -m compileall python_rag tests
bash scripts/ci_smoke.sh

# 依赖完整运行后，执行跨服务用户路径
bash scripts/e2e_all.sh ./day7_demo.md
```

| 场景 | 验收重点 |
| --- | --- |
| 文件 / 网页入库 | 任务阶段、chunk 与索引就绪 |
| 全局 / 指定文档检索 | 范围、正文回表、重排与引用来源 |
| Agent 工具失败 | Trace 留存、失败证据不进入成功上下文 |
| 断线与重连 | 后续事件补发、消息不重复、终止事件一致 |
| 续传状态缺失 | 明确失败，不新建一轮生成 |
| 依赖或模型异常 | 稳定错误响应、任务状态和诊断信息 |

运行记录应包含提交、环境、命令、输出和测试文件，不能仅留下“全部完成”。本次文章维护只核对已发布源码与文档，没有替项目执行上述验收命令。

## 7. 部署前仍需解决的问题

当前整栈入口服务于本地开发、演示和工程验证。多租户隔离、生产密钥管理和部署编排需要另外设计与验收；SSE 代理占用受限 OS thread 的模型也需要并发压测。

对外历史会话和 Agent Runs 列表尚未提供，LanceDB 健康与逐句引用证据也有边界。先用 [架构复盘](/notes/ai模型开发/开发进度记录/) 中的完整链路验证真实行为，再依据测量结果决定下一步。

## 参考实现

- [当前项目说明](https://github.com/ChutianDuan/Repo/blob/0771a82d698eb155b110653dc5e97831ef3ca46e/README.md)
- [外部 API、工具和续传请求](https://github.com/ChutianDuan/Repo/blob/0771a82d698eb155b110653dc5e97831ef3ca46e/docs/api_agent.md)
- [统一进程管理与验证脚本](https://github.com/ChutianDuan/Repo/blob/0771a82d698eb155b110653dc5e97831ef3ca46e/scripts/README.md)
- [Gateway 鉴权与限流](https://github.com/ChutianDuan/Repo/blob/0771a82d698eb155b110653dc5e97831ef3ca46e/docs/gateway_auth_rate_limit.md)
