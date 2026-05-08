---
title: "STL 容器、迭代器与算法实践"
date: 2026-05-04 14:48:32
updated: 2026-05-04 14:48:32
categories:
  - "学习"
  - "现代C++实践"
permalink: /notes/现代c-实践/15-stl容器-迭代器与算法实践/
---

# STL 容器、迭代器与算法实践

时间：2026/05/04

> 关键词：容器选择、迭代器失效、标准算法、比较器、查找、排序、erase-remove、复杂度
> 核心目标：建立工程里选择容器和使用标准算法的基本判断，不把 STL 只当成“会 push_back 的工具箱”。

---

## 1. 为什么还要单独学 STL 容器和算法

现代 C++ 里，很多代码质量问题不是语法问题，而是：

* 容器选错
* 复杂度误判
* 迭代器失效
* 手写循环替代标准算法
* 比较器写错导致排序或查找出问题

标准库容器和算法的价值不只是“少写代码”，而是：

* 让意图更明确
* 让复杂度更可预期
* 让边界条件更少出错

---

## 2. 容器选择先看访问模式

常见容器可以先这样粗略分类：

| 容器 | 适合场景 | 典型代价 |
| --- | --- | --- |
| `std::vector` | 连续存储、随机访问、尾部追加 | 中间插删慢，扩容会搬迁 |
| `std::deque` | 两端插删、随机访问 | 不保证整体连续 |
| `std::list` | 已有迭代器位置的频繁插删 | 缓存不友好，随机访问慢 |
| `std::map` | 有序键值、稳定迭代顺序 | 红黑树，查找 `O(log n)` |
| `std::unordered_map` | 哈希查找、平均快速访问 | 无序，rehash 会失效 |
| `std::set` | 有序唯一集合 | 插入查找 `O(log n)` |
| `std::unordered_set` | 哈希唯一集合 | 依赖 hash 质量 |

经验上：

* 默认先考虑 `std::vector`
* 需要按 key 查找时考虑 `unordered_map` / `map`
* 不要因为“中间插删”就马上用 `list`

很多时候 `vector` 即使中间移动元素，也可能因为缓存友好而比链表快。

---

## 3. `vector` 为什么经常是默认答案

`vector` 的优势来自连续内存：

* 遍历快
* 随机访问快
* 缓存友好
* 容易和 C API 交互

```cpp
#include <vector>

std::vector<int> xs;
xs.reserve(1000);

for (int i = 0; i < 1000; ++i) {
    xs.push_back(i);
}
```

如果你大概知道元素数量，`reserve` 通常是最简单有效的优化。

需要注意：

* `reserve` 改 capacity，不改 size
* `resize` 改 size，会真的构造元素
* 扩容会让原来的指针、引用、迭代器失效

---

## 4. 迭代器失效规则要主动记

迭代器失效是 STL 里非常常见的 bug 来源。

### 4.1 `vector`

发生扩容时：

* 所有迭代器失效
* 所有指针和引用也失效

中间 `insert/erase` 时：

* 插入点或删除点之后的迭代器通常失效

### 4.2 `deque`

`deque` 的失效规则比 `vector` 更复杂。
如果代码依赖长期保存迭代器，要查清具体操作的规则。

### 4.3 `map` / `set`

节点式有序容器一般比较稳定：

* 插入通常不影响已有迭代器
* 删除某个元素只让指向该元素的迭代器失效

### 4.4 `unordered_map` / `unordered_set`

rehash 时：

* 迭代器会失效

但指向元素的引用和指针通常仍然有效，前提是元素没有被删除。

---

## 5. 删除元素：erase-remove 惯用法

从 `vector` 删除满足条件的元素，经典写法是：

```cpp
#include <algorithm>
#include <vector>

void remove_even(std::vector<int>& xs) {
    xs.erase(
        std::remove_if(xs.begin(), xs.end(), [](int x) {
            return x % 2 == 0;
        }),
        xs.end()
    );
}
```

`std::remove_if` 不会真的缩短容器，它只是把要保留的元素前移，并返回新的逻辑尾部。
真正删除尾部多余元素的是 `erase`。

C++20 起可以直接用：

```cpp
#include <vector>

std::erase_if(xs, [](int x) {
    return x % 2 == 0;
});
```

更短，也更不容易写错。

---

## 6. 优先使用标准算法表达意图

与其写：

```cpp
bool found = false;
for (int x : xs) {
    if (x == target) {
        found = true;
        break;
    }
}
```

不如写：

```cpp
#include <algorithm>

bool found = std::find(xs.begin(), xs.end(), target) != xs.end();
```

常用算法：

| 算法 | 用途 |
| --- | --- |
| `std::find` | 查找等于某值的元素 |
| `std::find_if` | 查找满足条件的元素 |
| `std::any_of` | 是否至少一个满足 |
| `std::all_of` | 是否全部满足 |
| `std::none_of` | 是否全部不满足 |
| `std::count_if` | 统计满足条件的数量 |
| `std::sort` | 排序 |
| `std::stable_sort` | 稳定排序 |
| `std::lower_bound` | 有序区间二分下界 |
| `std::partition` | 按条件分区 |

算法名字本身就是文档。

---

## 7. 排序和比较器

`std::sort` 要求比较器满足严格弱序。

正确写法：

```cpp
#include <algorithm>
#include <string>
#include <vector>

struct User {
    int id;
    std::string name;
};

void sort_users(std::vector<User>& users) {
    std::sort(users.begin(), users.end(), [](const User& a, const User& b) {
        return a.id < b.id;
    });
}
```

危险写法：

```cpp
return a.id <= b.id; // 错
```

比较器不是“是否排在前面或相等”，而是：

> `a` 是否严格排在 `b` 前面。

如果比较器违反规则，排序结果可能不稳定，甚至触发未定义行为。

---

## 8. 二分查找的前提

`std::lower_bound` 和 `std::binary_search` 的前提是：

* 区间已经按同一规则有序

```cpp
#include <algorithm>
#include <vector>

bool contains_sorted(const std::vector<int>& xs, int value) {
    return std::binary_search(xs.begin(), xs.end(), value);
}
```

如果区间没有排序，二分查找没有意义。

常见模式：

```cpp
auto it = std::lower_bound(xs.begin(), xs.end(), value);
if (it != xs.end() && *it == value) {
    // found
}
```

---

## 9. `map` 和 `unordered_map` 怎么选

优先问几个问题：

1. 是否需要按 key 有序遍历？
2. 是否需要范围查询？
3. key 有没有稳定可靠的 hash？
4. 是否关心最坏情况复杂度？

大致规则：

* 需要顺序或范围查询：`std::map`
* 只需要 key 到 value 的快速查询：`std::unordered_map`
* 数据量很小：有时 `vector<pair<K,V>>` 线性查找也够用

小数据上不要盲目迷信哈希表。
哈希计算、桶、节点分配都不是免费的。

---

## 10. 不要滥用 `operator[]`

`map` / `unordered_map` 的 `operator[]` 如果 key 不存在，会插入默认值。

```cpp
std::unordered_map<std::string, int> count;
int n = count["missing"]; // 插入 {"missing", 0}
```

如果只是查询，优先用：

```cpp
auto it = count.find("missing");
if (it != count.end()) {
    // use it->second
}
```

C++20 可以用：

```cpp
if (count.contains("missing")) {
    // found
}
```

---

## 11. `emplace` 不是永远比 `push_back` 好

`emplace_back` 的价值是原位构造：

```cpp
std::vector<std::string> names;
names.emplace_back(10, 'x');
```

但如果你已经有一个对象：

```cpp
std::string s = "hello";
names.push_back(s);
names.push_back(std::move(s));
```

这时 `push_back` 更清楚。
不要把 `emplace` 当成“性能更强的 push”。

---

## 12. 常见坑

### 12.1 遍历时删除元素写错

删除元素后，原迭代器可能失效。
需要使用 `erase` 返回的新迭代器，或者使用 `erase_if`。

### 12.2 对无序容器的遍历顺序有期待

`unordered_map` 不保证顺序。
不同平台、不同运行时、rehash 后顺序都可能变化。

### 12.3 保存 `vector` 元素地址后继续 push

后续扩容可能让地址悬空。

### 12.4 比较器写成 `<=`

排序比较器必须表达严格小于关系。

### 12.5 在小数据量上过度复杂化

几十个元素的查找，用简单 `vector` 可能已经非常好。

---

## 13. 一页总结

STL 容器和算法最值得记住的是：

1. 默认优先考虑 `vector`，除非访问模式明确不适合
2. 先看复杂度，再看数据布局和缓存
3. 迭代器、引用、指针失效规则必须主动记
4. 标准算法能更准确表达意图
5. 排序比较器必须满足严格弱序
6. `map` / `unordered_map` 的选择取决于是否需要有序和范围查询

如果只记一句：

> 容器选择不是背 API，而是把访问模式、生命周期和复杂度放在一起判断。

---

## 14. 参考资料

1. cppreference: containers
   <https://en.cppreference.com/w/cpp/container>

2. cppreference: algorithms
   <https://en.cppreference.com/w/cpp/algorithm>

3. cppreference: iterator invalidation
   <https://en.cppreference.com/w/cpp/container#Iterator_invalidation>
