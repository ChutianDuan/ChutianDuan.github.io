---
title: "按键必须等服务器确认吗？从一次预测错误讲清 Rollback Netcode"
date: 2026-07-13 17:09:40
updated: 2026-07-13 17:09:40
categories:
  - "学习"
  - "实时竞技游戏开发"
permalink: /notes/实时竞技游戏开发/fighting-netcode-项目知识笔记/
series: "实时竞技游戏开发"
---

假设玩家按下向右键，网络往返时延（round-trip time，RTT）是 100 ms。如果客户端必须等服务器确认后才移动，操作流程会变成：

```text
按键 ──50 ms──> 服务器处理 ──50 ms──> 客户端显示
```

画面至少晚 100 ms 才响应。对回合制游戏或许还能接受，对需要闪避、瞄准和碰撞判定的实时动作游戏，这种延迟会让角色像被一根橡皮筋拽住。

直觉上的另一个方案是“客户端按下就直接修改位置”。手感变好了，却把最终位置交给了客户端：丢包、预测错误乃至作弊都可能让不同机器看到不同世界。

`Fighting` 项目选择第三条路：客户端立即预测，服务端独立计算权威状态，客户端收到权威快照后恢复并重放尚未确认的输入。这就是回滚网络同步（rollback netcode）的核心。本文不把它拆成一串名词，而是从一次故意制造的预测错误开始，解释 tick、输入历史、状态快照、权威校正和 UDP 协议怎样组成闭环。

本文对应当前 `Fighting` 项目源码，使用 **C++20、CMake 3.20+、UDP、libevent、SDL2/SDL2_ttf**。协议与内部结构不是稳定 API，具体常量应以当前源码为准。

## 1. 为什么“只同步角色坐标”解决不了问题？

设客户端每帧把自己的坐标发给服务端：

```cpp
// 存在设计隐患：客户端提交的是结果，而不是操作意图。
struct MovePacket {
    float x;
    float y;
};
```

这段结构很小，但有三个根本问题。

第一，服务端不知道玩家如何到达该坐标，无法可靠验证速度、碰撞和技能规则。第二，UDP 包可能延迟或乱序，晚到的旧坐标可能覆盖新坐标。第三，客户端和服务端各自计算碰撞时，即使最终只差几厘米，后续子弹命中和生命值也可能沿着不同分支继续发展。

Rollback Netcode 更关心两类数据：

```text
InputCmd：玩家在逻辑帧 t 想做什么
Snapshot：世界完成某段模拟后处于什么状态
```

客户端提交“向右、开火”这样的意图，服务端负责计算最终坐标、碰撞和伤害。输入带逻辑帧编号（tick），快照也带 tick，于是迟到的消息不再只能依赖到达顺序解释。

当前项目中的输入结构是：

```cpp
using Tick = std::uint32_t;

struct InputCmd {
    Tick tick = 0;
    std::uint16_t buttons = 0;
    std::int8_t moveX = 0;
    std::int8_t moveY = 0;
};
```

它描述输入意图，不携带最终位置、HP、碰撞结果，也不保存指针、窗口事件或真实时间戳。这样的命令才能被网络发送、按 tick 缓存并在回滚后重放。

## 2. Tick 为什么是整条链路的坐标系？

项目以 60 Hz 固定逻辑帧推进，逻辑步长为：

```text
dt = 1 / 60 秒
```

这里的 tick 不是当前墙上时钟，也不是渲染帧编号，而是模拟事件的离散序号：

```text
tick 120：消费双方第 120 帧输入
           ↓
        World::Step
           ↓
生成可与 tick 120 对应的权威状态
```

统一 tick 后，系统才能准确回答：

- 这个输入属于哪一次模拟？
- 服务端已经处理到哪里？
- 权威快照纠正的是哪段历史？
- 客户端应从哪个位置开始重放？
- 环形缓冲中的槽位是否已经被新帧覆盖？

渲染帧率可以是 75、120 或 144 FPS，网络包也可能忽快忽慢，但模拟仍按固定 `dt` 前进。真实时间负责决定“现在应该推进几个 tick”，不能直接成为物理计算的可变步长。

一个常见的 fixed timestep 累加器可以表示为：

```cpp
constexpr double dt = 1.0 / 60.0;
constexpr double maxFrame = 0.25;

double accumulator = 0.0;
double previous = nowSeconds();

while (running) {
    const double current = nowSeconds();
    accumulator += std::min(current - previous, maxFrame);
    previous = current;

    while (accumulator >= dt) {
        sampleInputForCurrentTick();
        stepWorld(dt);
        accumulator -= dt;
    }

    render();
}
```

`maxFrame` 用来限制窗口暂停或断点调试后突然积累的真实时间。它只能防止一次补进过多时间，实际工程通常还会限制单轮最多追赶多少 tick，否则“追帧”本身可能让主循环持续落后。

这段代码展示的是循环骨架，不是本文的独立示例；其中 `nowSeconds`、输入和渲染函数需要由具体平台实现。

## 3. 最小可运行版本：预测错了一帧，怎样回到正确历史？

下面用一个一维世界复现核心过程。客户端预测 5 帧都向右；服务端在 tick 2 没收到输入，按空输入推进。客户端随后收到服务端在 tick 3 的快照，恢复到权威位置，再重放 tick 3、4 的本地输入。

示例故意省略 UDP、渲染和多玩家，只验证回滚成立所需的最小条件：固定 tick、确定性 `Step`、输入历史与权威快照。

```cpp
#include <cassert>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <vector>

using Tick = std::uint32_t;

struct InputCmd {
    Tick tick = 0;
    int axis = 0;  // -1、0、1
};

struct Snapshot {
    Tick nextTick = 0;  // 该快照下一次应消费的输入 tick
    int position = 0;
};

class World {
public:
    void Step(const InputCmd& input) {
        if (input.tick != state_.nextTick) {
            throw std::logic_error("input tick does not match world tick");
        }
        state_.position += input.axis;
        ++state_.nextTick;
    }

    [[nodiscard]] Snapshot Save() const {
        return state_;
    }

    void Restore(const Snapshot& snapshot) {
        state_ = snapshot;
    }

private:
    Snapshot state_{};
};

int main() {
    const std::vector<InputCmd> localHistory{
        {0, 1}, {1, 1}, {2, 1}, {3, 1}, {4, 1}
    };

    World client;
    for (const InputCmd& input : localHistory) {
        client.Step(input);  // 不等待网络，立即预测
    }
    const int predictedBeforeCorrection = client.Save().position;

    World server;
    server.Step(localHistory[0]);
    server.Step(localHistory[1]);
    server.Step({2, 0});  // tick 2 输入丢失，权威端使用空输入
    const Snapshot authoritative = server.Save();

    client.Restore(authoritative);
    for (Tick tick = authoritative.nextTick;
         tick < localHistory.size();
         ++tick) {
        client.Step(localHistory[tick]);
    }

    // 服务端稍后也收到了 tick 3、4 的输入。
    server.Step(localHistory[3]);
    server.Step(localHistory[4]);

    std::cout << "predicted_before=" << predictedBeforeCorrection << '\n'
              << "authoritative_at_tick_3=" << authoritative.position << '\n'
              << "corrected_after_replay=" << client.Save().position << '\n';

    assert(client.Save().nextTick == server.Save().nextTick);
    assert(client.Save().position == server.Save().position);
}
```

在 macOS 或 Linux 上使用 Clang 编译：

```bash
clang++ -std=c++20 -O2 -Wall -Wextra -Wpedantic \
  rollback_demo.cpp -o rollback_demo
./rollback_demo
```

预期输出：

```text
predicted_before=5
authoritative_at_tick_3=2
corrected_after_replay=4
```

最终位置从 5 变成 4，不是把角色简单“拉回 tick 3 的位置 2”后停住，而是在权威历史上重新应用仍然有效的 tick 3、4 输入。这一步就是 replay。

## 4. 这次回滚的数据是怎样流动的？

最小示例可以画成一条时间线：

```text
输入 tick        0      1      2      3      4
客户端预测位置    1      2      3      4      5
服务端权威位置    1      2      2      3      4
                              ↑
                     tick 2 使用了空输入

客户端收到 tick 3 快照：position = 2, nextTick = 3
              Restore ──> 重放输入 3、4 ──> position = 4
```

其中有四个不能缺少的约束。

### 4.1 `Step` 必须只由确定状态和本帧输入决定

`World::Step` 可以修改 `World`，所以它不是数学意义上的纯函数。更准确的要求是：给定相同起始快照、相同输入序列和相同固定 `dt`，它应产生相同结果。

如果 `Step` 内部读取 `std::chrono::now()`、无种子的随机数、窗口事件或异步任务完成顺序，重放就可能得到另一条历史。

### 4.2 Snapshot 必须足够恢复未来

快照不只是“拿来画画的数据”。凡是会影响后续模拟的状态都必须保存，例如：

- 玩家位置、速度、HP、动作状态与计时器；
- 子弹位置、速度、寿命与所属玩家；
- 开火冷却和最近瞄准方向；
- 迷宫布局或能够唯一确定布局的数据；
- 与快照语义一致的 tick。

漏掉 `shotCooldown` 可能不会立刻改变当前画面，却会让重放后的下一次开火时间不同。这类 bug 最难排查，因为恢复当下看起来正确，几帧后才开始分叉。

### 4.3 输入历史必须覆盖回滚窗口

客户端需要保存从权威快照之后到本地当前 tick 的输入。项目使用按 tick 索引的环形缓冲：

```text
index = tick % capacity
```

环形槽位会复用，所以读取时必须同时验证槽位中保存的真实 tick：

```cpp
const std::size_t index = tick % capacity;
if (!slots[index].valid || slots[index].command.tick != tick) {
    return std::nullopt;
}
return slots[index].command;
```

如果只比较下标，tick 10 和 tick 4106 在容量 4096 的缓冲中会命中同一槽位，旧输入就可能冒充新输入。

### 4.4 权威状态必须带身份和时间边界

真实 UDP 包不能只带一个快照。当前项目使用 `playerId + sessionId + matchId` 区分玩家、连接会话和比赛，并拒绝旧 tick 的 State。否则上一局延迟到达的包可能覆盖新一局状态。

## 5. Fighting 项目如何把最小模型扩展成完整链路？

项目按模拟、网络和应用三层组织：

| 层 | 当前目录 | 主要责任 |
| --- | --- | --- |
| 模拟层 | `include/lab/sim`、`src/sim` | `World::Step`、快照、输入/状态历史、hash |
| 网络层 | `include/lab/net`、`src/net` | 非阻塞 UDP、v5 协议包、逐字段编解码 |
| 应用/服务层 | `apps`、`include/lab/app`、`src/app`、`src/server` | 固定帧循环、握手、预测、权威推进、回滚与渲染 |

这个边界让 `lab_stress` 可以绕过 SDL 窗口和真实 socket，直接验证同步核心；真实 UDP 则由单独的 loopback 集成测试覆盖。

### 5.1 服务端：只接受输入，独立推进权威世界

`AuthoritativeServer::AdvanceOneTick` 每帧为每个玩家取当前 tick 输入。收到输入就使用；缺失时最多 Hold Last Input 6 tick，之后退回空输入。然后服务端以固定 `1/60` 秒推进 `World`，计算状态 hash，每帧发送 ACK、每 2 tick 发送 State。

```text
InputPacket
    ↓ 身份、tick 窗口、方向、按钮掩码等校验
InputBuffer
    ↓ 当前 tick 输入 / Hold Last / Default
World::Step(commands, 1/60)
    ↓
Snapshot + stateHash
    ├── Ack（每 tick）
    └── State（每 2 tick）
```

Hold Last 只是缺包时的短期策略，不等于可靠传输。持续按住方向时它能减少突然停顿；如果丢失的是“松开按键”，继续 Hold 反而会让角色多移动几帧。因此窗口必须有限，最终仍依赖权威状态校正。

### 5.2 客户端：先预测，再接受权威重建历史

客户端每 tick 采样本地输入，保存到 `localHist`，预测远端玩家输入，然后调用同一套 `World::Step` 推进 `worldPred`。

收到新的 State 后，当前实现会：

1. 校验 `sessionId`、`matchId`、`playerId` 和 tick 新旧关系；
2. 将网络中的毫米整数状态还原为 `WorldSnapshot`；
3. 重新计算 hash，拒绝损坏或不一致的 State；
4. 比较本地玩家状态，决定是否增加 rollback 统计；
5. 把权威快照写入历史；
6. 从权威快照恢复，并重放到本地当前 tick。

第 4、6 步容易混淆。当前代码只用本地玩家的显著差异增加 `rollbackCount`，避免远端预测误差让计数频繁跳动；但每个通过校验的新权威 State 都会执行 rebase/replay，让远端玩家、弹道等状态及时回到权威历史。统计口径不等于是否应用权威状态。

### 5.3 ACK 和 State 解决的不是同一个问题

| 消息 | 主要内容 | 解决的问题 |
| --- | --- | --- |
| ACK | 服务端处理 tick、最新输入 tick、输入序号和收包统计、hash | 进度与网络观测 |
| State | 可恢复的玩家/弹道权威状态、tick、hash | 校正与重放起点 |

只有 ACK 而没有可恢复状态，客户端知道自己错了也无法重建；只发 State 而没有进度统计，也能实现校正，但更难估算 RTT、丢包和 input lead。

当前 `clientAckServerTick` 字段仍标注为后续用途预留，不能把“字段存在”误写成已经完成了基于该字段的可靠确认协议。

## 6. UDP 不可靠，输入为什么还敢只发一次？

项目实际上不会只发一次。每个 `InputPacket` 携带最近 4 帧输入：

```text
packet N:     [100, 101, 102, 103]
packet N + 1: [101, 102, 103, 104]
packet N + 2: [102, 103, 104, 105]
```

如果第一个包丢失，后续包仍可能补回 101～103。服务端按 tick 写入 `InputBuffer`，相同 tick 重复到达只会覆盖同一逻辑位置，因此冗余发送容易保持幂等。

但冗余不是可靠性的数学保证。连续多个包丢失、网络延迟超过历史窗口或包在服务端处理对应 tick 后才到达，输入仍可能错过权威推进。系统之所以还能收敛，是因为服务端状态始终权威，客户端会通过后续 State 纠正。

当前二进制协议还包含：

- `magic`：快速拒绝不属于本协议的数据；
- `version`：当前源码为 v5，用于拒绝不兼容布局；
- `type`：区分 Input、Ack、State、Start 和 Reset；
- `sessionId`、`matchId`、`playerId`：隔离会话和对局；
- `seq`、`newestTick`：观察包进度并验证输入集合。

不要直接把包含 `std::vector` 的 C++ 结构体内存发送出去。真实实现需要明确字段宽度、字节序、长度上限和解码失败路径；当前项目在 `NetCode.cpp` 中逐字段编解码，只对固定头部使用紧凑布局。

## 7. 状态 hash 能保证两端完全确定吗？

不能。Hash 是分叉探测器，不是确定性制造器。

当前 `Hasher` 会把玩家和弹道的浮点位置量化为毫米整数，再按固定字节顺序混合，同时覆盖 tick、动作状态、冷却、瞄准、迷宫等确定性字段。量化能避免“网络只传毫米整数，但本地保留更多浮点尾数”造成无意义 mismatch。

```text
float position
      ↓ round(position × 1000)
int32 millimeters
      ↓ stable byte mixing
uint64 stateHash
```

它的边界同样重要：

- 两个不同状态可能发生 hash 碰撞，只是 64 位良好 hash 下概率通常很低；
- 没有进入 hash 的字段即使分叉也检测不到；
- 量化到同一毫米的两个浮点值会得到相同 hash；
- 不同 CPU、编译器或浮点模式仍可能让模拟先分叉，hash 只能报告结果；
- 如果双方同时实现了同一个错误，hash 仍会一致。

因此，当前设计适合同工具链和受控环境下的 Demo 与诊断。若要承诺严格跨平台确定性，还需要逐项审计浮点、随机数、容器迭代顺序、物理碰撞和编译选项，必要时使用定点数或经过验证的确定性数学实现。

## 8. 为什么不能只在差异明显时才恢复权威快照？

假设本地玩家位置与权威只差 1 cm，低于画面抖动阈值，但远端子弹的生命周期已经不同。如果客户端因为“我的角色看起来没差”而完全跳过权威状态，子弹差异可能继续影响下一帧命中。

所以需要区分两件事：

```text
是否把这次校正记为一次明显 rollback？
是否以新的权威快照为基线继续模拟？
```

当前项目的答案是：前者只观察本地玩家的较大位置误差、HP、动作和落地状态；后者对每个有效的新 State 都执行。这样 HUD 的 rollback 数量更接近玩家可感知的纠正，同时模拟基线仍持续接受权威状态。

代价是每次 State 都可能重放若干 tick。工程上必须监控 `replayTicks` 和 `replayCostMs`，并根据状态发送频率、网络延迟和历史容量寻找平衡。不能只追求“回滚次数为零”，因为零可能只是统计阈值太宽，或权威状态根本没有正确应用。

## 9. 从 Demo 走向工程实现，最容易踩哪些坑？

### 9.1 新增状态字段只改一处

新增技能冷却时，只给 `PlayerState` 加字段不够。至少要沿着这条链检查：

```text
World 状态与 Step
    ↓
WorldSnapshot / Restore
    ↓
StatePacket 编解码
    ↓
Hasher
    ↓
回滚与集成测试
```

漏掉任何一环，都可能出现“正常向前运行没问题，一回滚就分叉”。

### 9.2 把显示平滑混进权威模拟

权威状态校正可能让渲染位置跳变。可以在渲染层做插值或视觉误差衰减，但模拟层必须立即回到权威基线。若为了画面平滑而慢慢修改 `World` 的碰撞位置，接下来的游戏规则仍在错误状态上运行。

### 9.3 历史容量小于最坏网络窗口

历史容量至少要覆盖可能收到的 State 延迟、重放长度和一定安全余量。容量过小后，输入槽位已被覆盖，客户端无法完整 replay。容量越大则快照内存和复制成本越高，应结合最大玩家/弹道数实测，而不是盲目设成无限。

### 9.4 Tick 回绕仍用普通大小比较

`Tick` 是 `uint32_t`，长期运行会回绕。直接使用 `incoming > current` 在回绕附近会失效。项目已有基于有符号差值的先后判断，新增网络逻辑时也要复用一致的序号比较规则，并限制可接受窗口小于半个序号空间。

### 9.5 把 Hold Last 当作万能预测

Hold Last 对连续移动有效，对松键、瞬时闪避和攻击边沿可能很差。更复杂的预测可以利用动作状态，但预测越聪明不代表权威越少；所有预测最终仍必须可被快照纠正。

### 9.6 在网络回调里执行长时间工作

项目由 libevent 驱动 UDP 收发与 tick 定时。回调里若执行阻塞磁盘 IO、大量日志或长时间重放，会拖延后续包和 tick。应记录必要数据，把可延后的工作移出延迟敏感路径，并对 replay 成本设置观测指标。

## 10. 应该怎样验证回滚真的正确？

只启动两个窗口“玩起来没问题”不够，因为正常局域网很难稳定复现乱序、延迟和预测错误。当前 CMake 定义了分层测试目标：

| 目标 | 验证重点 |
| --- | --- |
| `lab_tests` | codec、hash、环形缓冲等基础行为 |
| `lab_stress` | 延迟 State、预测错误、大量 restore/replay |
| `lab_network_integration` | 真实 UDP loopback 下的握手、输入、Ack/State 与最终 hash |
| `lab_performance` | 标准性能场景和结果输出 |

项目完整构建依赖 libevent；构建图形客户端还需要 SDL2 和 SDL2_ttf。依赖已准备好时，可在项目根目录执行：

```bash
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure \
  -E lab_performance_standard
```

性能套件在 CMake 中配置了更长超时，不属于默认的短时验证。测试或改动笔记时不要用一次性能运行宣称稳定；应使用 Release 构建、固定输入种子、重复运行，并分别记录回滚次数、重放 tick、重放耗时、网络字节和 hash mismatch。

对同步系统最有价值的断言不是“画面差不多”，而是：

```text
同一权威快照 + 同一后续输入日志
                ↓ replay
应得到与权威历史一致的可量化状态和 hash
```

## 11. 什么时候适合使用 Rollback Netcode？

它适合这些场景：输入频繁、玩家强烈期待即时反馈、核心模拟能够快速重放、状态规模可以保存、短时间预测错误允许被视觉修正。格斗、动作和小规模竞技游戏通常符合这些条件。

以下场景需要谨慎：模拟包含大量不可逆外部副作用；一次 tick 成本很高，无法在帧预算内重放；世界规模巨大，快照与历史不可承受；跨平台浮点行为难以约束；玩法更适合插值展示远端权威状态而不是预测全部世界。

Rollback 也不替代安全校验。服务端权威只能说明最终规则由服务器计算，输入频率、速度、按钮掩码、会话身份和资源消耗仍需验证；反作弊更是独立课题。

## 12. 总结：低延迟手感来自“先预测，再证明”

回到开头，按键不必等待服务器往返，因为客户端可以立即用本地输入预测。但预测之所以不会变成“各玩各的”，依靠的是一条完整闭环：

1. 固定 tick 为输入、状态和网络消息提供统一时间坐标。
2. 客户端发送操作意图并保存输入历史，服务端独立推进权威世界。
3. Snapshot 必须包含所有影响未来的状态，`Step` 必须可确定地重放。
4. 客户端从权威快照恢复，再重放尚未确认的输入，而不是只修补一个坐标。
5. UDP 冗余、身份字段和 hash 提高抗丢包与诊断能力，但都不能替代权威校正和确定性设计。

最直接的实践建议是：每新增一个会影响模拟的字段，都执行一次“状态闭环检查”——确认它进入 Step、Snapshot、Restore、网络包、hash 和回滚测试。Rollback Netcode 最危险的 bug，往往不是某一帧算错，而是某个状态只走完了半条链路。

## 13. 当前项目阅读入口

以下路径均相对于 `Fighting` 项目根目录：

- `README.md`：构建方式、目标程序和项目边界；
- `include/lab/sim/InputCmd.h`：输入命令与 Tick；
- `include/lab/sim/StateSnapshot.h`：玩家、弹道与世界快照；
- `src/sim/World.cpp`：确定性模拟的主要推进逻辑；
- `src/sim/InputBuffer.cpp`、`include/lab/sim/StateHistory.h`：输入与状态环形历史；
- `src/sim/Hasher.cpp`：毫米量化与状态 hash；
- `include/lab/net/Packets.h`、`src/net/NetCode.cpp`：v5 包定义和编解码；
- `src/server/AuthoritativeServer.cpp`：权威输入选择、推进与 Ack/State；
- `apps/client_main.cpp`：本地预测、State 校验和 `RestoreAndReplay`；
- `tests/stress_tests.cpp`、`tests/network_integration_tests.cpp`：离线回滚压力与真实 UDP 集成验证。
