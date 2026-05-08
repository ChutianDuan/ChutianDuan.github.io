---
title: "Server 实现分析"
date: 2026-05-04 10:47:15
updated: 2026-05-04 10:47:15
categories:
  - "学习"
  - "实时竞技游戏开发"
permalink: /notes/实时竞技游戏开发/server/
---

# Server 实现分析

time：2026_1_20

核心文件：

- `apps/server_main.cpp`

服务端的职责可以概括为：

```text
分配玩家 slot；
接收每个玩家按 tick 上传的输入；
用同一套 World::Step 推进唯一权威世界；
向客户端广播 ACK 和 State。
```

---

## 1. ClientConn

`ClientConn` 表示一个客户端连接。

关键字段：

| 字段 | 作用 |
|---|---|
| `addr` | 客户端 UDP 地址 |
| `inputBuf` | 按 tick 保存该玩家输入 |
| `lastInputTick` | 服务端已收到该玩家最大的输入 tick |
| `lastAppliedTick` | 服务端上次实际用于模拟的输入 tick |
| `lastApplied` | HoldLast 时复用的输入 |
| `assigned` | 是否已经分配 player slot |
| `playerId` | 玩家编号，当前是 1 或 2 |
| `lastHeardSec` | 连接超时判断 |

服务端不相信客户端上传的位置，只接收输入。

---

## 2. ServerCtx

`ServerCtx` 是服务端运行态上下文。

关键字段：

| 字段 | 作用 |
|---|---|
| `sock` | UDP socket |
| `clients` | addr key 到 `ClientConn` 的映射 |
| `playerKey` | player slot 到 addr key 的映射 |
| `world` | 服务端权威世界 |
| `tick` | 服务端权威 tick |
| `started` | 是否开局 |
| `prev`、`acc` | 固定时间步 accumulator |
| `mazeSeed` | 当前对局迷宫种子 |

服务端的 `world` 是唯一权威状态来源。

---

## 3. 玩家 slot 分配

主要函数：

- `AssignSlot`
- `GetPlayer`
- `OnlineCount`
- `KickPlayer`

服务端用 `UdpAddr::Key()` 作为客户端身份 key。

流程：

```text
收到 InputPacket
  -> 根据 from.Key() 找 ClientConn
  -> 如果未分配，则 AssignSlot
  -> 写入该玩家 inputBuf
```

当前版本固定 2 人，第三个连接会被拒绝。

---

## 4. 开局同步

函数：

```text
MaybeStartMatch()
```

当在线人数达到 `kRequiredPlayers` 后：

1. 计算 `startTick = tick + kStartDelayTicks`。
2. 把服务端 `tick` 设置为 `startTick`。
3. 标记 `started = true`。
4. 给每个客户端发送 `StartPacket`。

注意：

当前实现里的 `kStartDelayTicks` 更像 tick 编号偏移。服务端会直接跳到 `startTick` 并开局，不是墙钟意义上的倒计时等待。

---

## 5. 输入接收

收包函数：

```text
OnUdp()
```

服务端只解析 `InputPacket`。

收到包后会遍历 `in->cmds`：

```text
for cmd in inputPacket.cmds:
  inputBuf.Put(cmd)
  lastInputTick = max(lastInputTick, cmd.tick)
```

因为客户端每包带最近 K 帧输入，所以服务端可能重复收到同一个 tick 的输入。按 tick 写入环形缓冲即可覆盖同 tick 旧值。

---

## 6. 缺输入处理：HoldLast / Default

函数：

```text
GetCmdForTick(ClientConn& cc, Tick tick)
```

逻辑：

1. 如果 `inputBuf.Get(tick)` 有值，使用该输入。
2. 如果没有，但上次输入仍在 `kHoldInputTicks` 窗口内，复用上一帧输入并改成当前 tick。
3. 如果超过窗口，使用默认空输入。

这个策略用于抵抗 UDP 短暂丢包和延迟。

注意：

HoldLast 不能无限持续，否则玩家断线后会一直沿着旧方向移动。

---

## 7. 权威 tick 推进

服务端 `OnTick` 也使用 accumulator。

每个逻辑 tick：

```text
cmds = []
for each player:
  cmds.push_back(GetCmdForTick(player, serverTick))

world.Step(cmds, dt)
snap = world.Snapshot()
h = Hasher::Hash(snap)

send Ack every tick
send State every kStateEvery tick

tick++
```

当前 `kStateEvery = 2`，也就是每 2 tick 下发一次完整权威状态。

---

## 8. ACK 和 State

### ACK

每 tick 发送。

包含：

- `playerId`
- `serverTickProcessed`
- `serverLastInputTick`
- `serverStateHash`

ACK 的重点是告诉客户端服务端处理进度。

### State

按频率发送。

包含：

- `tick`
- `mazeSeed`
- 玩家状态
- 子弹状态
- `stateHash`

State 用于客户端恢复权威快照并回滚重放。

---

## 9. 服务端注意事项

- 服务端只能信任输入，不能信任客户端上传的最终状态。
- 输入应校验 tick 范围，避免异常客户端写入过大 tick 覆盖环形缓冲。
- 输入值应校验范围，例如 `moveX/moveY` 只允许 `-1/0/1`，`buttons` 只允许合法位。
- 迷宫如果只同步 seed，跨平台时要注意 RNG 和 shuffle 的确定性。
- `World::Step` 必须是唯一权威推进入口，不要在网络层或渲染层偷偷改状态。
- 如果扩展多人，需要同步修改 `kMaxPlayers`、State 编解码、渲染和压测。
- `Ack` 不是完整状态，客户端不能只靠 ACK 回滚。
- `State` 包太频繁会增加带宽，太稀疏会增加修正延迟，需要按玩法调参。

---

## 10. 权威状态回滚更新详细流程

这一节是服务端权威同步最关键的闭环。

先分清职责：

```text
服务端：生产权威 State。
客户端：接收权威 State，把预测世界回滚到权威历史点，再重放本地输入追到当前 tick。
```

所以“权威状态回滚更新”不是服务端自己回滚，而是：

```text
Server authoritative state
        ↓
StatePacket
        ↓
Client ApplyAuthoritativeState
        ↓
World::Restore(auth)
        ↓
Replay local input history
        ↓
新的客户端预测世界
```

---

### 10.1 为什么需要这条链路

客户端为了手感会提前预测：

```text
玩家按键
  -> 客户端立即 World::Step
  -> 画面马上移动
```

但服务端才是最终权威。

如果服务端稍后告诉客户端：

```text
tick 120 的真实位置不是你预测的位置
```

客户端不能简单把当前画面拉回 tick 120，因为本地已经跑到更后面的 tick 了。

正确做法是：

```text
恢复到服务端 tick 120 的权威快照
重新执行 tick 121 ~ 当前 tick 的本地输入
得到一个新的当前预测状态
```

这就是 rollback + replay。

---

### 10.2 服务端生成权威 State

服务端每个 tick 先收集输入，再推进唯一权威世界：

```cpp
std::vector<InputCmd> cmds;
cmds.reserve(ServerCtx::kMaxPlayers);

for (uint8_t pid = 1; pid <= ServerCtx::kMaxPlayers; ++pid) {
    ClientConn* p = GetPlayer(ctx, pid);
    cmds.push_back(p ? GetCmdForTick(*p, ctx->tick)
                     : InputBuffer::DefaultForTick(ctx->tick));
}

ctx->world.Step(cmds, float(ServerCtx::dt));

auto snap = ctx->world.Snapshot();
uint64_t h = Hasher::Hash(snap);
```

这里的 `snap` 就是服务端权威快照。

注意：

- 服务端只使用客户端上传的输入。
- 服务端不会相信客户端上传的位置、HP、命中结果。
- `Hasher::Hash(snap)` 用来给客户端做状态对账。

---

### 10.3 服务端把 Snapshot 压缩成 StatePacket

服务端不是直接发送 `WorldSnapshot`，而是构造网络包 `StatePacket`。

关键代码：

```cpp
lab::net::StatePacket st{};
st.playerId = pid;
st.tick = snap.tick;
st.mazeSeed = snap.mazeSeed;
st.playerCount = static_cast<uint8_t>(
    std::min<size_t>(ServerCtx::kMaxPlayers, snap.players.size()));
st.projectileCount = static_cast<uint8_t>(
    std::min<size_t>(snap.projectiles.size(), 255));
```

玩家状态会被量化后写入：

```cpp
ps.x_mm = (int32_t)std::lround(wp.x * 1000.0f);
ps.v_mm = (int32_t)std::lround(wp.v * 1000.0f);
ps.y_mm = (int32_t)std::lround(wp.y * 1000.0f);
ps.vy_mm = (int32_t)std::lround(wp.vy * 1000.0f);
ps.hp = wp.hp;
ps.action = static_cast<uint8_t>(wp.action);
ps.shotCooldown = wp.shotCooldown;
ps.aimX = wp.aimX;
ps.aimY = wp.aimY;
```

子弹也会被写入：

```cpp
pr.x_mm = (int32_t)std::lround(wp.x * 1000.0f);
pr.y_mm = (int32_t)std::lround(wp.y * 1000.0f);
pr.vx_mm = (int32_t)std::lround(wp.vx * 1000.0f);
pr.vy_mm = (int32_t)std::lround(wp.vy * 1000.0f);
pr.owner = wp.owner;
pr.life = wp.life;
```

最后写入权威 hash 并发送：

```cpp
st.stateHash = h;

auto bytes = lab::net::EncodeState(st);
ctx->sock.SendTo(pc->addr, bytes);
```

当前服务端每 `kStateEvery = 2` 个 tick 发送一次完整 State。

---

### 10.4 客户端收到 State

客户端收包入口在 `OnUdp`。

收到 State 后先做三件事：

1. 如果还没有 `localPlayerId`，从 State 中记录。
2. 如果这个 State 比已应用的权威 State 更旧，直接丢弃。
3. 根据 State 更新远端玩家输入预测。

对应代码：

```cpp
if (auto st = lab::net::DecodeState(data, len)) {
    if (ctx->localPlayerId == 0) {
        ctx->localPlayerId = st->playerId;
    }
    if (ctx->lastAuthoritativeTick != 0 &&
        st->tick <= ctx->lastAuthoritativeTick) {
        return;
    }

    // 更新远端输入预测...
    ApplyAuthoritativeState(*ctx, *st);
    return;
}
```

旧 State 必须丢弃。

原因是 UDP 可能乱序。如果 tick 130 的 State 已经应用，之后才收到 tick 126 的旧 State，就不能让旧权威覆盖新权威。

---

### 10.5 客户端把 StatePacket 还原成权威 Snapshot

`ApplyAuthoritativeState` 会把网络包还原成 `WorldSnapshot auth`。

核心逻辑：

```cpp
WorldSnapshot auth = ctx.worldPred.Snapshot();
if (auth.mazeSeed != st.mazeSeed || auth.maze.empty()) {
    ctx.worldPred.SetMazeSeed(st.mazeSeed);
    auth = ctx.worldPred.Snapshot();
}

auth.tick = st.tick;
auth.mazeSeed = st.mazeSeed;
auth.players.resize(ClientCtx::kMaxPlayers);
```

然后还原玩家状态：

```cpp
auth.players[i].x = FromMM(ps.x_mm);
auth.players[i].v = FromMM(ps.v_mm);
auth.players[i].y = FromMM(ps.y_mm);
auth.players[i].vy = FromMM(ps.vy_mm);
auth.players[i].hp = ps.hp;
auth.players[i].action = toAction(ps.action);
auth.players[i].facing = ps.facing;
auth.players[i].stateTimer = ps.stateTimer;
auth.players[i].shotCooldown = ps.shotCooldown;
auth.players[i].aimX = ps.aimX;
auth.players[i].aimY = ps.aimY;
```

还原子弹状态：

```cpp
ProjectileState prd{};
prd.x = FromMM(pr.x_mm);
prd.y = FromMM(pr.y_mm);
prd.vx = FromMM(pr.vx_mm);
prd.vy = FromMM(pr.vy_mm);
prd.life = pr.life;
prd.owner = pr.owner;
prd.alive = pr.life > 0 ? 1 : 0;
auth.projectiles.push_back(prd);
```

注意：

StatePacket 里没有直接发送完整迷宫网格，只发送 `mazeSeed`。客户端会根据 seed 生成迷宫，然后 `WorldSnapshot` 中仍然保留迷宫网格用于恢复和 hash。

---

### 10.6 权威 hash 校验

客户端还原出 `auth` 后，会重新计算 hash：

```cpp
const uint64_t authHash = Hasher::Hash(auth);
if (authHash != st.stateHash &&
    ctx.lastHashMismatchTick != st.tick) {
    ctx.hashMismatchCount++;
    ctx.lastHashMismatchTick = st.tick;
}
```

如果这里 mismatch，说明：

- 服务端和客户端还原出来的快照不同。
- 或者某个字段没有正确进入网络包。
- 或者迷宫 seed 生成结果不一致。
- 或者 hash 覆盖字段和 StatePacket 字段不匹配。

这是定位状态分叉的重要工具。

---

### 10.7 判断是否计入 rollback

项目只用“本地玩家”的误差来判断是否增加 `rollbackCount`：

```cpp
bool needRollback = false;
if (auto localOpt = ctx.stateHist.Get(st.tick)) {
    const auto& local = *localOpt;

    float dx = std::fabs(local.players[idx].x - auth.players[idx].x);
    float dy = std::fabs(local.players[idx].y - auth.players[idx].y);

    const bool hpDiff = local.players[idx].hp != auth.players[idx].hp;
    const bool actionDiff = local.players[idx].action != auth.players[idx].action;
    const bool groundDiff = local.players[idx].onGround != auth.players[idx].onGround;

    needRollback = (dx > 0.15f) || (dy > 0.15f) ||
                   hpDiff || actionDiff || groundDiff;
}
```

为什么只比较本地玩家？

因为远端玩家本来就是客户端猜出来的。远端预测错很正常，如果把远端差异也算进 rollback，会导致 rollback 统计一直增长。

注意：

`needRollback` 只影响 `rollbackCount` 统计。

真正的 rebase + replay 不管 `needRollback` 是否为 true，都会执行。

---

### 10.8 写入权威快照并执行回滚重放

客户端会先把权威快照写入 `stateHist`：

```cpp
ctx.stateHist.Put(auth);
ctx.lastAuthoritativeTick = st.tick;

if (needRollback) {
    ctx.rollbackCount++;
    ctx.lastRollbackTick = st.tick;
}

RestoreAndReplay(ctx, auth);
```

这里有两个重点：

1. `stateHist.Put(auth)` 会覆盖该 tick 原来的预测快照。
2. `RestoreAndReplay` 会从权威历史点重新模拟到当前客户端 tick。

---

### 10.9 RestoreAndReplay 的完整流程

核心代码：

```cpp
static void RestoreAndReplay(ClientCtx& ctx, const WorldSnapshot& auth) {
    ctx.worldPred.Restore(auth);

    for (Tick t = auth.tick + 1; t < ctx.tick; ++t) {
        InputCmd localCmd =
            ctx.localHist.Get(t).value_or(InputBuffer::DefaultForTick(t));

        std::vector<InputCmd> remoteCmds(
            ClientCtx::kMaxPlayers,
            InputBuffer::DefaultForTick(t));

        for (uint8_t pid = 1; pid <= ClientCtx::kMaxPlayers; ++pid) {
            if (pid == ctx.localPlayerId) continue;
            remoteCmds[pid - 1] = GetRemoteCmdForTick(ctx, pid, t);
        }

        auto cmds = BuildCmdVec(ctx.localPlayerId, localCmd, remoteCmds);
        ctx.worldPred.Step(cmds, float(ClientCtx::dt));
        ctx.stateHist.Put(ctx.worldPred.Snapshot());
    }
}
```

可以拆成三步：

```text
1. Restore(auth)
   把预测世界恢复到服务端权威 tick。

2. Replay auth.tick + 1 到 ctx.tick - 1
   用本地输入历史 + 远端预测输入重新推进。

3. Put Snapshot
   每重放一帧都保存新的预测快照。
```

这里的 `ctx.tick` 是客户端下一帧要模拟的 tick，所以循环条件是：

```text
t < ctx.tick
```

也就是追到客户端当前已经预测过的最后一帧。

---

### 10.10 World::Restore 恢复了哪些内容

`World::Restore` 不是只恢复玩家位置。

它会恢复：

- `snap_`
- `mazeSeed_`
- 迷宫宽高
- 迷宫网格
- 玩家状态
- `lastDirX_ / lastDirY_`
- 子弹列表

关键代码：

```cpp
void World::Restore(const WorldSnapshot& s) {
    snap_ = s;
    mazeSeed_ = s.mazeSeed;
    mazeW_ = s.mazeWidth ? s.mazeWidth : mazeW_;
    mazeH_ = s.mazeHeight ? s.mazeHeight : mazeH_;

    if (!s.maze.empty()) {
        maze_ = s.maze;
    } else {
        rng_.seed(mazeSeed_);
        GenerateMaze();
    }

    lastDirX_.assign(snap_.players.size(), 1.0f);
    lastDirY_.assign(snap_.players.size(), 0.0f);

    projectiles_.clear();
    for (const auto& pr : s.projectiles) {
        if (!pr.alive) continue;
        // 恢复 projectile
    }
}
```

这个函数说明一个核心原则：

```text
回滚恢复必须恢复所有会影响未来模拟的状态。
```

如果只恢复玩家位置，不恢复子弹、冷却、瞄准方向、迷宫，重放结果仍然会分叉。

---

### 10.11 一个具体例子

假设：

```text
客户端当前 tick = 140
客户端收到服务端 State tick = 132
```

客户端执行：

```text
1. 解码 StatePacket。
2. 还原 auth snapshot at tick 132。
3. hash(auth) 对比服务端 stateHash。
4. 对比本地 stateHist[132] 的本地玩家状态。
5. stateHist[132] = auth。
6. worldPred.Restore(auth)。
7. 依次重放 tick 133 ~ 139：
   - 本地输入来自 localHist
   - 远端输入来自 remoteHist / HoldLast / Default
   - 每帧调用 World::Step
   - 每帧重新写 stateHist
8. 渲染新的 worldPred。
```

最终客户端画面仍然在 tick 140 附近，不会倒退显示 tick 132。

---

### 10.12 总结流程图

```text
Server OnTick
  -> GetCmdForTick
  -> world.Step
  -> snap = world.Snapshot
  -> hash = Hasher::Hash(snap)
  -> EncodeState
  -> SendTo(client)

Client OnUdp
  -> DecodeState
  -> 丢弃旧 State
  -> 更新远端输入预测
  -> ApplyAuthoritativeState
       -> StatePacket 还原 WorldSnapshot auth
       -> Hasher::Hash(auth) 对账
       -> 对比本地玩家误差
       -> stateHist.Put(auth)
       -> lastAuthoritativeTick = st.tick
       -> RestoreAndReplay
            -> worldPred.Restore(auth)
            -> for t = auth.tick + 1; t < ctx.tick; ++t
                 -> localHist.Get(t)
                 -> GetRemoteCmdForTick(t)
                 -> BuildCmdVec
                 -> worldPred.Step
                 -> stateHist.Put(snapshot)
```

---

### 10.13 常见易错点

- 旧 State 没有丢弃，导致客户端被延迟包拉回旧历史。
- 只恢复玩家位置，没有恢复子弹、冷却、aim、maze。
- 新增字段只加到 `World`，忘了加到 `WorldSnapshot`。
- 新增字段进入 Snapshot，但忘了加到 `StatePacket` 编解码。
- 新增字段影响模拟，但忘了加入 `Hasher`。
- 把远端预测误差也计入 rollback，导致 rollback 统计失真。
- `StatePacket` 频率太低，客户端纠偏延迟变大。
- `StatePacket` 频率太高，带宽和解码压力变大。
- 回滚窗口太小，`localHist` 或 `stateHist` 被环形覆盖后无法重放。

---

### 10.14 一句话记忆

```text
服务端每隔几帧下发权威 State；
客户端收到后，不是直接显示旧 State；
而是恢复旧 State，再重放旧 State 之后的输入；
这样既接受服务端权威，又保留本地即时操作手感。
```
