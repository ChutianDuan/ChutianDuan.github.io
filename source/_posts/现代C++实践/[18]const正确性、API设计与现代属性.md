---
title: "参数写了 `const`，接口就安全了吗？把可变性与生命周期写进 C++ 签名"
date: 2026-07-13 10:05:31
updated: 2026-07-13 10:05:31
categories:
  - "学习"
  - "现代 C++ 实践"
permalink: /notes/现代c-实践/18-const正确性-api设计与现代属性/
series: "现代 C++ 实践"
series_order: 18
---

时间：2026/05/08

下面两个声明对调用者来说是同一个函数：

```cpp
void set_retry_count(int value);
void set_retry_count(const int value);
```

按值参数上的顶层 `const` 只限制函数实现内部那份副本，不改变调用者对象，也不属于函数类型。相比之下，`const User&`、`const User*` 和 `User* const` 表达的是完全不同的修改权限。

`const` 正确性不是机械地给所有类型加关键字，而是让签名回答：函数借用还是拥有数据、能否修改对象、结果是否可能缺失、返回的引用能活多久、错误能否忽略。本文从这些问题出发，讲清顶层/底层 const、逻辑 const、值与视图、`explicit`、`[[nodiscard]]`、`noexcept` 和现代属性怎样组成可读的 API 契约。

---

## 1. 一个函数签名应该告诉调用者什么？

看到接口时，调用者至少需要判断：

1. 参数是否会被修改；
2. 函数会借用、复制还是接管所有权；
3. 参数能否为空，借用能持续多久；
4. 返回值是否拥有数据，是否可能缺失；
5. 失败通过返回值还是异常表达；
6. 结果能否安全忽略；
7. 调用是否承诺不让异常逃出。

对比：

```cpp
int parse(const char* data, int size);
```

和：

```cpp
[[nodiscard]] std::expected<Config, ParseError>
parse_config(std::string_view text);
```

第二个接口把非拥有字符视图、成功值和失败原因写进类型。它仍需文档说明编码、长度上限等规则，但已经消除了“负数是不是错误”“谁释放返回指针”等大量隐含约定。

## 2. 顶层 const 与底层 const 有什么区别？

顶层 const 约束对象本身：

```cpp
const int value = 42;
int* const pointer = &number; // pointer 不能改指向，*pointer 可以改
```

底层 const 约束间接指向的对象：

```cpp
const int* pointer = &number; // 可以改指向，不能通过 pointer 改 number
```

组合起来：

```cpp
const int* const pointer = &number; // 指向和所指值都不能通过它修改
```

按值形参会复制实参，因此声明中的顶层 const 不影响调用方：

```cpp
void process(int value);       // 公共声明通常写这一种
// 定义内部若想保护副本，可写 const int value，但不是新重载
```

引用和指针的底层 const 则是接口契约：

```cpp
void inspect(const User& user); // 必须存在，只读借用
void update(User& user);        // 必须存在，可写借用
void maybe_inspect(const User* user); // 可为空，只读借用
```

`const` 防止通过当前访问路径修改，不保证对象绝对不会被其他别名或线程修改。

## 3. 参数应该按值、引用还是视图传递？

| 意图 | 常见参数形式 | 说明 |
| --- | --- | --- |
| 小标量/枚举 | `T` | 复制简单，避免悬空 |
| 只在调用期间读取大对象 | `const T&` | 非空借用，不复制 |
| 在调用期间修改对象 | `T&` | 可写借用 |
| 可空观察 | `const T*` / `T*` | 空值有语义时使用 |
| 读取字符序列 | `string_view` | 非拥有，不保证空终止 |
| 读取连续对象序列 | `span<const T>` | 非拥有并携带长度 |
| 函数要保存一份对象 | `T` 后 move | 左值复制，右值移动，接口简单 |
| 接管独占动态对象 | `unique_ptr<T>` | 类型明确转移所有权 |

“大对象一律 `const T&`”并不完整。函数若要保存参数，引用形式最终仍需复制，并可能诱导错误地保存引用：

```cpp
class User {
public:
    explicit User(std::string name) : name_(std::move(name)) {}
    void rename(std::string name) { name_ = std::move(name); }

private:
    std::string name_;
};
```

值传递让左值调用付一次复制，右值调用可以移动，往往比维护 `const&` 与 `&&` 两套重载更清楚。对极大且复制昂贵、调用模式特殊的类型，再用测量和接口需求决定重载。

## 4. `const` 成员函数保证了什么？

成员函数后的 `const` 把隐式 `this` 视为指向 const 对象，不能修改普通数据成员：

```cpp
class Buffer {
public:
    std::size_t size() const noexcept { return data_.size(); }

private:
    std::vector<std::byte> data_;
};
```

它使 `const Buffer&` 可以查询，也向读者表达“不会改变对象的逻辑可观察状态”。这叫 const-correctness 的传播：如果底层查询漏写 const，上层只读接口也无法在 const 对象上调用它。

但 const 成员函数不是线程安全声明。两个线程同时调用一个使用 `mutable` 缓存的 const 函数，仍可能数据竞争。

## 5. `mutable` 什么时候合理？

逻辑 const 允许不改变抽象值的内部更新，例如缓存一次昂贵计算：

```cpp
class Text {
public:
    std::size_t word_count() const {
        if (!cached_) {
            cached_words_ = compute_word_count(data_);
            cached_ = true;
        }
        return cached_words_;
    }

private:
    std::string data_;
    mutable bool cached_ = false;
    mutable std::size_t cached_words_ = 0;
};
```

该代码在并发只读调用下并不安全。若对象会跨线程共享，需要互斥、`call_once`、构造期预计算，或把缓存移到独立同步对象。

`mutable` 适合实现层 bookkeeping，不应拿来绕过设计上真正的状态变化。若调用 `size() const` 会改变业务可观察结果，接口就不应伪装成查询。

## 6. `string_view` 和 `span` 为什么是借用契约？

它们把“只观察、不拥有”写进类型：

```cpp
void log(std::string_view message);
double average(std::span<const double> values);
```

二者都不延长底层生命周期。对象若要保存名称，应拥有 `string`：

```cpp
class BadUser {
    std::string_view name_; // 若源字符串先销毁，就会悬空
};

class User {
    std::string name_;
};
```

`string_view.data()` 不保证指向空字符结尾的字符串；把子串 view 直接传给 C API 可能越界读取。`span` 则要求连续存储，不能直接观察 `list`。

视图最适合短期参数。跨线程、协程或对象成员保存时，必须重新证明源所有者和地址稳定性；难以证明就复制成拥有类型。

## 7. 返回值为什么通常比输出参数更好？

现代 C++ 的拷贝省略和移动语义让按值返回成为默认安全选择：

```cpp
std::vector<int> make_ids();
```

返回引用或指针会把所有者生命周期暴露给调用方：

```cpp
const std::string& name() const noexcept; // 仅在 *this 和内部地址有效时可用
```

尤其不要返回局部引用，也不要为了“防修改”返回 const 值：

```cpp
const std::string make_name(); // 顶层 const 可能妨碍移动和组合，通常没有价值
```

如果访问器需要兼顾左值和临时对象，可使用引用限定：

```cpp
const std::string& name() const & noexcept { return name_; }
std::string name() && noexcept { return std::move(name_); }
```

这样持久对象返回借用引用，临时对象则把字符串按值移出，避免从即将销毁对象取得悬空引用。只有确实存在这种调用需求时才增加重载，不必为所有 getter 套模板。

## 8. 一个可运行的只读与可写存储接口

下面的 C++20 示例让查询返回 `optional<User>` 快照，而不是内部 `vector` 元素指针。后续修改存储时，先前查询结果仍然有效。

```cpp
#include <iostream>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

enum class Role {
    admin,
    guest,
};

struct User {
    int id;
    std::string name;
    Role role;
};

class UserStore {
public:
    explicit UserStore(std::vector<User> users)
        : users_(std::move(users)) {}

    [[nodiscard]] std::optional<User> find(int id) const {
        for (const User& user : users_) {
            if (user.id == id) {
                return user;
            }
        }
        return std::nullopt;
    }

    [[nodiscard]] bool rename(int id, std::string name) {
        for (User& user : users_) {
            if (user.id == id) {
                user.name = std::move(name);
                return true;
            }
        }
        return false;
    }

    void append_all(std::span<const User> users) {
        users_.insert(users_.end(), users.begin(), users.end());
    }

private:
    std::vector<User> users_;
};

int main() {
    UserStore store({{1, "alice", Role::admin}});

    const auto snapshot = store.find(1);
    if (!snapshot) {
        return 1;
    }

    if (!store.rename(1, "renamed")) {
        return 1;
    }

    const auto current = store.find(1);
    std::cout << "snapshot = " << snapshot->name << '\n';
    std::cout << "current = " << current->name << '\n';
}
```

编译运行：

```bash
clang++ -std=c++20 -O2 -Wall -Wextra -pedantic \
  user_store.cpp -o user_store
./user_store
```

预期输出：

```text
snapshot = alice
current = renamed
```

返回快照有复制成本，却拥有最简单的生命周期。若 User 很大、查询极频繁，可以返回短期 `const User*`、稳定句柄或提供回调式访问，但必须明确 `append`/`erase` 后是否失效，不能只为避免复制牺牲契约。

示例中第二次 `find` 按前置逻辑必然成功，但生产代码若无法证明这一点，仍应检查 `current` 再解引用。测试可以把“rename 成功后 find 必须成功”固定为不变量。

## 9. `explicit` 防止了什么？

单参数构造函数可能成为隐式转换路径：

```cpp
class Port {
public:
    explicit Port(int value) : value_(value) {}

private:
    int value_;
};

void connect(Port port);
connect(Port{443}); // 调用意图明确
```

除非类型本来就设计成可自然替换的值转换，否则构造函数优先 `explicit`。多参数构造也可能通过列表初始化参与隐式转换，C++11 起 `explicit` 并不只值得用于“单参数”口号。

`explicit` 不负责验证数值。`Port{-1}` 是否有效仍要由构造函数、工厂或强类型错误接口建立不变量。

## 10. `[[nodiscard]]` 能强制处理错误吗？

它要求实现对忽略结果给出诊断，但标准诊断通常是警告，调用者也能显式丢弃：

```cpp
static_cast<void>(store.rename(1, "new name"));
```

适合标记：错误结果、`expected`/业务 Result、重要资源句柄、纯查询中丢弃明显可疑的返回值。不要给每个无害 getter 都机械添加，否则警告噪声会削弱真正重要提示。

可以附带理由：

```cpp
[[nodiscard("check whether the update succeeded")]]
bool update();
```

工具链对属性警告级别和文字展示可能不同，CI 仍需合理警告策略与代码审查。

## 11. `noexcept` 为什么是终止级承诺？

异常逃出 `noexcept` 函数时，程序调用 `std::terminate()`：

```cpp
void cleanup() noexcept;
```

它首先是语义契约，其次才可能帮助优化。真正不抛的析构、移动、swap 和简单观察函数适合声明；调用任何可能抛操作时必须重新检查。

标准容器可能在扩容时利用 `is_nothrow_move_constructible`，在移动可能抛且类型可复制时选择复制以维持异常保证。因此，能真实保证不抛的移动操作应准确标记，但不能为了让容器移动而写错误承诺。

模板可以条件声明：

```cpp
template <class T>
void swap_values(T& left, T& right)
    noexcept(noexcept(std::swap(left, right))) {
    using std::swap;
    swap(left, right);
}
```

## 12. 现代属性还适合表达哪些意图？

| 属性 | 用途 | 注意事项 |
| --- | --- | --- |
| `[[maybe_unused]]` | 条件编译下故意未使用 | 不应掩盖本可删除的死代码 |
| `[[deprecated("reason")]]` | 给旧 API 提供迁移提示 | 保留兼容期和替代路径 |
| `[[fallthrough]]` | 明确 switch 有意贯穿下一 case | 必须放在合法 fallthrough 位置 |
| `[[nodiscard]]` | 忽略返回值很可疑 | 通常是警告，不是运行时强制 |
| `[[likely]]` / `[[unlikely]]` | 提供分支概率提示 | 只在测量支持且确实稳定时使用 |

属性不是装饰。错误的 `likely` 可能误导优化或读者，滥用 `maybe_unused` 会隐藏清理机会。只在意图明确且编译器能合理利用时添加。

## 13. `enum class` 为什么也是 API 设计工具？

作用域枚举避免名称泄漏，也不会隐式转换成整数：

```cpp
enum class HttpStatus : int {
    ok = 200,
    not_found = 404,
};
```

这让函数签名 `send(HttpStatus)` 不会随便接收一个任意 `int`。指定底层类型有助于存储和部分边界协议，但直接把内存表示写入网络仍要明确字节序和序列化规则。

不要用 `static_cast` 到处绕过强类型。如果业务经常需要整数值，可以提供命名转换函数，让校验和语义集中。

## 14. 工程中最容易踩哪些坑？

### 误区一：所有参数都使用 `const T&`

小标量按值更简单；要保存的对象按值再 move 往往更清楚；视图和所有权转移还有专门类型。

### 误区二：const 成员函数天然线程安全

它只限制通过当前 `this` 修改普通成员。`mutable`、共享指针所指对象和外部状态仍可能数据竞争。

### 误区三：返回 `const T` 更安全

按值结果已经独立，顶层 const 通常只限制调用者移动/调用，降低组合能力而没有所有权收益。

### 误区四：`string_view` 成员总能减少复制

若源字符串先销毁或重分配，成员立即悬空。长期保存默认拥有 `string`。

### 误区五：所有函数都加 `noexcept`

它不是愿望，而是异常逃出即终止的承诺。依赖调用变化后也要重新审查。

### 误区六：`[[nodiscard]]` 等于错误一定被处理

调用者能显式忽略，编译器也通常只警告。它是契约提示，需要配合警告策略和审查。

## 15. 什么时候应该优先保持 API 简单？

值对象、短期 `const&` 和明确返回值已经能覆盖大多数业务接口。引用限定、条件 noexcept、多个值类别重载和复杂 view 返回类型只有在生命周期或性能需求真实存在时再引入。

签名越精细，调用规则越多。好的 API 不是使用最多现代关键字，而是用最少类型机制排除真正无效的状态。

## 16. 总结

开头按值参数的 `const` 没有改变调用者契约，因为函数处理的是副本；真正重要的是引用/指针所指对象的可变性，以及借用能否活过使用期。

1. 按值、引用、指针、view 和智能指针分别表达复制、借用、可空和所有权；
2. const 成员函数表达逻辑只读，但不自动提供线程安全；
3. `string_view`/`span` 适合短期观察，长期结果优先拥有值；
4. `explicit`、`[[nodiscard]]` 和 `noexcept` 分别约束转换、结果忽略与异常逃逸；
5. 返回值默认按值，只有能证明生命周期时才暴露内部引用或指针。

审查一个函数签名时，逐个参数标注 `copy`、`borrow`、`mutate` 或 `take ownership`，再给返回值标注 `owning` 或 `view`。任何标不清的地方，通常就是 API 最容易误用的位置。
