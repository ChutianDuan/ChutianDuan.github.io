---
title: "Fighting Netcode 项目知识笔记"
date: 2026-05-04 09:30:06
updated: 2026-05-04 09:30:06
categories:
  - "学习"
  - "实时竞技游戏开发"
permalink: /notes/实时竞技游戏开发/fighting-netcode-项目知识笔记/
---

# Fighting Netcode 项目知识笔记

## 1. 这个项目是什么

`Fighting` 是一个用 C++ 写的联机动作游戏同步 Demo。

项目地址：

`/Volumes/拯救者PSSD/Fighting`

它不是 AI 模型训练项目，而是一个很适合学习“实时系统工程”的项目。它实现的是：

- 固定帧推进
- UDP 通信
- 服务端权威状态
- 客户端本地预测
- 输入冗余
- 回滚重放
- 状态快照
- 状态哈希对账
- 压力测试

可以把它理解成一个“小型实时分布式系统”。

如果放到 AI 模型开发学习体系里，它最值得参考的不是模型算法，而是工程能力：

- 如何让多个端的状态保持一致
- 如何处理延迟、丢包和乱序
- 如何用快照、日志和 hash 定位状态分叉
- 如何用固定 tick 管理实时流程
- 如何把核心逻辑拆成可测试的模块

一句话概括：

> 这个项目是一个 60Hz 回滚同步网络游戏 Demo，但它背后的工程思想可以迁移到 AI 推理服务、Agent 执行系统、实时任务调度和分布式状态一致性设计里。

---

## 2. 项目整体目标

这个项目不是为了做一个完整游戏，而是为了跑通联机动作游戏最难的几件事。

核心目标是：

- 玩家输入能快速反馈
- 服务端保持最终权威
- 网络延迟不会让本地操作卡顿
- 客户端预测错了以后可以回滚修正
- 服务端和客户端可以通过 hash 判断状态是否分叉

联机动作游戏里，一个常见问题是：

> 如果每次按键都等服务端确认，游戏会非常卡；如果完全相信客户端，又容易作弊和状态不一致。

这个项目采用的方案是：

- 客户端先预测，保证操作手感
- 服务端做权威推进，保证最终正确
- 客户端收到权威状态后回滚重放，修正预测误差

这就是 Rollback Netcode 的核心思想。

---

## 3. 项目目录结构

项目主要目录如下：

```text
apps/
  client_main.cpp
  server_main.cpp

include/lab/
  app/
  core/
  io/
  net/
  sim/
  time/
  util/

src/
  app/
  core/
  io/
  net/
  sim/
  time/

tests/
  core_tests.cpp
  stress_tests.cpp

docs/
  ARCHITECTURE.md

README.md
日志.md
CMakeLists.txt
```

可以按三层理解：

| 层级 | 目录 | 作用 |
|---|---|---|
| 模拟层 | `include/lab/sim`、`src/sim` | 世界状态、输入、快照、回滚、hash |
| 网络层 | `include/lab/net`、`src/net` | UDP、协议包、二进制编解码 |
| 应用层 | `apps`、`include/lab/app`、`src/app` | 服务端循环、客户端预测、渲染、输入采样 |

这个分层比较清晰：

- 模拟层不关心网络和窗口
- 网络层不关心游戏规则
- 应用层负责把模拟、网络、渲染拼起来

这也是很多 AI 工程项目应该学习的拆法：

- 模型推理核心逻辑
- API / 网络协议层
- 应用编排层
- 测试和压测层

---

## 4. 快速运行方式

项目依赖：

- CMake 3.20+
- C++20
- libevent
- SDL2
- SDL2_ttf
- nlohmann_json

构建：

```bash
cmake -S . -B build
cmake --build build
```

启动服务端：

```bash
./build/lab_server
```

启动两个客户端：

```bash
./build/lab_client
./build/lab_client
```

运行测试：

```bash
ctest --test-dir build --output-on-failure
```

运行压力测试：

```bash
./build/lab_stress
```

更长时间压力测试：

```bash
./build/lab_stress --ticks 200000 --history 8192 --state-delay 12
```

---

## 5. 核心概念总览

这个项目最重要的概念有 8 个。

### 5.1 Tick

`Tick` 是逻辑帧编号。

代码里定义：

```cpp
using Tick = uint32_t;
```

游戏不是直接按真实时间推进，而是按离散帧推进。

例如 60Hz 表示：

```text
1 秒 = 60 个 tick
1 tick = 1 / 60 秒
```

这样做的好处是：

- 逻辑顺序明确
- 输入可以绑定到某个 tick
- 状态可以按 tick 保存
- 回滚时可以从某个 tick 重新模拟
- 网络包可以明确说明自己属于哪一帧

AI 工程迁移理解：

> Tick 类似任务系统里的 step id、事件序号、offset、version。只要系统存在异步、重试、回放，就需要这种明确的逻辑编号。

### 5.2 InputCmd

`InputCmd` 是每一帧的最小输入单位。

```cpp
struct InputCmd {
    Tick tick = 0;
    uint16_t buttons = 0;
    int8_t moveX = 0;
    int8_t moveY = 0;
};
```

它包含：

- 属于哪个 tick
- 按键位图
- 水平方向
- 垂直方向

这个结构很小，适合频繁发送。

设计重点：

- 输入要带 tick
- 输入结构要尽量小
- 输入可以重复发送，服务端按 tick 去重覆盖

### 5.3 WorldSnapshot

`WorldSnapshot` 是世界状态快照。

它包含：

- 当前 tick
- 玩家状态
- 子弹状态
- 迷宫 seed
- 迷宫网格

它的作用是：

- 网络状态同步
- 回滚恢复
- hash 对账
- 测试验证

这说明项目把“状态数据”和“推进逻辑”分开了。

这种设计很重要：

> 只要系统支持回滚、回放、审计、调试，就应该有明确的 Snapshot 结构。

### 5.4 World::Step

`World::Step(cmds, dt)` 是世界推进入口。

它接收所有玩家在同一个 tick 的输入，然后推进一帧。

关键要求：

- `cmds.size()` 必须等于玩家数量
- 所有 `cmd.tick` 必须一致
- 同样输入和同样初始状态，应该得到同样输出

这就是确定性模拟的基础。

### 5.5 InputBuffer

`InputBuffer` 是按 tick 存输入的环形缓冲。

核心逻辑：

```cpp
idx = tick % capacity
```

读取时不只看槽位，还要校验 tick：

```cpp
if (ring_[idx].cmd.tick != tick) return std::nullopt;
```

这个校验非常关键。

因为环形缓冲会覆盖旧数据，如果只看下标，不看 tick，就可能把旧帧误当成当前帧。

### 5.6 StateHistory

`StateHistory` 是按 tick 存世界快照的环形缓冲。

它和 `InputBuffer` 思路一样：

- 写入时按 `tick % cap`
- 读取时校验真实 tick

它用于：

- 客户端保存预测状态
- 收到权威状态后比较误差
- 从某个权威 tick 恢复并重放
- hash 对账

### 5.7 State Hash

`Hasher` 对 `WorldSnapshot` 做 hash。

它不是直接 hash float 的内存，而是先做毫米级量化：

```cpp
int32_t QuantizeMm(float v) {
  return std::lround(v * 1000.0f);
}
```

这样做是为了避免浮点误差造成假 mismatch。

hash 覆盖内容包括：

- tick
- 玩家位置和速度
- 玩家 HP
- action
- cooldown
- aim 方向
- 子弹状态
- 迷宫 seed 和网格

如果新增一个会影响模拟结果的字段，但忘了加入快照、网络包或 hash，就容易出现服务端和客户端状态分叉。

### 5.8 Rollback Replay

回滚重放是客户端收到权威状态后的修正流程。

基本公式：

```text
Restore(authoritativeSnapshot)
for t in authoritativeTick + 1 .. localTick - 1:
  取本地输入
  取远端预测输入
  World::Step(cmds, dt)
  保存快照
```

它解决的问题是：

- 客户端先预测，保证响应快
- 权威状态来了以后，以权威状态为准
- 重新模拟未来帧，让当前画面追上本地时间

---

## 6. 服务端流程

服务端是权威端。

核心文件：

`apps/server_main.cpp`

服务端主要做 6 件事：

1. 启动 UDP socket
2. 接收客户端 hello / input
3. 按地址分配玩家 slot
4. 收齐玩家后发送 `Start`
5. 每个 tick 收集输入并推进权威世界
6. 下发 `Ack` 和 `State`

### 6.1 玩家分配

服务端用客户端地址作为 key。

每个客户端连接后分配：

- player1
- player2

如果人数满了，后续客户端会被拒绝。

### 6.2 开局同步

服务端收齐 `kRequiredPlayers = 2` 后，不是立刻从当前 tick 开始，而是设置：

```cpp
startTick = tick + kStartDelayTicks;
```

这个设计用于给客户端一点时间接收开局包，减少起步不同步。

### 6.3 缺输入处理

服务端每个 tick 都要给每个玩家拿到输入。

如果该 tick 有输入：

- 直接使用

如果没有输入，但上次输入还在 hold 窗口内：

- 复用上一帧输入
- 把 tick 改成当前 tick

如果超出 hold 窗口：

- 使用默认空输入

这段逻辑本质上是在处理 UDP 丢包和延迟。

### 6.4 权威推进

服务端每帧执行：

```text
cmds = 每个玩家当前 tick 的输入
world.Step(cmds, dt)
snapshot = world.Snapshot()
hash = Hasher::Hash(snapshot)
```

服务端的状态是最终可信状态。

客户端的预测状态只是为了体验。

### 6.5 状态下发

服务端每帧发 `Ack`，每隔若干帧发完整 `State`。

当前配置：

```cpp
kStateEvery = 2
```

也就是每 2 tick 下发一次完整状态。

这种设计平衡了：

- 状态同步频率
- 带宽消耗
- 回滚修正速度

---

## 7. 客户端流程

客户端负责“先动起来，然后等权威校正”。

核心文件：

`apps/client_main.cpp`

客户端主要做 8 件事：

1. 未开局时定期发送 hello
2. 收到 `Start` 后对齐 `startTick`
3. 每 tick 采样键盘输入
4. 本地保存输入历史
5. 预测远端玩家输入
6. 本地推进预测世界
7. 发送带冗余的输入包
8. 收到权威 `State` 后恢复并重放

### 7.1 本地预测

本地玩家的输入来自键盘。

远端玩家的输入无法立即知道，只能预测。

当前预测逻辑比较简单：

- 根据远端玩家速度推测移动方向
- 如果远端处于 Hitstun，则预测不动
- 如果速度接近 0，则预测停止

相关文件：

`src/app/InputPrediction.cpp`

这不是高级 AI，而是一个经验规则。

### 7.2 输入冗余发送

客户端每个 tick 不只发送当前输入，而是发送最近 K 帧输入。

配置：

```cpp
kInputRedundancy = 4
```

这样即使 UDP 丢了某个包，后续包也可能补上之前几帧输入。

输入包里包含：

- playerId
- seq
- newestTick
- clientAckServerTick
- 最近 K 个 `InputCmd`

### 7.3 权威状态应用

客户端收到 `State` 后，会把网络包还原成 `WorldSnapshot`。

然后做几件事：

- 校验 `stateHash`
- 判断本地玩家是否偏离权威状态
- 把权威快照写入 `StateHistory`
- 从权威快照恢复
- 重放后续输入到当前 tick

注意：

项目只用本地玩家差异来判断是否计入 rollback。

原因是：

> 远端玩家本来就是预测的，如果把远端误差也算进回滚触发条件，客户端会频繁回滚。

### 7.4 为什么即使没有计入 rollback 也要 rebase

代码里有一个重要设计：

即使本地玩家误差没有超过阈值，客户端仍然会从权威快照 rebase，然后 replay。

这样做的原因是：

- 远端玩家状态应该尽快采用权威值
- 子弹状态也应该采用权威值
- 不然画面可能长期偏离真实世界

也就是说：

- rollbackCount 只是统计“本地玩家明显错误”的次数
- rebase + replay 是状态校正流程本身

---

## 8. 网络协议设计

核心文件：

- `include/lab/net/Packets.h`
- `src/net/NetCode.cpp`

当前协议版本：

```cpp
kVersion = 3
```

协议包类型：

| 包 | 方向 | 作用 |
|---|---|---|
| `Input` | Client -> Server | 上传玩家输入 |
| `Start` | Server -> Client | 分配 playerId，告知 startTick |
| `Ack` | Server -> Client | 告知服务端处理进度和 hash |
| `State` | Server -> Client | 下发权威状态 |

### 8.1 二进制编解码

项目手写了二进制协议。

特点：

- 使用固定 magic
- 使用协议 version
- 使用 packet type
- 整数统一转网络字节序
- 64 位整数拆成两个 32 位写入
- float 不直接传，而是转毫米整数

例如状态里的位置：

```cpp
ps.x_mm = std::lround(wp.x * 1000.0f);
```

接收端还原：

```cpp
float x = x_mm / 1000.0f;
```

这比直接传 float 更稳定，也更容易做 hash 对账。

### 8.2 为什么要有 magic 和 version

`magic` 用来识别是不是本协议的数据包。

`version` 用来防止不同协议版本之间误解码。

这在 AI 服务协议里也很重要。

例如模型推理请求如果格式变了，最好也有：

- api version
- schema version
- feature version
- model version

否则新旧客户端混用时很难排查问题。

### 8.3 Input 包为什么带冗余

UDP 不保证可靠。

如果每个输入只发一次：

- 丢包就会丢输入
- 服务端只能默认空输入
- 玩家表现会突然停顿

所以 Input 包会带最近 K 帧输入。

这是一种简单可靠的抗丢包策略。

AI 工程里类似的思想是：

- 请求重试带幂等 id
- 消息队列消费保留 offset
- 事件流消费允许重复事件
- 服务端按版本号或序号去重

---

## 9. 世界模拟逻辑

核心文件：

`src/sim/World.cpp`

当前世界是一个顶视角小型“迷宫坦克”。

包含：

- 迷宫地图
- 玩家移动
- 墙体碰撞
- 玩家之间 pushbox 分离
- 子弹发射
- 子弹碰撞
- HP 扣减
- hitstun
- cooldown

### 9.1 迷宫生成

迷宫由固定 seed 生成。

服务端通过 `mazeSeed` 下发给客户端。

这样客户端不需要每次接收完整地图，只要用同样 seed 就可以生成同样迷宫。

但项目的 `WorldSnapshot` 里也保留了迷宫网格。

这样更稳：

- seed 用于重建
- maze 数据用于快照、hash 和回滚

### 9.2 玩家移动

玩家速度不是瞬间切换，而是用摩擦插值靠近目标速度：

```text
v += (targetV - v) * alpha
```

这样移动更平滑。

但它依然是确定性的，因为每一帧都只由：

- 当前状态
- 当前输入
- 固定 dt

共同决定。

### 9.3 子弹状态

子弹包含：

- 位置
- 速度
- owner
- life

子弹撞墙或命中玩家后消失。

命中后：

- 被击中玩家 HP 减少
- 进入 Hitstun
- 产生轻微击退

子弹也进入快照、网络包和 hash。

这是必须的。

因为子弹会影响未来游戏状态。

### 9.4 aimX / aimY 的意义

玩家状态里有：

```cpp
int8_t aimX;
int8_t aimY;
```

它保存最近的瞄准方向。

这个字段很关键。

如果玩家停下来以后再开火，当前 moveX / moveY 可能是 0。

这时开火方向就要依赖上一次方向。

如果回滚恢复时没有保存 aim 方向，重放结果就可能和服务端不同。

这个例子说明：

> 只要某个字段会影响未来模拟结果，它就必须进入 Snapshot、网络包和 hash。

---

## 10. 固定帧推进

服务端和客户端都使用 accumulator 控制固定时间步。

基本结构：

```text
frame = now - prev
acc += min(frame, maxFrame)

while acc >= dt:
  step one tick
  acc -= dt
```

项目里：

```cpp
dt = 1.0 / 60.0
maxFrame = 0.25
```

为什么不用真实 frameTime 直接推进？

因为真实时间不稳定：

- 系统调度会抖动
- 渲染耗时会变化
- 网络回调时间不可控

固定 dt 的好处是：

- 模拟稳定
- 回滚可重放
- hash 更容易一致
- 测试更容易复现

AI 工程迁移理解：

在 Agent、多轮任务执行、流式处理、训练调度里，也应该尽量区分：

- 真实时间
- 逻辑步数
- 状态版本

系统内部最好基于逻辑 step 推进，而不是让 wall clock 到处影响业务逻辑。

---

## 11. 回滚同步完整链路

完整链路可以这样理解。

### 11.1 正常预测阶段

每个客户端每 tick 做：

```text
采样本地输入
保存 localHist[tick]
预测远端输入
World::Step(allCmds, dt)
保存 stateHist[tick]
发送最近 K 帧输入给服务端
tick++
```

### 11.2 服务端权威阶段

服务端每 tick 做：

```text
读取每个玩家输入
缺输入则 hold/default
World::Step(allCmds, dt)
生成权威 snapshot
计算 hash
发送 Ack
按频率发送 State
tick++
```

### 11.3 客户端校正阶段

客户端收到权威 State：

```text
解码 State
还原 auth snapshot
校验 stateHash
比较本地玩家误差
写入权威快照
Restore(auth)
Replay auth.tick + 1 到当前 tick
```

这个流程的本质是：

> 客户端永远允许自己先猜，但最终必须回到服务端认可的历史上。

---

## 12. 测试设计

项目测试分两类。

### 12.1 core_tests

文件：

`tests/core_tests.cpp`

主要验证：

- `InputBuffer` 零容量时会被修正为 1
- `StateHistory` 零容量时会被修正为 1
- `InputPacket` 编解码正确
- `StatePacket` 编解码正确
- `Hasher` 使用毫米精度
- `Hasher` 覆盖 shotCooldown
- `World(0)` 会至少创建 1 个玩家

这些是小而关键的回归测试。

### 12.2 stress_tests

文件：

`tests/stress_tests.cpp`

压力测试更重要。

它在单进程里模拟：

- 权威世界
- 客户端预测世界
- 输入历史
- 网络包编解码
- State 延迟
- State 抖动
- 回滚重放
- hash 校验

测试重点不是窗口和真实 socket，而是核心逻辑链路。

它验证：

- 从原始权威快照恢复并重放，能追上权威历史
- 从网络量化后的 State 恢复并重放，hash 仍然一致
- 输入冗余包可以正常编解码
- 长时间 tick 推进不会破坏状态一致性

这类测试对 AI 工程也有参考意义：

> 真正可靠的系统，不只测单个函数，还要测“数据经过网络、延迟、恢复、重放之后是否仍然正确”。

---

## 13. 这个项目值得学习的重点知识点

### 13.1 分层设计

项目没有把所有逻辑写在一个 main 里，而是拆成：

- sim
- net
- app
- tests

这种拆分让核心模拟可以脱离网络和渲染测试。

AI 工程对应：

- 模型调用逻辑不要和 HTTP handler 混在一起
- 数据处理逻辑不要和 UI 混在一起
- 推理服务核心最好能被单元测试和压测直接调用

### 13.2 状态快照

`WorldSnapshot` 是这个项目的核心中间结构。

它让系统可以：

- 保存状态
- 传输状态
- 恢复状态
- 比较状态
- hash 状态

AI 工程对应：

- Agent 运行状态
- RAG 查询状态
- 会话上下文快照
- 任务执行 checkpoint
- 分布式训练 checkpoint

### 13.3 输入日志

项目不是只保存当前输入，而是保存输入历史。

这让系统可以从任意历史点重新计算。

AI 工程对应：

- prompt history
- tool call history
- message queue event log
- workflow step log
- 训练样本处理日志

### 13.4 确定性推进

同样状态 + 同样输入 + 同样 dt，应该得到同样结果。

这对回滚极其重要。

AI 工程里虽然模型推理本身可能有随机性，但工程层也可以尽量确定：

- 固定 prompt 模板版本
- 固定模型版本
- 固定采样参数
- 固定工具调用输入
- 固定数据预处理逻辑

否则线上问题很难复现。

### 13.5 网络协议版本化

项目协议有：

- magic
- version
- packet type

这能避免错误解码。

AI 服务接口也应该重视：

- API version
- request schema version
- model version
- embedding version
- prompt version

### 13.6 冗余和幂等

Input 包重复携带最近 K 帧输入。

这是一种用冗余换可靠性的设计。

AI 工程对应：

- 任务重试要有 task id
- 消息重复消费要能去重
- 请求超时后重发不能重复扣费或重复写库
- 流式输出恢复要能从 offset 继续

### 13.7 Hash 对账

项目用 hash 判断状态是否一致。

AI 工程也可以用类似思想：

- 对输入文档算 hash
- 对 chunk 结果算 hash
- 对 embedding 输入算 hash
- 对模型配置算 hash
- 对 prompt 模板算 hash
- 对 workflow 状态算 hash

这能帮助定位：

- 是输入变了
- 是模型变了
- 是参数变了
- 是代码逻辑变了
- 是缓存污染了

### 13.8 压力测试

`lab_stress` 很值得参考。

它没有依赖窗口和真实 socket，而是直接压核心逻辑。

AI 工程里也可以这样做：

- 不一定先压真实 API
- 可以先压核心 pipeline
- 模拟延迟、乱序、失败和重试
- 验证恢复后结果是否一致

---

## 14. 和 AI 模型开发的关联

这个项目虽然不是 AI 项目，但可以帮助理解 AI 工程里的几个难点。

### 14.1 和推理服务的关系

推理服务也有类似问题：

- 请求并发
- 网络延迟
- 状态追踪
- 版本一致性
- 超时重试
- 结果校验

可以借鉴：

- 每个请求带 request id
- 每个模型有 model version
- 每次调用记录输入 hash
- 缓存 key 包含模型和参数版本
- 异步任务保存 checkpoint

### 14.2 和 Agent 系统的关系

Agent 执行多步任务时，很像 tick 推进。

每一步可以看成：

```text
step_id
observation
decision
tool_call
tool_result
state_update
```

如果中途失败，就需要：

- 从某个 step 恢复
- 重放历史
- 判断状态是否一致
- 避免重复执行副作用工具

这和回滚同步的思路很接近。

### 14.3 和 RAG 系统的关系

RAG 里也需要状态和版本管理。

例如：

- 文档版本
- chunk 版本
- embedding 模型版本
- 向量库索引版本
- 查询改写版本
- reranker 版本

如果没有这些版本，线上效果变化时很难排查。

可以参考这个项目的 hash 思想，对关键中间结果做记录。

### 14.4 和分布式训练的关系

分布式训练也重视：

- step
- checkpoint
- deterministic replay
- 状态恢复
- 参数同步
- 异常恢复

`WorldSnapshot` 类似训练 checkpoint。

`InputCmd` 类似每一步的 batch / event。

`StateHistory` 类似最近 checkpoint 历史。

`Hasher` 类似一致性校验。

---

## 15. 如果继续完善这个项目

这个项目已经把核心链路跑通了，但如果要继续做，可以考虑这些方向。

### 15.1 网络层增强

可以增加：

- 延迟统计
- 丢包率统计
- RTT 估计
- 抖动缓冲
- 包乱序处理
- 客户端 ping / pong
- 输入确认窗口

### 15.2 协议层增强

可以增加：

- 协议 schema 文档
- 包大小统计
- 包字段版本兼容
- State 增量同步
- 压缩
- 加密或签名

### 15.3 回滚体验增强

可以增加：

- 插值平滑
- 远端玩家视觉修正
- 回滚次数可视化
- 回滚帧数统计
- 输入延迟动态调整

### 15.4 测试增强

可以增加：

- 真实 UDP bot 压测
- 随机丢包模拟
- 随机乱序模拟
- 多平台 hash 对比
- fuzz 解码测试
- 长时间 soak test

### 15.5 工程结构增强

可以增加：

- 更明确的协议文档
- 更统一的配置来源
- CI 自动测试
- clang-format
- sanitizers
- 性能 profiling

---

## 16. 学习路线建议

如果你要用这个项目作为学习材料，可以按这个顺序看。

### 16.1 第一遍：先看整体

先读：

- `README.md`
- `docs/ARCHITECTURE.md`
- `CMakeLists.txt`

目标是知道：

- 项目怎么构建
- 有哪些模块
- 服务端和客户端怎么交互

### 16.2 第二遍：看数据结构

重点看：

- `InputCmd.h`
- `StateSnapshot.h`
- `InputBuffer.h`
- `StateHistory.h`
- `Packets.h`

目标是理解：

- 输入怎么表示
- 状态怎么表示
- 网络包怎么表示
- 历史怎么保存

### 16.3 第三遍：看核心模拟

重点看：

- `World.h`
- `World.cpp`
- `Rules.h`
- `Hasher.cpp`

目标是理解：

- 一帧怎么推进
- 哪些字段影响确定性
- 为什么 hash 要覆盖这些字段

### 16.4 第四遍：看服务端

重点看：

- `server_main.cpp`

目标是理解：

- 玩家怎么分配
- 输入怎么接收
- 缺输入怎么处理
- 权威状态怎么广播

### 16.5 第五遍：看客户端

重点看：

- `client_main.cpp`
- `InputPrediction.cpp`

目标是理解：

- 本地预测怎么做
- 远端输入怎么猜
- 收到权威 State 后怎么回滚
- hash mismatch 怎么统计

### 16.6 第六遍：看测试

重点看：

- `core_tests.cpp`
- `stress_tests.cpp`

目标是理解：

- 这个项目如何验证状态一致性
- 压测为什么不依赖真实窗口和 socket
- 如何模拟延迟和重放

---

## 17. 重点代码阅读清单

建议重点阅读这些文件：

```text
include/lab/sim/InputCmd.h
include/lab/sim/StateSnapshot.h
include/lab/sim/InputBuffer.h
include/lab/sim/StateHistory.h
include/lab/net/Packets.h
src/sim/World.cpp
src/sim/Hasher.cpp
src/net/NetCode.cpp
apps/server_main.cpp
apps/client_main.cpp
tests/stress_tests.cpp
```

阅读时重点问自己几个问题：

- 每个 tick 的输入从哪里来？
- 服务端和客户端的 tick 如何对齐？
- 客户端什么时候预测？
- 权威状态什么时候覆盖预测状态？
- 什么字段进入 Snapshot？
- 什么字段进入网络包？
- 什么字段进入 hash？
- 如果新增一个状态字段，需要改哪些地方？
- 如果 UDP 丢包，会发生什么？
- 如果 State 延迟到达，客户端如何追上当前 tick？

---

## 18. 常见易错点

### 18.1 新增字段只改了 World，没有改 Snapshot

如果新增字段会影响模拟，但没有进入 Snapshot，回滚恢复后就会丢状态。

### 18.2 新增字段只改了 Snapshot，没有改网络包

服务端有这个状态，但客户端收不到，预测和权威会分叉。

### 18.3 新增字段没有进入 hash

状态已经不同，但 hash 检查不出来。

### 18.4 直接 hash float 内存

不同平台或编解码后可能有微小浮点差异，导致假 mismatch。

项目用毫米量化规避了这个问题。

### 18.5 环形缓冲读取时不校验 tick

只用 `tick % cap` 会读到被覆盖的旧数据。

项目里读取时会校验真实 tick，这是正确做法。

### 18.6 把远端预测误差也算作 rollback 条件

远端玩家本来就是猜的。

如果把远端差异也作为回滚计数依据，会导致 rollback 统计爆炸。

项目只比较本地玩家，比较合理。

---

## 19. 可以写成博客的版本

### 标题

从一个 C++ 格斗游戏 Demo 学实时系统：固定帧、预测、回滚与状态一致性

### 开头

很多人以为游戏网络同步只是“把坐标发给别人”。

但动作游戏真正困难的地方在于：

- 玩家按键必须立刻有反馈
- 网络包可能延迟或丢失
- 服务端必须保持权威
- 客户端预测错了还要能修回来

这个项目用一个小型 60Hz 顶视角对战 Demo，把这些问题完整串了起来。

### 第一部分：为什么需要固定帧

实时系统最怕逻辑跟真实时间强绑定。

如果每一帧都直接用真实耗时推进，状态会受到系统调度、渲染耗时和网络回调影响。

所以项目采用固定 tick：

```text
1 秒 60 帧
每帧 dt = 1 / 60
所有输入和状态都绑定 tick
```

这让回放、回滚和调试都变得可控。

### 第二部分：客户端为什么要预测

如果玩家按键后必须等服务端确认，游戏会非常卡。

所以客户端先假设自己的输入有效，立即推进本地世界。

这样玩家看到的是即时反馈。

但客户端不是最终权威。

服务端稍后会下发真实状态，客户端再根据权威状态修正。

### 第三部分：回滚的本质

回滚不是简单地把当前位置拉回服务端位置。

真正的流程是：

```text
恢复到服务端给的历史快照
重新执行这之后的输入
追上当前本地 tick
```

这要求系统必须保存：

- 历史输入
- 历史状态
- 可恢复的快照
- 确定性的 Step 函数

### 第四部分：为什么 hash 很重要

服务端和客户端状态一旦分叉，肉眼很难定位原因。

项目用 `Hasher` 对关键状态做 hash。

只要 hash 不一致，就说明某个状态字段不同。

更重要的是，hash 不是直接混合 float，而是和网络包一样做毫米量化。

这样可以避免浮点误差造成误报。

### 第五部分：这个项目对 AI 工程的启发

虽然这是游戏项目，但它的工程思想非常适合迁移到 AI 系统。

AI Agent 也有 step。

RAG 也有中间状态。

推理服务也有请求版本、模型版本和缓存一致性。

分布式训练也有 checkpoint 和恢复。

如果一个 AI 系统需要稳定运行，就不能只关心模型输出，还要关心：

- 输入是否可追踪
- 中间状态是否可恢复
- 版本是否明确
- 错误是否可复现
- 结果是否可校验

### 结尾

这个 Fighting 项目真正值得学习的，不只是 Rollback Netcode，而是它展示了一套实时系统的基本工程方法：

- 用 tick 管理时间
- 用输入日志支撑回放
- 用快照支撑恢复
- 用 hash 支撑一致性检查
- 用压力测试验证长链路正确性

这些能力放到 AI 模型开发中，同样非常重要。

---

## 20. 可扩展博客选题

后续可以基于这份笔记拆成几篇博客。

### 20.1 选题一：Rollback Netcode 入门

重点讲：

- 为什么动作游戏不能只靠服务端确认
- 本地预测是什么
- 回滚重放是什么
- 输入历史和状态快照怎么设计

### 20.2 选题二：用 C++ 实现一个确定性模拟核心

重点讲：

- `World::Step`
- 固定 dt
- 状态字段管理
- 碰撞和子弹逻辑
- 如何避免不确定性

### 20.3 选题三：UDP 协议如何对抗丢包

重点讲：

- 为什么用 UDP
- Input 包为什么带冗余
- 服务端如何 hold last input
- Ack 和 State 分别解决什么问题

### 20.4 选题四：状态 hash 如何定位分布式系统分叉

重点讲：

- 为什么需要 hash
- 为什么不能直接 hash float
- 哪些字段必须进入 hash
- hash mismatch 如何排查

### 20.5 选题五：从游戏同步看 AI Agent 状态恢复

重点讲：

- tick 和 Agent step 的类比
- InputCmd 和 tool call 的类比
- Snapshot 和 checkpoint 的类比
- Replay 和失败恢复的类比

---

## 21. 总结

这个项目可以用一句话总结：

> 用 C++ 实现了一个小型实时联机同步系统，通过固定帧、输入冗余、本地预测、服务端权威、回滚重放和 hash 对账来解决网络延迟下的状态一致性问题。

最应该记住的重点：

- `Tick` 是逻辑时间基础
- `InputCmd` 是最小输入事件
- `WorldSnapshot` 是恢复和同步的核心
- `World::Step` 必须尽量确定性
- `InputBuffer` 和 `StateHistory` 用环形缓冲保存历史
- 客户端预测是为了体验，服务端权威是为了正确
- 回滚不是瞬移，而是恢复历史状态后重放输入
- hash 对账要和网络量化精度一致
- 压力测试应该覆盖完整链路，而不是只测单个函数

放到 AI 模型开发学习里，这个项目最有价值的地方是：

> 它训练的是工程化思维：状态、版本、恢复、重放、对账、压测。

## 22. 项目设计模式应用与注意事项

这一节专门从设计模式角度看项目。这里的重点不是硬套 GoF 名词，而是看每个模式在实时竞技游戏里解决了什么工程问题。

### 22.1 命令模式：把玩家操作变成 InputCmd

项目里最明显、最值得记住的模式是命令模式。

传统命令模式是把“动作请求”封装成对象。这个项目里的 `InputCmd` 就是玩家每一帧的动作命令：

```cpp
struct InputCmd {
    Tick tick;
    uint16_t buttons;
    int8_t moveX;
    int8_t moveY;
};
```

它的价值是：

- 输入可以被网络发送。
- 输入可以被环形缓冲保存。
- 输入可以按 tick 重放。
- 服务端和客户端都能用同一份 `World::Step(cmds, dt)` 消费输入。
- 压力测试可以直接构造输入序列，不依赖键盘和窗口。

这就是 rollback netcode 能成立的基础：系统保存的不是“玩家最后位置”，而是“玩家在每个 tick 做了什么”。只要初始快照一样，输入日志一样，就可以重新推导后续状态。

### 22.2 命令模式的注意点

`InputCmd` 必须保持小、确定、可序列化。

不要把这些内容放进输入命令：

- 真实时间戳，例如 `std::chrono::now()`。
- 客户端计算出的最终坐标、HP、命中结果。
- 指针、引用、窗口事件对象、平台相关对象。
- 随机数结果。

输入命令应该只描述玩家意图，例如移动方向和按钮。最终位置、碰撞、子弹命中必须由权威模拟算出来。

如果后续新增技能或攻击，推荐做法是：

1. 在 `buttons` 或输入结构中增加“意图”字段。
2. 在 `World::Step` 中解释这个意图。
3. 把会影响未来模拟的状态加入 `WorldSnapshot`。
4. 把需要下发给客户端的状态加入 `StatePacket`。
5. 把确定性相关字段加入 `Hasher`。
6. 给编解码、hash、回滚压测补测试。

### 22.3 分层架构：sim / net / app

项目采用很清楚的分层架构：

| 层 | 代表文件 | 责任 |
|---|---|---|
| 模拟层 | `src/sim/World.cpp` | 按输入推进世界，生成快照 |
| 网络层 | `src/net/NetCode.cpp` | UDP 协议包编解码 |
| 应用层 | `apps/server_main.cpp`、`apps/client_main.cpp` | 组织主循环、收发包、预测、回滚、渲染 |

这个分层的好处是测试成本低。`lab_stress` 可以绕开 SDL 和真实 UDP，直接压核心同步链路。

注意点：

- 模拟层不要依赖 socket、SDL、窗口、日志 UI。
- 网络层不要偷偷写游戏规则。
- 应用层可以编排流程，但不要把碰撞、伤害、hash 规则散落在 main 里。

### 22.4 Reactor / 事件驱动：libevent 和 SDL

服务端和客户端都使用事件驱动：

- UDP 收包通过 `UdpSocket::StartEventRead` 注册回调。
- 固定 tick 通过 libevent 定时器驱动。
- 客户端窗口输入通过 SDL event 和键盘状态采样。

这种模式适合实时游戏，因为网络、输入和计时都不是线性阻塞流程。

注意点：

- 回调里尽量只做小而确定的状态更新。
- 不要在收包回调里做长时间阻塞操作。
- tick 推进要以固定 `dt` 为准，真实时间只负责 accumulator。
- `maxFrame` 要限制单次追帧上限，避免窗口卡顿后一次补太多 tick。

### 22.5 Snapshot / DTO：WorldSnapshot 和网络包

`WorldSnapshot` 是项目里的状态传输对象，也可以理解成 DTO。

它把世界状态从 `World` 对象里抽出来，供这些场景复用：

- 服务端下发权威状态。
- 客户端回滚恢复。
- 压力测试保存历史。
- `Hasher` 做状态对账。

注意点：

- Snapshot 里必须包含所有会影响未来模拟的状态。
- 网络包可以比 Snapshot 更紧凑，但不能漏掉客户端恢复权威所需的字段。
- hash 覆盖范围要和“确定性状态”一致。
- float 不要直接按内存 hash，本项目用毫米量化是正确方向。

### 22.6 RAII：资源生命周期管理

项目里 `UdpSocket` 适合按 RAII 思路理解：socket fd 的打开、关闭、事件注册应该由对象生命周期管理。SDL 的窗口、renderer、font 目前由 `InitRenderer` / `ShutdownRenderer` 成对管理，也体现了同样思想。

注意点：

- socket、event、SDL 资源不能泄露。
- 初始化失败时要释放已经创建的资源。
- 后续可以把 `event*`、`event_base*`、SDL texture 等进一步封装成 RAII wrapper。

### 22.7 为什么本项目不适合滥用 Singleton

这个项目最不应该做成单例的是：

- `World`
- `InputBuffer`
- `StateHistory`
- `ClientCtx`
- `ServerCtx`
- `UdpSocket`

原因是 rollback、预测和压测都需要多实例。

例如同一个进程里可能同时存在：

- 一个权威世界。
- 一个客户端预测世界。
- 多个历史快照。
- 多个输入缓冲。

如果把这些做成单例，会让状态隐藏起来，回滚恢复不完整，测试互相污染。

可以考虑单例的对象非常少，例如只读配置表或日志入口。但只要对象带有对局状态、网络连接、玩家状态，就不要做成单例。

### 22.8 设计模式复习口诀

这个项目里可以这样记：

```text
InputCmd 是命令模式：保存玩家意图，支持发送、缓存、重放。
WorldSnapshot 是快照/DTO：保存权威状态，支持恢复、同步、hash。
sim/net/app 是分层架构：隔离模拟、协议和应用流程。
libevent/SDL 是事件驱动：网络、输入、tick 都由事件推进。
UdpSocket/RenderCtx 要按 RAII 思维管理：资源成对创建和释放。
不要滥用 Singleton：回滚系统需要多实例和显式状态。
```
