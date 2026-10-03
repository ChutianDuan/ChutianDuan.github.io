---
title: "库自己能编译，为什么链接它的程序却找不到头文件？"
date: 2026-07-13 15:24:58
updated: 2026-07-13 15:24:58
categories:
  - "学习"
  - "Linux 与 C++ 工程化"
permalink: /notes/liunx-c-工程化/1-cmake学习笔记/
series: "Linux 与 C++ 工程化"
series_order: 1
---

> 关键词：现代 CMake、target、使用要求、`PUBLIC`、`PRIVATE`、`INTERFACE`、安装、RPATH

一个 C++ 库单独构建完全正常，加入可执行程序后却报错：

```text
fatal error: 'greeting/greeting.hpp' file not found
```

对应的 CMake 看起来也没有少什么：

```cmake
add_library(greeting src/greeting.cpp)
target_include_directories(greeting PRIVATE include)

add_executable(app app/main.cpp)
target_link_libraries(app PRIVATE greeting)
```

`greeting.cpp` 能找到公共头文件，为什么已经链接 `greeting` 的 `app` 反而找不到？

问题在于 `include` 被声明成了 `greeting` 的私有构建要求。它只用于编译库自身，没有进入库的“使用要求”（usage requirements），所以不会传播给消费者。

这正是现代 CMake 最值得理解的核心：

> CMake 工程不是一堆全局编译参数，而是一张 target 依赖图；每个 target 同时描述“怎样构建自己”和“别人怎样正确使用我”。

本文会从这个头文件错误出发，讲清：

1. 编译、链接和运行时加载为什么是三个不同阶段；
2. `PRIVATE`、`PUBLIC`、`INTERFACE` 如何传播；
3. 怎样写出一个可构建、可测试、可安装的最小项目；
4. `find_package()`、vcpkg、构建配置和 RPATH 如何接入同一 target 模型；
5. 遇到“找不到头文件、undefined reference、找不到动态库”时如何判断故障层次。

示例以 CMake 3.20 为最低版本，并已在 CMake 3.21.3、Apple Clang 17 上验证。更新版本通常兼容这些基础用法；生成器、平台和第三方包行为仍应在目标环境验证。

---

## 一、先分清：CMake 并不负责直接编译 C++

CMake 是构建系统生成器。执行：

```bash
cmake -S . -B build
```

它会读取 `CMakeLists.txt`、检测工具链、查找依赖，并为 Unix Makefiles、Ninja、Xcode 或 Visual Studio 等生成器创建构建规则。

随后：

```bash
cmake --build build
```

才会调用底层构建工具，再由编译器和链接器产生程序：

```text
CMake 配置 / 生成
        ↓
底层构建工具调度任务
        ↓
.cpp ──编译──▶ .o / .obj
        ↓
目标文件 + 库 ──链接──▶ 可执行文件或动态库
        ↓
程序启动 ──动态加载器查找──▶ .so / .dylib / .dll
```

三个阶段的错误不能混在一起处理：

| 典型错误 | 所在阶段 | 优先检查 |
| --- | --- | --- |
| `header not found` | 编译 | include 路径、生成头文件、使用要求 |
| `undefined reference/symbol` | 链接 | 实现源文件、链接 target、ABI 与架构 |
| `Library not loaded` | 程序启动 | 安装布局、RPATH、间接动态依赖 |

给编译器增加 include 路径不能修复缺失符号；给链接器增加库也不能修复运行时加载路径。先判断层次，排障会简单很多。

---

## 二、target 为什么比全局变量更重要？

`add_library()` 和 `add_executable()` 创建逻辑 target：

```cmake
add_library(greeting src/greeting.cpp)
add_executable(greeting_cli app/main.cpp)
```

target 不只是最终文件名。它可以携带：

- 源文件；
- 头文件搜索目录；
- 所需 C++ 语言特性；
- 编译宏和编译选项；
- 链接依赖与链接选项；
- 构建目录和安装目录中的使用方式。

通过：

```cmake
target_link_libraries(greeting_cli PRIVATE greeting)
```

建立依赖边后，CMake 不只把 `greeting` 交给链接器，还会把它公开的使用要求传给 `greeting_cli`。

可以把 target 想成一份可组合的构建契约：

```text
greeting target
  ├─ 自己的源码：src/greeting.cpp
  ├─ 自己和消费者都需要：include/
  ├─ 公共头文件要求：C++17
  └─ 链接产物：libgreeting
                  ↓ target_link_libraries
greeting_cli 自动获得消费者所需信息
```

这比在根目录调用 `include_directories()`、修改 `CMAKE_CXX_FLAGS` 更可靠，因为全局设置会无差别影响当前目录及子目录中的多个 target，让依赖关系变得不可见。

---

## 三、`PRIVATE`、`PUBLIC`、`INTERFACE` 到底在描述什么？

| 关键字 | 构建当前 target 时使用 | 消费当前 target 时传播 |
| --- | --- | --- |
| `PRIVATE` | 是 | 否 |
| `PUBLIC` | 是 | 是 |
| `INTERFACE` | 否 | 是 |

判断方法不是“这个库重要不重要”，而是信息出现在哪里。

### 只在 `.cpp` 实现中出现：`PRIVATE`

```cmake
target_link_libraries(greeting PRIVATE InternalParser::parser)
```

如果公共头文件没有暴露 `InternalParser` 的头文件或类型，消费者不需要知道它。

### 当前库与公共头文件消费者都需要：`PUBLIC`

```cmake
target_include_directories(greeting PUBLIC include)
target_compile_features(greeting PUBLIC cxx_std_17)
```

`greeting` 自己包含公共头文件；消费者也需要找到它。公共头文件使用了 `std::string_view`，消费者编译该头文件时也需要足够的 C++ 标准。

### 当前 target 没有源码，只有消费者需要：`INTERFACE`

```cmake
add_library(project_warnings INTERFACE)
target_compile_options(project_warnings INTERFACE -Wall -Wextra)
```

`INTERFACE` 常用于纯头文件库或一组可复用使用要求。编译器相关参数仍要通过生成器表达式区分 GCC、Clang 和 MSVC，不应把 `-Wall` 无条件传给所有平台。

还有一个容易混淆的细节：

```cmake
target_link_libraries(greeting_cli PRIVATE greeting)
```

这里的 `PRIVATE` 不会阻止 `greeting_cli` 消费 `greeting` 的公开要求；它表示 `greeting_cli` 自己若再被其他 target 使用，不继续把这条依赖作为自己的接口传播。

---

## 四、最小可运行项目：让依赖自动传播

目录结构：

```text
greeting-project/
├── CMakeLists.txt
├── include/
│   └── greeting/
│       └── greeting.hpp
├── src/
│   └── greeting.cpp
└── app/
    └── main.cpp
```

公共头文件 `include/greeting/greeting.hpp`：

```cpp
#pragma once

#include <string>
#include <string_view>

namespace greeting {

std::string make_message(std::string_view name);

}  // namespace greeting
```

实现文件 `src/greeting.cpp`：

```cpp
#include "greeting/greeting.hpp"

namespace greeting {

std::string make_message(std::string_view name) {
    return "Hello, " + std::string{name} + "!";
}

}  // namespace greeting
```

程序入口 `app/main.cpp`：

```cpp
#include "greeting/greeting.hpp"

#include <iostream>
#include <string_view>

int main(int argc, char** argv) {
    const std::string_view name = argc > 1 ? argv[1] : "world";
    std::cout << greeting::make_message(name) << '\n';
}
```

顶层 `CMakeLists.txt`：

```cmake
cmake_minimum_required(VERSION 3.20)

project(Greeting VERSION 1.0 LANGUAGES CXX)

include(CTest)
include(GNUInstallDirs)

add_library(greeting
    src/greeting.cpp
)
add_library(Greeting::greeting ALIAS greeting)

target_compile_features(greeting
    PUBLIC
        cxx_std_17
)

target_include_directories(greeting
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>
)

add_executable(greeting_cli
    app/main.cpp
)

target_link_libraries(greeting_cli
    PRIVATE
        Greeting::greeting
)

if(BUILD_TESTING)
    add_test(
        NAME greeting_cli_output
        COMMAND greeting_cli CMake
    )
    set_tests_properties(greeting_cli_output PROPERTIES
        PASS_REGULAR_EXPRESSION "Hello, CMake!"
    )
endif()

install(TARGETS greeting greeting_cli
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
    LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
)

install(DIRECTORY include/
    DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}
)
```

配置、构建、测试与运行：

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build --parallel 4
ctest --test-dir build --output-on-failure
./build/greeting_cli CMake
```

预期程序输出：

```text
Hello, CMake!
```

项目没有给 `greeting_cli` 手工添加 include 路径或 C++17 参数。它链接 `Greeting::greeting` 后，CMake 从依赖 target 的接口自动收集这些要求。

---

## 五、`BUILD_INTERFACE` 和 `INSTALL_INTERFACE` 为什么要分开？

同一份公共头文件在两个阶段位于不同位置：

```text
源码树构建：/path/to/project/include/greeting/greeting.hpp
安装后：    <prefix>/include/greeting/greeting.hpp
```

因此：

```cmake
target_include_directories(greeting PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>
)
```

在源码树使用 target 时展开 `BUILD_INTERFACE`；导出并安装 target 后，由消费者使用 `INSTALL_INTERFACE`。安装接口应使用相对安装前缀的路径，不要把 `/Users/name/project/include` 或 `/home/name/project/include` 写进发布包。

本文的最小示例安装了产物和头文件，但没有生成完整的 `GreetingConfig.cmake` 包配置。若要让另一个项目通过：

```cmake
find_package(Greeting CONFIG REQUIRED)
```

使用它，还需要 `install(EXPORT ...)`、包配置文件和版本文件。这属于“发布 CMake package”的下一层工作，不能因为复制了 `.a` 与头文件就声称包已经可被 `find_package()` 发现。

执行本地安装布局验证：

```bash
cmake --install build --prefix ./stage
```

典型结果：

```text
stage/
├── bin/greeting_cli
├── include/greeting/greeting.hpp
└── lib/libgreeting.a
```

`GNUInstallDirs` 会根据平台和安装前缀选择常见目录名，实际布局应以配置结果为准。

---

## 六、为什么公共头文件也会决定 C++ 标准？

示例头文件暴露了 `std::string_view`。即使 `app/main.cpp` 自己没有主动选择 C++17，它仍要用支持该类型的语言模式解析公共头文件。

因此：

```cmake
target_compile_features(greeting PUBLIC cxx_std_17)
```

比只给库实现加 `-std=c++17` 更准确。它描述的是接口最低要求，并传播给消费者。

`target_compile_features()` 表达“需要某项语言能力”，CMake 决定是否添加对应标准选项。小型且标准统一的项目也可以设置：

```cmake
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
```

但可复用库更适合把真实要求放在 target 上，避免作为子目录加入其他工程时修改整个父项目。

同样的原则适用于编译宏和依赖：公共头文件用到的 ABI 宏或第三方类型，通常需要 `PUBLIC` 或 `INTERFACE`；只影响 `.cpp` 实现的配置使用 `PRIVATE`。

---

## 七、源码目录变量应该选哪一个？

| 变量 | 指向什么 |
| --- | --- |
| `CMAKE_SOURCE_DIR` | 最外层 CMake 源码根目录 |
| `PROJECT_SOURCE_DIR` | 最近一次 `project()` 对应源码目录 |
| `CMAKE_CURRENT_SOURCE_DIR` | 当前 `CMakeLists.txt` 所在源码目录 |
| `CMAKE_CURRENT_LIST_DIR` | 当前正在解析的 `.cmake` 文件目录 |
| `CMAKE_BINARY_DIR` | 最外层构建目录 |
| `CMAKE_CURRENT_BINARY_DIR` | 当前目录对应构建目录 |

单一顶层项目中，前几项可能恰好相等，导致问题长期隐藏。当该项目通过 `add_subdirectory()` 成为别人项目的一部分时，`CMAKE_SOURCE_DIR` 会指向最外层宿主。

可复用子目录通常使用 `CMAKE_CURRENT_SOURCE_DIR`；可复用 `.cmake` 模块查找相邻文件通常使用 `CMAKE_CURRENT_LIST_DIR`。不要假设自己永远是顶层项目。

多目录工程可以保持简单：顶层声明项目和添加子目录，各目录只配置自己拥有的 target。不要为了“分层”制造大量只转发变量的 CMake 文件。

---

## 八、Debug 与 Release 为什么在不同生成器上用法不同？

Unix Makefiles 和普通 Ninja 通常是单配置生成器，在配置时选择：

```bash
cmake -S . -B build/debug -DCMAKE_BUILD_TYPE=Debug
cmake -S . -B build/release -DCMAKE_BUILD_TYPE=Release

cmake --build build/debug
cmake --build build/release
```

Visual Studio、Xcode 和 Ninja Multi-Config 通常在构建时选择：

```bash
cmake -S . -B build
cmake --build build --config Debug
cmake --build build --config Release
ctest --test-dir build -C Release --output-on-failure
```

因此不要在 `CMakeLists.txt` 中强行覆盖 `CMAKE_BUILD_TYPE`，也不要假设程序始终位于 `build/app`。多配置生成器可能放到 `build/Debug/` 等目录。

性能测试应使用 Release 或 RelWithDebInfo，并确认实际编译命令；调试时可使用 Debug。构建类型名称不是跨所有工具链都具有完全相同旗标的标准契约，具体优化和运行库仍应查看目标环境。

`CMakePresets.json` 可以把生成器、binary directory、cache 变量和 toolchain 组合成团队可复用的配置。Preset schema 版本与客户端 CMake 版本有关，提交前应以项目声明的最低 CMake 版本验证；个人机器路径放入通常不提交的 `CMakeUserPresets.json`。

---

## 九、`find_package()` 为什么不等于“安装依赖”？

```cmake
find_package(fmt CONFIG REQUIRED)
target_link_libraries(greeting PRIVATE fmt::fmt)
```

`find_package()` 在配置阶段寻找包信息并创建 imported target；它本身通常不负责下载和安装包。依赖可能由系统包管理器、vcpkg、Conan、源码子项目或 SDK 提供。

imported target 的价值与本地 target 相同：它携带库文件位置、include 目录、编译宏和间接依赖。优先链接 `fmt::fmt` 之类 target，不要手工猜 `-I`、`-L` 和平台库文件名。

找不到包时，先区分三个名称：

| 名称 | 示例 | 使用位置 |
| --- | --- | --- |
| 包管理器 port | `fmt` | vcpkg manifest |
| CMake package | `fmt` 或 `Boost` | `find_package()` |
| CMake target | `fmt::fmt`、`Boost::filesystem` | `target_link_libraries()` |

它们经常不同，不能从 port 名推测 target 名。以包的官方 usage、安装输出和 `*Config.cmake` 为准。

排查查找过程时，支持该参数的 CMake 可使用：

```bash
cmake --debug-find-pkg=fmt -S . -B build
```

该参数在 CMake 3.23 引入；更低版本可使用范围更广、输出更多的 `--debug-find`，或升级项目工具后验证。

---

## 十、vcpkg toolchain 为什么要在第一次配置时确定？

Manifest 模式用 `vcpkg.json` 声明项目依赖：

```json
{
  "dependencies": [
    "fmt",
    "zlib"
  ]
}
```

让 CMake 使用 vcpkg：

```bash
cmake -S . -B build \
  -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake"
```

toolchain 会影响编译器、平台检测和包查找，应在第一次 `project()` 配置之前生效。更适合通过命令行或 preset 设置，而不是在 `project()` 之后临时 `set(CMAKE_TOOLCHAIN_FILE ...)`。

CMake 会把 toolchain 和许多查找结果写入 `CMakeCache.txt`。已经用系统依赖配置过的构建目录，再改成 vcpkg toolchain，可能继续残留旧路径。切换编译器、toolchain、架构或 vcpkg triplet 时，优先使用新的构建目录。

CMake 3.24 及以上也提供：

```bash
cmake --fresh -S . -B build
```

但项目最低版本若更低，仍应使用新目录或按项目流程清理生成目录。不要删除来源不明的构建或产出目录；只处理明确可再生成的当前构建树。

vcpkg manifest、baseline、feature 和 triplet 的命令细节会随工具版本演进，应以项目锁定版本和 Microsoft 官方文档为准。不要在 CMake 文件中硬编码个人 vcpkg 安装路径。

---

## 十一、`install()` 成功，为什么程序仍可能找不到动态库？

构建和安装是不同布局：

```text
build/：编译过程的临时产物和构建系统文件
stage/：按照 install 规则整理后的交付布局
```

当 `greeting` 构建为共享库时，链接成功只证明链接器找到了它。程序启动时，操作系统动态加载器还要再次定位 `.so`、`.dylib` 或 `.dll`。

Unix-like 平台可根据交付布局设置相对 RPATH：

```cmake
if(APPLE)
    set_target_properties(greeting_cli PROPERTIES
        INSTALL_RPATH "@loader_path/../${CMAKE_INSTALL_LIBDIR}"
    )
elseif(UNIX)
    set_target_properties(greeting_cli PROPERTIES
        BUILD_RPATH_USE_ORIGIN TRUE
        INSTALL_RPATH "$ORIGIN/../${CMAKE_INSTALL_LIBDIR}"
    )
endif()
```

- Linux `$ORIGIN` 以当前 ELF 对象所在目录为基准；
- macOS `@loader_path` 以正在加载依赖的 Mach-O 对象为基准；
- Windows 没有同样的 RPATH，常见部署会把应用 DLL 放在受控搜索目录，通常是可执行文件旁。

不要把开发机的绝对 build 路径写入发布 RPATH。临时设置 `LD_LIBRARY_PATH` 或 `DYLD_LIBRARY_PATH` 可以帮助排查，但不是可靠交付方案。

检查依赖：

```bash
# Linux
readelf -d ./stage/bin/greeting_cli
ldd ./stage/bin/greeting_cli

# macOS
otool -L ./stage/bin/greeting_cli
otool -l ./stage/bin/greeting_cli
```

是否需要自定义 RPATH 取决于动态库类型、安装前缀、系统 loader 和打包方式，应在实际安装产物上验证，而不是只检查 build 目录程序。

---

## 十二、STATIC、SHARED、MODULE 和 INTERFACE 应该怎样选？

| `add_library` 类型 | 产物与使用方式 |
| --- | --- |
| `STATIC` | 静态归档，消费者链接所需对象，运行时通常不需要该归档 |
| `SHARED` | 动态库，消费者链接并由 loader 在运行时加载 |
| `MODULE` | 插件模块，通常由 `dlopen()` / `LoadLibraryExW()` 显式加载 |
| `INTERFACE` | 不产生二进制，只传播使用要求 |

省略类型时，`BUILD_SHARED_LIBS` 决定普通库默认形态：

```cmake
option(BUILD_SHARED_LIBS "Build shared libraries" OFF)
add_library(greeting src/greeting.cpp)
```

插件通常应提供版本化、稳定的 C ABI 入口，例如：

```cpp
extern "C" int plugin_init(unsigned host_api_version);
```

这只能避免 C++ name mangling，不能自动解决编译器、标准库、结构体布局、异常、内存分配器和运行时 ABI 差异。不要跨模块随意一边分配、一边用不兼容运行时释放；插件路径也必须受控，防止加载同名恶意库。

如果需求只是可选源码模块，不一定需要运行时插件；普通 target 加构建选项往往更简单。

---

## 十三、常见错误应该从哪一层查？

### 1. 找不到头文件

先查看报错来自哪个 target，再检查提供头文件的 target 是否把 include 目录声明为 `PUBLIC/INTERFACE`，以及消费者是否真正链接该 target。

### 2. 能编译但 undefined reference

可能原因包括：实现 `.cpp` 没加入任何 target、消费者没有链接库、静态库依赖传播范围错误、符号签名不一致，或链接到了错误架构与 ABI。

查看真实命令：

```bash
cmake --build build --verbose
```

### 3. 链接成功但启动失败

检查实际安装的库文件、程序记录的依赖名称、RPATH、间接依赖和 CPU 架构。不要继续增加 include 路径。

### 4. 修改配置后没有变化

确认使用的是同一个 `-B` 目录，查看 `CMakeCache.txt` 中相关 cache 变量，并用 `cmake --build` 的 verbose 输出验证。切换工具链或架构时使用新构建目录。

### 5. Debug 能链接，Release 不能链接

多配置包可能为不同配置提供不同 imported location；Windows 运行库、第三方库后缀和 ABI 也可能不同。确认配置、架构、triplet 和运行库组合一致。

---

## 十四、哪些 CMake 写法容易让小问题扩散到整个工程？

### 全局 include 和 flags

```cmake
# 不推荐作为默认工程风格
include_directories(include)
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Wall")
```

它们让无关 target 隐式依赖当前目录状态。优先使用 `target_include_directories()`、`target_compile_options()` 和专门属性。

### 硬编码本机绝对路径

```cmake
include_directories(/Users/alice/local/include)
```

这会破坏其他开发机、CI、安装包和交叉编译。使用 imported target、toolchain、cache 变量和项目相对路径。

### 无条件 `file(GLOB ...)` 收集所有源码

新增文件是否触发重新配置取决于具体写法与生成器。中小 target 明确列源文件更容易审查。若确实需要 glob，应理解 `CONFIGURE_DEPENDS` 的成本与生成器差异。

### 在库项目中强迫全局选项

子项目不应擅自修改父项目的 C++ 标准、警告即错误、输出目录或 `BUILD_TESTING`。把真实使用要求放在自己的 target，项目策略选项增加唯一前缀，并提供合理默认值。

---

## 十五、什么时候 CMake 反而不是最简单的选择？

适合使用 CMake：

- 有多个 C++ target 和依赖关系；
- 需要跨 Linux、macOS、Windows 或多种生成器；
- 需要测试、安装、打包或第三方 package 集成；
- 项目已有 CMake 生态，继续遵循现有工具链。

一个只有单文件、一次性验证的示例，直接运行：

```bash
c++ -std=c++17 -Wall -Wextra demo.cpp -o demo
```

可能更清楚。不要为了“工程化”给临时代码建立复杂 target 层级和选项系统。

一旦使用 CMake，也不要混入另一套手写 Makefile 来维护同一批产物，除非项目明确需要并有同步策略。

---

## 十六、总结

回到开头：库能编译而消费者找不到头文件，是因为头文件目录只进入了库自身构建配置，没有作为使用要求传播。

最重要的结论是：

1. 现代 CMake 的核心是 target 依赖图，不是全局参数集合；
2. `PRIVATE` 只构建自己，`INTERFACE` 只服务消费者，`PUBLIC` 同时覆盖两者；
3. 公共头文件使用的 include、语言特性、宏和依赖必须进入 target 接口；
4. `BUILD_INTERFACE` 与 `INSTALL_INTERFACE` 分别描述源码树和安装后的路径；
5. 编译、链接、动态加载是不同阶段，要根据错误发生层次排查；
6. toolchain、架构和 vcpkg triplet 应在新的配置目录中确定，避免旧 cache 混入。

可以直接用于代码审查的一条建议是：**看到一条 target 配置时，问“这是实现细节，还是公共头文件消费者也必须知道？”答案通常就决定了它应该是 `PRIVATE`、`PUBLIC` 还是 `INTERFACE`。**

---

## 参考资料

- [CMake Buildsystem：target 与使用要求](https://cmake.org/cmake/help/latest/manual/cmake-buildsystem.7.html)
- [`target_include_directories()`](https://cmake.org/cmake/help/latest/command/target_include_directories.html)
- [`target_link_libraries()`](https://cmake.org/cmake/help/latest/command/target_link_libraries.html)
- [`target_compile_features()`](https://cmake.org/cmake/help/latest/command/target_compile_features.html)
- [CMake Presets](https://cmake.org/cmake/help/latest/manual/cmake-presets.7.html)
- [vcpkg 与 CMake 集成](https://learn.microsoft.com/vcpkg/users/buildsystems/cmake-integration)
