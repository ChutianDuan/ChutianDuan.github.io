---
title: "依赖管理与包管理：FetchContent、vcpkg、Conan"
date: 2026-05-08 14:31:05
updated: 2026-05-08 14:31:05
categories:
  - "学习"
  - "现代C++实践"
permalink: /notes/现代c-实践/22-依赖管理与包管理-fetchcontent-vcpkg-conan/
---

# 依赖管理与包管理：FetchContent、vcpkg、Conan

时间：2026/05/08

> 关键词：CMake、FetchContent、find_package、vcpkg manifest、Conan 2、版本固定、可复现构建
> 核心目标：理解 C++ 项目如何管理第三方库，避免“我机器上能编”的依赖混乱。

---

## 1. 为什么 C++ 依赖管理值得单独学

C++ 依赖管理比很多语言麻烦，常见原因是：

* 编译器和标准库 ABI 会影响二进制兼容
* Debug / Release 可能需要不同二进制
* 静态库、动态库、头文件库混在一起
* CMake target 传播 include path、宏、链接库
* 不同平台依赖安装方式不同
* 依赖版本不固定会导致构建不可复现

现代 C++ 工程通常围绕 CMake target 管依赖。
包管理工具的最终目的也是让你能写：

```cmake
find_package(fmt CONFIG REQUIRED)
target_link_libraries(app PRIVATE fmt::fmt)
```

而不是到处手写 include path 和 library path。

---

## 2. 先分清三种依赖接入方式

### 2.1 系统已安装依赖

适合：

* 系统库
* 团队统一开发镜像
* Linux 发行版包

```cmake
find_package(OpenSSL REQUIRED)
target_link_libraries(app PRIVATE OpenSSL::SSL OpenSSL::Crypto)
```

优点：简单。
缺点：版本和平台差异容易失控。

### 2.2 CMake 拉源码

适合：

* 小型依赖
* 测试库
* 纯 CMake 项目
* 需要和主项目一起构建

典型工具：`FetchContent`。

### 2.3 包管理器

适合：

* 依赖较多
* 跨平台
* 需要固定版本
* 需要预编译二进制或统一构建选项

常见工具：

* vcpkg
* Conan

---

## 3. CMake 依赖使用的核心：target

现代 CMake 里，依赖最好表现为 imported target：

```cmake
find_package(fmt CONFIG REQUIRED)

add_executable(app main.cpp)
target_link_libraries(app PRIVATE fmt::fmt)
```

`fmt::fmt` 这个 target 里通常带着：

* include 目录
* 编译定义
* 编译选项
* 链接库
* 传递依赖

不要写成：

```cmake
include_directories(/usr/local/include)
link_directories(/usr/local/lib)
target_link_libraries(app PRIVATE fmt)
```

这种写法会污染全局，且不容易跨平台。

---

## 4. FetchContent：配置期拉取源码

`FetchContent` 适合把第三方源码在 CMake configure 阶段引入。

```cmake
cmake_minimum_required(VERSION 3.20)
project(demo LANGUAGES CXX)

include(FetchContent)

FetchContent_Declare(
  fmt
  GIT_REPOSITORY https://github.com/fmtlib/fmt.git
  GIT_TAG        10.2.1
)

FetchContent_MakeAvailable(fmt)

add_executable(app main.cpp)
target_link_libraries(app PRIVATE fmt::fmt)
```

`FetchContent_Declare()` 记录依赖来源。
`FetchContent_MakeAvailable()` 让依赖可用，并尽量加入当前构建。

---

## 5. FetchContent 要固定版本

不要这样：

```cmake
FetchContent_Declare(
  fmt
  GIT_REPOSITORY https://github.com/fmtlib/fmt.git
  GIT_TAG        master
)
```

`master` 会变，今天能编不代表明天能编。

更好的写法：

```cmake
FetchContent_Declare(
  fmt
  GIT_REPOSITORY https://github.com/fmtlib/fmt.git
  GIT_TAG        10.2.1
)
```

更严谨时用 commit hash：

```cmake
FetchContent_Declare(
  fmt
  GIT_REPOSITORY https://github.com/fmtlib/fmt.git
  GIT_TAG        0c9fce2ffefecfdce794e1859584e25877b7b592
)
```

原则：

> 依赖版本必须可复现，不要让构建悄悄追随远端分支。

---

## 6. FetchContent 适合和不适合什么

适合：

* googletest
* 小型头文件库
* CMake 支持好的库
* 项目内工具库

不太适合：

* 依赖树很大的库
* 需要复杂系统依赖的库
* 多项目共享同一套二进制依赖
* 构建时间很敏感的大工程

原因是 `FetchContent` 通常把依赖纳入当前构建，依赖多了以后配置和编译时间会变重。

---

## 7. vcpkg manifest 模式

vcpkg 推荐项目用 `vcpkg.json` 描述依赖。

```json
{
  "name": "demo",
  "version-string": "0.1.0",
  "dependencies": [
    "fmt",
    "nlohmann-json"
  ]
}
```

在包含 `vcpkg.json` 的项目目录中安装：

```bash
vcpkg install
```

CMake 配置时使用 vcpkg toolchain：

```bash
cmake -S . -B build \
  -DCMAKE_TOOLCHAIN_FILE=/path/to/vcpkg/scripts/buildsystems/vcpkg.cmake
cmake --build build
```

CMakeLists：

```cmake
cmake_minimum_required(VERSION 3.20)
project(demo LANGUAGES CXX)

find_package(fmt CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)

add_executable(app main.cpp)
target_link_libraries(app PRIVATE fmt::fmt nlohmann_json::nlohmann_json)
```

---

## 8. vcpkg features

有些包提供 feature：

```json
{
  "name": "demo",
  "version-string": "0.1.0",
  "dependencies": [
    {
      "name": "boost",
      "features": ["filesystem"]
    }
  ]
}
```

feature 用来控制可选组件。
不要盲目打开所有 feature，否则依赖树会变大，构建时间也会变长。

---

## 9. vcpkg 版本固定和 registry

仅写：

```json
{
  "dependencies": ["fmt"]
}
```

不能完整表达“用哪一组端口版本”。
工程上更可复现的做法是配合 baseline 或自己的 registry。

`vcpkg-configuration.json` 可以指定 registry 和 baseline：

```json
{
  "default-registry": {
    "kind": "git",
    "repository": "https://github.com/microsoft/vcpkg",
    "baseline": "7476f0d4e77d3333fbb249657df8251c28c4faae"
  }
}
```

思路和锁文件类似：

> 不只记录“我要 fmt”，还要记录“从哪一版依赖索引解析 fmt”。

---

## 10. Conan 2：用配置生成 CMake 依赖文件

Conan 2 常见方式是用 `conanfile.txt` 或 `conanfile.py` 描述依赖，并生成 CMake 所需文件。

一个简单 `conanfile.txt`：

```ini
[requires]
fmt/10.2.1
nlohmann_json/3.11.3

[generators]
CMakeDeps
CMakeToolchain

[layout]
cmake_layout
```

安装依赖：

```bash
conan install . --build=missing -s build_type=Release
```

配置 CMake：

```bash
cmake -S . -B build/Release \
  -DCMAKE_TOOLCHAIN_FILE=build/Release/generators/conan_toolchain.cmake \
  -DCMAKE_BUILD_TYPE=Release
cmake --build build/Release
```

CMakeLists：

```cmake
cmake_minimum_required(VERSION 3.20)
project(demo LANGUAGES CXX)

find_package(fmt CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)

add_executable(app main.cpp)
target_link_libraries(app PRIVATE fmt::fmt nlohmann_json::nlohmann_json)
```

Conan 2 的 CMake 集成重点是：

* `CMakeToolchain` 生成 toolchain 文件
* `CMakeDeps` 生成 `find_package()` 能找到的配置文件
* CMakeLists 本身尽量不感知 Conan

---

## 11. Conan 用 `conanfile.py` 表达更复杂逻辑

如果依赖需要条件判断、选项、打包，就用 `conanfile.py`。

```python
from conan import ConanFile
from conan.tools.cmake import CMakeToolchain, CMakeDeps, cmake_layout

class DemoRecipe(ConanFile):
    settings = "os", "compiler", "build_type", "arch"
    requires = (
        "fmt/10.2.1",
        "nlohmann_json/3.11.3",
    )

    def layout(self):
        cmake_layout(self)

    def generate(self):
        deps = CMakeDeps(self)
        deps.generate()

        tc = CMakeToolchain(self)
        tc.generate()
```

适合：

* 条件依赖
* 自定义选项
* 需要发布包
* cross build
* tool requirements

---

## 12. FetchContent、vcpkg、Conan 怎么选

简单对比：

| 场景 | 更合适 |
| --- | --- |
| 小项目拉一个测试库 | FetchContent |
| 跨平台应用，依赖很多开源库 | vcpkg |
| 需要二进制包、私有包、复杂构建矩阵 | Conan |
| 公司内部 C++ 包生态 | Conan 或私有 vcpkg registry |
| 依赖是项目内源码模块 | `add_subdirectory` |

没有绝对答案。
最关键的是团队统一一种主路径，不要每个依赖一种接入方式。

---

## 13. 依赖封装：不要让第三方库扩散到所有文件

坏模式：

```cpp
// 到处 include 第三方库头文件
#include <nlohmann/json.hpp>

void handle(const nlohmann::json& j);
```

更稳的边界：

```cpp
// config.h
struct Config {
    std::string host;
    int port = 0;
};

Config parse_config(std::string_view text);
```

```cpp
// config.cpp
#include "config.h"
#include <nlohmann/json.hpp>

Config parse_config(std::string_view text) {
    auto j = nlohmann::json::parse(text);
    return Config{
        .host = j.at("host").get<std::string>(),
        .port = j.at("port").get<int>(),
    };
}
```

好处：

* 第三方依赖集中在实现文件
* 以后替换 JSON 库成本低
* 编译依赖更少
* 公共 API 更稳定

---

## 14. CMake target 封装第三方依赖

可以把第三方库包在自己的库 target 后面：

```cmake
add_library(config config.cpp)
target_include_directories(config PUBLIC include)
target_link_libraries(config PRIVATE nlohmann_json::nlohmann_json)

add_executable(app main.cpp)
target_link_libraries(app PRIVATE config)
```

注意这里 JSON 库是 `PRIVATE`。
如果 `config` 的 public header 没暴露 `nlohmann::json`，调用者就不需要知道它。

如果 public header 暴露了第三方类型：

```cpp
#include <nlohmann/json.hpp>

nlohmann::json to_json(const Config&);
```

那 CMake 就必须：

```cmake
target_link_libraries(config PUBLIC nlohmann_json::nlohmann_json)
```

依赖是否 `PUBLIC`，取决于它是否出现在你的公开接口里。

---

## 15. 版本策略

依赖版本管理的几个原则：

1. 应用项目应固定版本
2. 库项目应谨慎扩大版本范围
3. 不要默认追随 `master/main`
4. 升级依赖要有测试
5. 安全更新要单独跟踪
6. 记录每次升级原因和影响

示例升级记录：

```text
fmt 10.1.1 -> 10.2.1
reason: fix compiler warning on Clang 17
checked: unit tests, sanitizer build, linux/macOS CI
impact: no public API change
```

依赖升级不是“顺手改一下版本号”，它是工程变更。

---

## 16. 私有库和内部包

团队内部库常见做法：

* Git submodule
* FetchContent 指向内部仓库
* vcpkg custom registry
* Conan remote
* monorepo 里 `add_subdirectory`

选择时看：

* 是否需要独立版本
* 是否需要二进制缓存
* 是否跨多个项目复用
* 是否要支持多个编译器和平台
* 是否需要访问控制

小团队可以先简单，别一开始就搭很重的平台。
但只要项目多起来，就要尽早统一依赖入口。

---

## 17. 一个推荐的 CMake 工程结构

```text
demo/
  CMakeLists.txt
  vcpkg.json 或 conanfile.txt
  include/
    demo/config.h
  src/
    config.cpp
    main.cpp
  tests/
    config_test.cpp
```

顶层 CMake：

```cmake
cmake_minimum_required(VERSION 3.20)
project(demo LANGUAGES CXX)

find_package(fmt CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)

add_library(demo_config src/config.cpp)
target_include_directories(demo_config PUBLIC include)
target_link_libraries(demo_config
  PRIVATE
    nlohmann_json::nlohmann_json
)

add_executable(demo_app src/main.cpp)
target_link_libraries(demo_app
  PRIVATE
    demo_config
    fmt::fmt
)
```

main.cpp：

```cpp
#include <demo/config.h>
#include <fmt/format.h>

int main() {
    auto cfg = parse_config(R"({"host":"127.0.0.1","port":8080})");
    fmt::print("{}:{}\n", cfg.host, cfg.port);
}
```

---

## 18. 常见误区

### 18.1 依赖版本不固定

构建不可复现，问题会在未来某一天突然出现。

### 18.2 到处写 include path

现代 CMake 应该靠 target 传播依赖信息。

### 18.3 public header 暴露第三方类型

这会让第三方库变成你的 API 一部分，替换成本很高。

### 18.4 Debug 链接 Release 依赖

有些平台和库会出 ABI 或运行时问题。
要让包管理器按 build type 安装匹配依赖。

### 18.5 混用多套包管理器且没有边界

FetchContent、vcpkg、Conan 可以共存，但要有明确规则。
例如测试库用 FetchContent，第三方运行库统一用 vcpkg。

---

## 19. 一页总结

依赖管理的核心原则：

1. CMake 里优先使用 target
2. 能 `find_package()` 就不要手写路径
3. 版本要固定，构建要可复现
4. 第三方类型尽量别扩散到公共 API
5. 小依赖可用 FetchContent
6. 跨平台应用可考虑 vcpkg
7. 私有包和复杂构建矩阵可考虑 Conan

一句话：

> 依赖管理不是把库下载下来，而是让依赖版本、构建选项、链接方式和 API 边界都可控。

---

## 20. 参考资料

1. CMake FetchContent
   <https://cmake.org/cmake/help/latest/module/FetchContent.html>

2. vcpkg manifest mode
   <https://learn.microsoft.com/en-us/vcpkg/concepts/manifest-mode>

3. Conan 2 CMake integration
   <https://docs.conan.io/2/integrations/cmake.html>

4. Conan 2 CMakeDeps
   <https://docs.conan.io/2/reference/tools/cmake/cmakedeps.html>
