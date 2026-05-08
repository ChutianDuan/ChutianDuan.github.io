---
title: "FastAPI 学习笔记"
date: 2026-04-23 10:53:53
updated: 2026-04-23 10:53:53
categories:
  - "学习"
  - "AI模型开发"
  - "知识点学习"
  - "框架"
permalink: /notes/ai模型开发/知识点学习/框架/fasthapi/
---

# FastAPI 学习笔记

## 1. FastAPI 是什么

FastAPI 是一个基于 Python 类型注解构建的 Web API 框架，适合用来开发：

- 后端接口服务
- AI 模型推理接口
- 文件上传和处理接口
- 内部微服务
- 需要自动生成接口文档的项目

它的几个核心特点：

- 开发效率高，写法接近普通 Python 函数
- 自动参数校验
- 自动生成 OpenAPI 文档
- 支持异步
- 和 Pydantic 配合很好，适合结构化数据处理

FastAPI 最实用的地方在于：你写的是普通 Python 函数，但它会顺手帮你把 HTTP 请求、参数校验和接口文档这些事情一起处理掉。

## 2. 为什么很多 AI 项目喜欢用 FastAPI

在 AI 项目里，FastAPI 很常见，因为它很适合做这些事情：

- 暴露模型推理接口
- 上传文档、图片、音频
- 提供任务提交和状态查询接口
- 给前端或其他服务提供统一 API
- 和 Celery、Redis、数据库组合成一套服务

尤其是下面这种场景：

1. 前端上传文件
2. FastAPI 接收请求
3. 把耗时任务交给 Celery
4. 再通过 FastAPI 提供任务状态查询接口

这类架构在 RAG、推理平台、数据处理平台里非常常见。

## 3. 安装

最基础的安装：

```bash
pip install fastapi uvicorn
```

如果要做文件上传，还需要：

```bash
pip install python-multipart
```

说明：

- `fastapi`：框架本身
- `uvicorn`：ASGI Server，用来启动服务
- `python-multipart`：处理表单和文件上传

## 4. 最小可运行示例

文件：`main.py`

```python
from fastapi import FastAPI

app = FastAPI()

@app.get("/")
def read_root():
    return {"message": "hello fastapi"}
```

启动命令：

```bash
uvicorn main:app --reload
```

含义：

- `main`：Python 文件名 `main.py`
- `app`：文件中的 FastAPI 实例
- `--reload`：代码变更后自动重启，适合开发环境

启动后可以访问：

- `http://127.0.0.1:8000/`
- `http://127.0.0.1:8000/docs`
- `http://127.0.0.1:8000/redoc`

其中：

- `/docs`：Swagger UI
- `/redoc`：ReDoc 文档页面

## 5. FastAPI 的基本工作方式

可以把一个接口理解成：

1. 定义一个路径
2. 指定请求方法，比如 `GET`、`POST`
3. 声明这个接口需要哪些参数
4. FastAPI 自动帮你解析参数并做校验
5. 函数返回值自动转换为 JSON 响应

示例：

```python
from fastapi import FastAPI

app = FastAPI()

@app.get("/hello")
def hello(name: str):
    return {"message": f"hello {name}"}
```

访问：

```text
/hello?name=tom
```

返回：

```json
{"message": "hello tom"}
```

这里的 `name: str` 会被 FastAPI 识别为查询参数。

## 6. 路由基础

FastAPI 支持常见的 HTTP 方法：

- `@app.get()`
- `@app.post()`
- `@app.put()`
- `@app.delete()`
- `@app.patch()`

示例：

```python
from fastapi import FastAPI

app = FastAPI()

@app.get("/users")
def get_users():
    return {"action": "list users"}

@app.post("/users")
def create_user():
    return {"action": "create user"}

@app.get("/users/{user_id}")
def get_user(user_id: int):
    return {"user_id": user_id}
```

说明：

- `/users` 通常表示资源集合
- `/users/{user_id}` 表示某个具体资源
- `user_id: int` 会自动做类型校验

如果路径参数类型不对，FastAPI 会直接返回校验错误。

## 7. 路径参数、查询参数、请求体

这是 FastAPI 最重要的基础之一。

### 7.1 路径参数

路径里写在 `{}` 中的内容就是路径参数。

```python
@app.get("/items/{item_id}")
def get_item(item_id: int):
    return {"item_id": item_id}
```

例如：

```text
/items/100
```

这里的 `item_id` 就是路径参数。

### 7.2 查询参数

函数里那些不在路径中的普通基础类型参数，通常会被当成查询参数。

```python
@app.get("/items")
def list_items(page: int = 1, size: int = 10):
    return {"page": page, "size": size}
```

例如：

```text
/items?page=2&size=20
```

### 7.3 请求体

如果参数是 Pydantic 模型，FastAPI 会把它当成请求体。

```python
from pydantic import BaseModel

class UserCreate(BaseModel):
    name: str
    age: int

@app.post("/users")
def create_user(user: UserCreate):
    return user
```

请求：

```json
{
  "name": "alice",
  "age": 18
}
```

结论：

- 路径里的参数是路径参数
- 简单类型参数通常是查询参数
- Pydantic 模型通常是请求体

## 8. Pydantic 模型

FastAPI 的数据校验非常依赖 Pydantic。

最常见的用途：

- 定义请求体结构
- 定义返回体结构
- 做字段校验
- 约束字段类型

### 8.1 基本示例

```python
from pydantic import BaseModel, Field

class ArticleCreate(BaseModel):
    title: str = Field(min_length=1, max_length=100)
    content: str
    author: str
```

这里的好处是：

- 字段缺失会报错
- 类型不对会报错
- 长度不满足约束会报错

### 8.2 作为返回模型

```python
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

class UserOut(BaseModel):
    id: int
    name: str

@app.get("/users/{user_id}", response_model=UserOut)
def get_user(user_id: int):
    return {"id": user_id, "name": "tom", "password": "secret"}
```

返回给客户端时，`password` 这类不在 `response_model` 中的字段会被过滤掉。

这非常适合做：

- 隐藏敏感字段
- 固定接口返回结构
- 保证前后端契约一致

## 9. `def` 和 `async def` 怎么选

这是 FastAPI 初学时很容易混淆的点。

### 9.1 用 `async def` 的情况

适合：

- 调用异步数据库客户端
- 调用异步 HTTP 客户端
- WebSocket
- 其他真正支持异步的 IO 场景

### 9.2 用普通 `def` 的情况

适合：

- 普通同步逻辑
- CPU 密集型计算
- 调用同步库
- 本来就不是异步的代码

注意：

> `async def` 不是“更快”的意思，它只是更适合异步 IO。

如果你在 `async def` 里直接跑很重的同步任务，照样会阻塞。

对于重任务，通常应该交给：

- Celery
- 任务队列
- 独立 Worker

## 10. 请求参数的更明确写法

FastAPI 虽然能自动推断参数来源，但实际项目里更推荐写明确一些。

可以使用：

- `Path`
- `Query`
- `Body`

示例：

```python
from fastapi import Body, FastAPI, Path, Query

app = FastAPI()

@app.post("/items/{item_id}")
def update_item(
    item_id: int = Path(..., ge=1),
    keyword: str | None = Query(default=None, min_length=1),
    data: dict = Body(...),
):
    return {
        "item_id": item_id,
        "keyword": keyword,
        "data": data,
    }
```

这里：

- `Path(..., ge=1)` 表示路径参数必须大于等于 1
- `Query(...)` 用来描述查询参数校验
- `Body(...)` 明确说明这个参数来自请求体

这种写法更清晰，也更适合团队协作。

## 11. APIRouter 路由拆分

项目一大，通常不会把所有接口都写在一个 `main.py` 里。

FastAPI 推荐使用 `APIRouter` 拆模块。

### 11.1 基本示例

文件：`routers/health.py`

```python
from fastapi import APIRouter

router = APIRouter(prefix="/health", tags=["health"])

@router.get("")
def health_check():
    return {"status": "ok"}
```

主文件：`main.py`

```python
from fastapi import FastAPI

from routers.health import router as health_router

app = FastAPI()
app.include_router(health_router)
```

访问路径：

```text
/health
```

### 11.2 为什么要拆 Router

好处：

- 按业务模块组织代码
- 主入口文件更简洁
- 适合多人协作
- 后续做版本管理更方便

常见拆分方式：

- `routers/user.py`
- `routers/auth.py`
- `routers/files.py`
- `routers/tasks.py`

## 12. 路由前缀和 API 版本管理

你原来的笔记重点写的是这部分，这里整理成更清晰的版本。

### 12.1 统一加前缀

如果整个项目都希望走 `/api/v1` 前缀，可以在 `include_router()` 时统一加上。

```python
from fastapi import FastAPI

from routers.health import router as health_router

app = FastAPI()

root_prefix = "/api/v1"
app.include_router(health_router, prefix=root_prefix)
```

如果 `health_router` 本身是：

```python
router = APIRouter(prefix="/health", tags=["health"])
```

那么最终路径就是：

```text
/api/v1/health
```

### 12.2 在 Router 上直接带业务前缀

例如：

```python
router = APIRouter(prefix="/users", tags=["users"])
```

再在主应用里挂上版本前缀：

```python
app.include_router(user_router, prefix="/api/v1")
```

最后效果就是：

```text
/api/v1/users
```

### 12.3 多版本应用挂载

如果你想同时保留多个版本，也可以挂多个 FastAPI 子应用。

```python
from fastapi import FastAPI

app = FastAPI()

app_v1 = FastAPI(title="API V1")
app_v2 = FastAPI(title="API V2")

app.mount("/api/v1", app_v1)
app.mount("/api/v2", app_v2)
```

这种方式适合：

- 两个版本差异非常大
- 想彻底隔离文档和路由
- 历史接口需要长期兼容

但如果只是小规模版本演进，通常直接用：

- `include_router(..., prefix="/api/v1")`
- `include_router(..., prefix="/api/v2")`

就够了。

### 12.4 版本管理建议

实际项目里一般这样做：

- 先按模块拆 Router
- 再统一加版本前缀
- 不要一开始就把版本设计得过于复杂

多数项目初期使用：

```text
/api/v1/xxx
```

已经足够。

## 13. 依赖注入 `Depends`

`Depends` 是 FastAPI 很重要的能力。

它的核心作用是：

- 把公共逻辑抽出来复用
- 给接口注入数据库连接、用户信息、分页参数等
- 让路由函数更干净

### 13.1 基本示例

```python
from fastapi import Depends, FastAPI

app = FastAPI()

def common_pagination(page: int = 1, size: int = 10):
    return {"page": page, "size": size}

@app.get("/articles")
def list_articles(pagination=Depends(common_pagination)):
    return pagination
```

说明：

- `page` 和 `size` 可以在多个接口中复用
- 路由函数里只拿最终整理好的结果

### 13.2 常见依赖场景

- 获取当前登录用户
- 获取数据库 Session
- 提取分页参数
- 权限校验
- 校验请求头

例如认证场景：

```python
from fastapi import Depends, FastAPI, Header, HTTPException

app = FastAPI()

def verify_token(x_token: str = Header(...)):
    if x_token != "demo-token":
        raise HTTPException(status_code=401, detail="invalid token")
    return x_token

@app.get("/secure")
def secure_api(token: str = Depends(verify_token)):
    return {"token": token}
```

## 14. 异常处理

FastAPI 常用 `HTTPException` 抛业务错误。

```python
from fastapi import FastAPI, HTTPException

app = FastAPI()

@app.get("/users/{user_id}")
def get_user(user_id: int):
    if user_id != 1:
        raise HTTPException(status_code=404, detail="user not found")
    return {"id": 1, "name": "tom"}
```

适合用在：

- 资源不存在
- 权限不足
- 参数不合法
- 业务状态不满足要求

补充理解：

- 参数校验错误通常由 FastAPI 自动处理
- 业务逻辑错误通常由你主动抛 `HTTPException`

## 15. 文件上传

这在 AI 项目里很常见，比如：

- 上传 PDF
- 上传图片
- 上传音频
- 上传知识库文档

### 15.1 单文件上传

```python
from fastapi import FastAPI, File, UploadFile

app = FastAPI()

@app.post("/upload")
def upload_file(file: UploadFile = File(...)):
    return {
        "filename": file.filename,
        "content_type": file.content_type,
    }
```

### 15.2 保存到本地

```python
from pathlib import Path
import shutil

from fastapi import FastAPI, File, UploadFile

app = FastAPI()

UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)

@app.post("/upload")
def upload_file(file: UploadFile = File(...)):
    save_path = UPLOAD_DIR / file.filename

    with save_path.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    return {"path": str(save_path)}
```

### 15.3 实战建议

- 不要直接相信上传文件名
- 最好自己生成唯一文件名
- 大文件处理不要阻塞接口太久
- 上传成功后可以把处理任务交给 Celery

## 16. 表单与文件混合提交

有时接口既要文件，也要普通字段，比如：

- 文件 + 文档类型
- 图片 + 用户 ID
- 音频 + 语言参数

示例：

```python
from fastapi import FastAPI, File, Form, UploadFile

app = FastAPI()

@app.post("/documents")
def create_document(
    file: UploadFile = File(...),
    doc_type: str = Form(...),
):
    return {
        "filename": file.filename,
        "doc_type": doc_type,
    }
```

## 17. 中间件和 CORS

### 17.1 中间件是什么

中间件是在请求进入路由前、响应返回客户端前统一插入的一层处理逻辑。

常见用途：

- 记录请求日志
- 统计耗时
- 增加追踪 ID
- 统一鉴权

### 17.2 CORS

如果前后端分离，浏览器经常会遇到跨域问题。

FastAPI 通常这样加：

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

开发环境常见，生产环境一般要更严格地限制来源。

## 18. 生命周期事件

很多项目需要在服务启动时做初始化，比如：

- 建立连接池
- 加载配置
- 初始化日志
- 加载模型

FastAPI 支持应用生命周期管理。

```python
from contextlib import asynccontextmanager

from fastapi import FastAPI

@asynccontextmanager
async def lifespan(app: FastAPI):
    print("service starting")
    yield
    print("service stopping")

app = FastAPI(lifespan=lifespan)
```

如果项目里有大模型、向量库客户端、数据库连接池，这一层会比较重要。

## 19. `BackgroundTasks` 和 Celery 的区别

这点和你刚整理的 `Celery.md` 是连着的。

### 19.1 `BackgroundTasks`

适合：

- 很轻量的后台操作
- 和当前 Web 进程生命周期绑定
- 不需要重试
- 不需要独立扩容

示例：

```python
from fastapi import BackgroundTasks, FastAPI

app = FastAPI()

def write_log(message: str):
    with open("app.log", "a", encoding="utf-8") as f:
        f.write(message + "\n")

@app.post("/notify")
def notify(background_tasks: BackgroundTasks):
    background_tasks.add_task(write_log, "new request")
    return {"message": "accepted"}
```

### 19.2 Celery

更适合：

- 长耗时任务
- 文件处理
- 模型推理
- 批量任务
- 需要失败重试
- 需要多机扩展

一句话：

> 轻任务用 `BackgroundTasks`，重任务用 Celery。

## 20. FastAPI 和 Celery 的典型配合方式

在 AI 项目里，比较常见的结构是：

1. FastAPI 负责接收请求
2. 接口做参数校验和鉴权
3. 把耗时任务提交给 Celery
4. 返回 `task_id`
5. 前端轮询任务状态

例如：

```python
from fastapi import FastAPI

from tasks import process_document

app = FastAPI()

@app.post("/tasks/documents")
def create_document_task(file_path: str):
    task = process_document.delay(file_path)
    return {"task_id": task.id}
```

这个思路尤其适合：

- 文档解析
- embedding 计算
- 批量摘要
- 图片处理
- 音频转写

## 21. 响应模型和状态码

建议在正式项目里尽量把返回结构固定下来。

```python
from fastapi import FastAPI, status
from pydantic import BaseModel

app = FastAPI()

class UserCreate(BaseModel):
    name: str

class UserOut(BaseModel):
    id: int
    name: str

@app.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(user: UserCreate):
    return {"id": 1, "name": user.name}
```

这样做的好处：

- 文档更清晰
- 前端更好联调
- 返回结构更稳定

## 22. 测试

FastAPI 支持用 `TestClient` 做接口测试。

```python
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)

def test_read_root():
    response = client.get("/")
    assert response.status_code == 200
    assert response.json() == {"message": "hello fastapi"}
```

这个对接口开发很有用，特别是：

- 改接口时防止回归
- 验证参数校验
- 验证权限逻辑

## 23. FastAPI 项目的工程结构

当项目从 demo 变成一个后端服务时，最重要的不是目录多，而是每一层职责清楚。

FastAPI 官方文档里会用 `app/main.py`、`app/dependencies.py`、`app/routers/` 这种结构说明大型应用拆分。实际项目里可以在这个基础上继续细分成：

```text
project/
├── app/
│   ├── main.py
│   ├── api/
│   │   └── v1/
│   │       ├── router.py
│   │       └── endpoints/
│   │           ├── health.py
│   │           ├── documents.py
│   │           ├── chat.py
│   │           └── tasks.py
│   ├── core/
│   │   ├── config.py
│   │   ├── logging.py
│   │   ├── security.py
│   │   └── exceptions.py
│   ├── schemas/
│   │   ├── document.py
│   │   ├── chat.py
│   │   └── task.py
│   ├── models/
│   │   ├── document.py
│   │   ├── chunk.py
│   │   └── message.py
│   ├── crud/
│   │   ├── document.py
│   │   └── task.py
│   ├── services/
│   │   ├── document_service.py
│   │   ├── rag_service.py
│   │   ├── embedding_service.py
│   │   └── llm_service.py
│   ├── clients/
│   │   ├── redis_client.py
│   │   ├── vector_store.py
│   │   └── llm_client.py
│   ├── db/
│   │   ├── session.py
│   │   └── base.py
│   └── workers/
│       ├── celery_app.py
│       └── tasks.py
├── tests/
│   ├── test_documents.py
│   └── test_chat.py
└── requirements.txt
```

不一定每个项目都要这么全。目录结构应该跟项目复杂度匹配，小项目可以先从 `main.py + routers + schemas + services` 开始。

### 23.1 各目录负责什么

- `main.py`：应用入口，只负责创建 `FastAPI` 实例、注册中间件、注册路由、声明生命周期逻辑。
- `api/v1/router.py`：汇总某个 API 版本下的所有 router，例如 `/documents`、`/chat`、`/tasks`。
- `api/v1/endpoints/`：HTTP 接口层，只处理请求参数、依赖注入、状态码和响应模型，不直接堆复杂业务。
- `schemas/`：Pydantic 模型，定义请求体、返回体和接口契约。
- `models/`：数据库 ORM 模型，对应 MySQL 表结构。
- `crud/`：数据库读写封装，只做增删改查，不写复杂业务流程。
- `services/`：业务逻辑层，负责组织多个 `crud`、`client`、算法模块完成一个完整业务动作。
- `clients/`：外部服务或基础设施客户端，例如 Redis、向量库、LLM 服务、对象存储。
- `core/`：全局配置、日志、安全、异常处理、公共常量。
- `workers/`：Celery 应用和后台任务，处理文档解析、embedding、索引构建等耗时流程。
- `tests/`：接口测试、业务测试、E2E 测试。

最关键的原则：

> Router 不写重业务，Service 不关心 HTTP，CRUD 不关心业务流程。

### 23.2 一次请求在结构里的流动

以创建文档任务为例：

```text
Client
  -> FastAPI middleware
  -> api/v1/endpoints/documents.py
  -> Depends 获取配置、数据库 Session、用户信息
  -> schemas/document.py 校验请求体
  -> services/document_service.py 组织业务
  -> crud/document.py 写入文档记录
  -> workers/tasks.py 提交 Celery 任务
  -> 返回 task_id
```

接口函数应该尽量薄，例如：

```python
from fastapi import APIRouter, Depends, UploadFile

from app.db.session import get_db
from app.schemas.document import DocumentUploadResponse
from app.services.document_service import DocumentService

router = APIRouter(prefix="/documents", tags=["documents"])

@router.post("", response_model=DocumentUploadResponse)
def upload_document(file: UploadFile, db=Depends(get_db)):
    service = DocumentService(db)
    return service.create_ingest_task(file)
```

这个接口只做三件事：

- 接收 HTTP 请求
- 通过 `Depends` 拿到依赖
- 调用 service 返回结果

文件保存、数据库写入、任务提交、错误处理都应该下沉到 service 或更底层。

### 23.3 `main.py` 应该保持很薄

`main.py` 更像“装配入口”，不要把业务逻辑都塞进去。

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.router import api_router
from app.core.config import settings

def create_app() -> FastAPI:
    app = FastAPI(title=settings.app_name)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(api_router, prefix="/api/v1")

    return app

app = create_app()
```

好处：

- 应用创建逻辑清楚
- 测试时可以复用 `create_app()`
- 业务模块不会和框架入口互相缠住

### 23.4 API Router 汇总方式

可以用一个 `api/v1/router.py` 统一挂载各业务模块：

```python
from fastapi import APIRouter

from app.api.v1.endpoints import chat, documents, health, tasks

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(documents.router)
api_router.include_router(tasks.router)
api_router.include_router(chat.router)
```

这样 `main.py` 只需要引入一个 `api_router`，不会随着接口数量变多而越来越乱。

### 23.5 配置层 `core/config.py`

正式项目不要把数据库地址、Redis 地址、模型地址直接写死在业务代码里。更好的做法是用配置对象统一管理。

```python
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env")

    app_name: str = "rag-api"
    mysql_url: str
    redis_url: str
    llm_base_url: str
    embedding_model: str = "KaLM-Embedding-0.5B"
    cors_origins: list[str] = ["http://localhost:3000"]

settings = Settings()
```

这样可以做到：

- 本地、测试、生产环境分开配置
- 敏感信息不写进代码
- 配置类型可以被 Pydantic 校验

### 23.6 结合 RAG 项目的推荐结构

如果是你的 RAG 文档检索项目，可以这样对应：

```text
接口层：
- documents.py：上传文档、查询文档列表、删除文档
- tasks.py：查询 Celery 任务状态和进度
- chat.py：创建会话、提交问题、返回回答和 citations
- health.py：健康检查和依赖状态检查

业务层：
- document_service.py：保存文件、创建文档记录、提交 ingest 任务
- rag_service.py：Top-K 检索、上下文拼接、调用 LLM、保存 message/citation
- embedding_service.py：文本向量化、批量 embedding
- index_service.py：FAISS 索引构建、加载、保存

基础设施层：
- db/session.py：MySQL Session
- clients/redis_client.py：Redis 连接
- clients/llm_client.py：OpenAI-compatible LLM 调用
- clients/vector_store.py：FAISS 检索封装
- workers/tasks.py：文档解析、chunk、embedding、建索引
```

RAG 链路可以这样记：

```text
上传接口
  -> document_service 创建文档和任务
  -> Celery worker 解析文档
  -> chunk 切片
  -> embedding_service 生成向量
  -> index_service 写入 FAISS
  -> task 状态更新

问答接口
  -> rag_service 接收问题
  -> vector_store Top-K 检索
  -> 拼接上下文和 Prompt
  -> llm_client 调用模型
  -> 保存 answer 和 citation
  -> 返回给前端
```

### 23.7 什么时候需要拆得更细

如果项目只有几个接口：

```text
main.py
routers/
schemas/
services/
```

就已经够用。

当出现下面情况时，再继续拆：

- 接口超过十几个
- 多个接口复用同一批业务逻辑
- 数据库表开始变多
- 出现 Celery、Redis、LLM、向量库等外部依赖
- 测试变得难写
- `main.py` 或某个 router 文件超过几百行

不要为了“看起来专业”一开始就堆很多目录。目录结构的目的不是复杂，而是让业务边界清楚。

## 24. 常见坑

### 24.1 把所有代码都写在一个文件里

初学时能跑，项目一大就很难维护。

建议尽快学会：

- `APIRouter`
- 模块拆分
- 业务逻辑下沉到 service 层

### 24.2 在 `async def` 里跑重同步任务

这会阻塞事件循环。

如果是：

- 长时间计算
- 文件处理
- 模型推理

通常不应该直接堆在接口函数里。

### 24.3 请求体验证和返回结构不统一

如果不定义 Pydantic 模型，接口会越来越乱。

建议：

- 请求体尽量用模型
- 返回值尽量用 `response_model`

### 24.4 忽略文件上传安全问题

例如：

- 直接使用用户传上来的文件名
- 不限制文件类型
- 不限制文件大小

这些在正式项目里都容易出问题。

### 24.5 把 FastAPI 当成“万能后台线程框架”

FastAPI 主要是 Web API 框架，不是专门的任务调度系统。

如果任务已经明显是：

- 重任务
- 批处理
- 需要排队
- 需要重试

就应该交给 Celery 之类的任务系统。

## 25. 一套比较实用的学习顺序

建议按这个顺序掌握：

1. 先跑通最小示例
2. 理解路由、路径参数、查询参数
3. 学会用 Pydantic 定义请求体和返回体
4. 学会拆 `APIRouter`
5. 学会 `Depends`
6. 学会文件上传
7. 学会 `BackgroundTasks`
8. 最后再接入 Celery、数据库、鉴权

## 26. 总结

FastAPI 的核心价值在于：

- 用很少的代码快速暴露 API
- 自动完成参数解析和校验
- 自动生成接口文档
- 很适合和 Pydantic、Celery、Redis、数据库组合

对于 AI 项目，可以把它理解成：

- 对外接口入口
- 请求校验层
- 文件上传入口
- 任务分发入口
- 状态查询入口

如果你后面要继续整理 AI 模型开发相关知识点，FastAPI、Redis、Celery 这三份笔记其实可以看成一条链：

- FastAPI：接请求
- Redis：做缓存 / 消息中间件
- Celery：处理后台任务

## 27. 参考

- FastAPI Official Docs: https://fastapi.tiangolo.com/
- FastAPI Path Params: https://fastapi.tiangolo.com/tutorial/path-params/
- FastAPI Query Params: https://fastapi.tiangolo.com/tutorial/query-params/
- FastAPI Request Body: https://fastapi.tiangolo.com/tutorial/body/
- FastAPI APIRouter: https://fastapi.tiangolo.com/tutorial/bigger-applications/
- FastAPI Dependencies: https://fastapi.tiangolo.com/tutorial/dependencies/
- FastAPI File Upload: https://fastapi.tiangolo.com/tutorial/request-files/
- FastAPI Background Tasks: https://fastapi.tiangolo.com/tutorial/background-tasks/
- FastAPI Testing: https://fastapi.tiangolo.com/tutorial/testing/
- FastAPI Middleware: https://fastapi.tiangolo.com/tutorial/middleware/
- FastAPI Lifespan Events: https://fastapi.tiangolo.com/advanced/events/
- FastAPI Settings: https://fastapi.tiangolo.com/advanced/settings/
