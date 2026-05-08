---
title: "const 正确性、API 设计与现代属性"
date: 2026-05-08 14:32:41
updated: 2026-05-08 14:32:41
categories:
  - "学习"
  - "现代C++实践"
permalink: /notes/现代c-实践/18-const正确性-api设计与现代属性/
---

# const 正确性、API 设计与现代属性

时间：2026/05/08

> 关键词：`const`、引用、值传递、`explicit`、`[[nodiscard]]`、`noexcept`、`enum class`、API 边界
> 核心目标：把“函数签名”写成清楚的契约，让调用者一眼知道所有权、可变性、失败方式和使用方式。

---

## 1. API 设计先看函数签名

函数签名不是只给编译器看的，它也是给人看的。

一个好的签名应该回答：

1. 参数会不会被修改
2. 参数会不会被保存
3. 返回值是否必须检查
4. 函数是否可能抛异常
5. 构造是否允许隐式转换
6. 调用者是否转移所有权

对比两个接口：

```cpp
void parse(char* data, int len);
```

和：

```cpp
[[nodiscard]] Config parse_config(std::string_view text);
```

第二个签名更清楚：

* 输入只是观察，不拥有
* 输入不会被修改
* 返回值值得检查
* 解析结果是一个明确对象

---

## 2. `const` 参数：表达“我不会改它”

读大对象时，优先用 `const T&`：

```cpp
struct User {
    std::string name;
    std::string email;
};

void print_user(const User& user) {
    std::cout << user.name << " <" << user.email << ">\n";
}
```

如果写成值传递：

```cpp
void print_user(User user);
```

会拷贝整个对象，通常没有必要。

如果参数很小，值传递更简单：

```cpp
void set_retry_count(int n);
void set_timeout(std::chrono::milliseconds timeout);
```

经验：

* 小标量：值传递
* 大对象只读：`const T&`
* 可空观察：`const T*`
* 连续数组观察：`std::span<const T>`
* 字符串观察：`std::string_view`

---

## 3. `const` 成员函数：承诺不改对象状态

成员函数后面的 `const` 表示不会修改这个对象的可观察状态：

```cpp
class Cache {
public:
    std::size_t size() const {
        return items_.size();
    }

    bool empty() const {
        return items_.empty();
    }

private:
    std::vector<int> items_;
};
```

如果一个查询函数没写 `const`：

```cpp
std::size_t size();
```

那么 `const Cache&` 就不能调用它。
这会让 API 很难组合。

---

## 4. 什么时候用 `mutable`

`mutable` 用于“逻辑上不改变对象，但需要更新内部缓存”的场景。

```cpp
class Text {
public:
    explicit Text(std::string s) : data_(std::move(s)) {}

    std::size_t word_count() const {
        if (!cached_) {
            cached_words_ = count_words(data_);
            cached_ = true;
        }
        return cached_words_;
    }

private:
    static std::size_t count_words(std::string_view text);

    std::string data_;
    mutable bool cached_ = false;
    mutable std::size_t cached_words_ = 0;
};
```

注意：

* `mutable` 不是绕过 const 的万能钥匙
* 多线程读同一个对象时，mutable 缓存也需要同步
* 如果缓存逻辑复杂，优先考虑显式构建缓存对象

---

## 5. 字符串参数优先考虑 `std::string_view`

只读、不保存字符串时：

```cpp
void log_message(std::string_view msg) {
    std::cout << msg << "\n";
}
```

它可以接收：

```cpp
log_message("hello");

std::string s = "world";
log_message(s);

std::string_view v = "cpp";
log_message(v);
```

但不要保存 `string_view` 指向临时对象：

```cpp
class Bad {
public:
    void set_name(std::string_view name) {
        name_ = name; // 危险：name 可能指向临时字符串
    }

private:
    std::string_view name_;
};
```

如果对象要保存字符串，应该拥有它：

```cpp
class User {
public:
    void set_name(std::string name) {
        name_ = std::move(name);
    }

private:
    std::string name_;
};
```

---

## 6. 连续数组参数优先考虑 `std::span`

传统接口：

```cpp
double average(const double* data, std::size_t n);
```

现代写法：

```cpp
#include <span>
#include <numeric>

double average(std::span<const double> xs) {
    if (xs.empty()) {
        return 0.0;
    }

    double sum = std::accumulate(xs.begin(), xs.end(), 0.0);
    return sum / static_cast<double>(xs.size());
}
```

可以接收：

```cpp
std::vector<double> v{1.0, 2.0, 3.0};
std::array<double, 3> a{1.0, 2.0, 3.0};
double raw[] = {1.0, 2.0, 3.0};

average(v);
average(a);
average(raw);
```

`span` 只观察，不拥有。
不要让 `span` 活得比底层数组更久。

---

## 7. 值传递 + move：接收要保存的对象

如果函数要把参数保存到成员里，经常可以用值传递：

```cpp
class Person {
public:
    explicit Person(std::string name)
        : name_(std::move(name)) {}

    void rename(std::string name) {
        name_ = std::move(name);
    }

private:
    std::string name_;
};
```

调用者传左值时会拷贝一次：

```cpp
std::string n = "Alice";
Person p(n); // 拷贝进参数，再 move 到成员
```

调用者传右值时通常很高效：

```cpp
Person p("Alice");
Person q(std::string("Bob"));
```

这比同时写 `const std::string&` 和 `std::string&&` 两套重载更简单。

---

## 8. `explicit`：阻止意外隐式转换

单参数构造函数默认可能触发隐式转换：

```cpp
class Port {
public:
    Port(int value) : value_(value) {}

private:
    int value_;
};

void connect(Port port);

connect(80); // 可以隐式把 int 转成 Port
```

很多时候这不是你想要的。
更推荐：

```cpp
class Port {
public:
    explicit Port(int value) : value_(value) {}

private:
    int value_;
};

connect(Port{80}); // 调用者明确表达意图
```

经验：

> 除非你明确希望它能隐式转换，否则单参数构造函数优先写 `explicit`。

---

## 9. `[[nodiscard]]`：返回值不能随手丢

错误处理或资源构造结果经常不能忽略：

```cpp
enum class Error {
    none,
    file_not_found,
    permission_denied,
};

[[nodiscard]] Error save_config(std::string_view path);
```

调用者如果丢掉返回值，编译器会提醒：

```cpp
save_config("app.toml"); // 可能警告
```

更清晰的写法：

```cpp
if (auto err = save_config("app.toml"); err != Error::none) {
    report(err);
}
```

也可以标记类型：

```cpp
struct [[nodiscard]] Result {
    bool ok;
    std::string message;
};

Result load_user(int id);
```

适合 `[[nodiscard]]` 的返回值：

* 错误码
* `std::optional`
* `std::expected`
* 资源句柄
* 需要调用者继续使用的 builder 结果

---

## 10. `noexcept`：承诺不抛异常

`noexcept` 不只是优化提示，也是契约。

```cpp
#include <cstddef>
#include <utility>

class Buffer {
public:
    Buffer(Buffer&& other) noexcept
        : data_(std::exchange(other.data_, nullptr)),
          size_(std::exchange(other.size_, 0)) {}

private:
    int* data_ = nullptr;
    std::size_t size_ = 0;
};
```

移动构造如果是 `noexcept`，容器扩容时更愿意移动元素而不是拷贝元素。

不要乱写：

```cpp
void f() noexcept {
    may_throw(); // 如果真的抛出，会 std::terminate
}
```

经验：

* 析构函数默认应不抛
* 移动构造/移动赋值能保证不抛时写 `noexcept`
* 低层工具函数如果不抛，可以写 `noexcept`
* 不能保证时不要硬写

---

## 11. `enum class`：避免枚举污染和隐式转换

老式 enum：

```cpp
enum Color {
    red,
    green,
};

int x = red; // 可以隐式转 int
```

更推荐：

```cpp
enum class Color {
    red,
    green,
};

void paint(Color c);

paint(Color::red);
```

如果要指定底层类型：

```cpp
enum class HttpStatus : int {
    ok = 200,
    not_found = 404,
};
```

`enum class` 的好处：

* 名称不污染外层作用域
* 不会随便隐式转整数
* API 可读性更强

---

## 12. 现代属性的几个实用场景

### 12.1 `[[maybe_unused]]`

用于故意未使用的变量或参数：

```cpp
void on_debug_event([[maybe_unused]] int code) {
#ifdef DEBUG
    std::cout << code << "\n";
#endif
}
```

### 12.2 `[[deprecated]]`

给旧接口留迁移提示：

```cpp
[[deprecated("use parse_config_v2 instead")]]
Config parse_config(std::string_view text);
```

### 12.3 `[[fallthrough]]`

明确 switch 穿透是有意的：

```cpp
switch (level) {
case 3:
    enable_verbose();
    [[fallthrough]];
case 2:
    enable_info();
    break;
default:
    break;
}
```

这些属性不是装饰，它们让代码意图对编译器和读者都更清楚。

---

## 13. 返回值设计：值、引用、指针怎么选

### 13.1 返回值

最常见、最安全：

```cpp
std::vector<int> make_ids();
```

现代 C++ 有移动语义和返回值优化，不要过早改成输出参数。

### 13.2 返回引用

表示返回对象内部已有内容：

```cpp
class User {
public:
    const std::string& name() const noexcept {
        return name_;
    }

private:
    std::string name_;
};
```

注意调用者不能让引用超过对象生命周期。

### 13.3 返回指针

适合表达“可能没有”且不转移所有权：

```cpp
const User* find_user(int id) const;
```

如果没有值，也可以用：

```cpp
std::optional<User> find_user(int id) const;
```

如果对象很大、不想复制，并且不拥有，就用指针或引用包装语义说清楚。

---

## 14. 一个完整的小 API 示例

```cpp
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

enum class Role {
    admin,
    guest,
};

struct User {
    int id = 0;
    std::string name;
    Role role = Role::guest;
};

class UserStore {
public:
    explicit UserStore(std::vector<User> users)
        : users_(std::move(users)) {}

    [[nodiscard]] const User* find(int id) const noexcept {
        for (const auto& user : users_) {
            if (user.id == id) {
                return &user;
            }
        }
        return nullptr;
    }

    [[nodiscard]] std::vector<User> find_by_name(std::string_view name) const {
        std::vector<User> out;
        for (const auto& user : users_) {
            if (user.name == name) {
                out.push_back(user);
            }
        }
        return out;
    }

    void append(User user) {
        users_.push_back(std::move(user));
    }

    void append_all(std::span<const User> users) {
        users_.insert(users_.end(), users.begin(), users.end());
    }

private:
    std::vector<User> users_;
};
```

这个例子里：

* 构造函数 `explicit`
* 只读查询是 `const`
* 可能没有结果时返回指针
* 必须关注的查询结果加 `[[nodiscard]]`
* 保存参数时用值传递 + move
* 批量只读输入用 `span<const User>`

---

## 15. 常见误区

### 15.1 所有参数都写 `const T&`

小整数、枚举、轻量句柄直接值传递更好。

### 15.2 到处返回 `const T&`

如果返回的是临时对象或局部变量引用，会立刻悬空。
现代 C++ 返回值通常很便宜，别怕返回对象。

### 15.3 `string_view` 当成字符串成员保存

除非你非常清楚底层字符串生命周期，否则成员里保存 `std::string`。

### 15.4 所有函数都加 `noexcept`

`noexcept` 是承诺，不是祝福。
承诺错了会直接终止程序。

### 15.5 不写 `explicit`

隐式转换引起的问题很隐蔽。
构造函数默认倾向 `explicit` 是很好的工程习惯。

---

## 16. 一页总结

现代 C++ API 设计最常用的几条规则：

1. 只读大对象用 `const T&`
2. 字符串观察用 `std::string_view`
3. 连续数组观察用 `std::span`
4. 要保存的对象可以值传递再 move
5. 查询成员函数尽量写 `const`
6. 单参数构造函数优先 `explicit`
7. 重要返回值加 `[[nodiscard]]`
8. 能保证不抛时才写 `noexcept`

一句话：

> 好 API 的核心是把所有权、可变性和失败语义写在签名里，而不是藏在文档里。
