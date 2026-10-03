---
title: "镜像明明构建成功，容器为什么一启动就退出？"
date: 2026-07-13 16:11:39
updated: 2026-07-13 16:11:39
categories:
  - "学习"
  - "Linux 与 C++ 工程化"
permalink: /notes/liunx-c-工程化/10-docket/
series: "Linux 与 C++ 工程化"
series_order: 10
---

时间：2026/05/06
整理：2026/07/06

> 关键词：Docker、镜像、容器、Dockerfile、数据卷、网络、Compose、C++、ONNX Runtime、OpenCV

---

你把 C++ ONNX 程序写进 Dockerfile，`docker build` 顺利结束，镜像也出现在列表中。可执行下面的命令后，`docker ps` 里却什么都没有：

```bash
docker run -d --name infer cpp-onnx:cpu
```

继续查看才发现容器已经退出：有时退出码是 0，因为默认命令执行完就结束；有时是 127，因为缺少 `libonnxruntime.so`；还有时程序找不到宿主机上的模型路径。镜像“构建成功”只证明每个构建步骤完成了，并不证明容器具备正确的主进程、动态库、挂载、网络、权限和运行配置。

本文从这个失败现场展开，先解释镜像、容器与主进程的关系，再逐步加入多阶段构建、数据卷、网络、Compose 和 C++ ONNX Runtime。最终目标不是记住一页 Docker 命令，而是建立一条可验证的部署契约：镜像交付程序与依赖，运行参数注入环境差异，容器主进程以前台方式运行，日志和退出码能够解释失败。

文中运行的是 Linux 容器。Linux 主机直接共享宿主机内核；macOS 和 Windows 上的 Docker Desktop 通常通过 Linux 虚拟机承载这些容器，因此文件挂载、网络和性能表现可能不同。示例中的版本标签用于固定演示环境，不表示当前最新版；正式项目还应固定镜像 digest、依赖锁定方式并验证供应链来源。

## 1. 构建成功为什么还不能证明部署成功？

开发一个 Linux 服务器程序时，经常遇到这些问题：

* 本机能跑，换一台机器就缺库、缺配置、缺系统包
* 开发环境、测试环境、生产环境版本不一致
* 部署服务时要手动安装依赖、创建目录、配置端口
* 多个服务共用一台机器，依赖版本互相影响
* 想快速启动、停止、回滚某个服务，但手工操作很容易遗漏步骤
* C++ 程序依赖 `.so` 动态库，拷贝到服务器后运行时报 `libxxx.so: cannot open shared object file`

Docker 的核心思路是：

```text
把程序 + 依赖库 + 运行配置 + 文件系统环境
打包成一个镜像
再从镜像启动一个隔离的容器进程
```

可以粗略理解成：

```text
Dockerfile  -> 描述如何制作镜像
image       -> 程序运行所需的只读文件系统模板
container   -> 镜像运行起来之后的进程和可写层
registry    -> 保存和分发镜像的仓库
compose     -> 描述多个容器如何一起运行
```

对于 C++ / ONNX 部署来说，Docker 最直接的价值是：

```text
固定 Linux 发行版
固定 glibc / libstdc++ 环境
固定 OpenCV / ONNX Runtime 版本
固定模型、配置、输入输出目录约定
固定启动命令
```

这样部署时不再依赖“服务器上刚好安装了正确的库”，而是把依赖一起交付。

---

## 2. 容器和虚拟机的区别

虚拟机通常包含完整操作系统：

```text
硬件
  ↑
宿主机操作系统
  ↑
Hypervisor
  ↑
Guest OS + 应用
```

Docker 容器共享宿主机内核：

```text
硬件
  ↑
宿主机 Linux 内核
  ↑
Docker Engine
  ↑
容器进程 + 独立文件系统视图
```

常见差异：

| 对比项 | Docker 容器 | 虚拟机 |
| --- | --- | --- |
| 启动速度 | 通常秒级 | 通常更慢 |
| 资源占用 | 较低 | 较高 |
| 内核 | 共享宿主机内核 | 每个虚拟机有自己的内核 |
| 隔离强度 | 进程级隔离 | 机器级隔离 |
| 镜像大小 | 通常较小 | 通常较大 |
| 适合场景 | 应用打包、部署、测试环境 | 强隔离、多系统内核环境 |

Docker 不是虚拟机。容器本质上还是宿主机上的进程，只是通过 Linux 内核能力做了隔离和资源限制。

Docker 常用的 Linux 内核机制：

* `namespace`：隔离进程、网络、挂载点、用户、主机名等视图
* `cgroups`：限制 CPU、内存、I/O 等资源
* `overlayfs`：把镜像层叠加成容器文件系统

一个重要结论：

> Docker 能隔离用户态环境，但不能改变宿主机内核。Linux 容器运行 Linux 程序，Windows 容器运行 Windows 程序，macOS 上的 Docker Desktop 本质上是在 Linux 虚拟机里运行 Linux 容器。

---

## 3. 镜像、容器、仓库和 Dockerfile

### 3.1 镜像 image

镜像是一个只读模板，里面包含：

* 基础系统文件，比如 `ubuntu`、`debian`、`alpine`
* 程序运行依赖，比如 `libstdc++`、`opencv`、`onnxruntime`
* 你的程序二进制文件
* 默认启动命令

查看本地镜像：

```bash
docker images
```

拉取镜像：

```bash
docker pull ubuntu:24.04
docker pull nginx:1.27
```

删除镜像：

```bash
docker rmi nginx:1.27
```

### 3.2 容器 container

容器是镜像运行起来之后的实例。一个镜像可以启动多个容器。

运行一个容器：

```bash
docker run ubuntu:24.04 echo "hello docker"
```

进入交互式 shell：

```bash
docker run --rm -it ubuntu:24.04 bash
```

查看正在运行的容器：

```bash
docker ps
```

查看所有容器：

```bash
docker ps -a
```

停止容器：

```bash
docker stop <container_id_or_name>
```

删除容器：

```bash
docker rm <container_id_or_name>
```

### 3.3 镜像仓库 registry

镜像仓库用来保存和分发镜像。常见仓库：

* Docker Hub
* GitHub Container Registry
* 公司内部镜像仓库

镜像名通常长这样：

```text
nginx:1.27
ubuntu:24.04
registry.example.com/backend/server:v1.0.0
```

格式大致是：

```text
仓库地址/命名空间/镜像名:标签
```

工程里尽量固定版本标签，例如：

```text
ubuntu:24.04
redis:7.4
myserver:2026-07-06
```

少用裸 `latest`，否则同一份 Dockerfile 在不同时间构建出来的环境可能不同。

### 3.4 Dockerfile

`Dockerfile` 是构建镜像的说明书。

最小示例：

```dockerfile
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

CMD ["curl", "--version"]
```

构建镜像：

```bash
docker build -t curl-demo:v1 .
```

运行镜像：

```bash
docker run --rm curl-demo:v1
```

---

## 4. 第一个容器：从 hello-world 到 nginx

运行官方测试镜像：

```bash
docker run hello-world
```

运行一个后台 nginx：

```bash
docker run -d --name web -p 8080:80 nginx:1.27
```

参数含义：

| 参数 | 含义 |
| --- | --- |
| `-d` | 后台运行 |
| `--name web` | 容器命名为 `web` |
| `-p 8080:80` | 把宿主机 `8080` 端口映射到容器 `80` 端口 |
| `nginx:1.27` | 使用的镜像 |

访问：

```bash
curl http://127.0.0.1:8080
```

查看日志：

```bash
docker logs web
```

进入容器：

```bash
docker exec -it web sh
```

停止并删除：

```bash
docker stop web
docker rm web
```

临时运行一个容器并自动删除：

```bash
docker run --rm -it ubuntu:24.04 bash
```

`--rm` 很适合练习和一次性任务，容器退出后不会留下停止状态的容器。

---

## 5. `docker run` 常用参数

常用形式：

```bash
docker run [options] image [command]
```

常见参数：

| 参数 | 作用 |
| --- | --- |
| `-d` | 后台运行 |
| `-it` | 交互式终端 |
| `--name` | 指定容器名 |
| `--rm` | 容器退出后自动删除 |
| `-p host:container` | 端口映射 |
| `-v host:container` | 挂载目录或数据卷 |
| `-e KEY=VALUE` | 设置环境变量 |
| `--env-file` | 从文件读取环境变量 |
| `--network` | 指定网络 |
| `--restart` | 设置重启策略 |
| `--memory` | 限制内存 |
| `--cpus` | 限制 CPU |
| `--entrypoint` | 覆盖镜像入口命令 |
| `-w` | 设置容器工作目录 |

服务例子：

```bash
docker run -d \
  --name myserver \
  -p 9000:9000 \
  -e LOG_LEVEL=info \
  --restart unless-stopped \
  myserver:v1
```

含义：

* 后台运行 `myserver:v1`
* 容器名叫 `myserver`
* 暴露服务端口 `9000`
* 设置环境变量 `LOG_LEVEL=info`
* Docker 重启后自动拉起容器

开发环境例子：

```bash
docker run --rm -it \
  -v "$PWD":/work \
  -w /work \
  ubuntu:24.04 bash
```

含义：

* 把当前目录挂载到容器 `/work`
* 容器退出后自动删除
* 在容器内直接操作当前工程目录

ONNX 推理例子：

```bash
docker run --rm -it \
  -v "$PWD/models":/models:ro \
  -v "$PWD/data":/data:ro \
  -v "$PWD/outputs":/outputs \
  -e MODEL_PATH=/models/model.onnx \
  -e INPUT_PATH=/data/test.jpg \
  cpp-onnx:cpu
```

这里的 `:ro` 表示只读挂载，适合模型和输入数据，避免容器意外改动原始文件。

---

## 6. 容器生命周期与常用管理命令

容器生命周期大致是：

```text
create -> start -> running -> stop -> removed
```

常用命令：

```bash
docker create --name app myserver:v1
docker start app
docker stop app
docker restart app
docker rm app
```

查看容器状态：

```bash
docker inspect app
```

查看容器资源占用：

```bash
docker stats
```

查看容器内进程：

```bash
docker top app
```

注意：

> 容器的主进程退出后，容器就会停止。服务容器通常以前台方式运行服务进程，而不是在容器内部再把服务放到后台。

错误写法：

```bash
./myserver &
```

正确思路：

```dockerfile
CMD ["/app/myserver"]
```

这里使用 JSON 数组形式，也叫 exec form。程序会直接成为容器内的 PID 1，更容易收到 `docker stop` 发出的终止信号。下面的 shell form 会额外经过 `/bin/sh -c`，如果没有正确转发信号，服务可能等到超时后才被强制结束：

```dockerfile
# 长期服务不推荐这样写
CMD /app/myserver
```

C++ 服务本身仍要正确处理 `SIGTERM`：停止接收新请求、让正在处理的任务在有上限的时间内结束、刷新必要数据，然后返回明确退出码。如果程序还会创建并遗留子进程，可评估 `docker run --init` 或在镜像中使用专门 init；不要让 shell 脚本无意中变成不转发信号的 PID 1。

如果需要临时查看容器为什么退出：

```bash
docker ps -a
docker logs <container_name>
docker inspect <container_name>
```

---

## 7. Dockerfile：构建自己的镜像

### 7.1 常用 Dockerfile 指令

| 指令 | 含义 |
| --- | --- |
| `FROM` | 指定基础镜像 |
| `WORKDIR` | 设置工作目录 |
| `COPY` | 复制文件到镜像 |
| `RUN` | 构建镜像时执行命令 |
| `ENV` | 设置环境变量 |
| `ARG` | 设置构建参数 |
| `EXPOSE` | 声明容器服务端口 |
| `CMD` | 默认启动命令 |
| `ENTRYPOINT` | 固定入口命令 |

`RUN` 和 `CMD` 的区别：

* `RUN` 在构建镜像时执行，结果会写进镜像层
* `CMD` 在容器启动时执行，是容器的默认主进程

`EXPOSE 9000` 也只是镜像元数据，用来声明程序预期监听的端口；它不会自动把端口发布到宿主机。外部访问仍需 `docker run -p 9000:9000 ...` 或 Compose `ports`。容器内程序还必须监听容器可访问的地址，不能只绑定 `127.0.0.1` 后又期待宿主机端口映射生效。

例子：

```dockerfile
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

CMD ["curl", "--version"]
```

### 7.2 镜像分层和构建缓存

Dockerfile 每条指令通常会形成一层。构建时 Docker 会尽量复用缓存。

缓存命中思路：

```text
变化少的步骤放前面
变化多的源码 COPY 放后面
```

C++ 项目常见写法：

```dockerfile
WORKDIR /src

COPY CMakeLists.txt .
COPY cmake ./cmake
COPY include ./include
COPY src ./src

RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --parallel 4
```

如果项目依赖文件单独存在，也可以先复制依赖描述，再复制源码，以便依赖安装层复用缓存。

### 7.3 `.dockerignore`

`.dockerignore` 用来排除不该发送给 Docker 构建上下文的文件。

推荐示例：

```text
.git
build
cmake-build-*
*.log
*.tmp
.DS_Store
node_modules
data
datasets
outputs
runs
```

注意：

* 不要把大型数据集、模型权重、实验输出直接打进镜像
* 模型文件更常见的做法是运行时挂载到 `/models`
* 输入数据挂载到 `/data`
* 结果输出挂载到 `/outputs`

---

## 8. 案例一：打包一个 C++ TCP 服务端

假设项目结构：

```text
server/
├── CMakeLists.txt
├── src/
│   └── main.cpp
└── Dockerfile
```

可以写一个多阶段构建 Dockerfile：

```dockerfile
FROM ubuntu:24.04 AS builder

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    libevent-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .

RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --parallel 4

FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    libevent-2.1-7 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /src/build/myserver /app/myserver

EXPOSE 9000
CMD ["/app/myserver"]
```

构建：

```bash
docker build -t myserver:v1 .
```

运行：

```bash
docker run -d --name myserver -p 9000:9000 myserver:v1
```

测试：

```bash
nc 127.0.0.1 9000
```

查看日志：

```bash
docker logs -f myserver
```

多阶段构建的好处：

* 编译工具链只留在 `builder` 阶段
* 最终镜像只包含运行服务所需文件
* 镜像更小，攻击面也更小
* C++ 编译依赖和运行依赖分离，部署更清楚

---

## 9. 数据卷：保存数据与挂载工程目录

容器文件系统默认是临时的。容器删除后，容器内部写入的数据也会丢失。

如果要保存数据，应使用数据卷或目录挂载。

### 9.1 命名卷

创建数据卷：

```bash
docker volume create mysql-data
```

使用数据卷：

```bash
docker run -d \
  --name mysql \
  -v mysql-data:/var/lib/mysql \
  -e MYSQL_ROOT_PASSWORD=123456 \
  mysql:8
```

查看数据卷：

```bash
docker volume ls
```

删除数据卷：

```bash
docker volume rm mysql-data
```

命名卷适合数据库、缓存持久化目录等不需要你直接手动编辑的内容。

### 9.2 宿主机目录挂载

```bash
docker run --rm -it \
  -v "$PWD":/work \
  -w /work \
  ubuntu:24.04 bash
```

含义：

* 把当前目录挂载到容器 `/work`
* 容器工作目录设置成 `/work`
* 容器里修改 `/work`，宿主机当前目录也会变化

工程经验：

* 数据库数据更适合使用命名卷
* 开发调试更适合使用宿主机目录挂载
* 模型和输入数据通常用只读挂载 `:ro`
* 输出目录用可写挂载，例如 `-v "$PWD/outputs":/outputs`
* 不要把敏感目录随意挂进容器，比如 `/`、`/etc`、`/var/run/docker.sock`

### 9.3 C++ ONNX 项目的目录挂载约定

推荐把路径固定成：

```text
/app       程序目录
/models    模型目录，只读挂载
/data      输入图片或视频，只读挂载
/outputs   输出结果，可写挂载
/configs   配置文件，只读挂载
```

运行命令：

```bash
docker run --rm -it \
  -v "$PWD/models":/models:ro \
  -v "$PWD/data":/data:ro \
  -v "$PWD/outputs":/outputs \
  -v "$PWD/configs":/configs:ro \
  cpp-onnx:cpu
```

这样做的好处：

* 镜像不绑定某个具体模型文件
* 换模型不需要重新构建镜像
* 输入和输出路径清晰
* 生产环境和本地测试可以使用同一套容器启动方式

---

## 10. Docker 网络：端口映射与容器互联

Docker 默认会创建一个 `bridge` 网络。容器之间如果在同一个自定义网络里，可以通过容器名互相访问。

创建网络：

```bash
docker network create app-net
```

运行 Redis：

```bash
docker run -d --name redis --network app-net redis:7
```

运行应用：

```bash
docker run -d \
  --name app \
  --network app-net \
  -e REDIS_HOST=redis \
  myserver:v1
```

此时 `app` 容器里可以用 `redis:6379` 访问 Redis。

常见网络模式：

| 模式 | 含义 |
| --- | --- |
| `bridge` | 默认桥接网络，最常用 |
| `host` | 直接使用宿主机网络命名空间，Linux 上常见 |
| `none` | 不配置网络 |
| 自定义 bridge | 推荐给一组服务使用 |

注意：

* `-p 8080:80` 是把容器端口暴露给宿主机
* 同一 Docker 网络内，容器之间通常不需要 `-p`
* 容器互访时使用容器内部端口，不使用宿主机映射端口
* 生产环境应只暴露外部真正需要访问的端口

C++ 推理程序如果只是离线图片或视频处理，通常不需要暴露端口。
如果它是 HTTP / gRPC 推理服务，才需要 `-p` 映射服务端口。

---

## 11. Docker Compose：管理多容器项目

当一个项目包含多个服务，比如：

```text
web server + redis + mysql
```

继续手写多个 `docker run` 命令会很麻烦。Docker Compose 用一个 `compose.yaml` 描述这些容器。

示例：

```yaml
services:
  app:
    build: .
    ports:
      - "9000:9000"
    environment:
      LOG_LEVEL: info
      REDIS_HOST: redis
    depends_on:
      redis:
        condition: service_healthy
    restart: unless-stopped

  redis:
    image: redis:7.4
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

volumes:
  redis-data:
```

普通短写法 `depends_on: [redis]` 只保证启动顺序，不保证 Redis 已经能处理请求。这里用 `healthcheck` 和 `condition: service_healthy` 等待依赖进入健康状态；应用自身仍应实现连接超时与有上限重试，因为运行期间 Redis 依旧可能重启或失联。

`container_name` 也不是服务发现所必需的。Compose 默认网络已经可以使用服务名 `redis` 解析依赖，省略固定容器名更利于项目隔离和水平扩展。

启动：

```bash
docker compose up -d
```

查看状态：

```bash
docker compose ps
```

查看日志：

```bash
docker compose logs -f app
```

停止并删除容器：

```bash
docker compose down
```

连数据卷一起删除：

```bash
docker compose down -v
```

### 11.1 C++ ONNX 离线推理 Compose 示例

```yaml
services:
  onnx-infer:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        ORT_VERSION: "1.26.0"
    image: cpp-onnx:cpu
    environment:
      MODEL_PATH: /models/model.onnx
      INPUT_PATH: /data/test.jpg
      OUTPUT_DIR: /outputs
      LOG_LEVEL: info
    volumes:
      - ./models:/models:ro
      - ./data:/data:ro
      - ./outputs:/outputs
    command: ["/app/onnx_demo"]
```

运行一次推理：

```bash
docker compose run --rm onnx-infer
```

如果程序是长期服务，可以改成：

```yaml
services:
  onnx-server:
    image: cpp-onnx:cpu
    ports:
      - "8080:8080"
    volumes:
      - ./models:/models:ro
      - ./configs:/configs:ro
    restart: unless-stopped
    command: ["/app/onnx_server", "--config", "/configs/app.yaml"]
```

---

## 12. 调试容器：日志、进入容器、排查依赖

### 12.1 查看日志

```bash
docker logs -f myserver
```

Compose 项目：

```bash
docker compose logs -f app
```

### 12.2 进入容器

```bash
docker exec -it myserver sh
```

如果镜像里有 `bash`：

```bash
docker exec -it myserver bash
```

一次性调试入口：

```bash
docker run --rm -it --entrypoint bash cpp-onnx:cpu
```

### 12.3 查看配置和挂载

```bash
docker inspect myserver
```

重点看：

* `Mounts`
* `Env`
* `NetworkSettings`
* `State`
* `Config.Cmd`
* `Config.Entrypoint`

### 12.4 查看端口

```bash
docker port myserver
```

容器内看监听端口：

```bash
docker exec -it myserver ss -lntp
```

### 12.5 排查 C++ 动态库

C++ 容器化最常见问题之一是动态库缺失。

进入容器后执行：

```bash
ldd /app/onnx_demo
```

如果看到：

```text
libonnxruntime.so.1 => not found
```

说明运行阶段没有找到 ONNX Runtime 动态库。解决方式通常是：

* 把 `libonnxruntime.so*` 复制到 `/usr/local/lib`
* 执行 `ldconfig`
* 或者设置 `LD_LIBRARY_PATH`
* 或者在 CMake 中设置 RPATH

更推荐的运行阶段做法：

```dockerfile
COPY --from=builder /opt/onnxruntime/lib/libonnxruntime.so* /usr/local/lib/
RUN ldconfig
```

### 12.6 临时启动一个网络排查容器

```bash
docker run --rm -it --network app-net nicolaka/netshoot
```

这个镜像常用于网络排查，里面带了 `curl`、`dig`、`tcpdump`、`ss` 等工具。

---

## 13. 案例二：用 Docker 搭建 C++ 编译环境

有时不急着把程序打成最终镜像，只是想要一个干净、可复制的 C++ 编译环境。

### 13.1 临时编译一个 C++ 文件

当前目录有 `main.cpp`：

```cpp
#include <iostream>

int main() {
    std::cout << "hello docker c++\n";
    return 0;
}
```

进入编译环境：

```bash
docker run --rm -it \
  -v "$PWD":/work \
  -w /work \
  ubuntu:24.04 bash
```

容器里安装编译器并编译：

```bash
apt-get update
apt-get install -y --no-install-recommends build-essential
g++ -std=c++17 -O2 main.cpp -o hello
./hello
```

这个适合临时验证，但不适合正式项目，因为每次进入容器都要重新安装工具链。

### 13.2 固定一个 C++ 开发镜像

`Dockerfile.dev`：

```dockerfile
FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    ninja-build \
    pkg-config \
    gdb \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work
CMD ["bash"]
```

构建：

```bash
docker build -f Dockerfile.dev -t cpp-dev:ubuntu24 .
```

使用：

```bash
docker run --rm -it \
  -v "$PWD":/work \
  -w /work \
  cpp-dev:ubuntu24
```

容器里构建 CMake 项目：

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel 4
```

这种方式适合：

* 学习 CMake
* 验证 Linux 编译
* 在 macOS 上模拟 Linux 构建环境
* 快速复现别人项目的依赖环境

---

## 14. 实战：部署 C++ ONNX Runtime 推理环境

目标：把一个 C++ ONNX Runtime 推理程序打进 Docker 镜像，在容器内加载 ONNX 模型，用 OpenCV 读图或读视频，输出推理结果。

典型链路：

```text
宿主机准备模型和输入数据
    ↓
docker build 构建 C++ 推理镜像
    ↓
docker run 挂载 /models、/data、/outputs
    ↓
容器内加载 libonnxruntime.so、OpenCV、模型文件
    ↓
执行预处理、ONNX 推理、后处理
    ↓
结果写入 /outputs 或输出到 stdout
```

### 14.1 推荐项目结构

```text
cpp-onnx-demo/
├── CMakeLists.txt
├── Dockerfile
├── compose.yaml
├── .dockerignore
├── src/
│   ├── main.cpp
│   ├── ort_runner.cpp
│   ├── ort_runner.h
│   ├── preprocess.cpp
│   └── preprocess.h
├── models/
│   └── model.onnx
├── data/
│   └── test.jpg
└── outputs/
```

建议：

* `src/` 放 C++ 源码
* `models/` 放模型，运行时挂载，不建议打进镜像
* `data/` 放测试图片或视频，运行时挂载
* `outputs/` 放推理结果
* 镜像里只放程序和运行依赖

### 14.2 CMakeLists.txt 示例

如果项目没有现成的 CMake，可以用下面这种最小结构。这里假设 ONNX Runtime 安装在 `/opt/onnxruntime`。

```cmake
cmake_minimum_required(VERSION 3.20)

project(CppOnnxDemo LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(OpenCV REQUIRED)

set(ONNXRUNTIME_ROOT "/opt/onnxruntime" CACHE PATH "ONNX Runtime root directory")

add_executable(onnx_demo
    src/main.cpp
    src/ort_runner.cpp
    src/preprocess.cpp
)

target_include_directories(onnx_demo PRIVATE
    ${ONNXRUNTIME_ROOT}/include
)

target_link_libraries(onnx_demo PRIVATE
    ${OpenCV_LIBS}
    ${ONNXRUNTIME_ROOT}/lib/libonnxruntime.so
)

install(TARGETS onnx_demo RUNTIME DESTINATION bin)
```

如果运行时报找不到 `libonnxruntime.so`，优先在 Dockerfile 运行阶段复制动态库并执行 `ldconfig`。

### 14.3 CPU 版本 Dockerfile

这个 Dockerfile 使用多阶段构建：

* `builder` 阶段安装编译器、CMake、OpenCV 开发包、ONNX Runtime
* `runtime` 阶段只保留运行程序需要的依赖

`ORT_VERSION` 要固定为你已经验证过的版本。下面以 2026 年 7 月可用的 `1.26.0` 为示例；以后升级时应重新核对 Release 资产名、opset/EP 兼容性和数值回归，不能只改版本字符串。

```dockerfile
FROM ubuntu:24.04 AS builder

ARG DEBIAN_FRONTEND=noninteractive
ARG ORT_VERSION=1.26.0
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    ca-certificates \
    wget \
    pkg-config \
    libopencv-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

RUN case "${TARGETARCH}" in \
        amd64) ORT_ARCH=x64 ;; \
        arm64) ORT_ARCH=aarch64 ;; \
        *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && ORT_DIR="onnxruntime-linux-${ORT_ARCH}-${ORT_VERSION}" \
    && wget -O onnxruntime.tgz \
        "https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/${ORT_DIR}.tgz" \
    && tar -xzf onnxruntime.tgz \
    && mv "${ORT_DIR}" onnxruntime \
    && rm onnxruntime.tgz

WORKDIR /src

COPY CMakeLists.txt .
COPY src ./src

RUN cmake -S . -B build \
    -DCMAKE_BUILD_TYPE=Release \
    -DONNXRUNTIME_ROOT=/opt/onnxruntime \
    && cmake --build build --parallel 4 \
    && cmake --install build --prefix /install

FROM ubuntu:24.04 AS runtime

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    libopencv-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/onnxruntime/lib/libonnxruntime.so* /usr/local/lib/
COPY --from=builder /install/bin/onnx_demo /app/onnx_demo

RUN ldconfig

WORKDIR /app

ENV MODEL_PATH=/models/model.onnx
ENV INPUT_PATH=/data/test.jpg
ENV OUTPUT_DIR=/outputs

CMD ["/app/onnx_demo"]
```

为了让示例跨 Ubuntu 小版本更容易阅读，runtime 阶段直接安装了 `libopencv-dev`，但它会带入头文件和不必要的开发内容。生产镜像应根据 `ldd /app/onnx_demo` 和实际编解码功能安装对应运行时包，再用集成测试确认没有漏库；不要只为追求镜像体积随意删除依赖。

BuildKit 会为目标平台提供 `TARGETARCH`。上面的 Dockerfile把 Docker 的 `amd64/arm64` 映射到 ONNX Runtime Release 资产使用的 `x64/aarch64`，遇到其他架构则直接失败，避免悄悄下载错误二进制。构建前仍应到对应 Release 页面确认该版本确实发布了目标架构资产，并在供应链要求较高的环境中校验下载文件的摘要。

Apple Silicon 上可以显式构建 `--platform=linux/amd64` 并通过虚拟化/仿真运行 x86_64 镜像，但这更适合兼容性验证，不能用于代表真实 x86_64 服务器的性能 benchmark。生产镜像应尽量在目标架构上构建和测试。

构建：

```bash
docker build \
  --build-arg ORT_VERSION=1.26.0 \
  -t cpp-onnx:cpu .
```

运行：

```bash
mkdir -p outputs

docker run --rm -it \
  -v "$PWD/models":/models:ro \
  -v "$PWD/data":/data:ro \
  -v "$PWD/outputs":/outputs \
  -e MODEL_PATH=/models/model.onnx \
  -e INPUT_PATH=/data/test.jpg \
  -e OUTPUT_DIR=/outputs \
  cpp-onnx:cpu
```

进入容器排查：

```bash
docker run --rm -it \
  --entrypoint bash \
  -v "$PWD/models":/models:ro \
  -v "$PWD/data":/data:ro \
  cpp-onnx:cpu
```

容器内检查：

```bash
ls -lh /models
ls -lh /data
ldd /app/onnx_demo
/app/onnx_demo
```

### 14.4 `.dockerignore` 示例

```text
.git
build
cmake-build-*
*.log
*.tmp
.DS_Store
models
data
outputs
runs
```

这里排除 `models`、`data`、`outputs` 是为了避免把大文件打进镜像。运行时用 `-v` 挂载。

### 14.5 Compose 版本

`compose.yaml`：

```yaml
services:
  onnx-infer:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        ORT_VERSION: "1.26.0"
    image: cpp-onnx:cpu
    environment:
      MODEL_PATH: /models/model.onnx
      INPUT_PATH: /data/test.jpg
      OUTPUT_DIR: /outputs
    volumes:
      - ./models:/models:ro
      - ./data:/data:ro
      - ./outputs:/outputs
    command: ["/app/onnx_demo"]
```

构建并运行：

```bash
docker compose build onnx-infer
docker compose run --rm onnx-infer
```

### 14.6 C++ 程序应支持的最小配置

为了让容器启动命令简单，C++ 程序建议从环境变量读取路径：

```cpp
#include <cstdlib>
#include <iostream>
#include <string>

std::string getenv_or(const char* key, const std::string& fallback) {
    const char* value = std::getenv(key);
    return value ? std::string(value) : fallback;
}

int main() {
    const std::string model_path = getenv_or("MODEL_PATH", "/models/model.onnx");
    const std::string input_path = getenv_or("INPUT_PATH", "/data/test.jpg");
    const std::string output_dir = getenv_or("OUTPUT_DIR", "/outputs");

    std::cout << "model: " << model_path << '\n';
    std::cout << "input: " << input_path << '\n';
    std::cout << "output: " << output_dir << '\n';

    return 0;
}
```

实际推理代码里至少要把这些错误打到 `stdout` / `stderr`：

* 模型文件不存在
* 图片或视频打开失败
* ONNX Runtime 创建 Session 失败
* 输入 shape 和程序预期不一致
* 输出 tensor shape 不符合后处理逻辑
* 输出目录不可写

容器里日志最好直接输出到终端，不要只写到容器内部文件，否则 `docker logs` 看不到。

### 14.7 ONNX Runtime C++ 初始化要点

核心配置通常包括：

```cpp
Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "onnx_demo");
Ort::SessionOptions session_options;

session_options.SetGraphOptimizationLevel(
    GraphOptimizationLevel::ORT_ENABLE_EXTENDED
);

session_options.SetIntraOpNumThreads(4);

Ort::Session session(env, model_path.c_str(), session_options);
```

建议：

* 先跑通 `CPUExecutionProvider`
* 先建立 FP32 正确性基线
* 再测试图优化、线程数、INT8、CUDA 或 TensorRT
* 每次只改一个变量，记录推理耗时和端到端耗时

### 14.8 预处理和后处理不要藏在 Docker 里

Docker 只负责环境一致，不能替你保证模型结果正确。

C++ ONNX 推理程序仍然要确认：

```text
BGR / RGB 是否一致
HWC -> CHW 是否正确
uint8 -> float32 是否正确
是否除以 255
letterbox 的 padding 是否记录
输出 shape 是否和模型一致
坐标是否从模型输入尺寸映射回原图
NMS 是否重复执行
```

容器化后的验证顺序：

```text
同一张图片
    ↓
Python 推理结果
    ↓
C++ 本机推理结果
    ↓
Docker 内 C++ 推理结果
```

如果 Docker 内结果不一致，优先排查：

* OpenCV 版本差异
* 模型文件是否同一个
* 输入图片是否同一个
* 工作目录和相对路径
* 动态库版本
* 线程数和非确定性后处理

### 14.9 CPU 性能配置

运行时限制资源：

```bash
docker run --rm -it \
  --cpus 4 \
  --memory 4g \
  -v "$PWD/models":/models:ro \
  -v "$PWD/data":/data:ro \
  -v "$PWD/outputs":/outputs \
  cpp-onnx:cpu
```

程序内部也要避免线程过度竞争：

```text
推理 worker 数 × ONNX Runtime intra_op 线程数
```

不要明显大于机器实际物理核心数。

性能统计建议至少拆成：

```text
decode_ms
preprocess_ms
onnx_ms
postprocess_ms
render_or_write_ms
total_ms
```

只看 FPS 不够，因为 FPS 不能告诉你瓶颈在模型推理、预处理、后处理还是视频读写。

### 14.10 可选：CUDA / GPU 版本

如果部署目标是 NVIDIA GPU，通常需要：

* 宿主机有 NVIDIA 驱动
* 宿主机已配置 NVIDIA Container Toolkit
* 镜像使用 CUDA / cuDNN 运行时基础镜像
* ONNX Runtime 使用 GPU 包
* 启动容器时加 `--gpus all`

注意：

> macOS Docker Desktop 不能直接提供 NVIDIA CUDA GPU 给 Linux 容器。CUDA 容器部署通常针对 Linux + NVIDIA GPU 服务器。

GPU 版 Dockerfile 只展示关键差异：

```dockerfile
FROM nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04 AS builder

ARG DEBIAN_FRONTEND=noninteractive
ARG ORT_VERSION=1.26.0

# 这里和 CPU 版类似：安装 build-essential、cmake、OpenCV，下载 GPU 版 ONNX Runtime。
# 注意 builder 和 runtime 都使用 ubuntu22.04，避免 glibc 版本不匹配。
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    ca-certificates \
    wget \
    pkg-config \
    libopencv-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

RUN wget -O onnxruntime.tgz \
    "https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/onnxruntime-linux-x64-gpu-${ORT_VERSION}.tgz" \
    && tar -xzf onnxruntime.tgz \
    && mv "onnxruntime-linux-x64-gpu-${ORT_VERSION}" onnxruntime \
    && rm onnxruntime.tgz

# COPY 源码、cmake 构建、cmake install 与 CPU 版相同。

FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04 AS runtime

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    libopencv-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/onnxruntime/lib/libonnxruntime.so* /usr/local/lib/
COPY --from=builder /install/bin/onnx_demo /app/onnx_demo

RUN ldconfig

WORKDIR /app
CMD ["/app/onnx_demo"]
```

关键点：

* `devel` 镜像用于编译，`runtime` 镜像用于运行
* `builder` 和 `runtime` 尽量使用同一个 Ubuntu 版本
* GPU 版 ONNX Runtime 包名通常带 `gpu`
* 程序内部还要显式注册 CUDA Execution Provider

运行：

```bash
docker run --rm -it \
  --gpus all \
  -v "$PWD/models":/models:ro \
  -v "$PWD/data":/data:ro \
  -v "$PWD/outputs":/outputs \
  cpp-onnx:gpu
```

GPU 版本不要只看容器能不能启动，还要确认程序确实启用了 CUDA Execution Provider。否则可能仍然在 CPU 上跑。

这个 GPU 示例使用 `linux-x64-gpu` 资产，目标是常见的 x86_64 Linux + NVIDIA GPU 服务器。Jetson 等 ARM64 NVIDIA 平台的 CUDA、TensorRT、JetPack 与 ONNX Runtime 组合不同，不能只把 `x64` 替换成 `aarch64` 就假定可用，必须依据目标设备版本矩阵选择官方包或自行构建。

### 14.11 部署检查脚本思路

正式部署前可以准备一个最小自检命令：

```bash
docker run --rm \
  -v "$PWD/models":/models:ro \
  -v "$PWD/data":/data:ro \
  -v "$PWD/outputs":/outputs \
  cpp-onnx:cpu \
  /app/onnx_demo
```

自检应确认：

```text
模型文件存在
输入文件存在
输出目录可写
动态库全部找到
能创建 ONNX Runtime Session
能完成一次推理
输出结果数量合理
耗时日志可见
容器退出码为 0
```

---

## 15. 常见问题和排查思路

### 15.1 容器启动后立刻退出

原因通常是主进程执行完了。

例如：

```bash
docker run ubuntu:24.04
```

这条命令没有前台任务，容器会马上退出。

可以这样进入 shell：

```bash
docker run -it ubuntu:24.04 bash
```

服务类容器应该以前台方式运行：

```dockerfile
CMD ["/app/myserver"]
```

不要在容器启动命令里把服务放到后台：

```bash
./myserver &
```

### 15.2 宿主机访问不到容器服务

检查：

* 程序是否监听 `0.0.0.0`，而不是只监听 `127.0.0.1`
* 是否用了 `-p host_port:container_port`
* 容器内服务端口是否正确
* 防火墙是否阻止连接

查看监听：

```bash
docker exec -it myserver ss -lntp
```

### 15.3 容器之间访问不到

检查：

* 两个容器是否在同一个 Docker 网络
* 是否使用容器名作为主机名
* 服务端口是否是容器内部端口，而不是宿主机映射端口

### 15.4 修改代码后镜像没有变化

重新构建：

```bash
docker build -t myserver:v1 .
```

如果缓存导致结果不符合预期：

```bash
docker build --no-cache -t myserver:v1 .
```

`--no-cache` 适合诊断缓存相关假设，不应成为每次构建的默认修复。先确认构建上下文是否正确、源码是否被 `.dockerignore` 排除、`COPY` 是否覆盖目标文件，以及运行的容器是否真的来自刚构建的 tag。否则禁用缓存只会让构建更慢，并不能修复错误的上下文或镜像标签。

### 15.5 磁盘空间被占满

查看空间：

```bash
docker system df
```

清理未使用资源：

```bash
docker system prune
```

清理未使用镜像、容器、网络和构建缓存：

```bash
docker system prune -a
```

注意：清理命令会删除未使用资源，执行前要确认没有需要保留的镜像或容器。

### 15.6 C++ 程序找不到动态库

典型错误：

```text
error while loading shared libraries: libonnxruntime.so.1: cannot open shared object file
```

排查：

```bash
ldd /app/onnx_demo
```

解决：

```dockerfile
COPY --from=builder /opt/onnxruntime/lib/libonnxruntime.so* /usr/local/lib/
RUN ldconfig
```

或者运行时设置：

```dockerfile
ENV LD_LIBRARY_PATH=/usr/local/lib:${LD_LIBRARY_PATH}
```

更工程化的方式是在 CMake 安装阶段设置 RPATH，不过对初学部署来说，先用 `ldconfig` 更直接。

### 15.7 模型路径在本机存在，容器里不存在

本机路径：

```text
/Users/me/project/models/model.onnx
```

容器内不一定存在。必须显式挂载：

```bash
docker run --rm -it \
  -v "$PWD/models":/models:ro \
  -e MODEL_PATH=/models/model.onnx \
  cpp-onnx:cpu
```

程序里不要硬编码宿主机绝对路径。

### 15.8 OpenCV 读不到图片或视频

检查：

* 文件是否挂载进容器
* 容器内路径是否正确
* OpenCV 是否安装了需要的图片或视频编解码依赖
* 文件名大小写是否一致
* 程序是否用相对路径，工作目录是否符合预期

容器内检查：

```bash
ls -lh /data
```

### 15.9 ONNX Runtime 能加载模型，但结果不对

这通常不是 Docker 的问题，而是推理链路问题。

优先检查：

```text
输入尺寸
BGR/RGB
HWC/CHW/NCHW
normalize
letterbox
padding 回映射
输出 shape
类别顺序
NMS 阈值
```

对照 Python 推理结果做一张图片的最小复现。

### 15.10 容器内速度和宿主机不同

可能原因：

* Docker Desktop 在 macOS / Windows 上经过 Linux 虚拟机
* 挂载目录 I/O 比容器内部文件慢
* CPU 和内存限制不同
* ONNX Runtime 线程数不同
* OpenCV / ORT 动态库版本不同
* GPU 没有透传，实际在 CPU 上跑

建议记录：

```text
镜像 tag
模型 hash
输入数据
CPU 核数
内存限制
ORT 版本
OpenCV 版本
线程数
P50 / P95 延迟
```

---

## 16. 推荐实践

### 16.1 Dockerfile

* 使用明确的镜像标签，比如 `ubuntu:24.04`，少用裸 `latest`
* 使用多阶段构建，编译环境和运行环境分离
* 把变化少的步骤放在前面，提升构建缓存命中率
* 构建完成后清理包管理器缓存
* `.dockerignore` 排除 `build/`、`.git/`、日志、数据集、模型和输出结果
* 镜像中不要保存密码、私钥和 token
* 构建阶段需要凭据时使用 BuildKit secret/SSH mount，不要通过 `ARG`、`ENV` 或 `COPY` 传入
* 运行阶段在条件允许时使用固定的非 root 用户，并提前验证 bind mount 的 UID/GID 和写权限
* 不要把大型模型和数据集直接打进镜像，优先运行时挂载

### 16.2 容器运行

* 用 `--name` 给重要容器命名
* 用 `--restart unless-stopped` 管理服务自动重启
* 用 `docker logs` 观察服务日志
* 用数据卷保存持久化数据
* 用自定义网络连接一组服务
* 模型和输入数据用只读挂载
* 输出目录用单独可写挂载
* 给容器设置合理的 CPU 和内存限制

### 16.3 C++ 服务

* 服务进程以前台方式运行
* 日志输出到 `stdout` / `stderr`
* 配置通过环境变量、配置文件或挂载注入
* 不把重要数据只写在容器临时文件系统里
* 只暴露必要端口
* 用 `ldd` 检查动态库依赖
* 对外提供明确的退出码和错误日志

### 16.4 ONNX 部署

* 先确认模型输入输出契约，再写 Dockerfile
* 先跑通 CPU，再考虑 CUDA、TensorRT 或其他 EP
* 先建立 FP32 基线，再测试 INT8
* 模型文件和配置文件运行时挂载
* 推理程序打印 ORT 版本、模型路径、输入 shape 和线程配置
* 性能日志拆分预处理、推理、后处理和总耗时
* 不要把 Docker 环境问题和模型数值问题混在一起排查

---

## 17. 常用命令速查

| 命令 | 作用 |
| --- | --- |
| `docker version` | 查看 Docker 客户端和服务端版本 |
| `docker info` | 查看 Docker 系统信息 |
| `docker images` | 查看本地镜像 |
| `docker pull image:tag` | 拉取镜像 |
| `docker build -t name:tag .` | 构建镜像 |
| `docker ps` | 查看运行中的容器 |
| `docker ps -a` | 查看所有容器 |
| `docker run image` | 创建并启动容器 |
| `docker stop name` | 停止容器 |
| `docker rm name` | 删除容器 |
| `docker rmi image` | 删除镜像 |
| `docker logs -f name` | 跟踪容器日志 |
| `docker exec -it name sh` | 进入容器 shell |
| `docker inspect name` | 查看容器详细信息 |
| `docker stats` | 查看资源占用 |
| `docker system df` | 查看 Docker 磁盘占用 |
| `docker system prune` | 清理未使用资源 |
| `docker compose up -d` | 后台启动 Compose 项目 |
| `docker compose down` | 停止并删除 Compose 容器 |
| `docker compose logs -f app` | 查看 Compose 服务日志 |
| `docker compose run --rm app` | 一次性运行 Compose 服务 |

调试 C++ 程序常用：

| 命令 | 作用 |
| --- | --- |
| `ldd /app/onnx_demo` | 查看动态库是否缺失 |
| `printenv` | 查看环境变量 |
| `pwd` | 查看当前工作目录 |
| `ls -lh /models` | 查看模型目录是否挂载成功 |
| `ls -lh /data` | 查看输入目录是否挂载成功 |
| `ls -lh /outputs` | 查看输出目录是否挂载成功 |

---

## 18. 回到开头：容器为什么会立即退出？

因为容器不是一台需要“保持开机”的虚拟机，它的生命周期跟随主进程。镜像构建成功后，如果默认命令很快执行完、动态库加载失败、模型路径不存在，或者程序因权限问题返回，PID 1 都会结束，容器也随之停止。正确排查顺序是 `docker ps -a → docker logs → docker inspect → 检查挂载、动态库和启动命令`，而不是先给容器加无限循环。

Docker 的主线可以压缩成一句话：

```text
Dockerfile 构建镜像，镜像启动容器，容器运行服务，Compose 编排多个服务。
```

学习顺序建议：

1. 先掌握 `docker run`、`docker ps`、`docker logs`、`docker exec`
2. 再理解镜像、容器、端口映射、数据卷、网络
3. 然后学会写 Dockerfile
4. 再用多阶段构建打包 C++ 程序
5. 最后用 Docker Compose 管理多服务项目

C++ ONNX 容器化部署检查：

```text
1. C++ 程序本机能编译、能运行
2. 模型输入输出契约明确
3. Dockerfile 能完成 Release 构建
4. 运行镜像内 ldd 不缺动态库
5. /models、/data、/outputs 挂载正确
6. 容器内能加载 ONNX 模型
7. 同一张图的 Python / C++ / Docker 结果一致
8. 日志能看到模型路径、输入 shape、输出 shape 和耗时
9. 性能拆分到预处理、推理、后处理和总耗时
10. 镜像 tag、ORT 版本、OpenCV 版本可追踪
```

对于 Linux 高性能服务器编程来说，Docker 是部署工具，不是性能模型本身。
它能让服务更容易交付、复制和回滚，但服务的并发能力仍然取决于程序本身的 I/O、线程、内存、协议设计，以及 ONNX 推理链路里的预处理、模型执行和后处理实现。

最后保留四条工程结论：

1. 构建阶段验证如何生成文件，运行阶段才验证主进程和部署契约。
2. 长期服务使用 exec form 前台运行，并正确处理 `SIGTERM` 与退出码。
3. Compose 的启动顺序不等于依赖就绪，健康检查也不能替代应用自身的超时和重试。
4. 镜像标签、CPU 架构、动态库和模型 hash 都是可复现部署的一部分，不能只保存一份 Dockerfile。

## 参考资料

- Dockerfile reference：<https://docs.docker.com/reference/dockerfile/>
- Docker Compose startup order：<https://docs.docker.com/compose/how-tos/startup-order/>
- Docker build cache optimization：<https://docs.docker.com/build/cache/optimize/>
- Docker build secrets：<https://docs.docker.com/build/building/secrets/>
- ONNX Runtime releases：<https://github.com/microsoft/onnxruntime/releases>
