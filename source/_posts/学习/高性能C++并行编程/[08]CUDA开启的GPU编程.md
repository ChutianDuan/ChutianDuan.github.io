---
title: "CUDA开启的GPU编程"
date: 2026-01-04 09:31:05
tags:
  - "CUDA"
  - "GPU"
  - "并行编程"
categories:
  - "学习"
  - "高性能C++并行编程"
thumbnail: /img/covers/cover2.jpg
---
# CUDA 开启的 GPU 编程

time：2025_12_26

---

## 1. 工程与编译（CMake / nvcc）

### 1.1 最小 CMake 工程

```cmake
cmake_minimum_required(VERSION 3.18)
project(hellocuda LANGUAGES CXX CUDA)

add_executable(main main.cu)

set_target_properties(main PROPERTIES
  CUDA_STANDARD 17
  CUDA_STANDARD_REQUIRED ON
)

# 需要跨 .cu 调用 device 函数/做 device link 时开启
set_target_properties(main PROPERTIES CUDA_SEPARABLE_COMPILATION ON)

# 常用 CUDA 编译选项（按需启用）
target_compile_options(main PUBLIC
  $<$<COMPILE_LANGUAGE:CUDA>:--expt-relaxed-constexpr>
  $<$<COMPILE_LANGUAGE:CUDA>:--expt-extended-lambda>
)
```

### 1.2 推荐的基础错误检查宏

避免依赖 sample 的 `helper_cuda.h`，直接自带一个最小版：

```cpp
#include <cstdio>
#include <cstdlib>
#include <cuda_runtime.h>

#define CUDA_CHECK(call) do {                                  \
  cudaError_t err = (call);                                    \
  if (err != cudaSuccess) {                                    \
    std::fprintf(stderr, "CUDA error %s:%d: %s\n",             \
      __FILE__, __LINE__, cudaGetErrorString(err));            \
    std::exit(1);                                              \
  }                                                            \
} while(0)
```

---

## 2. CUDA 基础：函数修饰符与执行位置

### 2.1 `__global__ / __device__ / __host__`

* `__global__`：核函数（kernel）

  * 在 GPU 上并行执行
  * 由主机端（CPU）发起 `<<<...>>>`
  * 返回类型必须为 `void`（通常通过指针写回结果）
* `__device__`：设备函数

  * 在 GPU 上执行
  * 只能从 device/global 调用
* `__host__`：主机函数

  * 在 CPU 上执行
  * 未标注的普通函数默认就是 host

组合：

* `__host__ __device__`：同一函数在 CPU/GPU 两侧都可用（注意 device 侧不支持完整的 C++ 标准库能力）

### 2.2 `__CUDA_ARCH__`（区分 device/host 编译路径）

* `__CUDA_ARCH__` 只在 device 编译路径中定义，值为计算能力架构号（例如 750/800 等）
* 常用于同一个函数在 host/device 的条件编译

```cuda
__host__ __device__ inline int where_am_i() {
#ifdef __CUDA_ARCH__
    return __CUDA_ARCH__;   // device：架构号
#else
    return -1;              // host：标记
#endif
}
```

### 2.3 `constexpr` 与 device 代码

* 如需更宽松的 `constexpr` 在 device 侧工作，常用 `--expt-relaxed-constexpr`
* device 侧 lambda 扩展常用 `--expt-extended-lambda`

---

## 3. Kernel 启动、线程块模型与索引

### 3.1 Kernel 启动语法

```cpp
kernel<<<grid, block, shared_bytes, stream>>>(args...);
```

* 常用：`<<<grid, block>>>`
* `shared_bytes`：动态共享内存字节数（默认 0）
* `stream`：CUDA 流（默认 0）

### 3.2 线程/块索引

* `threadIdx.{x,y,z}`：线程在块内索引
* `blockIdx.{x,y,z}`：块在网格内索引
* `blockDim.{x,y,z}`：每块线程数维度
* `gridDim.{x,y,z}`：网格块数维度

### 3.3 典型打印示例（便于理解执行模型）

```cuda
#include <cstdio>
#include <cuda_runtime.h>

__global__ void kernel() {
    printf("block %d/%d, thread %d/%d\n",
           blockIdx.x, gridDim.x,
           threadIdx.x, blockDim.x);
}

int main() {
    kernel<<<2, 3>>>();
    cudaDeviceSynchronize();
    return 0;
}
```

### 3.4 Grid-Stride Loop（通用遍历范式）

适用于任意大小数据与任意 grid/block 配置：

```cuda
__global__ void work(int* a, int n) {
    for (int i = blockIdx.x * blockDim.x + threadIdx.x;
         i < n;
         i += blockDim.x * gridDim.x) {
        a[i] = i;
    }
}
```

---

## 4. 同步与错误处理

### 4.1 CPU/GPU 默认异步

* kernel launch 对 host 来说通常是异步的
* 常用同步：

  * `cudaDeviceSynchronize()`：等待当前设备上所有已提交工作完成
  * `cudaStreamSynchronize(stream)`：等待某个流完成

### 4.2 推荐的 launch 后检查模板

```cpp
kernel<<<grid, block>>>(...);
CUDA_CHECK(cudaGetLastError());
CUDA_CHECK(cudaDeviceSynchronize());
```

---

## 5. 内存管理（Host/Device/Unified）

### 5.1 经典模式：`cudaMalloc + cudaMemcpy`

```cuda
#include <cstdio>
#include <cuda_runtime.h>

#define CUDA_CHECK(call) do { \
  cudaError_t err = (call); \
  if (err != cudaSuccess) { \
    std::fprintf(stderr, "CUDA error: %s\n", cudaGetErrorString(err)); \
    std::exit(1); \
  } \
} while(0)

__global__ void kernel(int* out) { *out = 42; }

int main() {
    int* d_out = nullptr;
    CUDA_CHECK(cudaMalloc(&d_out, sizeof(int)));

    kernel<<<1,1>>>(d_out);
    CUDA_CHECK(cudaGetLastError());
    CUDA_CHECK(cudaDeviceSynchronize());

    int h_out = 0;
    CUDA_CHECK(cudaMemcpy(&h_out, d_out, sizeof(int), cudaMemcpyDeviceToHost));

    std::printf("ret=%d\n", h_out);

    CUDA_CHECK(cudaFree(d_out));
    return 0;
}
```

### 5.2 统一内存（Unified Memory）：`cudaMallocManaged`

* 一份指针同时可被 CPU/GPU 访问
* 常配合同步；性能敏感时可用预取提升稳定性

```cuda
#include <cstdio>
#include <cuda_runtime.h>

__global__ void fill(int* a, int n) {
    for (int i = blockIdx.x * blockDim.x + threadIdx.x;
         i < n; i += blockDim.x * gridDim.x) {
        a[i] = i;
    }
}

int main() {
    int n = 32;
    int* a = nullptr;
    cudaMallocManaged(&a, sizeof(int) * n);

    fill<<<1, 128>>>(a, n);
    cudaDeviceSynchronize();

    for (int i = 0; i < n; ++i) std::printf("a[%d]=%d\n", i, a[i]);
    cudaFree(a);
    return 0;
}
```

### 5.3 预取（Prefetch）与驻留优化（进阶但常用）

```cpp
int dev = 0;
cudaGetDevice(&dev);
cudaMemPrefetchAsync(a, sizeof(int)*n, dev, 0);     // 预取到 GPU
// kernel ...
cudaMemPrefetchAsync(a, sizeof(int)*n, cudaCpuDeviceId, 0); // 预取回 CPU
cudaDeviceSynchronize();
```

---

## 6. C++ 封装：RAII 与可复用接口

### 6.1 RAII 管理 Unified Memory 指针（简单、可靠、适合入门）

```cpp
#include <cuda_runtime.h>
#include <cstddef>

template<class T>
struct ManagedArray {
    T* p{nullptr};
    size_t n{0};

    explicit ManagedArray(size_t n_) : n(n_) {
        cudaMallocManaged(&p, sizeof(T) * n);
    }
    ~ManagedArray() {
        if (p) cudaFree(p);
    }
    T* data() { return p; }
    const T* data() const { return p; }
    T& operator[](size_t i) { return p[i]; }
    const T& operator[](size_t i) const { return p[i]; }
};
```

### 6.2 结合 kernel 使用

```cuda
__global__ void init(int* a, int n) {
    for (int i = blockIdx.x * blockDim.x + threadIdx.x;
         i < n; i += blockDim.x * gridDim.x) {
        a[i] = i;
    }
}

int main() {
    int n = 1000;
    ManagedArray<int> a(n);
    init<<<32, 128>>>(a.data(), n);
    cudaDeviceSynchronize();
    // CPU 侧直接读
    return 0;
}
```

> allocator 方式也可把 unified memory 接入 `std::vector`，但 allocator 细节较多；建议先把 RAII 指针与 `.data()` 传参掌握牢。

---

## 7. Thrust 库：容器与算法（高层 CUDA）

### 7.1 常用容器

* `thrust::host_vector<T>`：主机端 vector
* `thrust::device_vector<T>`：设备端 vector
* 通过赋值可触发 H2D / D2H 拷贝（更准确地说：构造/赋值会在 host/device 容器之间进行数据迁移）

### 7.2 AXPY 示例（device_vector + 自写 kernel）

```cuda
#include <thrust/host_vector.h>
#include <thrust/device_vector.h>
#include <cuda_runtime.h>
#include <cstdio>

__global__ void axpy(float* x, const float* y, float a, int n) {
    for (int i = blockIdx.x * blockDim.x + threadIdx.x;
         i < n; i += blockDim.x * gridDim.x) {
        x[i] = a * x[i] + y[i];
    }
}

int main() {
    int n = 1 << 20;
    float a = 3.14f;

    thrust::host_vector<float> hx(n), hy(n);
    for (int i = 0; i < n; ++i) { hx[i] = i * 0.001f; hy[i] = 1.0f; }

    thrust::device_vector<float> dx = hx;
    thrust::device_vector<float> dy = hy;

    axpy<<<256, 256>>>(thrust::raw_pointer_cast(dx.data()),
                       thrust::raw_pointer_cast(dy.data()),
                       a, n);
    cudaDeviceSynchronize();

    hx = dx;
    std::printf("hx[0]=%f, hx[n-1]=%f\n", hx[0], hx[n-1]);
    return 0;
}
```

---

## 8. 原子操作（Atomic）

### 8.1 常用原子

* `atomicAdd / atomicSub`
* `atomicAnd / atomicOr / atomicXor`
* `atomicMin / atomicMax`
* `atomicCAS`：Compare-And-Swap，可用于构造自定义原子操作

### 8.2 用 CAS 实现自定义原子加

```cuda
__device__ __forceinline__ int my_atomic_add(int* dst, int val) {
    int old = *dst;
    int assumed;
    do {
        assumed = old;
        old = atomicCAS(dst, assumed, assumed + val);
    } while (assumed != old);
    return old;
}
```

### 8.3 朴素并行求和（全局原子累加）

```cuda
__global__ void parallel_sum(int* sum, const int* arr, int n) {
    for (int i = blockIdx.x * blockDim.x + threadIdx.x;
         i < n; i += blockDim.x * gridDim.x) {
        atomicAdd(sum, arr[i]);
    }
}
```

---

## 9. 线程块与共享内存（Shared Memory）

### 9.1 核心概念

* `__shared__`：块内共享内存（一个 block 内所有线程可见）
* `__syncthreads()`：块内同步屏障（必须保证同一 block 的线程都能到达）

共享内存常用于：

* 块内复用数据（减少 global memory 访问）
* 块内归约（reduce）
* tile-based 计算（矩阵乘、卷积、图像算子）

### 9.2 块内归约：每块只做一次全局原子

```cuda
#include <cuda_runtime.h>

__global__ void reduce_sum(const int* arr, int n, int* out) {
    extern __shared__ int sdata[]; // 动态共享内存
    int tid = threadIdx.x;
    int i = blockIdx.x * blockDim.x + tid;

    sdata[tid] = (i < n) ? arr[i] : 0;
    __syncthreads();

    for (int s = blockDim.x / 2; s > 0; s >>= 1) {
        if (tid < s) sdata[tid] += sdata[tid + s];
        __syncthreads();
    }

    if (tid == 0) atomicAdd(out, sdata[0]);
}
```

启动方式（动态共享内存大小）：

```cpp
int threads = 256;
int blocks = (n + threads - 1) / threads;
reduce_sum<<<blocks, threads, threads * sizeof(int)>>>(arr, n, out);
```

### 9.3 Tile 示例：2D 图像 3x3 均值滤波（共享内存加速范式）

适用于图像/矩阵类任务（tile + halo）：

```cuda
#include <cuda_runtime.h>

__global__ void mean3x3(const float* in, float* out, int H, int W) {
    // blockDim = (Bx, By)
    const int x = blockIdx.x * blockDim.x + threadIdx.x;
    const int y = blockIdx.y * blockDim.y + threadIdx.y;

    // tile 尺寸：块大小 + halo(上下左右各1)
    const int Bx = blockDim.x;
    const int By = blockDim.y;
    extern __shared__ float tile[];

    // tile 索引函数
    auto t = [&](int ty, int tx) -> float& {
        return tile[ty * (Bx + 2) + tx];
    };

    // 对应 tile 坐标（+1 是为了留 halo）
    const int tx = threadIdx.x + 1;
    const int ty = threadIdx.y + 1;

    // 读主区域
    float v = 0.f;
    if (x < W && y < H) v = in[y * W + x];
    t(ty, tx) = v;

    // 读 halo（边界处做 clamp 或置零，这里用置零策略）
    if (threadIdx.x == 0) {
        float lv = (x > 0 && y < H) ? in[y * W + (x - 1)] : 0.f;
        t(ty, 0) = lv;
    }
    if (threadIdx.x == Bx - 1) {
        float rv = (x + 1 < W && y < H) ? in[y * W + (x + 1)] : 0.f;
        t(ty, Bx + 1) = rv;
    }
    if (threadIdx.y == 0) {
        float uv = (y > 0 && x < W) ? in[(y - 1) * W + x] : 0.f;
        t(0, tx) = uv;
    }
    if (threadIdx.y == By - 1) {
        float dv = (y + 1 < H && x < W) ? in[(y + 1) * W + x] : 0.f;
        t(By + 1, tx) = dv;
    }

    // 角落 halo（四个角）
    if (threadIdx.x == 0 && threadIdx.y == 0) {
        t(0,0) = (x>0 && y>0) ? in[(y-1)*W + (x-1)] : 0.f;
    }
    if (threadIdx.x == Bx-1 && threadIdx.y == 0) {
        t(0,Bx+1) = (x+1<W && y>0) ? in[(y-1)*W + (x+1)] : 0.f;
    }
    if (threadIdx.x == 0 && threadIdx.y == By-1) {
        t(By+1,0) = (x>0 && y+1<H) ? in[(y+1)*W + (x-1)] : 0.f;
    }
    if (threadIdx.x == Bx-1 && threadIdx.y == By-1) {
        t(By+1,Bx+1) = (x+1<W && y+1<H) ? in[(y+1)*W + (x+1)] : 0.f;
    }

    __syncthreads();

    if (x < W && y < H) {
        float sum = 0.f;
        sum += t(ty-1, tx-1); sum += t(ty-1, tx); sum += t(ty-1, tx+1);
        sum += t(ty,   tx-1); sum += t(ty,   tx); sum += t(ty,   tx+1);
        sum += t(ty+1, tx-1); sum += t(ty+1, tx); sum += t(ty+1, tx+1);
        out[y * W + x] = sum / 9.f;
    }
}
```

共享内存大小（字节）：

```cpp
dim3 block(16, 16);
dim3 grid((W + block.x - 1) / block.x, (H + block.y - 1) / block.y);
size_t shared_bytes = (block.x + 2) * (block.y + 2) * sizeof(float);
mean3x3<<<grid, block, shared_bytes>>>(in, out, H, W);
```

---

## 10. CUDA Streams 与异步拷贝

### 10.1 为什么需要 streams

* 默认 stream（stream 0）会形成较强的串行依赖
* 多 stream 可以实现：

  * H2D 拷贝与 kernel 重叠
  * 多批次流水线（pipeline）
  * 与 `cudaMemcpyAsync` 配合提升吞吐

### 10.2 pinned（页锁定）主机内存：提升异步拷贝效率

* `cudaMallocHost` / `cudaFreeHost`
* pinned 内存更利于 DMA，`cudaMemcpyAsync` 才更有意义

### 10.3 基本模板：两条 stream 流水搬运

```cuda
#include <cstdio>
#include <cuda_runtime.h>

#define CUDA_CHECK(call) do {                                  \
  cudaError_t err = (call);                                    \
  if (err != cudaSuccess) {                                    \
    std::fprintf(stderr, "CUDA error %s:%d: %s\n",             \
      __FILE__, __LINE__, cudaGetErrorString(err));            \
    std::exit(1);                                              \
  }                                                            \
} while(0)

__global__ void scale(float* x, int n, float a) {
    for (int i = blockIdx.x * blockDim.x + threadIdx.x;
         i < n; i += blockDim.x * gridDim.x) {
        x[i] *= a;
    }
}

int main() {
    const int n = 1 << 20;
    const size_t bytes = n * sizeof(float);

    // pinned host memory
    float* h = nullptr;
    CUDA_CHECK(cudaMallocHost(&h, bytes));

    // device memory
    float* d = nullptr;
    CUDA_CHECK(cudaMalloc(&d, bytes));

    // init host
    for (int i = 0; i < n; ++i) h[i] = 1.0f;

    cudaStream_t s;
    CUDA_CHECK(cudaStreamCreate(&s));

    // async H2D
    CUDA_CHECK(cudaMemcpyAsync(d, h, bytes, cudaMemcpyHostToDevice, s));

    // kernel in same stream (will wait for H2D in this stream)
    scale<<<256, 256, 0, s>>>(d, n, 2.0f);
    CUDA_CHECK(cudaGetLastError());

    // async D2H
    CUDA_CHECK(cudaMemcpyAsync(h, d, bytes, cudaMemcpyDeviceToHost, s));

    // wait stream done
    CUDA_CHECK(cudaStreamSynchronize(s));

    std::printf("h[0]=%f, h[n-1]=%f\n", h[0], h[n-1]);

    CUDA_CHECK(cudaStreamDestroy(s));
    CUDA_CHECK(cudaFree(d));
    CUDA_CHECK(cudaFreeHost(h));
    return 0;
}
```

### 10.4 事件计时（event timing）

用于测量 GPU 端耗时：

```cpp
cudaEvent_t st, ed;
cudaEventCreate(&st); cudaEventCreate(&ed);

cudaEventRecord(st, stream);
// kernel / memcpyAsync ...
cudaEventRecord(ed, stream);
cudaEventSynchronize(ed);

float ms = 0.f;
cudaEventElapsedTime(&ms, st, ed);
```

