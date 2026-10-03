---
title: "权威状态晚到又乱序，客户端怎样校正而不吞掉玩家输入？"
date: 2026-07-13 17:14:09
updated: 2026-07-13 17:14:09
categories:
  - "学习"
  - "实时竞技游戏开发"
permalink: /notes/实时竞技游戏开发/client/
series: "实时竞技游戏开发"
---

客户端已经预测到 tick 104，画面中的玩家也连续向右移动了几帧。这时，服务端 tick 101 的权威状态才到达。最直接的写法是：

```cpp
// 存在隐患：直接覆盖后，tick 102～104 的本地输入全部丢失。
world.Restore(authoritativeState);
render(world.Snapshot());
```

角色会瞬间退回旧位置，而且玩家在网络往返期间按下的键仿佛从未发生。更麻烦的是，UDP 不保证有序：刚应用完 tick 101，tick 99 的旧包可能随后到达，再把世界倒退一次。

实时客户端真正要解决的不是“收到状态后覆盖坐标”，而是同时维护三条时间线：本地下一 tick、服务端已处理进度、最近已接受的权威 tick。正确流程是先验证包属于当前对局且比上一个权威状态新，再恢复到该权威点，最后重放它之后的本地输入。

本文以 `Fighting/apps/client_main.cpp` 的当前实现为依据，重点解释客户端预测、乱序过滤、输入历史、远端预测、rebase/replay 和网络指标如何协作。项目使用 **C++20、UDP、libevent、SDL2/SDL2_ttf**；内部协议和常量需要结合具体版本验证。

## 1. 客户端为什么不能只保存“当前位置”？

如果客户端只保留当前 `World`，收到 tick 101 的快照时，它并不知道 tick 102～104 做过什么，也就无法从权威历史重新推导当前画面。

当前 `ClientCtx` 因此保存了几类不同状态：

| 状态 | 当前实现中的代表字段 | 解决的问题 |
| --- | --- | --- |
| 本地进度 | `tick` | 下一次要预测哪个逻辑帧 |
| 预测世界 | `worldPred` | 立即响应本地输入 |
| 本地输入历史 | `localHist` | 权威校正后重放自己的输入 |
| 远端预测历史 | `remoteHist`、`remoteLast` | 重放时补齐其他玩家输入 |
| 状态历史 | `stateHist` | 比较同 tick 预测与权威状态 |
| 对局身份 | `sessionId`、`matchId`、`localPlayerId` | 拒绝其他会话或旧比赛的包 |
| 权威进度 | `lastAuthoritativeTick`、`lastServerTick` | 拒绝旧 State、观察服务端进度 |
| 调试指标 | `rollbackCount`、`hashMismatchCount`、`netStats` | 判断同步质量与重放成本 |

这些数据并不重复。`localHist` 保存的是玩家意图，`stateHist` 保存的是模拟结果；前者用于 replay，后者用于比较和对账。只保存其中一个都无法完整覆盖客户端职责。

## 2. 一个包到达后，为什么必须先过三道门？

UDP 收包回调 `OnUdp` 不会把任何能解码的数据直接交给模拟层。当前代码至少检查三类边界。

### 2.1 来源地址是否是配置的服务器？

客户端首先比较发送者地址与 `ctx.server`。这能过滤明显无关的数据报，但不能代替密码学身份认证；UDP 源地址可能被伪造，公网对抗场景还需要更强的认证与防重放设计。

### 2.2 包是否属于当前 session、match 和 player？

服务端下行包携带：

```text
sessionId：这次连接会话
matchId：这一局比赛
playerId：服务端分配的玩家槽位
```

三者必须与客户端当前上下文一致。只检查 `playerId` 不够，因为上一局的 P1 State 仍可能在网络中延迟；只检查 `matchId` 也不够，因为不同连接可能出现相同局部语义。

### 2.3 State tick 是否比最近权威状态新？

客户端会忽略：

```cpp
state.tick <= lastAuthoritativeTick
```

否则 UDP 乱序就可能让时间倒退。实际项目使用 `uint32_t Tick`，长期运行还要考虑回绕；新增比较逻辑时应复用项目已有的序号先后判断规则，而不是到处写普通整数大小比较。

通过这些边界后，包才有资格影响客户端状态。解码成功只说明字节布局合法，不代表消息在当前上下文中有效。

## 3. 最小可运行版本：应用新 State，拒绝随后到达的旧 State

下面的程序模拟一个预测客户端。客户端先连续预测 5 帧向右；服务端在 tick 2 的权威位置少 1 格。客户端应用 tick 2 后重放 tick 3、4，随后又收到 tick 1 的旧包并拒绝它。

示例只使用标准库，不包含真实 UDP 和远端玩家，目的是隔离客户端 reconciliation（状态协调）的关键逻辑。

```cpp
#include <cassert>
#include <cstdint>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <unordered_map>

using Tick = std::uint32_t;

struct InputCmd {
    Tick tick = 0;
    int axis = 0;
};

struct Snapshot {
    Tick tick = 0;  // 已经处理完的输入 tick
    int position = 0;
};

struct StatePacket {
    std::uint64_t sessionId = 0;
    std::uint32_t matchId = 0;
    std::uint8_t playerId = 0;
    Snapshot state{};
};

class World {
public:
    void Step(const InputCmd& input) {
        state_.tick = input.tick;
        state_.position += input.axis;
    }

    void Restore(const Snapshot& snapshot) {
        state_ = snapshot;
    }

    [[nodiscard]] Snapshot Save() const {
        return state_;
    }

private:
    Snapshot state_{};
};

class PredictiveClient {
public:
    PredictiveClient(std::uint64_t sessionId,
                     std::uint32_t matchId,
                     std::uint8_t playerId)
        : sessionId_(sessionId), matchId_(matchId), playerId_(playerId) {}

    void Predict(int axis) {
        const InputCmd input{nextTick_, axis};
        inputHistory_.insert_or_assign(nextTick_, input);
        world_.Step(input);
        stateHistory_.insert_or_assign(nextTick_, world_.Save());
        ++nextTick_;
    }

    bool ApplyAuthoritative(const StatePacket& packet) {
        if (packet.sessionId != sessionId_ ||
            packet.matchId != matchId_ ||
            packet.playerId != playerId_) {
            return false;
        }
        if (lastAuthoritativeTick_ &&
            packet.state.tick <= *lastAuthoritativeTick_) {
            return false;  // 重复包或乱序旧包
        }
        if (packet.state.tick >= nextTick_) {
            return false;  // 示例不接受超出本地预测进度的快照
        }

        const auto predicted = stateHistory_.find(packet.state.tick);
        if (predicted != stateHistory_.end() &&
            predicted->second.position != packet.state.position) {
            ++rollbackCount_;
        }

        world_.Restore(packet.state);
        stateHistory_.insert_or_assign(packet.state.tick, packet.state);

        for (Tick tick = packet.state.tick + 1; tick < nextTick_; ++tick) {
            const auto input = inputHistory_.find(tick);
            if (input == inputHistory_.end()) {
                throw std::runtime_error("missing input required for replay");
            }
            world_.Step(input->second);
            stateHistory_.insert_or_assign(tick, world_.Save());
        }

        lastAuthoritativeTick_ = packet.state.tick;
        return true;
    }

    [[nodiscard]] Snapshot Current() const { return world_.Save(); }
    [[nodiscard]] std::uint32_t RollbackCount() const { return rollbackCount_; }

private:
    std::uint64_t sessionId_;
    std::uint32_t matchId_;
    std::uint8_t playerId_;
    Tick nextTick_ = 0;
    World world_{};
    std::unordered_map<Tick, InputCmd> inputHistory_;
    std::unordered_map<Tick, Snapshot> stateHistory_;
    std::optional<Tick> lastAuthoritativeTick_;
    std::uint32_t rollbackCount_ = 0;
};

int main() {
    PredictiveClient client{1001, 7, 1};
    for (int i = 0; i < 5; ++i) {
        client.Predict(1);
    }
    std::cout << "before=" << client.Current().position << '\n';

    const StatePacket fresh{1001, 7, 1, Snapshot{2, 2}};
    const bool freshApplied = client.ApplyAuthoritative(fresh);
    std::cout << "after_fresh_state=" << client.Current().position << '\n';

    const StatePacket stale{1001, 7, 1, Snapshot{1, 100}};
    const bool staleApplied = client.ApplyAuthoritative(stale);
    std::cout << std::boolalpha
              << "fresh_state_applied=" << freshApplied << '\n'
              << "stale_state_applied=" << staleApplied << '\n'
              << "rollback_count=" << client.RollbackCount() << '\n';

    assert(freshApplied);
    assert(!staleApplied);
    assert(client.Current().position == 4);
    assert(client.RollbackCount() == 1);
}
```

在 macOS 或 Linux 上使用 Clang 编译：

```bash
clang++ -std=c++20 -O2 -Wall -Wextra -Wpedantic \
  predictive_client.cpp -o predictive_client
./predictive_client
```

预期输出：

```text
before=5
after_fresh_state=4
fresh_state_applied=true
stale_state_applied=false
rollback_count=1
```

这段输出验证了两个不同性质：新权威状态会改变预测历史，但不会吞掉它之后的输入；旧 State 即使携带荒谬的位置 100，也不能再次改变当前世界。

## 4. 示例中的恢复与重放为什么不会重复或漏掉一帧？

这里把 `Snapshot::tick` 定义为“该状态已经处理完的输入 tick”。所以收到 tick 2 快照后，应重放：

```text
2 + 1, 2 + 2, ... , nextTick - 1
```

不能从 tick 2 再执行一次，否则同一输入被消费两次；也不能从 tick 4 开始，否则 tick 3 永久丢失。项目当前的 `WorldSnapshot::tick` 同样记录 `World::Step` 消费的命令 tick，因此 `RestoreAndReplay` 从 `auth.tick + 1` 开始。

```text
本地预测：  tick 0  1  2  3  4      nextTick = 5
权威快照：              ↑ tick 2
replay：                      3  4
```

最小示例用 `unordered_map` 让逻辑清楚；真实项目使用容量 4096 的环形历史，避免容器无限增长。环形缓冲读取时必须同时验证槽位保存的 tick，否则被覆盖的旧槽位会冒充当前输入。

示例在缺少 replay 输入时抛出异常。游戏主循环通常不能让异常直接终止进程，但也不能悄悄当成空输入继续并声称同步成功。工程实现应记录历史缺口、放弃无法证明正确的 replay，并请求更近的完整权威基线或执行明确的重同步策略。当前项目用 `value_or(DefaultForTick)` 保持 Demo 继续运行，这个取舍需要结合实际产品的恢复协议评估。

## 5. 客户端每个逻辑 tick 到底做了什么？

当前 `OnTick` 由 libevent 定时回调驱动，并使用 accumulator 把真实时间转换成固定 `1/60` 秒模拟步。一次逻辑 tick 的主要流程是：

```text
读取当前 SDL 输入状态
        ↓
构造 localCmd(tick) 并写入 localHist
        ↓
为其他玩家生成 remoteCmds(tick)
        ↓
BuildCmdVec：按 player slot 排好所有命令
        ↓
worldPred.Step(cmds, fixed dt)
        ↓
保存预测快照
        ↓
发送包含最近 4 tick 本地输入的 InputPacket
        ↓
tick++
```

`BuildCmdVec` 的价值不是简单拼接 vector，而是保证服务端和客户端都用相同的玩家槽位顺序调用 `World::Step`。本地玩家只能拥有自己的真实输入；对手位置再清楚，也不能反推出唯一的真实按键历史。

当前代码在一次 `OnTick` 回调开始时调用一次 `PollInput`。如果 accumulator 需要连续补多个逻辑 tick，这几个 tick 会复用同一次键盘采样结果。这是常见且可接受的简化，但要理解它的边界：极短的按键边沿可能受到事件采样频率影响。需要精确边沿时，应把按下/松开事件按时间或 tick 排队，而不是只读当前键盘状态。

## 6. Start 和 Reset 为什么必须重置整套历史？

未开局时，客户端每 250 ms 发送一次空 `InputPacket` 作为 hello。服务端分配玩家槽位并在人数满足后返回 `StartPacket`。

当前 Start 不只是通知“你是几号玩家”：

- `playerId`、`sessionId`、`matchId` 确定当前身份；
- `startTick` 对齐双方起点；
- `mazeSeed`、尺寸和完整迷宫网格建立权威初始世界。

`ApplyStart` 会把 `tick` 对齐到 `startTick`，清空 accumulator，重建本地输入、远端预测和状态历史，再保存初始快照。如果只修改 playerId 而沿用上一局历史，旧 tick、旧迷宫或旧输入就可能参与新局 replay。

收到有效 Reset 后也要回到等待态，并清理世界与历史。Start/Reset 都可能经由不可靠 UDP 传输，所以客户端和服务端必须允许重复消息，并通过 session/match 让重复应用保持安全。

## 7. 远端输入不知道，客户端拿什么重放？

服务端不会把每个对手按键实时转发给当前客户端。`Fighting` 根据最近的权威玩家状态估计移动方向：

- Hitstun 时预测停止；
- 水平或垂直速度超过阈值时推断方向；
- 接近静止时归零；
- 处于中间阈值区间时延续上次方向；
- 缺少更新时最多 Hold Last 6 tick，之后使用默认输入。

这些规则的目的只是让远端画面在两次 State 之间连续。它们不是权威事实，也不可能从速度唯一恢复攻击、转向等全部输入。

客户端 replay 时，本地输入来自真实历史，远端输入仍来自预测历史：

```text
本地玩家：localHist[t]       —— 当时真实采样
远端玩家：remoteHist[t]      —— 当时或后来推断
最终校正：下一份 State       —— 服务端权威结果
```

因此远端误差是预期现象。预测策略应该追求较好的视觉连续性和较低校正幅度，而不是宣称能还原对手真实操作。

## 8. 为什么没有增加 rollbackCount，仍然要 rebase？

当前客户端用同 tick 的预测快照与权威快照比较本地玩家：位置差是否超过 0.15 m，以及 HP、action、onGround 是否变化。达到条件才增加 `rollbackCount`。

这个阈值只定义 HUD 指标，不定义权威性。即使本地玩家误差低于阈值，远端角色、弹道、冷却或迷宫相关状态仍可能需要修正，所以每个通过身份和 hash 校验的新 State 都会：

```text
stateHist.Put(authoritative)
RestoreAndReplay(authoritative)
```

把“是否显示为一次明显回滚”和“是否接受权威基线”分开，可以减少调试计数被远端预测噪声淹没。反过来，也不能只看 rollbackCount 很低就断言同步质量很好，还要观察 state delay、replay ticks、replay cost 和 hash mismatch。

## 9. ACK、State 和 HUD 指标分别告诉我们什么？

ACK 不携带可恢复的完整世界，它主要更新服务端进度与网络观测；State 才提供校正基线。

| 指标 | 当前计算依据 | 能说明什么 | 不能直接说明什么 |
| --- | --- | --- | --- |
| input lead | `local tick - server processed tick` | 本地预测领先程度 | 单独不能代表 RTT |
| RTT | 输入发送时间到 `serverLastInputTick` ACK 的时间，做平滑 | 输入确认链路的大致时延 | 不是纯网络传播时间 |
| packet loss | 服务端观察到的 input `seq` 缺口 | 包序列缺失估计 | 乱序和迟到下不是精确真实丢包率 |
| state delay | `local tick - State tick` | 收到状态时需要追赶的距离 | 不等于实际 replay 成本 |
| replay cost | 本次 restore/replay 耗时 | 校正是否接近帧预算 | 单次值不能代表长期分布 |
| hash mismatch | 同一量化状态的 hash 不同 | 编解码损坏或状态分叉信号 | 不能自动定位具体字段 |

冗余输入会让某个 tick 在多个包中出现，ACK 样本还包含服务端排队和处理时间。因此 HUD 的 RTT 是工程观测值，不是实验室级单向传播测量。优化前应记录一段时间的分布，而不是根据一个瞬时数字调整协议。

## 10. 客户端实现中还要注意哪些工程边界？

### 10.1 模拟状态与渲染状态要分开

权威 State 应立即纠正 `worldPred`，否则碰撞和攻击继续在错误世界上运行。视觉上的跳变可以在 `ClientRender` 中插值或衰减，但不能反向污染模拟状态。

### 10.2 收包回调不能长时间阻塞

`OnUdp` 与 tick 定时都由事件循环驱动。大量日志、磁盘 IO 或超长 replay 会延迟后续包和模拟。当前 HUD 已记录 replay ticks 与毫秒成本，真实项目还应关注 p95/p99，而非只看平均值。

### 10.3 State hash 校验不能省略字段闭环

新增会影响未来模拟的字段时，要同步修改：`WorldSnapshot`、Restore、StatePacket 编解码、Hasher 和回滚测试。Hash 只能检测参与 hash 的数据，不能弥补漏序列化字段。

### 10.4 4096 tick 不是无限历史

在 60 Hz 下，4096 tick 约为 68 秒，正常网络回滚通常远小于它。但历史需求还取决于 start tick、异常停顿、重连协议和快照体积。扩大容量会增加状态复制和内存，缩小则可能失去 replay 输入，必须用实际最大 state delay 和内存数据决定。

### 10.5 SDL 与默认字体路径具有平台边界

当前客户端依赖 SDL2/SDL2_ttf，并在 `client_main.cpp` 中使用 macOS 系统字体路径。Linux 或 Windows 上需要替换字体与依赖查找方式；核心预测和回滚逻辑不应依赖 SDL，才能在 headless 测试中独立验证。

### 10.6 不要在完整性校验前更新派生状态

当前 `OnUdp` 会先根据 State 中的远端玩家数据更新 `remoteHist`，随后 `ApplyAuthoritativeState` 才重建快照并验证 `stateHash`。因此，一个身份字段正确但 hash 校验失败的 State 虽然不会成为权威快照，仍可能影响后续远端输入预测。

更稳妥的顺序是：解码与长度检查 → 来源和对局身份检查 → 重建完整快照并验证 hash → 接受新的权威 tick → 更新远端预测派生数据 → restore/replay。派生缓存也属于可观察状态，不能因为它“不直接写 World”就绕过消息完整性边界。

## 11. 常见误区

### 11.1 误区：收到 State 就把玩家位置 lerp 过去

只平滑坐标没有恢复 HP、动作、弹道和冷却，也没有重放后续输入。正确做法是模拟层 restore/replay，渲染层另做视觉平滑。

### 11.2 误区：State 能解码，说明就可以应用

解码只验证字节格式。还要检查来源、session、match、player、tick 新旧和 state hash，才能避免旧局或损坏消息污染当前世界。

### 11.3 误区：远端预测越复杂，越接近权威

状态无法唯一反推出输入。复杂预测可能降低平均视觉误差，也可能在动作突变时错得更久。预测必须保持便宜、可重放，并始终服从下一份权威状态。

### 11.4 误区：rollbackCount 为 0 就没有发生校正

当前计数只记录本地玩家的显著差异，每个有效新 State 仍会 rebase/replay。应联合查看 State 到达、replay cost 和 hash 指标。

### 11.5 误区：直接使用真实帧耗时能让移动更平滑

可变 `dt` 会让不同机器得到不同模拟轨迹，也使 replay 难以复现。模拟使用固定 `dt`，渲染再根据 accumulator 做插值，职责不能混淆。

## 12. 什么时候适合使用这种客户端结构？

它适合本地输入必须立即反馈、服务端保持最终权威、模拟可以快速回放、可保存有限输入/状态历史的小规模实时竞技游戏。

如果世界状态巨大、一步模拟非常昂贵、外部副作用不可回滚，或者玩法允许玩家看到略旧但平滑的远端状态，客户端插值加服务端权威可能更合适。回滚客户端不是所有联网游戏的默认答案。

## 13. 总结：客户端不是状态副本，而是一台可重演的预测机

权威状态晚到并不可怕，真正危险的是客户端没有足够上下文解释它。可靠的预测客户端需要同时做到：

1. 用 session、match、player 和 tick 拒绝错误上下文与乱序旧包。
2. 保存本地输入历史和预测状态历史，明确每个 Snapshot 的 tick 语义。
3. 从权威状态恢复，并只重放它之后、当前 tick 之前的输入。
4. 把远端输入当成可被纠正的预测，不把它误认为事实。
5. 区分 rollback 统计、权威 rebase 和视觉平滑，分别处理模拟正确性与画面体验。

最直接的实践建议是给客户端增加一个确定性测试：先预测 N 帧，注入较旧但有效的权威快照，再乱序注入更旧快照；断言前者重放后收敛、后者完全不改变世界。这个测试比盯着两个游戏窗口观察“好像没抖”更能守住回滚边界。

## 14. 当前源码阅读入口

以下路径相对于 `Fighting` 项目根目录：

- `apps/client_main.cpp`：`ClientCtx`、`OnTick`、`OnUdp`、`ApplyStart`、`ApplyAuthoritativeState` 和 `RestoreAndReplay`；
- `src/app/InputPrediction.cpp`：根据权威状态估计远端移动意图；
- `src/app/ClientRender.cpp`：SDL 渲染和网络统计 HUD；
- `include/lab/sim/InputBuffer.h`、`src/sim/InputBuffer.cpp`：本地与远端输入环形历史；
- `include/lab/sim/StateHistory.h`：预测/权威快照历史；
- `include/lab/net/Packets.h`、`src/net/NetCode.cpp`：Start、Reset、Ack、State 与 Input 协议；
- `tests/network_integration_tests.cpp`：真实 UDP loopback 集成验证。
