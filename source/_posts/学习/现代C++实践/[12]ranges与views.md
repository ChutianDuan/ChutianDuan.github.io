---
title: "ranges 与 views"
date: 2026-04-09 10:50:31
updated: 2026-04-09 10:50:31
categories:
  - "学习"
  - "现代C++实践"
permalink: /notes/现代c-实践/12-ranges与views/
---

# ranges 与 views

时间：2026/04/09

> 关键词：`std::ranges`、`std::views`、惰性求值、管道风格、projection、view、dangling
> 核心目标：理解 ranges 为什么不是“语法糖”，以及 views 在工程里到底解决了什么问题。

---

## 1. 为什么会有 ranges

传统 STL 算法常见写法是：

```cpp
std::sort(v.begin(), v.end());
auto it = std::find_if(v.begin(), v.end(), pred);
```

它的问题不是不能用，而是：

* `begin/end` 很机械
* 容器、区间、子区间表达不统一
* 组合多步处理时可读性一般

`std::ranges` 的目标是：

* 直接面向“区间”编程
* 让算法和数据视图更自然地组合

---

## 2. 什么是 range

可以先粗略理解成：

> 一个可以拿到 `begin` 和 `end` 的可遍历对象。

例如：

* `std::vector`
* `std::array`
* `std::string`
* 某些 view

所以 `ranges` 的核心不是新容器，而是：

* 一套更统一的区间抽象

---

## 3. ranges 算法和传统算法的区别

传统写法：

```cpp
std::sort(v.begin(), v.end());
```

ranges 写法：

```cpp
std::ranges::sort(v);
```

优点：

* 少写重复样板
* 更容易配合子区间和 view
* 接口更贴近“处理一段范围”这件事

---

## 4. views 是什么

`view` 可以先理解成：

> 一个轻量、通常不拥有数据、按需计算的区间视图。

它最重要的特性通常是：

* 不拷贝底层数据
* 惰性求值
* 可组合

例如：

```cpp
auto even = v | std::views::filter([](int x) { return x % 2 == 0; });
```

这里并没有立刻生成一个新容器。

---

## 5. 为什么 views 很有价值

如果没有 views，很多处理中间会写成：

* 先过滤到一个新 vector
* 再 transform 到另一个新 vector
* 再截取前几个元素

这样的问题是：

* 中间容器多
* 拷贝和分配多
* 代码意图被“存中间结果”打断

views 的思路是：

* 先把处理流程串起来
* 真正遍历时再逐步应用

---

## 6. 最常见的 view 适配器

### 6.1 `filter`

```cpp
auto even = v | std::views::filter([](int x) { return x % 2 == 0; });
```

### 6.2 `transform`

```cpp
auto sq = v | std::views::transform([](int x) { return x * x; });
```

### 6.3 `take`

```cpp
auto first3 = v | std::views::take(3);
```

### 6.4 `drop`

```cpp
auto tail = v | std::views::drop(5);
```

### 6.5 `keys` / `values`

```cpp
auto ks = mp | std::views::keys;
auto vs = mp | std::views::values;
```

---

## 7. 管道风格最直观的例子

```cpp
#include <ranges>
#include <vector>
#include <iostream>

int main() {
    std::vector<int> v = {1, 2, 3, 4, 5, 6, 7, 8};

    auto result = v
        | std::views::filter([](int x) { return x % 2 == 0; })
        | std::views::transform([](int x) { return x * x; })
        | std::views::take(2);

    for (int x : result) {
        std::cout << x << '\n';
    }
}
```

---

## 8. views 的一个关键点：惰性

下面这句：

```cpp
auto result = v | std::views::filter(pred);
```

通常不会立刻把所有元素筛一遍。
真正发生计算，往往是在你：

* 遍历它
* 构造新容器
* 调用需要实际消费元素的算法

所以 `view` 更像“处理规则的组合”，不是立即产出的结果集。

---

## 9. view 和容器的区别

容器更像：

* 真正拥有数据
* 独立存储结果

view 更像：

* 一层观察或变换
* 常常依赖底层对象继续存在

这一点直接影响生命周期安全。

---

## 10. 什么时候需要把 view 落地成容器

如果你需要：

* 持久保存结果
* 随机访问结果
* 与不支持 ranges 的旧接口交互

就需要把 view materialize 成容器。

常见方式：

```cpp
std::vector<int> out(std::ranges::begin(view), std::ranges::end(view));
```

如果是 C++23，还常见：

```cpp
auto out = view | std::ranges::to<std::vector>();
```

---

## 11. `projection`：ranges 里非常实用但经常被忽略的点

很多 ranges 算法支持 projection。
意思是：

* 比较或匹配前，先对元素投影出某个字段

例如按成员排序：

```cpp
struct User {
    int id;
    std::string name;
};

std::ranges::sort(users, {}, &User::id);
```

这在工程里很实用。

---

## 12. 常见算法示例

```cpp
auto it = std::ranges::find(v, 42);
std::ranges::sort(v);
bool ok = std::ranges::all_of(v, pred);
std::ranges::copy(v, std::back_inserter(out));
```

---

## 13. 生命周期问题：views 最大的坑之一

因为很多 view 不拥有数据，所以要小心底层对象生命周期。

危险例子：

```cpp
auto make_view() {
    std::vector<int> v = {1, 2, 3};
    return v | std::views::filter([](int x) { return x > 1; }); // 危险
}
```

所以要记住：

* view 很轻，但通常不负责延长底层容器生命周期

---

## 14. 常见坑

### 14.1 把 view 当拥有结果的容器

它通常不是。

### 14.2 底层容器变了，view 却还在继续用

例如容器被销毁、扩容、失效。

### 14.3 pipeline 过长且带副作用

会让调试和推理变难。

### 14.4 误以为 ranges 一定更快

语义更清晰不代表每个场景都自动最优。

---

## 15. 一页总结

ranges 与 views 最重要的理解链是：

1. ranges 让算法直接面向区间
2. views 提供不拥有数据、可组合、惰性的处理视图
3. 它们最擅长表达“数据处理流水线”
4. 真正要注意的是生命周期、materialize 时机和可读性边界

如果只记一句：

> view 更像“处理规则”，容器才是“真正结果”。
