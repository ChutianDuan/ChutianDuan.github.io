---
title: "TBB开启的并行编程之旅"
date: 2025-12-23 15:24:08
tags:
  - "C++"
  - "TBB"
  - "并行编程"
categories:
  - "学习"
  - "高性能C++并行编程"
thumbnail: /img/covers/cover10.jpg
---
# TBB 开启的并行编程之旅
time: 2025-12-23

## 1. 并发与并行：概念与 TBB 的定位

* **并发（Concurrency）**：关注“任务结构”。多个任务在同一时间段内推进即可（单核也能并发）。
* **并行（Parallelism）**：关注“同时执行”。多个任务在同一时刻运行（通常依赖多核）。


## 2. 并发任务：`task_group` 与 `parallel_invoke`

### 2.1 `task_group`：提交多个独立任务

```cpp
#include <tbb/task_group.h>
#include <iostream>
#include <string>
#include <thread>
#include <chrono>

void download(const std::string& file) {
    for (int i = 0; i < 10; ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(400));
    }
    std::cout << "Downloaded: " << file << "\n";
}

void interact() {
    std::string name;
    std::cin >> name;
    std::cout << "Hello, " << name << "\n";
}

int main() {
    tbb::task_group tg;
    tg.run([&]{ download("hello.zip"); });
    tg.run([&]{ interact(); });
    tg.wait();
    return 0;
}
```

### 2.2 `parallel_invoke`：更简洁的并发调用

当只是“并行执行几个函数”，优先用 `parallel_invoke`：

```cpp
#include <tbb/parallel_invoke.h>

tbb::parallel_invoke(
    [&]{ download("hello.zip"); },
    [&]{ interact(); }
);
```

---

## 3. 数据并行：`parallel_for` / `parallel_for_each`

### 3.1 手动分块（`task_group`）→ 推荐替换为 `parallel_for`

手动分块能跑，但属于“自己实现调度”。TBB 风格是把“范围”交给调度器切分。

```cpp
#include <tbb/parallel_for.h>
#include <tbb/blocked_range.h>
#include <vector>
#include <cmath>
#include <cstddef>

int main() {
    const size_t n = 1u << 16;
    std::vector<float> dp(n);

    tbb::parallel_for(
        tbb::blocked_range<size_t>(0, n),
        [&](const tbb::blocked_range<size_t>& r) {
            for (size_t i = r.begin(); i != r.end(); ++i) {
                dp[i] = std::sinf(static_cast<float>(i));
            }
        }
    );

    return 0;
}
```

### 3.2 `parallel_for(begin,end,body)`：最短常用写法

```cpp
#include <tbb/parallel_for.h>
#include <vector>
#include <cmath>

int main() {
    const size_t n = 1u << 16;
    std::vector<float> dp(n);

    tbb::parallel_for((size_t)0, n, [&](size_t i){
        dp[i] = std::sinf((float)i);
    });
}
```

### 3.3 `parallel_for_each`：并行遍历容器元素

语义：对 `[first,last)` 每个元素并行调用一次 `func(element)`；要求元素之间无数据冲突。

```cpp
#include <tbb/parallel_for_each.h>
#include <vector>
#include <cmath>

int main() {
    std::vector<float> a(1<<16, 1.0f);
    tbb::parallel_for_each(a.begin(), a.end(), [&](float& f){
        f = std::sinf(f);
    });
}
```

---

## 4. 多维并行：`blocked_range2d / 3d`

### 4.1 二维：`blocked_range2d`（rows/cols）

```cpp
#include <tbb/parallel_for.h>
#include <tbb/blocked_range2d.h>
#include <vector>
#include <cmath>
#include <cstddef>

int main() {
    const size_t n = 1024;
    std::vector<float> a(n * n);

    tbb::parallel_for(
        tbb::blocked_range2d<size_t>(0, n, 0, n),
        [&](const tbb::blocked_range2d<size_t>& r) {
            for (size_t i = r.rows().begin(); i != r.rows().end(); ++i) {
                for (size_t j = r.cols().begin(); j != r.cols().end(); ++j) {
                    a[i*n + j] = std::sinf((float)(i*n + j));
                }
            }
        }
    );
    return 0;
}
```

### 4.2 维度记忆

* 1D：`tbb::blocked_range<T>`
* 2D：`tbb::blocked_range2d<T>`：`rows()`、`cols()`
* 3D：`tbb::blocked_range3d<T>`：`pages()`、`rows()`、`cols()`

---

## 5. 缩并（Reduce）：从“共享变量”到 `parallel_reduce`

当任务存在“跨迭代依赖”（比如求和、统计），不要用共享变量直接累加，会数据竞争或锁开销巨大。
标准范式：**局部累加 + 合并**。

### 5.1 `parallel_reduce`（lambda 版：最常用）

```cpp
#include <tbb/parallel_reduce.h>
#include <tbb/blocked_range.h>
#include <cmath>
#include <cstddef>

int main() {
    const size_t n = 1u << 26;

    float sum = tbb::parallel_reduce(
        tbb::blocked_range<size_t>(0, n),
        0.0f, // identity
        [&](const tbb::blocked_range<size_t>& r, float local) -> float {
            for (size_t i = r.begin(); i != r.end(); ++i) {
                local += std::sinf((float)i);
            }
            return local;
        },
        [](float a, float b) -> float { return a + b; } // combine
    );

    (void)sum;
    return 0;
}
```

### 5.2 `parallel_deterministic_reduce`

浮点加法不满足结合律：合并顺序不同，末位可能不同。
若需要“每次运行更一致的合并顺序”，可考虑 deterministic 版本（可能略慢）。

---

## 6. 缩并（工程写法）：Reducer 结构体

当归约逻辑变复杂（多个字段、多统计量、希望复用），用结构体 reducer 更稳、更清晰。

### 6.1 结构体 reducer：并行 `sum sin(i)`

```cpp
#include <tbb/parallel_reduce.h>
#include <tbb/blocked_range.h>
#include <cmath>
#include <cstddef>

struct SinSumReducer {
    float sum;

    SinSumReducer() : sum(0.0f) {}                       // identity
    SinSumReducer(SinSumReducer&, tbb::split) : sum(0.0f) {} // split ctor

    void operator()(const tbb::blocked_range<size_t>& r) {
        float local = sum;
        for (size_t i = r.begin(); i != r.end(); ++i) {
            local += std::sinf((float)i);
        }
        sum = local;
    }

    void join(const SinSumReducer& rhs) {
        sum += rhs.sum;
    }
};

int main() {
    const size_t n = 1u << 26;
    SinSumReducer body;
    tbb::parallel_reduce(tbb::blocked_range<size_t>(0, n), body);
    float result = body.sum;
    (void)result;
    return 0;
}
```

### 6.2 多字段统计：sum / min / max / count

```cpp
#include <tbb/parallel_reduce.h>
#include <tbb/blocked_range.h>
#include <vector>
#include <limits>
#include <cstddef>

struct StatsReducer {
    double sum;
    float  mn;
    float  mx;
    size_t cnt;

    StatsReducer()
        : sum(0.0),
          mn(std::numeric_limits<float>::infinity()),
          mx(-std::numeric_limits<float>::infinity()),
          cnt(0) {}

    StatsReducer(StatsReducer&, tbb::split)
        : sum(0.0),
          mn(std::numeric_limits<float>::infinity()),
          mx(-std::numeric_limits<float>::infinity()),
          cnt(0) {}

    const std::vector<float>* a = nullptr;

    void operator()(const tbb::blocked_range<size_t>& r) {
        double s = sum;
        float  lo = mn, hi = mx;
        size_t c = cnt;

        for (size_t i = r.begin(); i != r.end(); ++i) {
            float v = (*a)[i];
            s += v;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
            ++c;
        }
        sum = s; mn = lo; mx = hi; cnt = c;
    }

    void join(const StatsReducer& rhs) {
        sum += rhs.sum;
        if (rhs.mn < mn) mn = rhs.mn;
        if (rhs.mx > mx) mx = rhs.mx;
        cnt += rhs.cnt;
    }
};

int main() {
    std::vector<float> a(1u<<20, 1.0f);

    StatsReducer body;
    body.a = &a;
    tbb::parallel_reduce(tbb::blocked_range<size_t>(0, a.size()), body);

    // body.sum/body.mn/body.mx/body.cnt
    return 0;
}
```

---

## 7. 线程本地累加器：`combinable` / `enumerable_thread_specific`

当模式是“每线程一份局部值，最后合并”，这两者非常实用。

### 7.1 `tbb::combinable<T>`（标量/小对象）

```cpp
#include <tbb/parallel_for.h>
#include <tbb/combinable.h>
#include <cmath>
#include <cstddef>

int main() {
    const size_t n = 1u << 26;
    tbb::combinable<double> tls_sum([]{ return 0.0; });

    tbb::parallel_for((size_t)0, n, [&](size_t i){
        tls_sum.local() += std::sin((double)i);
    });

    double sum = tls_sum.combine([](double a, double b){ return a + b; });
    (void)sum;
    return 0;
}
```

### 7.2 `tbb::enumerable_thread_specific<T>`

```cpp
#include <tbb/parallel_for.h>
#include <tbb/enumerable_thread_specific.h>
#include <vector>
#include <cstddef>

int main() {
    const size_t n = 1u << 20;
    std::vector<int> data(n, 0); // 假设值域 [0,255]

    tbb::enumerable_thread_specific<std::vector<size_t>> tls_hist(
        []{ return std::vector<size_t>(256, 0); }
    );

    tbb::parallel_for((size_t)0, n, [&](size_t i){
        tls_hist.local()[(unsigned)data[i]] += 1;
    });

    std::vector<size_t> hist(256, 0);
    for (auto& h : tls_hist)
        for (int b = 0; b < 256; ++b) hist[b] += h[b];

    return 0;
}
```

---

## 8. 扫描（Scan）：`parallel_scan`（前缀和/累计输出）

`parallel_scan` 常用于：前缀和、累计概率、积分图等。
关键机制：两阶段（pre-scan / final-scan），用 `is_final` 控制是否写输出。

### 8.1 `parallel_scan`（lambda 版）

```cpp
#include <tbb/parallel_scan.h>
#include <tbb/blocked_range.h>
#include <vector>
#include <cmath>
#include <cstddef>
#include <iostream>

int main() {
    const size_t n = 1u << 20;
    std::vector<float> prefix(n);

    float total = tbb::parallel_scan(
        tbb::blocked_range<size_t>(0, n),
        0.0f,
        [&](const tbb::blocked_range<size_t>& r, float running, bool is_final) -> float {
            for (size_t i = r.begin(); i != r.end(); ++i) {
                running += std::sinf((float)i);
                if (is_final) prefix[i] = running;
            }
            return running;
        },
        [](float a, float b) -> float { return a + b; }
    );

    std::cout << prefix[n/2] << "\n";
    std::cout << total << "\n";
    return 0;
}
```

### 8.2 `parallel_scan`（结构体版：工程范式）

```cpp
#include <tbb/parallel_scan.h>
#include <tbb/blocked_range.h>
#include <vector>
#include <type_traits>
#include <cstddef>

struct PrefixScanBody {
    const std::vector<float>& in;
    std::vector<float>& out;
    float sum;

    PrefixScanBody(const std::vector<float>& in_, std::vector<float>& out_)
        : in(in_), out(out_), sum(0.0f) {}

    PrefixScanBody(PrefixScanBody& b, tbb::split)
        : in(b.in), out(b.out), sum(0.0f) {}

    template <typename Tag>
    void operator()(const tbb::blocked_range<size_t>& r, Tag) {
        float temp = sum;
        for (size_t i = r.begin(); i != r.end(); ++i) {
            temp += in[i];
            if constexpr (std::is_same_v<Tag, tbb::final_scan_tag>) {
                out[i] = temp;
            }
        }
        sum = temp;
    }

    void reverse_join(PrefixScanBody& rhs) { sum += rhs.sum; }
    void assign(PrefixScanBody& rhs)       { sum  = rhs.sum; }
};

int main() {
    const size_t n = 1u << 20;
    std::vector<float> in(n, 1.0f);
    std::vector<float> out(n, 0.0f);

    PrefixScanBody body(in, out);
    tbb::parallel_scan(tbb::blocked_range<size_t>(0, n), body);
    return 0;
}
```

---

## 9. 任务域与嵌套：`task_arena` / `isolate`

### 9.1 `task_arena`：限制并行度 / 隔离并行区域

```cpp
#include <tbb/task_arena.h>
#include <tbb/parallel_for.h>
#include <vector>
#include <cmath>

int main() {
    const size_t n = 1u << 20;
    std::vector<float> a(n);

    tbb::task_arena arena(4); // 该区域最多 4 个线程参与
    arena.execute([&]{
        tbb::parallel_for((size_t)0, n, [&](size_t i){
            a[i] = std::sinf((float)i);
        });
    });
    return 0;
}
```

### 9.2 `this_task_arena::isolate`：禁止内部任务被窃取（隔离干扰）

```cpp
#include <tbb/this_task_arena.h>

tbb::this_task_arena::isolate([&]{
    // 这里 spawn 的任务更隔离，不易跨域被 steal
});
```

> 实务提醒：嵌套并行时不要依赖“线程固定/执行路径固定”。更推荐减少共享状态、用 reduce/tls 合并，或用 arena/isolate 控制并行边界。

---

## 10. 分块策略（Partitioner）：性能与可预测性

TBB 切分范围时可以指定 partitioner：

* `tbb::static_partitioner`：划分更固定、可预测
* `tbb::affinity_partitioner`：记录历史映射，提高缓存命中（适合重复执行的相似循环）
* `tbb::simple_partitioner`：简单切分策略

示例：观察每个线程拿到的块

```cpp
#include <tbb/parallel_for.h>
#include <tbb/blocked_range.h>
#include <tbb/task_arena.h>
#include <tbb/this_task_arena.h>
#include <iostream>

int main() {
    const size_t n = 32;
    tbb::task_arena arena(4);

    arena.execute([&]{
        tbb::parallel_for(
            tbb::blocked_range<size_t>(0, n),
            [&](const tbb::blocked_range<size_t>& r){
                std::cout
                    << "tid=" << tbb::this_task_arena::current_thread_index()
                    << " range=[" << r.begin() << "," << r.end() << ")"
                    << " size=" << r.size() << "\n";
            },
            tbb::static_partitioner{}
        );
    });
    return 0;
}
```

---

## 11. 全局并行度控制：`global_control`（工程常用）

当你不希望 TBB “吃满所有核”，可全局限制：

```cpp
#include <tbb/global_control.h>

int main() {
    tbb::global_control gc(tbb::global_control::max_allowed_parallelism, 8);
    // 后续 TBB 并行算法最多使用 8 个线程
    return 0;
}
```

---

## 12. 并发容器：`concurrent_vector`

特点：并发 push 更友好，但实现上可能是分段存储，不等同于 `std::vector` 的严格连续内存语义。

```cpp
#include <tbb/concurrent_vector.h>
#include <tbb/parallel_for.h>
#include <string>

int main() {
    tbb::concurrent_vector<std::string> out;

    tbb::parallel_for(0, 1000, [&](int i){
        out.push_back("item_" + std::to_string(i));
    });
    return 0;
}
```

---

## 13. 流水线并行：`parallel_pipeline`（I/O + compute 的标准解法）

适用：读入→解析→计算→写出，多阶段、不同并行度需求。

```cpp
#include <tbb/parallel_pipeline.h>
#include <tbb/flow_control.h>
#include <iostream>

int main() {
    int x = 0;

    tbb::parallel_pipeline(
        4, // max live tokens

        tbb::make_filter<void, int>(
            tbb::filter_mode::serial_in_order,
            [&](tbb::flow_control& fc) -> int {
                if (x >= 20) { fc.stop(); return 0; }
                return x++;
            }
        )
        &
        tbb::make_filter<int, int>(
            tbb::filter_mode::parallel,
            [&](int v) -> int {
                return v * v; // heavy compute
            }
        )
        &
        tbb::make_filter<int, void>(
            tbb::filter_mode::serial_in_order,
            [&](int y) {
                std::cout << y << "\n";
            }
        )
    );

    return 0;
}
```

---



## 补充
https://en.cppreference.com/w/cpp/language/access.html?utm_source=chatgpt.com
https://en.cppreference.com/w/cpp/language/operators.html?utm_source=chatgpt.com
https://mooshak.dcc.fc.up.pt/~oni-judge/doc/cppreference/reference/en/cpp/language/constructor.html?utm_source=chatgpt.com