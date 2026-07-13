---
title: "选错容器后，代码为什么既慢又容易悬空？STL 容器与迭代器实践"
date: 2026-07-13 09:55:18
updated: 2026-07-13 09:55:18
categories:
  - "学习"
  - "现代 C++ 实践"
permalink: /notes/现代c-实践/15-stl容器-迭代器与算法实践/
series: "现代 C++ 实践"
series_order: 15
---

时间：2026/05/04

游戏大厅保存在线玩家时，有人为了“中间删除是 O(1)”选择 `std::list`，又把元素地址保存到其他系统。实际运行中，遍历比预期慢，按 ID 查找仍是线性扫描，删除后外部指针还可能悬空。

另一个实现使用 `vector`，却在保存 `&players[0]` 后继续 `push_back`；一次扩容搬走全部元素，旧地址随即失效。容器 API 都没有写错，错误来自访问模式、复杂度和生命周期没有一起考虑。

本文不按 API 顺序罗列 STL，而是从“数据怎样访问、谁需要稳定引用、哪些操作让迭代器失效”出发，建立容器选择和算法使用的判断方式，并用一个完整玩家列表示例串起 `reserve`、`erase_if`、ranges 排序和二分查找。

---

## 1. 选择容器前应该先回答什么？

先描述操作，而不是先挑类型：

- 主要是顺序遍历、随机下标还是按 key 查询？
- 插入删除集中在尾部、两端，还是已知中间位置？
- 是否要求按 key 有序和范围查询？
- 元素地址/引用需要稳定多久？
- 数据规模和元素大小如何？
- 顺序是否属于对外可观察结果？

常见容器的起点可以这样看：

| 容器 | 主要优势 | 关键代价/边界 |
| --- | --- | --- |
| `vector` | 连续存储、遍历和随机访问高效 | 扩容搬迁；中间插删移动后续元素 |
| `deque` | 两端高效插删，并支持随机访问 | 整体不连续；失效规则较复杂 |
| `list` | 已有位置的插删不移动其他节点 | 每节点分配、缓存局部性差、不能随机访问 |
| `map` | key 有序，支持范围查询，O(log n) | 节点和指针开销 |
| `unordered_map` | 平均 O(1) key 查找 | 无序、桶开销、最坏情况与 hash 质量相关 |
| `set`/`unordered_set` | 唯一 key 集合 | 与对应 map 类似，但没有映射值 |

多数顺序数据默认从 `vector` 开始。即便它中间删除需要移动元素，连续内存带来的缓存优势也可能胜过链表；Big-O 只描述增长趋势，不包含分配、间接访问和缓存常数。

## 2. 为什么 `vector` 经常是默认起点？

`vector` 的元素连续排列，CPU 预取和缓存行利用通常较好，也能通过 `data()` 与需要连续数组的 API 交互。

知道大致数量时，`reserve` 可以减少扩容次数：

```cpp
std::vector<Player> players;
players.reserve(expected_count);
```

要区分两个接口：

- `reserve(n)` 至少预留容量，不改变 `size()`，不构造新元素；
- `resize(n)` 改变元素数量，必要时构造或销毁元素。

```cpp
players.reserve(100); // size 仍为 0，players[0] 仍然越界
players.resize(100);  // 现在有 100 个元素
```

`reserve` 不是越多越好。过度预留会提高内存峰值，也可能让大量小容器各自长期保留空间。它应该来自可解释的输入规模或测量。

## 3. 迭代器失效为什么也是所有权问题？

迭代器、元素指针和引用通常只是观察者，不拥有元素。容器操作改变存储后，观察者可能失效：

```cpp
std::vector<int> values{1, 2, 3};
int* first = &values[0];
values.push_back(4); // 若触发扩容，first 悬空
```

常见规则概览：

| 容器/操作 | 典型失效行为 |
| --- | --- |
| `vector` 重新分配 | 全部迭代器、指针和引用失效 |
| `vector` 未重分配的 insert/erase | 操作位置及其后的观察者失效 |
| `list` 插入 | 现有迭代器通常保持有效 |
| `list` 删除 | 仅被删除元素的观察者失效 |
| `map/set` 插入 | 现有迭代器通常保持有效 |
| `map/set` 删除 | 指向被删除元素的观察者失效 |
| `unordered_*` rehash | 迭代器失效；未删除元素的引用/指针通常仍有效 |

这是概览，不应替代对具体操作的标准文档检查，`deque` 等容器尤其需要逐项确认。

如果其他系统需要长期引用玩家，优先保存稳定 ID，再在使用时查询，而不是把 `vector` 元素地址当作永久句柄。需要稳定地址时，也可以让容器保存 `unique_ptr<T>`，但这增加分配和间接访问，应由真实需求驱动。

## 4. 一个可运行的玩家列表示例

下面的 C++20 示例先移除离线玩家，再按 ID 排序并二分查找，最后按分数排序展示。每一步都通过标准算法表达意图，没有跨结构修改保存迭代器。

```cpp
#include <algorithm>
#include <functional>
#include <iostream>
#include <ranges>
#include <string>
#include <vector>

struct Player {
    int id;
    std::string name;
    int score;
    bool online;
};

int main() {
    std::vector<Player> players;
    players.reserve(4);
    players.push_back({3, "carol", 88, true});
    players.push_back({1, "alice", 91, true});
    players.push_back({2, "bob", 75, false});
    players.push_back({4, "dave", 60, true});

    const std::size_t removed = std::erase_if(players, [](const Player& player) {
        return !player.online;
    });
    std::cout << "removed = " << removed << '\n';

    std::ranges::sort(players, {}, &Player::id);
    const auto found = std::ranges::lower_bound(players, 3, {}, &Player::id);
    if (found != players.end() && found->id == 3) {
        std::cout << "found = " << found->name << '\n';
    }

    std::ranges::sort(players, std::greater{}, &Player::score);
    for (const Player& player : players) {
        std::cout << player.name << ':' << player.score << '\n';
    }
}
```

编译运行：

```bash
clang++ -std=c++20 -O2 -Wall -Wextra -pedantic \
  players.cpp -o players
./players
```

预期输出：

```text
removed = 1
found = carol
alice:91
carol:88
dave:60
```

`std::erase_if` 真正缩短 `vector`，并返回删除数量。第一次 `sort` 通过成员投影按 ID 排序，满足 `lower_bound` 的前提；第二次排序改变为分数顺序，之后就不能继续假设区间按 ID 有序。

## 5. 为什么二分查找必须使用同一排序规则？

`lower_bound` 不会检查输入是否有序。它要求区间已经按与本次查找一致的规则分区/排序：

```cpp
std::ranges::sort(players, {}, &Player::id);
auto position = std::ranges::lower_bound(players, target_id, {}, &Player::id);
```

如果刚按分数排序，却继续按 ID 二分，结果没有业务意义。数据需要同时支持“分数顺序展示”和“ID 快速查找”时，可以：

- 每次展示前排序，数据量小时足够；
- 主存储按一种顺序，另建 ID 索引；
- 使用适合多个索引的专门数据结构；
- 分离拥有数据与排序后的观察列表。

不要为了避免重复排序而同时让多个容器各自拥有一份可变 Player，状态同步通常比排序更难维护。

## 6. 比较器为什么必须是严格弱序？

排序比较器回答“left 是否严格排在 right 前面”，相等元素两个方向都应返回 false：

```cpp
return left.score < right.score; // 合法起点
```

下面的写法错误：

```cpp
return left.score <= right.score;
```

对同一个元素比较时它会返回 true，违反非自反等要求。标准排序算法依赖严格弱序；违反前提可能产生未定义行为，而不只是“顺序有点奇怪”。

多字段排序可以使用 tuple：

```cpp
return std::tie(left.score, left.id) < std::tie(right.score, right.id);
```

比较字段在排序期间也必须保持稳定。比较器不能一边比较一边修改元素，也不应依赖会变化的全局状态或随机数。

## 7. 删除元素为什么不应在普通范围循环里做？

下面的循环在 `erase` 后继续使用已失效迭代器：

```cpp
for (auto iterator = values.begin(); iterator != values.end(); ++iterator) {
    if (should_remove(*iterator)) {
        values.erase(iterator); // iterator 失效，循环仍会 ++iterator
    }
}
```

如果删除条件能独立表达，C++20 优先使用 `std::erase_if`。必须边遍历边做复杂处理时，接住 `erase` 返回的下一个有效迭代器：

```cpp
for (auto iterator = values.begin(); iterator != values.end();) {
    if (should_remove(*iterator)) {
        iterator = values.erase(iterator);
    } else {
        ++iterator;
    }
}
```

C++20 之前，序列容器常使用 erase-remove 惯用法。`remove_if` 只是把保留元素前移并返回逻辑末尾，真正改变容器大小的是后续 `erase`。

## 8. `map` 和 `unordered_map` 应该怎样选？

选择关键不是谁的复杂度符号更小：

| 需求 | 候选 |
| --- | --- |
| 按 key 有序遍历、上下界和范围查询 | `map` |
| 主要精确 key 查找，hash 稳定可靠 | `unordered_map` |
| 元素很少、读多写少、适合连续存储 | 排序 `vector<pair<K,V>>` 也可能更好 |

`unordered_map` 的 O(1) 是平均意义，性能受 hash、负载因子、节点分配和缓存局部性影响。来自不可信输入的 key 还要考虑恶意碰撞造成退化。

无序容器不保证遍历顺序。不能把当前机器看到的顺序用于序列化、测试黄金输出或网络协议；需要确定顺序时显式排序或选择有序容器。

## 9. 为什么只查询时不要随意使用 `operator[]`？

关联容器的 `operator[]` 在 key 不存在时插入默认值：

```cpp
std::unordered_map<std::string, int> counts;
int value = counts["missing"]; // 插入 missing -> 0
```

统计计数时这很方便：

```cpp
++counts[word];
```

只查询时使用 `find`、`contains` 或 `at`，让“查询是否允许修改容器”保持清楚。`at` 在缺失时抛 `out_of_range`，`find`/`contains` 适合缺失是正常分支。

## 10. `emplace` 是否总比 `push_back` 快？

`emplace_back(args...)` 在容器存储中用参数构造元素，适合参数本来就用于构造：

```cpp
names.emplace_back(10, 'x');
```

已经有对象时，`push_back` 更直接：

```cpp
std::string name = "alice";
names.push_back(name);            // 复制
names.push_back(std::move(name)); // 移动
```

`emplace_back(name)` 同样可能复制，且某些隐式构造会让接口接受意外参数。性能差异要看具体构造和编译器优化，不应机械替换所有 `push_back`。

## 11. 标准算法为什么通常优于手写循环？

算法名字直接表达目的：`find_if`、`any_of`、`count_if`、`sort`、`partition`。它们减少循环边界和状态变量错误，也更容易被组合、并行化或替换实现。

但“优先算法”不是禁止循环。一次遍历要维护多个相关状态、需要复杂错误处理，或算法组合反而多次扫描时，清晰的单循环可能更好。选择标准是意图和正确性是否更明显，而不是行数最少。

## 12. 工程中最容易踩哪些坑？

### 误区一：O(1) 插入一定比 O(n) 移动快

链表插入还需要先取得位置、分配节点并追逐指针。小型连续元素的 vector 移动可能更快，必须用真实负载测量。

### 误区二：`reserve` 后可以直接按下标写

`reserve` 不改变 size。只有已经构造的 `[0, size())` 元素可访问。

### 误区三：容器还存在，保存的迭代器就有效

扩容、erase、rehash 等操作都可能使观察者失效。有效性由具体操作决定，不只由容器生命周期决定。

### 误区四：排序过一次后可以一直二分

任何改变顺序或排序键的操作都可能破坏前提。排序规则应紧邻查找逻辑或由数据结构不变量保证。

### 误区五：无序容器顺序可以写进测试

顺序可能随实现、rehash 和运行条件变化。测试应比较集合语义，或在输出前显式排序。

## 13. 什么时候需要标准容器之外的结构？

稳定句柄、多索引查询、实时上限、无锁并发或极端数据布局可能需要专门结构。但在引入第三方容器或自研前，应先用 profiler 和测试证明标准容器确实不满足需求，并明确要改善的是延迟、内存、稳定地址还是并发语义。

自定义结构也必须给出迭代器/引用失效、异常安全和所有权规则，否则只是把熟悉的标准契约换成隐含约定。

## 14. 总结

开头的大厅数据问题不能靠“链表插入快”或“哈希平均 O(1)”一句话解决。容器选择必须同时考虑主要访问、数据布局和观察者生命周期。

1. 顺序数据默认从 `vector` 开始，再用测量证明是否需要更换；
2. 迭代器、指针和引用是观察者，容器修改可能让它们在容器析构前就失效；
3. 排序与二分查找必须使用一致规则，比较器必须满足严格弱序；
4. 删除优先使用 `erase_if` 或正确接住 `erase` 返回值；
5. 标准算法用于清楚表达意图，但复杂单遍逻辑不必强行拆成算法链。

为一个数据集合选容器时，先写下最常见的三种操作，再逐项标记复杂度、是否搬迁元素和哪些观察者会失效。这张小表通常比背诵“哪个容器最快”更能得到可靠答案。
