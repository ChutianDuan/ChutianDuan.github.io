---
title: "管道已经保存了，结果为什么还会变？理解 C++20 ranges 的惰性与生命周期"
date: 2026-07-13 09:45:31
updated: 2026-07-13 09:45:31
categories:
  - "学习"
  - "现代 C++ 实践"
permalink: /notes/现代c-实践/12-ranges与views/
series: "现代 C++ 实践"
series_order: 12
---

时间：2026/04/09

下面的代码看起来像是已经筛选出所有偶数：

```cpp
auto even = values | std::views::filter([](int value) {
    return value % 2 == 0;
});
```

但 `even` 通常不是一份独立结果。它更像“遍历 `values` 时，只暴露满足条件元素”的规则。如果之后修改 `values`，再次遍历 `even` 可能看到不同内容；如果底层容器已经销毁或重分配，view 还可能悬空。

这正是 C++20 ranges 与 views 最有价值也最容易误解的地方：它们让算法直接面向区间，让过滤、变换和截取可以惰性组合，却不会自动替你拥有结果或固定一次计算。本文从这个反直觉现象出发，说明 range、view、投影、物化和 borrowed range 各自解决什么问题。

---

## 1. 传统 STL 算法缺的真的是一对 `begin/end` 吗？

传统写法本身没有问题：

```cpp
std::sort(values.begin(), values.end());
auto iterator = std::find_if(values.begin(), values.end(), predicate);
```

但接口把一个逻辑区间拆成两个迭代器，调用方可能把不同容器的迭代器误配，也不容易直接表达“先过滤，再变换，最后取前两个”。C++20 ranges 算法可以直接接收区间：

```cpp
std::ranges::sort(values);
auto iterator = std::ranges::find_if(values, predicate);
```

range 可以粗略理解为能取得起点和终点、可以遍历的一段对象。`vector`、`array`、`string`、`span` 和许多 view 都是 range。它不是一种新容器，而是一组让算法对不同区间使用统一协议的概念与定制机制。

ranges 的收益也不只是少写字符：

- 算法约束通过 concepts 更早暴露类型错误；
- 返回类型会考虑临时 range 的生命周期；
- projection 让算法先提取成员再比较；
- view 适配器能够组合惰性区间。

## 2. view 与容器的根本区别是什么？

容器通常拥有元素存储，复制容器会产生独立数据。view 是为了遍历而设计的轻量 range，复制成本通常较低，很多 view 借用底层 range，或保存其他 view 与可调用对象。

```text
vector<User> users（拥有 User）
       ↓ 被观察
filter_view（保存筛选规则）
       ↓ 再包装
transform_view（保存投影规则）
       ↓
遍历时才逐个计算
```

“view 永远不拥有数据”并不完全准确。例如对某些右值 range 使用 `views::all`，标准库可以通过 owning view 接管它。但从 API 使用角度，不能看到一个 view 就默认它拥有源数据；必须根据具体适配器和源 range 的值类别判断。

最安全的直觉是：**view 是遍历方式，不是结果快照。**需要独立、稳定的结果时，应明确物化到容器。

## 3. 惰性求值具体发生在哪里？

构造管道时，`filter` 通常不会立即访问所有元素，`transform` 也不会立刻生成变换结果：

```cpp
auto result = values
    | std::views::filter(is_valid)
    | std::views::transform(normalize)
    | std::views::take(10);
```

真正迭代 `result` 时，每取得下一个元素，才按需执行筛选和变换。`take(10)` 还可能让后面的源元素完全不被处理。

这能减少中间容器与不必要计算，但带来三个后果：

1. 多次遍历可能重复执行谓词和转换；
2. 谓词中的副作用会在消费 view 时发生，而不是定义管道时；
3. 底层数据变化后，结果也可能变化。

因此，view 的谓词和 transform 最好保持纯粹、便宜且可重复。把日志计数、修改外部状态或随机行为藏在管道里，会让执行时机难以推断。

## 4. 一个可运行的排序、筛选和变换示例

下面的 C++20 程序按分数排序用户，再创建“活跃用户姓名”的惰性 view。第一次遍历后，它修改底层用户状态；第二次遍历同一个 view 得到不同结果。

```cpp
#include <algorithm>
#include <functional>
#include <iostream>
#include <ranges>
#include <string>
#include <string_view>
#include <vector>

struct User {
    std::string name;
    int score;
    bool active;
};

void print(std::string_view label, auto&& names) {
    std::cout << label;
    for (std::string_view name : names) {
        std::cout << ' ' << name;
    }
    std::cout << '\n';
}

int main() {
    std::vector<User> users{
        {"alice", 91, true},
        {"bob", 75, false},
        {"carol", 88, true},
        {"dave", 60, true},
    };

    std::ranges::sort(users, std::greater{}, &User::score);

    auto top_active_names = users
        | std::views::filter(&User::active)
        | std::views::transform([](const User& user) -> std::string_view {
              return user.name;
          })
        | std::views::take(2);

    print("before:", top_active_names);

    users[1].active = false; // 排序后 users[1] 是 carol
    print("after: ", top_active_names);
}
```

编译运行：

```bash
clang++ -std=c++20 -O2 -Wall -Wextra -pedantic \
  ranges_demo.cpp -o ranges_demo
./ranges_demo
```

预期输出：

```text
before: alice carol
after:  alice dave
```

`top_active_names` 没有保存两个人名。它保存的是对 `users` 的观察、成员谓词、姓名投影和“最多两个”的限制。第二次遍历时，`carol` 已经不再活跃，因此继续寻找 `dave`。

## 5. projection 为什么比手写比较器更直接？

示例中的排序：

```cpp
std::ranges::sort(users, std::greater{}, &User::score);
```

`std::greater{}` 是比较器，`&User::score` 是投影（projection）。算法先把每个 `User` 投影为 `score`，再比较分数。传统等价写法需要一个完整 lambda：

```cpp
std::sort(users.begin(), users.end(), [](const User& left, const User& right) {
    return left.score > right.score;
});
```

投影适合“按成员排序、查找或判断”，减少重复访问样板，并让比较规则与字段选择分开。它不会缓存投影结果；如果投影本身昂贵，算法可能多次计算，应该先测量或预计算键。

## 6. 底层容器发生什么变化会让 view 失效？

借用容器的 view 受到源 range 的迭代器失效规则约束。以 `vector` 为例：

- 析构 `vector`：所有 view、迭代器和元素引用失效；
- 触发重新分配的 `push_back`/`reserve`：原元素地址全部失效；
- `erase`：被删除位置及其后的迭代器和引用失效；
- 原地修改元素：地址通常仍有效，但惰性筛选结果可能改变。

```cpp
auto positives = values | std::views::filter([](int value) { return value > 0; });
values.push_back(42); // 若触发重分配，正在使用的迭代器会失效
```

view 对象本身仍存在不代表它内部依赖的迭代器、引用或源对象仍有效。尤其不要一边遍历过滤 view，一边通过另一条路径修改底层容器结构。

## 7. 返回局部容器的 view 为什么危险？

下面的函数返回一个借用局部 `vector` 的 view：

```cpp
auto make_view() {
    std::vector<int> values{1, 2, 3};
    return values | std::views::filter([](int value) {
        return value > 1;
    });
} // values 销毁，返回的 view 悬空
```

局部 `values` 是左值，管道通常保存对它的引用包装；函数返回后源对象销毁。修复方式取决于接口意图：

- 结果应独立保存：返回 `vector<int>`；
- 调用方拥有源数据：让函数接收调用方 range，并限制 view 使用范围；
- 需要封装拥有源和 view 的对象：设计明确的 owner 类型，而不是靠隐含引用。

不要仅凭“view 很轻”把它作为返回值。轻量往往意味着没有替你承担所有权。

## 8. ranges 算法为什么有时返回 `dangling`？

传统算法可能从临时容器返回一个立即悬空的迭代器。ranges 算法会利用 borrowed range 概念，在不能保证迭代器离开调用后仍有效时返回 `std::ranges::dangling`：

```cpp
auto result = std::ranges::find(std::vector{1, 2, 3}, 2);
// result 不是一个可解引用的 vector 迭代器
```

这提供了编译期保护，但不代表所有 view 生命周期错误都会自动被阻止。你仍然可以把借用 view 保存得比源对象久，或者在遍历期间让迭代器失效。

`borrowed_range` 的含义也不是“数据被安全拥有”，而是从该 range 得到的迭代器在 range 临时对象销毁后仍可继续使用。`span` 是典型 borrowed range，因为销毁 span 不销毁它指向的元素；元素所有者仍必须存在。

## 9. 什么时候应该把 view 物化成容器？

如果结果需要：

- 独立于源数据长期保存；
- 跨线程或异步边界传递；
- 避免重复执行昂贵转换；
- 交给只接受具体容器的旧接口；
- 固定一次计算时刻，形成快照；

就应明确物化。C++20 可以直接遍历构造结果：

```cpp
std::vector<std::string> names;
for (std::string_view name : top_active_names) {
    names.emplace_back(name);
}
```

这里使用 `std::string` 而不是继续保存 `string_view`，让结果真正拥有字符。C++23 提供 `std::ranges::to` 后可在相应标准库支持下使用更直接的转换，但编译器启用 C++23 不代表库一定完整实现。

“先 view 再物化”不一定比普通循环更快。它的主要收益是清楚表达处理阶段；性能仍要在 Release 构建、真实数据规模下重复测量。

## 10. 管道越长越好吗？

适度的 `filter | transform | take` 很接近数据处理语言，过长管道却可能带来：

- 难以定位哪一层产生错误；
- 复杂模板错误和较长编译时间；
- 同一元素被多个昂贵适配器反复处理；
- 临时 view 类型难以在调试器中阅读；
- 隐藏副作用与生命周期依赖。

当一段管道包含多个业务判断、需要错误处理或中间结果有明确领域含义时，可以命名中间 view、抽取普通函数，甚至直接写循环。ranges 是表达工具，不是必须把所有循环改成一行的代码高尔夫。

## 11. 常见 view 适配器怎样理解？

| 适配器 | 表达的操作 | 关键提醒 |
| --- | --- | --- |
| `filter` | 只遍历满足谓词的元素 | 谓词可能被重复调用 |
| `transform` | 遍历时计算映射结果 | 返回引用时检查生命周期 |
| `take(n)` | 最多观察前 n 个元素 | 不保证源 range 至少有 n 个 |
| `drop(n)` | 跳过前 n 个元素 | 对不同 range 的推进成本不同 |
| `keys` / `values` | 观察 pair-like range 的相应成员 | 仍依赖底层容器 |
| `iota` | 生成递增值序列 | 无界 iota 要由后续操作限制 |

view 的迭代器类别和复杂度取决于底层 range 与适配器。一个 `vector | filter` 不会因为源是随机访问容器就自动支持任意 O(1) 下标；过滤需要寻找下一个满足条件的元素。

## 12. 工程中最容易踩哪些坑？

### 误区一：定义 view 时已经得到结果

多数计算发生在遍历时。源数据变化、重复遍历和谓词副作用都会影响观察结果。

### 误区二：所有 view 都绝对不拥有数据

标准库存在 owning view；但很多常见管道借用左值源。应检查具体类型和源的值类别，不能用一句绝对规则代替所有权分析。

### 误区三：ranges 一定比循环快

优化器可能生成同样代码，也可能因复杂适配器、函数对象和难以优化的组合表现不同。语义清晰是首要收益，性能需要测量。

### 误区四：transform 返回引用总能减少复制

若引用指向临时对象、局部变量或会失效的容器元素，管道会产生悬空。返回引用前必须证明所有者和地址稳定性。

### 误区五：管道可以跨异步边界保存

异步任务执行时，源容器可能已经离开作用域。除非所有权明确覆盖任务，跨线程/协程边界优先传递拥有的结果。

## 13. 什么时候适合使用 ranges 和 views？

它们适合过滤、映射、截取和只读遍历组成的局部数据流水线，尤其是无需中间容器、处理规则可以保持纯函数的场景。projection 也非常适合按成员进行标准算法操作。

如果逻辑包含复杂状态机、每个元素需要多步错误处理、管道必须长期保存或性能分析表明适配器妨碍优化，普通循环和显式容器可能更清楚。现代 C++ 不要求放弃循环。

## 14. 总结

开头的 `even` 在源数据修改后会变化，因为 view 保存的是遍历规则和对源 range 的关系，而不是一份结果快照。

1. ranges 让算法直接面向区间，并用 concepts、projection 和生命周期感知返回值改善接口；
2. view 通常轻量且惰性，很多 view 借用数据，但不能简单断言所有 view 都不拥有；
3. 源容器的销毁、扩容和 erase 都可能让 view 或其迭代器失效；
4. 需要稳定、拥有的快照时，应在明确边界物化到容器；
5. 管道应保持短小、可预测、少副作用，性能结论必须测量。

写出一条 view 管道后，立刻回答两个问题：“它什么时候真正计算？”以及“它依赖的数据由谁拥有、能活多久？”只要这两个答案清楚，ranges 才会从漂亮语法变成可靠工具。
