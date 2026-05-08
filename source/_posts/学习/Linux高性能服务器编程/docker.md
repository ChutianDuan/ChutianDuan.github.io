---
title: "Docker 容器教程：镜像、容器、网络、数据卷与服务部署"
date: 2026-05-06 10:33:24
updated: 2026-05-06 10:33:24
categories:
  - "学习"
  - "Linux高性能服务器编程"
permalink: /notes/linux高性能服务器编程/docker/
---

# Docker 容器教程：镜像、容器、网络、数据卷与服务部署

时间：2026/05/06

> 关键词：Docker、镜像、容器、Dockerfile、数据卷、网络、Compose、服务部署
> 核心目标：理解 Docker 如何把一个 Linux 程序连同运行环境一起打包、运行、隔离和发布。

---

## 1. Docker 在解决什么问题

开发一个 Linux 服务器程序时，常见问题是：

* 本机能跑，换一台机器缺库、缺配置、版本不一致
* 开发环境、测试环境、生产环境差异很大
* 部署服务时要手动安装依赖、创建目录、配置端口
* 多个服务共用一台机器时，依赖版本互相影响
* 想快速启动、停止、回滚某个服务

Docker 的核心思想是：

```text
把程序 + 依赖库 + 运行配置 + 文件系统环境
打包成一个镜像
再从镜像启动一个隔离的容器进程
```

可以粗略理解成：

```text
镜像 image      -> 程序运行所需的文件系统模板
容器 container  -> 镜像运行起来之后的进程
仓库 registry   -> 保存和分发镜像的地方
Dockerfile      -> 描述如何构建镜像的脚本
Compose         -> 描述多个容器如何一起运行的配置
```

Docker 不是虚拟机。容器本质上还是宿主机上的进程，只是通过 Linux 内核能力做了隔离和资源限制。

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
| 适合场景 | 应用打包、部署、测试环境 | 强隔离、多系统内核环境 |

Docker 常用的 Linux 内核机制：

* `namespace`：隔离进程、网络、挂载点、用户、主机名等视图
* `cgroups`：限制 CPU、内存、I/O 等资源
* `overlayfs`：把镜像层叠加成容器文件系统

---

## 3. 基本概念

### 3.1 镜像 image

镜像是一个只读模板，里面包含：

* 基础系统文件，比如 `ubuntu`、`debian`、`alpine`
* 程序运行依赖，比如 `libevent`、`openssl`
* 你的程序二进制文件
* 默认启动命令

查看本地镜像：

```bash
docker images
```

拉取镜像：

```bash
docker pull ubuntu:24.04
docker pull nginx:latest
```

删除镜像：

```bash
docker rmi nginx:latest
```

### 3.2 容器 container

容器是镜像运行起来之后的实例。一个镜像可以启动多个容器。

运行一个容器：

```bash
docker run ubuntu:24.04 echo "hello docker"
```

进入交互式 shell：

```bash
docker run -it ubuntu:24.04 bash
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

### 3.3 仓库 registry

镜像仓库用来保存和分发镜像。常见仓库：

* Docker Hub
* GitHub Container Registry
* 公司内部镜像仓库

镜像名通常长这样：

```text
nginx:latest
ubuntu:24.04
registry.example.com/backend/server:v1.0.0
```

格式大致是：

```text
仓库地址/命名空间/镜像名:标签
```

---

## 4. 第一个容器

运行官方测试镜像：

```bash
docker run hello-world
```

运行一个后台 nginx：

```bash
docker run -d --name web -p 8080:80 nginx:latest
```

参数含义：

| 参数 | 含义 |
| --- | --- |
| `-d` | 后台运行 |
| `--name web` | 容器命名为 `web` |
| `-p 8080:80` | 把宿主机 `8080` 端口映射到容器 `80` 端口 |
| `nginx:latest` | 使用的镜像 |

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
| `--network` | 指定网络 |
| `--restart` | 设置重启策略 |
| `--memory` | 限制内存 |
| `--cpus` | 限制 CPU |

例子：

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

---

## 6. 容器生命周期

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

注意：容器的主进程退出后，容器就会停止。
所以一个服务容器通常以前台方式运行服务进程，而不是在容器内部再把服务放到后台。

---

## 7. Dockerfile：构建自己的镜像

`Dockerfile` 是构建镜像的说明书。

一个最小示例：

```dockerfile
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y curl

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

### 7.1 常用 Dockerfile 指令

| 指令 | 含义 |
| --- | --- |
| `FROM` | 指定基础镜像 |
| `WORKDIR` | 设置工作目录 |
| `COPY` | 复制文件到镜像 |
| `RUN` | 构建镜像时执行命令 |
| `ENV` | 设置环境变量 |
| `EXPOSE` | 声明容器服务端口 |
| `CMD` | 默认启动命令 |
| `ENTRYPOINT` | 固定入口命令 |

`RUN` 和 `CMD` 的区别：

* `RUN` 在构建镜像时执行，结果会写进镜像层
* `CMD` 在容器启动时执行，是容器的默认主进程

---

## 8. 打包一个 C/C++ TCP 服务端

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

RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    libevent-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .

RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j

FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
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

多阶段构建的好处：

* 编译工具链只留在 `builder` 阶段
* 最终镜像只包含运行服务所需文件
* 镜像更小，攻击面也更小

---

## 9. 数据卷 volume

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
* 不要把敏感目录随意挂进容器，比如 `/`、`/etc`、`/var/run/docker.sock`

---

## 10. Docker 网络

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
| `host` | 直接使用宿主机网络命名空间 |
| `none` | 不配置网络 |
| 自定义 bridge | 推荐给一组服务使用 |

注意：

* `-p 8080:80` 是把容器端口暴露给宿主机
* 同一 Docker 网络内，容器之间通常不需要 `-p`
* 生产环境应只暴露外部真正需要访问的端口

---

## 11. Docker Compose：管理多个容器

当一个项目包含多个服务，比如：

```text
web server + redis + mysql
```

继续手写多个 `docker run` 命令会很麻烦。
Docker Compose 用一个 `compose.yaml` 描述这些容器。

示例：

```yaml
services:
  app:
    build: .
    container_name: myserver
    ports:
      - "9000:9000"
    environment:
      LOG_LEVEL: info
      REDIS_HOST: redis
    depends_on:
      - redis
    restart: unless-stopped

  redis:
    image: redis:7
    container_name: redis
    volumes:
      - redis-data:/data
    restart: unless-stopped

volumes:
  redis-data:
```

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

---

## 12. 调试容器

### 12.1 查看日志

```bash
docker logs -f myserver
```

### 12.2 进入容器

```bash
docker exec -it myserver sh
```

如果镜像里有 `bash`：

```bash
docker exec -it myserver bash
```

### 12.3 查看配置和挂载

```bash
docker inspect myserver
```

### 12.4 查看端口

```bash
docker port myserver
```

### 12.5 临时启动一个排查容器

```bash
docker run --rm -it --network app-net nicolaka/netshoot
```

这个镜像常用于网络排查，里面带了 `curl`、`dig`、`tcpdump`、`ss` 等工具。

---

## 13. 常见问题

### 13.1 容器启动后立刻退出

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

### 13.2 宿主机访问不到容器服务

检查：

* 程序是否监听 `0.0.0.0`，而不是只监听 `127.0.0.1`
* 是否用了 `-p host_port:container_port`
* 容器内服务端口是否正确
* 防火墙是否阻止连接

查看监听：

```bash
docker exec -it myserver ss -lntp
```

### 13.3 容器之间访问不到

检查：

* 两个容器是否在同一个 Docker 网络
* 是否使用容器名作为主机名
* 服务端口是否是容器内部端口，而不是宿主机映射端口

### 13.4 修改代码后镜像没有变化

重新构建：

```bash
docker build -t myserver:v1 .
```

如果缓存导致结果不符合预期：

```bash
docker build --no-cache -t myserver:v1 .
```

### 13.5 磁盘空间被占满

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

---

## 14. Docker 与服务器程序的关系

对一个高性能服务器程序来说，Docker 不会替你解决这些问题：

* I/O 模型是否合理
* 线程池大小是否合适
* 协议解析是否健壮
* 是否正确处理半包、粘包
* 是否有内存泄漏
* 是否有连接超时和限流机制

Docker 主要解决的是运行和部署问题：

* 运行环境一致
* 依赖可复制
* 服务容易启动和销毁
* 多服务编排更清晰
* 镜像可以版本化和回滚

容器化服务时要特别注意：

* 服务进程以前台方式运行
* 日志输出到 `stdout` / `stderr`
* 配置通过环境变量、配置文件或挂载注入
* 不把重要数据只写在容器临时文件系统里
* 只暴露必要端口
* 给容器设置合理的 CPU 和内存限制

---

## 15. 推荐实践

### 15.1 Dockerfile

* 使用明确的镜像标签，比如 `ubuntu:24.04`，少用裸 `latest`
* 使用多阶段构建，编译环境和运行环境分离
* 把变化少的步骤放在前面，提升构建缓存命中率
* 构建完成后清理包管理器缓存
* `.dockerignore` 排除 `build/`、`.git/`、日志和临时文件

`.dockerignore` 示例：

```text
.git
build
cmake-build-*
*.log
*.tmp
```

### 15.2 容器运行

* 用 `--name` 给重要容器命名
* 用 `--restart unless-stopped` 管理自动重启
* 用 `docker logs` 观察服务日志
* 用数据卷保存持久化数据
* 用自定义网络连接一组服务

### 15.3 生产环境

* 镜像构建和运行使用不同阶段
* 不在镜像里保存密码、私钥和 token
* 不把 Docker socket 挂进普通业务容器
* 定期扫描镜像漏洞
* 服务配置、镜像版本和部署流程都纳入版本管理

---

## 16. 一套完整练习流程

目标：把一个 TCP 服务端打成镜像，用 Docker 运行，并用 Compose 管理。

### 16.1 编写 Dockerfile

```dockerfile
FROM ubuntu:24.04 AS builder

RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j

FROM ubuntu:24.04
WORKDIR /app
COPY --from=builder /src/build/myserver /app/myserver
EXPOSE 9000
CMD ["/app/myserver"]
```

### 16.2 构建镜像

```bash
docker build -t myserver:v1 .
```

### 16.3 直接运行

```bash
docker run -d --name myserver -p 9000:9000 myserver:v1
```

### 16.4 查看日志

```bash
docker logs -f myserver
```

### 16.5 测试连接

```bash
nc 127.0.0.1 9000
```

### 16.6 改成 Compose

```yaml
services:
  myserver:
    build: .
    ports:
      - "9000:9000"
    restart: unless-stopped
```

启动：

```bash
docker compose up -d
```

停止：

```bash
docker compose down
```

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

---

## 18. 总结

Docker 的主线可以压缩成一句话：

```text
Dockerfile 构建镜像，镜像启动容器，容器运行服务，Compose 编排多个服务。
```

学习顺序建议：

* 先掌握 `docker run`、`docker ps`、`docker logs`、`docker exec`
* 再理解镜像、容器、端口映射、数据卷、网络
* 然后学会写 Dockerfile
* 最后用 Docker Compose 管理多服务项目

对于 Linux 高性能服务器编程来说，Docker 是部署工具，不是性能模型本身。
它能让服务更容易交付、复制和回滚，但服务的并发能力仍然取决于程序本身的 I/O、线程、内存和协议设计。
