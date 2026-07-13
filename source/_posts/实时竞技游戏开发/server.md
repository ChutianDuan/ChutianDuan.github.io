---
title: "玩家输入没按时到，权威服务器应该等吗？从 Hold Last 到固定 Tick 推进"
date: 2026-07-13 17:17:55
updated: 2026-07-13 17:17:55
categories:
  - "学习"
  - "实时竞技游戏开发"
permalink: /notes/实时竞技游戏开发/server/
series: "实时竞技游戏开发"
---

服务端准备推进 tick 500，但玩家 2 的输入包还没到。此时有三种直觉选择：

```text
一直等：输入最完整，但一个玩家的网络抖动会卡住整局
立即空输入：服务端不停，但角色可能在一次丢包后突然刹车
沿用上一帧：短暂丢包更平滑，但“松开按键”丢失时会多走几帧
```

实时权威服务器通常不能无限等待。它必须按固定节奏给每个玩家选出一个本 tick 命令，推进唯一权威世界，再让客户端通过 State 校正预测误差。`Fighting` 的当前策略是：优先使用精确 tick 输入；缺失时最多沿用最近实际执行输入 6 tick；再缺失就使用空输入。

这个选择看起来只是一个 `if`，实际上连接着输入校验、环形缓冲、固定帧、UDP 冗余、客户端回滚和断线重置。本文以当前 `AuthoritativeServer` 实现为依据，解释服务端为何不能等待、不能盲信，也不能让 Hold Last 无限持续。

项目使用 **C++20、CMake 3.20+、UDP 和 libevent**。文中的人数、窗口和发包频率属于当前版本实现，不是 Rollback Netcode 的固定标准。

## 1. “服务端权威”到底意味着相信什么？

权威服务器（authoritative server）并不等于“客户端发什么都照做”。客户端只提交操作意图：

```cpp
struct InputCmd {
    Tick tick;
    std::uint16_t buttons;
    std::int8_t moveX;
    std::int8_t moveY;
};
```

最终位置、碰撞、生命值、攻击命中和子弹状态全部由服务端的 `World::Step` 计算。客户端若直接上传 `x = 1000` 或 `hp = 9999`，协议根本不应把这些结果当成输入。

但“只接收输入”也不代表输入天然可信。服务端仍需验证：

- session、match 和 player 是否属于当前连接；
- tick 是否落在允许的过去/未来窗口；
- 命令数量与包头声明是否一致；
- `moveX/moveY` 是否为 `-1/0/1`；
- buttons 是否只包含已定义位；
- 单连接发包速率是否超过限制。

权威性的准确含义是：服务端决定哪些输入有效，并由自己的状态机计算最终结果。

## 2. 为什么不能等到所有输入都到齐再推进？

如果每 tick 都等待最慢玩家，服务端帧率就不再由 60 Hz 定时器决定，而由最差网络决定：

```text
tick 500: P1 ✓  P2 ✓  → 推进
tick 501: P1 ✓  P2 …  → 全局停住
tick 502: 无法开始
```

这种 lockstep（锁步）可以配合输入延迟、超时和严格同步策略使用，但它会把网络抖动直接转化为所有玩家的停顿。`Fighting` 选择持续权威推进，把缺输入解释成一种明确策略，再由客户端预测与回滚隐藏大部分延迟。

每个服务端 tick 都必须为所有玩家构造同一 tick 的命令数组：

```text
玩家 1：Exact / Hold Last / Default
玩家 2：Exact / Hold Last / Default
                ↓
        World::Step(commands, 1/60)
```

只要策略是确定的，同一权威输入序列就能产生同一权威历史。客户端可能预测不同，但没有权力改写已经推进的服务端世界。

## 3. 最小可运行版本：输入丢失后，何时停止 Hold？

下面实现一个只有一名玩家的一维权威服务器。为了让输出简短，示例将 Hold 窗口设为 2 tick；`Fighting` 当前源码使用 6 tick。

程序还会提交一个过度超前的 tick 和非法方向，验证它们在进入环形缓冲前被拒绝。

```cpp
#include <cassert>
#include <cstdint>
#include <iostream>
#include <optional>
#include <string_view>
#include <vector>

using Tick = std::uint32_t;

struct InputCmd {
    Tick tick = 0;
    int axis = 0;
};

class InputBuffer {
public:
    explicit InputBuffer(std::size_t capacity)
        : slots_(capacity == 0 ? 1 : capacity) {}

    void Put(const InputCmd& input) {
        slots_[input.tick % slots_.size()] = input;
    }

    [[nodiscard]] std::optional<InputCmd> Get(Tick tick) const {
        const auto& slot = slots_[tick % slots_.size()];
        if (!slot || slot->tick != tick) {
            return std::nullopt;
        }
        return slot;
    }

private:
    std::vector<std::optional<InputCmd>> slots_;
};

enum class InputSource { Exact, HoldLast, Default };

std::string_view Name(InputSource source) {
    switch (source) {
        case InputSource::Exact: return "exact";
        case InputSource::HoldLast: return "hold";
        case InputSource::Default: return "default";
    }
    return "unknown";
}

struct SelectedInput {
    InputCmd command{};
    InputSource source = InputSource::Default;
};

class AuthoritativeServer {
public:
    bool Submit(const InputCmd& input) {
        constexpr std::int32_t pastWindow = 2;
        constexpr std::int32_t maxLead = 3;
        const auto distance = static_cast<std::int32_t>(input.tick - tick_);

        if (distance < -pastWindow || distance > maxLead) {
            return false;
        }
        if (input.axis < -1 || input.axis > 1) {
            return false;
        }
        inputs_.Put(input);
        return true;
    }

    SelectedInput AdvanceOneTick() {
        const SelectedInput selected = SelectInput();
        position_ += selected.command.axis;
        ++tick_;
        return selected;
    }

    [[nodiscard]] int Position() const { return position_; }

private:
    SelectedInput SelectInput() {
        constexpr Tick holdTicks = 2;

        if (const auto exact = inputs_.Get(tick_)) {
            lastApplied_ = *exact;
            lastAppliedTick_ = tick_;
            return {*exact, InputSource::Exact};
        }
        if (lastApplied_ && tick_ - lastAppliedTick_ <= holdTicks) {
            InputCmd held = *lastApplied_;
            held.tick = tick_;
            return {held, InputSource::HoldLast};
        }
        return {{tick_, 0}, InputSource::Default};
    }

    Tick tick_ = 0;
    int position_ = 0;
    InputBuffer inputs_{16};
    std::optional<InputCmd> lastApplied_;
    Tick lastAppliedTick_ = 0;
};

int main() {
    AuthoritativeServer server;

    assert(!server.Submit({100, 1}));  // 超出未来窗口
    assert(!server.Submit({0, 2}));    // 非法方向
    assert(server.Submit({0, 1}));

    for (int i = 0; i < 4; ++i) {
        const SelectedInput selected = server.AdvanceOneTick();
        std::cout << "tick=" << selected.command.tick
                  << " source=" << Name(selected.source)
                  << " position=" << server.Position() << '\n';
    }

    assert(server.Position() == 3);
}
```

在 macOS 或 Linux 上使用 Clang 编译：

```bash
clang++ -std=c++20 -O2 -Wall -Wextra -Wpedantic \
  authoritative_server.cpp -o authoritative_server
./authoritative_server
```

预期输出：

```text
tick=0 source=exact position=1
tick=1 source=hold position=2
tick=2 source=hold position=3
tick=3 source=default position=3
```

tick 1、2 沿用 tick 0 的向右输入；到 tick 3，距离最近一次**实际收到并应用**的输入已经超过窗口，服务端切换为空输入。Hold 得到的派生命令不会刷新 `lastAppliedTick`，否则每次 Hold 都会延长下一次 Hold，窗口将永远不会结束。

## 4. 输入选择为什么必须基于“最后精确输入”？

当前项目的 `GetCmdForTick` 只有在 `inputBuf.Get(tick)` 精确命中时才更新：

```text
lastApplied
lastAppliedTick
hasLastApplied
```

缺失帧生成的 held 命令只把 tick 改成当前值，不会写回 `lastAppliedTick`。因此 6 tick 窗口是相对于最后一次真实应用输入计算，而不是相对于上一次合成 Hold 计算。

这还解释了为什么不能简单使用“收到的最大 tick 输入”。客户端可能提前上传未来几帧，服务端当前 tick 缺失时，不能拿未来命令倒填现在；未来输入只能等到自己的 tick 被消费。

Hold Last 的优缺点与输入类型有关：

| 丢失的输入 | Hold Last 的效果 |
| --- | --- |
| 持续按住方向 | 通常比立即停下更自然 |
| 松开方向 | 可能多移动几帧 |
| 单帧攻击边沿 | 可能漏掉攻击，或错误延续按钮状态 |
| 断线 | 有限窗口后必须归零 |

因此它只是短时缺包策略，不是可靠输入协议。不同游戏甚至可能需要对“连续状态”和“单次边沿事件”采用不同缺失策略。

## 5. 输入为什么必须先校验，再写环形缓冲？

环形缓冲使用：

```text
index = tick % capacity
```

一个恶意或损坏的超远 tick 可以与正常 tick 落入同一槽位。如果先 `Put` 再检查窗口，它可能覆盖即将使用的合法输入。当前 `ValidateGameplayInput` 会在遍历全部命令并确认整个包有效后，才把命令写入各连接的 `InputBuffer`。

当前校验边界为：

| 项目 | 当前值 |
| --- | ---: |
| 最旧可接收输入 | 相对服务端 tick 为 `-8` |
| 最大 input lead | 相对服务端 tick 为 `+12` |
| 单包最大命令数 | 8 |
| 每连接每秒最大包数 | 240 |
| moveX/moveY | `-1`、`0`、`1` |
| buttons | 仅定义的移动、跳跃、攻击位 |

这些数值是 Demo 的防御边界，不是完整安全方案。固定窗口计数器不能替代全局容量控制、IP/会话级限流、认证、带宽预算和 DDoS 防护。

还要注意：当前服务端**不做历史回滚**。处于过去窗口但已经错过权威推进的输入，即使因冗余包再次到达，也不会改写过去的 `World`；它可能进入缓冲，但对应 tick 不会再次被消费。过去窗口主要容纳网络冗余与边界抖动，不能理解成“服务端会补算迟到输入”。

## 6. ClientConn 为什么不能只用 UDP 地址标识？

当前 `ClientConn` 保存地址、随机 `sessionId`、玩家槽位、输入缓冲、最近应用输入、最后活跃时间、速率窗口和序号统计。

新客户端以空命令 Input 作为 hello：

```text
sessionId = 0 且 cmds 为空
          ↓
创建随机非零 sessionId
          ↓
分配空闲 player slot
```

后续包优先按 session 查找连接；服务端也保留按地址找回既有 hello 的路径。相比只用 `addr.Key()`，session 能更清楚地区分连接身份，并为地址变化留出空间。

当前实现会在包成功解码、关联到连接并通过速率限制后更新 `client.addr` 与 `lastHeardSec`，这一步发生在 gameplay 身份和命令字段验证之前。它允许客户端地址变化，但也意味着只要知道 sessionId，就可能用一个随后验证失败的包改变回复地址或延长连接存活。随机 session ID 仍不是完整身份认证：它提供难猜的会话标识，不自动提供加密、消息认证、密钥协商或防中间人能力。公网服务应先验证认证标签和对局字段，再提交地址迁移与活跃时间更新。

当前固定两个玩家槽位，第三个新会话在无法分配 slot 时会被移除。扩展多人不能只修改 `kMaxPlayers`，还要检查包内计数字段、World 玩家数量、State 带宽、客户端渲染和压力测试。

## 7. Start 为什么能重发，`kStartDelayTicks` 又是不是倒计时？

当在线人数达到 2，`MaybeStartMatch` 会递增 `matchId`，把服务端 tick 设置为 30，并立即标记 started，然后向双方发送 Start。

所以当前 `kStartDelayTicks = 30` 更准确地说是“本局起始 tick 编号偏移”，不是服务端等待半秒后才开始推进的墙钟倒计时。客户端收到 Start 后把自己的下一 tick 对齐到该编号。

Start 包包含：

- session、match、player 与总玩家数；
- `startTick`；
- 迷宫 seed、宽高和完整权威网格。

如果 Start 丢失，客户端继续发送空 hello；已开局服务端会再次返回该连接的 Start。这个流程依赖重复 Start 对客户端保持幂等，不能让同一个 match 的重发反复重置已经运行的客户端。

## 8. 一个权威 tick 从定时器走到网络经历了什么？

`apps/server_main.cpp` 只负责事件循环和 UDP 适配，核心对局状态在可测试的 `AuthoritativeServer` 中：

```text
libevent OnTick
    ↓ 累积真实 elapsed，单帧最多计入 0.25 秒
ExpireClients(now)
    ↓
while accumulator >= 1/60:
    AuthoritativeServer::AdvanceOneTick()
        ↓
    每个玩家 GetCmdForTick
        ↓
    World::Step(commands, 1/60)
        ↓
    Snapshot + Hasher::Hash
        ↓
    ACK 每 tick / State 每 2 tick
        ↓
    tick++
```

ACK 和 State 的职责不同：

| 包 | 频率 | 主要用途 |
| --- | --- | --- |
| ACK | 每 tick | 告知处理进度、最新输入 tick、seq 和收包统计、当前 hash |
| State | 每 2 tick | 提供可恢复的玩家/弹道权威快照与 hash |

State 为玩家和弹道使用毫米整数表示，减少带宽并让网络状态 hash 有稳定量化边界。完整迷宫在 Start 中发送，周期 State 只携带 maze seed；客户端必须保留同一局的权威网格才能还原完整快照。

`while` 追帧能在事件循环略有抖动时保持平均 60 Hz，但暂停过久后一次推进太多 tick 仍可能让循环持续饥饿。当前代码限制单次累计真实时间为 0.25 秒，却没有另设单回调最大推进 tick 数；生产环境应监控事件循环延迟，并决定是限制追帧、降级还是终止异常对局。

## 9. 玩家超时后，为什么要重置整局？

当前连接的 `lastHeardSec` 超过 10 秒没有更新就会过期。按照现有处理顺序，它表示“没有通过解码、连接关联和速率限制的 InputPacket”，不严格等于“没有合法 gameplay 输入”。若过期玩家属于正在运行的比赛，服务端会：

1. 清除其 player slot 与连接；
2. 向剩余玩家发送 Reset；
3. 停止当前比赛并把 tick 归零；
4. 重建权威 World 与迷宫；
5. 清空仍在线连接的输入、Hold 和序号统计；
6. 等待新玩家补位，再使用递增的 matchId 开局。

为什么不让剩余玩家继续？因为当前 Demo 的 World、协议和客户端都围绕固定两人对局设计。重置比临时改变玩家数更简单，也避免断线玩家残留输入或状态继续影响比赛。

Reset 同样走 UDP，可能丢失。服务端在未 started 状态收到旧场次 gameplay Input 时会回复 Reset，客户端继续发送旧输入也能再次获得回退信号。这是一种可重试状态机，而不是“发一次控制包就假设一定收到”。

## 10. 服务端实现最容易踩哪些坑？

### 10.1 把 `lastInputTick` 当成已应用进度

`lastInputTick` 是收到过的最大输入 tick；`lastAppliedTick` 是最近真正用于模拟的精确输入 tick。未来输入可以先收到但尚未执行，两者不能混用。ACK 需要分别表达处理进度和接收进度。

### 10.2 让 Hold 命令刷新 Hold 窗口

这样会形成无限 Hold，断线玩家永久移动。只有精确命中当前 tick 的真实输入才能更新基线。

### 10.3 把 ACK 当作权威快照

ACK 的 hash 可以帮助对账，但没有完整玩家、弹道等恢复数据。客户端知道 hash 不同后，仍需要 State 才能 restore/replay。

### 10.4 只校验 packet header，不校验业务字段

长度与 magic/version 正确不代表 move、buttons、身份和 tick 合法。网络解码与业务验证是两层边界。

### 10.5 只同步迷宫 seed

`std::shuffle` 和标准随机设施的结果不保证在所有标准库实现间形成跨平台协议。当前项目在 Start 中发送完整迷宫网格是更稳妥的权威做法，seed 主要用于标识和诊断。

### 10.6 认为服务端权威就不需要测试客户端异常

真正需要测试的正是重复、乱序、超前 tick、非法按钮、Start/Reset 丢失、超时补位和序号回绕。正常客户端路径不能证明服务器在异常输入下仍保持状态边界。

## 11. 怎样验证服务端策略而不是只验证“能启动”？

当前项目把权威逻辑从 `server_main.cpp` 抽成 `AuthoritativeServer`，使测试不必真的打开端口。基础测试可以直接构造数据报并检查返回的 `OutboundDatagram`；真实 socket 行为再交给 loopback 集成测试。

建议至少覆盖：

- 精确输入、连续缺失直到 Hold 窗口结束；
- 同 tick 冗余覆盖与环形槽位 tick 校验；
- 过去 `-8`、未来 `+12` 两侧的边界值和越界值；
- 非法 move、buttons、count 与 newestTick；
- 重复/乱序 seq 对统计的影响；
- Start 丢失后的 hello 重发；
- 运行中玩家超时、Reset 重试与新 matchId；
- tick 回绕附近的先后判断；
- 每 2 tick State 和每 tick ACK 的输出节奏。

项目依赖准备完成后，可在项目根目录构建并跳过长性能套件运行短测试：

```bash
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure \
  -E lab_performance_standard
```

完整性能结果不能用一次 Debug 运行下结论。应使用 Release 构建、固定输入、重复测量，并记录事件循环延迟、每 tick 模拟耗时、发包字节、输入缺失来源比例和 p95/p99。

## 12. 什么时候适合这种持续推进的权威服务器？

它适合实时动作游戏：服务端必须保持固定节奏，客户端能够预测和回滚，短时输入缺失允许用明确策略近似，最终由周期 State 收敛。

如果每一步都必须获得所有参与者的明确同意、模拟无法回滚或错误输入替代会造成不可接受结果，带输入延迟的 lockstep、回合制提交或其他一致性协议可能更合适。Hold Last 不是通用分布式共识算法，它只是实时游戏在帧预算内的一种体验取舍。

## 13. 总结：权威服务器的核心不是“永远正确收到输入”

服务端无法保证每个 UDP 输入按时到达，但可以保证缺失时如何决策、哪些输入有资格进入世界，以及权威历史只由一条受控路径产生：

1. 客户端提交意图，服务端验证身份、tick、数量和值域后才缓存。
2. 每个固定 tick 都选择 Exact、有限 Hold Last 或 Default，不无限等待玩家。
3. 只有精确输入更新 Hold 基线，迟到输入不会自动改写已经推进的权威历史。
4. `World::Step` 是唯一权威推进入口，ACK 报进度，State 提供客户端恢复基线。
5. session、match、Start 重发、超时 Reset 和测试共同构成对局生命周期。

最直接的实践建议是为输入选择器单独记录来源计数：Exact、Hold、Default 各出现多少次。只看总丢包率无法回答玩家为何发生校正，而这三个计数可以直接连接网络质量、Hold 窗口和客户端 rollback 行为。

## 14. 当前源码阅读入口

以下路径相对于 `Fighting` 项目根目录：

- `include/lab/server/AuthoritativeServer.h`：连接状态、校验窗口和服务端接口；
- `src/server/AuthoritativeServer.cpp`：slot/session、输入验证、Hold、推进、Start/Reset；
- `apps/server_main.cpp`：libevent、UDP 适配和 fixed timestep accumulator；
- `include/lab/sim/InputBuffer.h`、`src/sim/InputBuffer.cpp`：按 tick 存储输入；
- `src/sim/World.cpp`：权威世界推进；
- `include/lab/net/Packets.h`、`src/net/NetCode.cpp`：Input、Ack、State、Start、Reset 编解码；
- `tests/core_tests.cpp`：基础编解码、hash 和缓冲测试；
- `tests/network_integration_tests.cpp`：真实 UDP loopback 对局生命周期验证。
