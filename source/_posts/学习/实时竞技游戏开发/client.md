---
title: "Client 实现分析"
date: 2026-05-04 09:30:06
updated: 2026-05-04 09:30:06
categories:
  - "学习"
  - "实时竞技游戏开发"
permalink: /notes/实时竞技游戏开发/client/
---

# Client 实现分析

time：2026_1_21

核心文件：

- `apps/client_main.cpp`
- `src/app/InputPrediction.cpp`
- `src/app/ClientRender.cpp`

客户端的职责可以概括为：

```text
先预测，让本地操作立刻生效；
再接受服务端权威状态；
最后从权威快照回滚重放，追上当前 tick。
```

---

## 1. ClientCtx 保存了什么

`ClientCtx` 是客户端运行态上下文。

它包含几类状态：

| 类别 | 字段 | 作用 |
|---|---|---|
| 网络 | `UdpSocket sock`、`UdpAddr server` | 和服务端收发 UDP |
| 时间 | `prev`、`acc`、`dt`、`maxFrame` | 固定时间步 accumulator |
| 本地 tick | `tick` | 客户端下一帧要推进的逻辑 tick |
| 预测世界 | `worldPred` | 客户端本地预测出来的世界 |
| 输入历史 | `localHist` | 保存本地玩家每个 tick 的输入 |
| 远端预测 | `remoteHist`、`remoteLast` | 保存和延续远端玩家预测输入 |
| 状态历史 | `stateHist` | 保存预测快照和权威快照，用于回滚/对账 |
| 开局状态 | `hasStart`、`startTick`、`localPlayerId` | 服务端分配的玩家槽位和统一起始 tick |
| 调试计数 | `rollbackCount`、`hashMismatchCount` | 观察回滚和 hash 分叉 |

这说明客户端不是只保存“当前位置”，而是保存：

- 输入历史
- 状态历史
- 网络进度
- 权威 tick
- 本地预测 tick

这些状态共同支撑 rollback。

---

## 2. 未开局阶段：hello / Start

客户端启动后如果还没收到 `Start`，会定期发送空 `InputPacket`：

```text
SendHello()
```

服务端收到后按 UDP 地址分配 slot。

客户端收到 `StartPacket` 后执行：

```text
ApplyStart()
```

主要动作：

1. 记录 `localPlayerId`。
2. 设置 `startTick`。
3. 把客户端本地 `tick` 对齐到 `startTick`。
4. 初始化世界快照并写入 `stateHist`。

注意：

`Start` 不是权威状态同步包，它只是告诉客户端“你是谁，以及从哪个 tick 开始”。

---

## 3. 每帧预测流程

客户端 `OnTick` 里使用 accumulator：

```text
frame = now - prev
acc += min(frame, maxFrame)

while acc >= dt:
  推进一个逻辑 tick
  acc -= dt
```

每个逻辑 tick 做四件事：

1. 从 SDL 键盘状态采样本地输入。
2. 写入 `localHist`。
3. 用本地输入和远端预测输入调用 `worldPred.Step`。
4. 保存预测快照到 `stateHist`，然后发送冗余 Input 包。

核心链路：

```text
PollInput
  -> localHist.Put(localCmd)
  -> GetRemoteCmdForTick
  -> BuildCmdVec
  -> worldPred.Step
  -> stateHist.Put
  -> EncodeInput + SendTo
```

---

## 4. BuildCmdVec 的意义

`World::Step` 需要的是“所有玩家同一个 tick 的输入数组”。

但是客户端本地只真正知道自己的输入，对手输入只能预测。

所以 `BuildCmdVec` 的任务是：

```text
把本地真实输入放到自己的 player slot；
把远端预测输入放到其他 player slot；
形成 vector<InputCmd> 交给 World::Step。
```

这也是服务端和客户端能复用同一个 `World::Step` 的原因。

---

## 5. 远端输入预测

远端玩家的真实输入不会直接发给客户端。

客户端根据服务端 State 里的远端状态估计远端输入：

- 如果远端在 Hitstun，预测不动。
- 如果速度明显向右，预测 `moveX = 1`。
- 如果速度明显向左，预测 `moveX = -1`。
- 如果速度接近 0，预测停止。
- 缺少新预测时，短时间 HoldLast。

相关函数：

- `PredictMoveXFromState`
- `PredictMoveYFromState`
- `GetRemoteCmdForTick`

注意：

远端输入预测只是为了让画面连续，不是权威逻辑。最终仍然以服务端 State 为准。

---

## 6. 收包处理：ACK 和 State

客户端收包入口：

```text
OnUdp()
```

它会依次尝试解析：

1. `StartPacket`
2. `AckPacket`
3. `StatePacket`

### ACK

ACK 更新：

- `lastServerTick`
- `lastServerHash`
- `serverLastInputTick`

它主要表示服务端处理进度，不携带完整权威状态。

客户端可以用：

```text
lead = localTick - lastServerTick
```

观察自己本地预测领先服务端多少 tick。

### State

State 才是真正的权威状态包。

客户端收到 State 后：

1. 还原成 `WorldSnapshot auth`。
2. 校验 `Hasher::Hash(auth)` 是否等于 `stateHash`。
3. 更新远端输入预测。
4. 判断本地玩家是否明显偏离。
5. 写入权威快照。
6. `RestoreAndReplay`。

---

## 7. RestoreAndReplay

回滚重放流程：

```text
worldPred.Restore(authoritativeSnapshot)

for t = authoritativeTick + 1; t < localNextTick; ++t:
  localCmd = localHist[t] or default
  remoteCmd = remoteHist[t] or hold/default
  cmds = BuildCmdVec(...)
  worldPred.Step(cmds, dt)
  stateHist.Put(worldPred.Snapshot())
```

重点：

- 回滚不是把玩家瞬移到服务端位置。
- 回滚是恢复到历史权威点，然后重新模拟未来输入。
- 这样玩家本地输入仍然能保持即时反馈。

---

## 8. 为什么只统计本地玩家 rollback

代码里判断 `needRollback` 时只比较本地玩家：

- 位置误差
- HP
- action
- onGround

原因是远端玩家本来就是预测出来的。如果远端误差也算 rollback，会导致统计频繁增长，调试信息失真。

但是注意：

即使没有计入 `rollbackCount`，客户端仍然会 rebase + replay。

这是为了让远端玩家和子弹尽快采用权威状态。

---

## 9. 客户端注意事项

- `localHist` 只保存本地玩家输入，不保存整局所有玩家真实输入。
- `remoteHist` 保存的是远端预测输入，不是权威输入。
- `stateHist` 既会存预测快照，也会被权威快照覆盖。
- `lastAuthoritativeTick` 用来丢弃旧 State，防止延迟包覆盖新状态。
- 新增会影响模拟的玩家字段时，要同步改 `WorldSnapshot`、`StatePacket`、`Hasher` 和测试。
- 不要把远端预测当成权威结果。
- 不要用真实帧耗时直接推进 `World::Step`。
- `rollbackCount` 是调试指标，不等于所有 rebase 次数。
