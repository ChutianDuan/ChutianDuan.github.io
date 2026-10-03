---
title: "自动释放资源就够了吗？从 RAII 到跨线程所有权的性能边界"
date: 2026-07-13 10:30:23
updated: 2026-07-13 10:30:23
categories:
  - "学习"
  - "高性能 C++ 并行编程"
permalink: /notes/高性能c-并行编程/02-raii与智能指针/
series: "高性能 C++ 并行编程"
series_order: 2
---

时间：2026/04/09

> `delete` 没漏写，程序就安全吗？未必。真正棘手的问题通常是：谁拥有资源、资源应该活多久，以及多个线程是否在为同一份所有权付费。

## 一、先看一个“没有内存泄漏”的故障

下面的代码最终会释放内存，但它仍然可能让服务长期占用大量资源：

```cpp
std::shared_ptr<Session> session = load_session();

thread_pool.submit([session] {
    process(*session);
});
```

捕获 `session` 会增加共享引用计数。任务如果在线程池里排队十分钟，`Session` 以及它间接持有的缓存、文件和连接就至少多活十分钟。

这不是传统意义上的泄漏，却可能表现得像泄漏。若热路径频繁复制 `shared_ptr`，引用计数的原子更新还会形成额外开销。

因此，资源管理不能只问“最后会不会释放”，还要问三个问题：

1. 谁是资源的唯一或共同拥有者？
2. 观察者怎样保证使用期间资源仍然存在？
3. 生命周期是否被异步任务、回调或循环引用意外延长？

RAII 和智能指针解决这些问题的前提，是所有权语义选对了。

## 二、RAII 究竟保证了什么？

RAII（Resource Acquisition Is Initialization）把资源的获取和释放绑定到一个 C++ 对象：

- 构造成功，对象便拥有资源；
- 离开作用域，对象析构并释放资源；
- 中途 `return` 或抛出异常，也会沿栈展开并析构已经构造完成的局部对象。

“资源”不只是堆内存，也可以是文件、Socket、数据库连接、互斥锁、线程或 GPU 句柄。

```cpp
void update() {
    std::lock_guard<std::mutex> lock(mutex);
    change_shared_state();
} // lock 在这里析构，互斥锁自动释放
```

确定性析构是重点。RAII 并不依靠垃圾回收器未来某个时刻运行，而是让释放时机与作用域直接对应。

不过 RAII 只管理“释放动作”，不会自动修正错误的生命周期设计。例如，把本应独占的对象全部改成 `shared_ptr`，只是把所有权问题藏进了引用计数。

## 三、怎样为一个非内存资源编写 RAII 包装？

假设某个 C 接口用整数表示句柄，并要求调用者手动释放。一个可靠的包装器至少要做到：

- 析构时释放有效句柄；
- 禁止复制，避免同一句柄被释放两次；
- 允许移动，用于返回值和容器；
- 移动后，源对象不再拥有资源；
- 析构函数不抛异常。

下面是可直接运行的最小示例：

```cpp
#include <iostream>
#include <stdexcept>
#include <utility>

namespace demo {

int open_count = 0; // 仅用于这个单线程示例的验证

int acquire_resource() {
    ++open_count;
    return 7;
}

void release_resource(int handle) noexcept {
    if (handle != -1) {
        --open_count;
    }
}

class Handle {
public:
    explicit Handle(int value = -1) noexcept : value_(value) {}

    ~Handle() {
        reset();
    }

    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;

    Handle(Handle&& other) noexcept
        : value_(std::exchange(other.value_, -1)) {}

    Handle& operator=(Handle&& other) noexcept {
        if (this != &other) {
            reset(std::exchange(other.value_, -1));
        }
        return *this;
    }

    [[nodiscard]] int get() const noexcept {
        return value_;
    }

    explicit operator bool() const noexcept {
        return value_ != -1;
    }

    void reset(int replacement = -1) noexcept {
        release_resource(value_);
        value_ = replacement;
    }

private:
    int value_ = -1;
};

Handle make_handle() {
    return Handle(acquire_resource());
}

void work(bool should_fail) {
    Handle handle = make_handle();
    std::cout << "处理中，资源数：" << open_count << '\n';

    if (should_fail) {
        throw std::runtime_error("处理失败");
    }
}

} // namespace demo

int main() {
    std::cout << "调用前，资源数：" << demo::open_count << '\n';

    try {
        demo::work(true);
    } catch (const std::exception& error) {
        std::cout << "捕获异常：" << error.what() << '\n';
    }

    std::cout << "调用后，资源数：" << demo::open_count << '\n';
}
```

使用 C++20 编译：

```bash
clang++ -std=c++20 -O2 -Wall -Wextra -pedantic raii_handle.cpp -o raii_handle
./raii_handle
```

预期输出：

```text
调用前，资源数：0
处理中，资源数：1
捕获异常：处理失败
调用后，资源数：0
```

即使 `work()` 抛出异常，局部变量 `handle` 仍会在栈展开时析构。这里的全局计数只为展示结果，不适用于多线程生产代码。

### 析构时释放失败怎么办？

析构函数通常应保持 `noexcept`。尤其在异常传播期间，若析构函数再次抛异常，程序可能调用 `std::terminate()`。

若资源关闭本身可能失败，可同时提供两条路径：

- `close()`：调用者显式处理错误；
- 析构函数：执行尽力而为的兜底清理，并记录错误，但不抛出。

## 四、为什么默认应从值语义和 `unique_ptr` 开始？

如果对象可以直接作为成员或局部变量保存，值语义通常最简单：

```cpp
class Worker {
    Buffer buffer_;
};
```

确实需要动态生命周期、运行时多态或可空所有权时，再考虑 `std::unique_ptr`：

```cpp
auto parser = std::make_unique<JsonParser>();
```

`unique_ptr` 表达“此刻只有一个所有者”。它不可复制，但可以移动：

```cpp
auto first = std::make_unique<Job>();
auto second = std::move(first);

// second 拥有 Job，first 为空
```

这种限制不是麻烦，而是编译器替你检查所有权转移。通常它也不需要独立的引用计数控制块，容易内联，成本接近手写裸指针管理。

### 函数参数怎样表达意图？

```cpp
void inspect(const Job& job);              // 只使用，且不能为空
void inspect_optional(const Job* job);     // 只使用，允许为空
void take(std::unique_ptr<Job> job);        // 接管所有权
void replace(std::unique_ptr<Job>& job);    // 可能修改调用方的所有权
```

只观察对象时，优先传 `Job&` 或 `Job*`，不要为了“看起来安全”而传 `const unique_ptr<Job>&`。后者暴露了调用者的管理方式，却没有表达更多业务含义。

### 自定义删除器适合什么场景？

`unique_ptr` 不只会调用 `delete`。它可以包装 `FILE*` 或其他 C 资源：

```cpp
#include <cstdio>
#include <memory>

using File = std::unique_ptr<std::FILE, decltype(&std::fclose)>;

File open_file(const char* path) {
    return File(std::fopen(path, "rb"), &std::fclose);
}
```

使用前仍要检查指针是否为空。需要注意，删除器类型是 `unique_ptr` 类型的一部分；有状态删除器还可能增大智能指针对象本身的尺寸。

## 五、`shared_ptr` 的方便究竟付了什么成本？

`shared_ptr` 适用于多个参与者确实共同决定对象寿命的情况。它通常包含对象指针和控制块信息，控制块维护强引用、弱引用以及删除器等状态。

复制一个 `shared_ptr` 并不是复制一个普通裸指针：

```cpp
void enqueue(std::shared_ptr<Task> task) {
    queue.push(task); // 再增加一次共享所有权
}
```

实现通常需要以线程安全的方式更新引用计数。高并发下，不同核心反复修改同一个控制块，可能产生缓存一致性流量。具体成本取决于标准库、硬件和使用方式，应通过基准或性能分析验证，不能仅凭直觉断言它一定是瓶颈。

减少无意义复制的第一步，是让接口准确表达是否要延长生命周期：

```cpp
void execute(const Task& task);                  // 不拥有
void retain(std::shared_ptr<Task> task);          // 明确保留一份所有权
void observe(const std::shared_ptr<Task>& task);  // 仅查看智能指针状态
```

不要机械地把所有参数都改成 `const shared_ptr<T>&`。业务代码只需要 `T` 时，仍应传 `T&` 或 `T*`。

### 引用计数线程安全，等于对象线程安全吗？

不等于。多个线程可以安全地销毁各自持有的 `shared_ptr` 副本，并不代表它们可以无同步地修改 `*ptr`：

```cpp
auto counter = std::make_shared<int>(0);

// 两个线程同时执行 ++*counter 仍然是数据竞争
```

智能指针管理的是生命周期；互斥锁、原子变量或消息传递管理的是并发访问。这是两套问题。

### `make_shared` 为什么常见？

```cpp
auto task = std::make_shared<Task>(arguments);
```

实现通常能把对象和控制块放入一次分配，减少分配次数并改善局部性。但它也有一个容易忽略的边界：对象析构后，只要仍有 `weak_ptr` 指向控制块，这块合并分配的内存可能还不能归还。

若对象非常大、弱引用长期存在，并且尽快归还对象占用的内存很重要，可比较以下写法的实际效果：

```cpp
std::shared_ptr<LargeObject> object(new LargeObject(arguments));
```

这里通常把对象和控制块分开分配，使对象内存能在最后一个强引用消失时释放，但会多一次分配。它是针对特定生命周期的权衡，不是普遍优于 `make_shared` 的写法。

## 六、循环引用为什么让析构永远等不到？

两个对象相互持有强引用时，外部所有者即使全部消失，内部引用计数仍不为零：

```cpp
struct Child;

struct Parent {
    std::shared_ptr<Child> child;
};

struct Child {
    std::shared_ptr<Parent> parent; // 与 Parent::child 构成环
};
```

如果 `Child` 只是回看其父对象，不应共同决定父对象寿命，可以改成弱引用：

```cpp
struct Child {
    std::weak_ptr<Parent> parent;

    void notify() {
        if (auto owner = parent.lock()) {
            // owner 在这个作用域内保证 Parent 存活
        }
    }
};
```

`weak_ptr` 是非拥有观察者。调用 `lock()` 会尝试取得临时强引用；对象已经销毁时得到空的 `shared_ptr`。不要先调用 `expired()` 再使用，因为两步之间对象仍可能被其他线程销毁。

## 七、跨线程传递资源时，生命周期怎样设计？

### 情况 1：任务完整接管资源

让 `unique_ptr` 随任务移动，所有权最清楚：

```cpp
auto buffer = std::make_unique<Buffer>();

pool.submit([buffer = std::move(buffer)]() mutable {
    consume(*buffer);
});
```

提交成功后，调用线程不再拥有 `buffer`。任务结束时资源自动释放。

### 情况 2：多个异步任务确实共享只读数据

可以捕获 `shared_ptr<const T>`：

```cpp
std::shared_ptr<const Model> model = load_model();

pool.submit([model] {
    run_inference(*model);
});
```

`const` 能限制通过该指针修改对象，但不能让对象内部所有操作天然线程安全。若类型包含惰性缓存或 `mutable` 状态，仍要检查其并发契约。

### 情况 3：回调不应延长服务对象寿命

捕获弱引用，并在回调执行时升级：

```cpp
std::weak_ptr<Service> weak_service = service;

register_callback([weak_service] {
    if (auto service = weak_service.lock()) {
        service->on_event();
    }
});
```

这能避免回调注册表与服务对象形成强引用环。代价是回调必须接受“对象已不存在”这一合法结果。

## 八、锁和线程也应该由 RAII 管理吗？

应该。手写 `lock()` / `unlock()` 很容易在异常或提前返回时遗漏解锁：

```cpp
std::lock_guard<std::mutex> lock(mutex);
update();
```

需要延迟加锁、临时解锁或条件变量时使用 `std::unique_lock`；一次锁多个互斥量时，使用 `std::scoped_lock` 可避免自己编排加锁顺序：

```cpp
std::scoped_lock lock(left_mutex, right_mutex);
swap(left_state, right_state);
```

线程同样有生命周期。C++20 的 `std::jthread` 析构时会请求停止并等待线程结束，比忘记对 `std::thread` 调用 `join()` 更安全：

```cpp
#include <chrono>
#include <stop_token>
#include <thread>

void run(std::stop_token stop) {
    while (!stop.stop_requested()) {
        do_one_piece_of_work();
    }
}

void launch() {
    std::jthread worker(run);
    // 离开作用域时请求停止并 join
}
```

但 RAII 不会保证线程一定迅速退出。如果任务忽略停止请求，或永久阻塞在不可中断的调用中，`jthread` 的析构仍可能长时间等待。

## 九、哪些常见写法看似安全，实际有隐患？

### 1. 从同一个裸指针构造多个 `shared_ptr`

```cpp
Widget* raw = new Widget;
std::shared_ptr<Widget> first(raw);
std::shared_ptr<Widget> second(raw); // 错误：两个独立控制块
```

两个控制块都会尝试删除同一对象。应从一开始创建一个 `shared_ptr`，之后复制它。

### 2. 对栈对象使用默认删除器

```cpp
Widget widget;
std::shared_ptr<Widget> pointer(&widget); // 错误
```

`pointer` 析构时会对栈地址执行 `delete`。非拥有关系请使用引用或裸指针，并让其生命周期约束在接口中足够清晰。

### 3. 把 `use_count()` 当作同步判断

```cpp
if (pointer.use_count() == 1) {
    // 不能据此证明接下来仍是唯一拥有者
}
```

并发环境中，观察结果可能立即变化；即使单线程，`use_count()` 也容易把业务逻辑与实现细节耦合。它更适合诊断，不适合构造正确性。

### 4. 构造函数先拿到资源，随后又抛异常

如果资源先存入裸成员，后续成员构造失败，类的析构函数不会执行。应让资源一获取就进入已经构造完成的 RAII 成员：

```cpp
class Connection {
    File socket_;       // 自身负责释放
    std::string name_;  // 即使这里构造失败，socket_ 也会析构
};
```

## 十、如何选择所有权工具？

可以按下面的顺序判断：

| 需求 | 优先选择 | 原因 |
|---|---|---|
| 生命周期就是当前作用域或包含对象 | 值语义 | 最直接，无额外分配 |
| 一个所有者，需要动态生命周期 | `unique_ptr` | 独占语义明确，开销低 |
| 多方确实共同决定寿命 | `shared_ptr` | 自动管理共享生命周期 |
| 只观察共享对象，不延长寿命 | `weak_ptr` | 可检测对象是否仍存在 |
| 临时访问且调用方保证存活 | `T&` / `T*` | 不制造额外所有权 |
| 锁、文件、线程等非内存资源 | 专用 RAII 类型 | 把释放动作绑定到析构 |

一个实用原则是：从最强约束、最低成本的方案开始。只有在共享所有权确实属于问题本身时，才使用 `shared_ptr`，而不是把它当成默认指针。

## 十一、性能优化前应该测什么？

发现热路径中有大量智能指针操作时，可依次检查：

1. 这些复制是否真的要延长对象寿命？
2. 能否改为明确的独占所有权或借用引用？
3. 队列积压是否意外延长大型对象寿命？
4. 分配次数是否重要，`make_shared` 是否更合适？
5. 控制块是否被多个核心频繁更新？
6. 改动后吞吐、延迟和峰值内存是否真的改善？

不要为了消除引用计数而退回不受约束的裸指针。生命周期错误往往比少量原子操作昂贵得多。先建立正确所有权，再用 profiler、基准测试和内存曲线定位真正瓶颈。

## 十二、总结

RAII 的价值不是少写一个 `delete`，而是让资源释放成为类型和作用域的一部分：

- 值语义适用时，优先值语义；
- 动态资源默认考虑 `unique_ptr`，用移动表达所有权转移；
- `shared_ptr` 只用于真实的共享所有权，并留意引用计数和寿命延长；
- `weak_ptr` 用来打破所有权环，并安全观察可能已经销毁的对象；
- 引用计数线程安全不等于对象线程安全；
- 文件、锁、线程和系统句柄都应尽快交给 RAII 对象；
- 性能结论必须通过测量验证，但生命周期正确性不能靠测量补救。

写并发 C++ 时，最值得先画清楚的往往不是线程数量，而是资源所有权图。图越简单，程序通常越容易正确，也越容易快。
