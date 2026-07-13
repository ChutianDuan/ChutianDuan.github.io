---
title: "本机能编译，换台机器为什么就找不到库？把 C++ 依赖变成可复现构建"
date: 2026-07-13 10:18:32
updated: 2026-07-13 10:18:32
categories:
  - "学习"
  - "现代 C++ 实践"
permalink: /notes/现代c-实践/22-依赖管理与包管理-fetchcontent-vcpkg-conan/
series: "现代 C++ 实践"
series_order: 22
---

时间：2026/05/08

开发者电脑上已经通过 Homebrew 或系统包装好了某个库，于是 CMake 里写下：

```cmake
include_directories(/opt/homebrew/include)
link_directories(/opt/homebrew/lib)
target_link_libraries(app PRIVATE third_party)
```

换到 Intel Mac、Linux CI 或同事电脑后，路径不存在；即使找到同名库，也可能版本、编译器 ABI、Debug/Release 或静态/动态选项不一致。问题不是“少装了一个包”，而是依赖来源、版本、构建配置和传递关系都没有进入项目契约。

现代 C++ 依赖管理最终应该让消费代码面对 CMake target：

```cmake
find_package(fmt CONFIG REQUIRED)
target_link_libraries(app PRIVATE fmt::fmt)
```

至于 target 来自系统安装、`FetchContent`、vcpkg 还是 Conan，是项目依赖策略的另一层。本文从这个分层出发，比较三种工具的边界，并讨论版本锁定、ABI、缓存、离线构建和供应链验证。

---

## 1. “依赖可用”至少包含哪些条件？

一个头文件能被 include 只证明编译器找到了声明。完整依赖还可能包含：

- include 目录；
- 编译定义和语言特性；
- 静态/动态库及传递链接库；
- Debug/Release 等配置对应的二进制；
- 编译器、标准库、架构和运行时 ABI；
- 运行时动态库、资源与插件位置；
- 许可证、版本来源和安全更新记录。

Imported/alias target 可以把大部分编译与链接 usage requirements 组合起来：

```text
包管理器/安装前缀
        ↓ 产生或提供 package config
find_package(Foo CONFIG REQUIRED)
        ↓
Foo::Foo target
        ↓ PUBLIC/PRIVATE 传播
项目 target
```

手写全局 include/library 路径会绕过这些关系，让未声明依赖偶然可见。现代 CMake 应围绕 target 连接依赖，而不是把整个进程的搜索路径当作构建模型。

## 2. 三类依赖接入方式有什么差别？

| 方式 | 谁取得/构建依赖 | 适合场景 | 主要风险 |
| --- | --- | --- | --- |
| 系统/预安装 + `find_package` | 系统镜像、开发环境或上游流程 | 平台系统库、受控镜像 | 机器版本漂移 |
| `add_subdirectory` / FetchContent | 当前 CMake 构建源码 | 小型 CMake 依赖、测试工具 | 配置/编译时间和选项冲突 |
| vcpkg/Conan | 专门包管理器解析并构建/获取包 | 多依赖、跨平台、二进制缓存 | profiles/registry/版本策略需要维护 |

项目内自己拥有的模块优先普通 `add_subdirectory`，无需伪装成外部包。`FetchContent` 适合少量源码依赖；依赖图扩大、构建矩阵复杂或多个项目共享二进制时，包管理器更合适。

团队应定义主路径，而不是每个库随手选一种。工具可以共存，例如测试框架用 FetchContent、运行依赖统一由 vcpkg，但边界必须写进构建文档与 CI。

## 3. FetchContent 实际做了什么？

`FetchContent` 在配置阶段取得依赖内容，再通常通过依赖自身的 CMake 项目加入当前构建：

```cmake
include(FetchContent)

FetchContent_Declare(
    fmt
    GIT_REPOSITORY https://github.com/fmtlib/fmt.git
    GIT_TAG        <固定发布标签或完整提交哈希>
)

FetchContent_MakeAvailable(fmt)
target_link_libraries(app PRIVATE fmt::fmt)
```

不要跟随 `main`/`master` 等可移动分支。固定发布标签比浮动分支好，完整 commit hash 更明确；下载归档时可校验内容 hash。标签也可能在托管端被重写，安全要求高的项目应使用受控镜像和完整性验证。

FetchContent 的代价是依赖成为当前配置/构建的一部分：

- 依赖选项可能污染或与父项目冲突；
- 多个上层声明同名依赖时有“先记录者优先”等协调规则；
- 每个 clean build 可能重复配置/编译大型依赖；
- 无网络 CI 需要预填充、镜像或本地 source override；
- 第三方警告与安装规则可能进入主构建。

它不是完整包解析器，不负责自动解决任意版本区间、ABI 二进制矩阵和许可证策略。

## 4. 一个不访问网络的 FetchContent 示例

下面用 `SOURCE_DIR` 引入仓库内模拟依赖，展示核心 target 关系。真实外部依赖只需把来源改为经过固定和验证的 Git/URL，消费端仍链接同一个 target。

```text
demo/
├── CMakeLists.txt
├── main.cpp
└── vendor/greeting/
    ├── CMakeLists.txt
    └── include/greeting/greet.hpp
```

依赖的头文件：

```cpp
// vendor/greeting/include/greeting/greet.hpp
#pragma once
#include <string_view>

namespace greeting {
constexpr std::string_view message() noexcept {
    return "hello dependency";
}
}
```

依赖导出 target：

```cmake
# vendor/greeting/CMakeLists.txt
add_library(greeting INTERFACE)
target_include_directories(greeting INTERFACE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_compile_features(greeting INTERFACE cxx_std_20)
```

主项目：

```cmake
cmake_minimum_required(VERSION 3.20)
project(fetch_demo LANGUAGES CXX)

include(FetchContent)
FetchContent_Declare(greeting
    SOURCE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/vendor/greeting
)
FetchContent_MakeAvailable(greeting)

add_executable(app main.cpp)
target_link_libraries(app PRIVATE greeting)
```

程序只使用依赖公开接口：

```cpp
#include <greeting/greet.hpp>
#include <iostream>

int main() {
    std::cout << greeting::message() << '\n';
}
```

配置、限制并行度构建并运行：

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel 2
./build/app
```

预期输出：

```text
hello dependency
```

消费 target 没有手写 include path。`greeting` 的 INTERFACE 使用要求通过 `target_link_libraries` 传播，这才是示例的重点，而不是源码恰好位于 `vendor/`。

## 5. vcpkg manifest 管理了什么？

manifest 模式用项目内 `vcpkg.json` 声明依赖和 feature：

```json
{
  "name": "demo",
  "version-string": "0.1.0",
  "builtin-baseline": "<固定的 vcpkg registry commit>",
  "dependencies": [
    "fmt",
    {
      "name": "example-package",
      "features": ["required-feature"]
    }
  ]
}
```

配置 CMake 时传入项目选定的 vcpkg toolchain：

```bash
cmake -S . -B build \
  -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake"
cmake --build build --parallel 2
```

toolchain 文件应在首次配置时确定；复用一个已用其他 toolchain 配置的 build 目录可能得到混乱缓存，应使用独立构建目录。

vcpkg 的版本机制只在 manifest 模式可用。`builtin-baseline`/registry baseline 固定一组端口版本基线；`version>=` 是最低版本约束，解析策略不是简单“挑最新”；确需强制特定版本时还有 override。baseline 不应被含糊称为每个包的传统 lockfile，团队要理解 registry commit、port-version 和 overlay 的共同影响。

feature 只启用业务需要的组件。全部开启会扩大依赖图、攻击面、构建时间和缓存体积。

## 6. Conan 2 怎样与 CMake 分工？

Conan recipe/配置描述依赖、settings、options 和构建上下文，生成 CMake toolchain 与 package config，使项目 CMakeLists 继续使用标准 target 流程：

```ini
[requires]
fmt/<项目固定版本>

[generators]
CMakeDeps
CMakeToolchain

[layout]
cmake_layout
```

典型流程先安装/解析依赖，再配置 CMake：

```bash
conan install . --build=missing -s build_type=Release
cmake --preset conan-release
cmake --build --preset conan-release --parallel 2
```

生成的 preset 名和目录取决于 layout、profile、生成器及 Conan 版本，也可以显式使用生成的 `conan_toolchain.cmake`。不要把示例路径硬编码成所有平台共同结构。

Conan 的 profile/settings 对二进制兼容至关重要：操作系统、架构、编译器版本、运行时、build type 和库 options 共同决定 package ID。Debug 主程序误用不兼容 Release 依赖，在某些平台会产生 ABI 或运行时问题。

截至当前 Conan 2 官方文档，除了长期使用的 `CMakeDeps` 外还提供较新的 `CMakeConfigDeps` 路径，并提示其演进状态。现有项目应根据已锁定 Conan 版本和官方迁移说明选择，不能从一篇笔记盲目替换生成器。

## 7. 三种工具应该怎样选择？

| 当前需求 | 较自然的起点 |
| --- | --- |
| 仓库内自有源码模块 | `add_subdirectory` |
| 一个小型、CMake 友好且随主项目构建的依赖 | FetchContent |
| 跨平台应用使用常见开源端口生态 | vcpkg manifest |
| 私有包、复杂 options/profile、二进制缓存与发布 | Conan 2 |
| 操作系统提供且 ABI 必须跟随系统的库 | 系统 package + `find_package`/pkg-config 适配 |

这不是绝对产品排名。团队已有缓存、registry、镜像和 CI 经验通常比“理论功能最多”更重要。迁移包管理器是构建基础设施变更，必须验证所有目标平台和部署产物。

## 8. 为什么第三方类型不应轻易出现在公共头文件？

公共接口直接暴露 JSON 库类型：

```cpp
#include <third_party/json.hpp>
third_party::json load_config();
```

会产生三种耦合：所有调用者必须编译第三方头；CMake 依赖必须标为 PUBLIC；未来更换库会改变自己的 API/ABI。

更稳定的边界是转换为领域类型：

```cpp
struct Config {
    std::string host;
    int port;
};

Config parse_config(std::string_view text);
```

实现 `.cpp` 私有包含 JSON 库：

```cmake
add_library(config src/config.cpp)
target_include_directories(config PUBLIC include)
target_link_libraries(config PRIVATE ThirdParty::Json)
```

如果公共头确实出现第三方类型，依赖 usage requirements 就必须 PUBLIC。`PRIVATE`/`PUBLIC` 不是对库重要性的评价，而是调用者编译接口是否需要它。

## 9. “固定版本”为什么仍不等于完全可复现？

可复现构建还受到：

- 编译器、标准库、SDK 和系统工具版本；
- package recipe/port revision；
- target architecture 与 build options；
- 环境变量、生成器和 toolchain；
- 下载源码是否可变、是否校验 hash；
- 构建脚本访问当前时间、网络和本机路径；
- 二进制缓存键是否包含完整配置。

依赖标签固定只是第一步。可靠项目会固定/记录工具链镜像或版本、registry baseline/profile、直接与传递依赖图，并在干净环境中重建验证。

应用项目通常应精确控制已验证依赖集合；可复用库则需要兼顾下游解析，不能简单把自己的完整环境强加给所有消费者。版本策略与产物类型有关。

## 10. 离线构建和供应链需要哪些额外约束？

配置阶段临时访问公网会让构建受网络、服务可用性和上游篡改影响。团队可以：

- 使用受控源码镜像、私有 registry/remote；
- 校验归档 hash 或固定不可变提交；
- 预热并审计二进制缓存；
- 定义离线构建模式，禁止悄悄回退公网；
- 记录许可证、来源和依赖清单/SBOM；
- 对依赖升级运行功能、Sanitizer、平台与安全检查；
- 保护发布凭据和缓存写权限。

固定老版本也可能保留已知漏洞，因此“可复现”与“及时安全更新”要同时管理。升级应是可审查变更，而不是每次构建自动漂移。

## 11. 依赖升级应该怎样验证？

一次升级记录至少回答：

```text
升级了什么直接/传递依赖？
为什么升级：漏洞、兼容、功能还是维护？
ABI/API 或默认 option 是否变化？
哪些平台、Debug/Release、静态/动态组合已验证？
功能测试、诊断构建和部署冒烟是否通过？
回滚到哪个已知版本？
```

不要在同一提交顺手升级大量无关依赖，会让失败难以归因。自动更新机器人可以提出变更，但合并仍需项目自己的证据门槛。

## 12. 工程中最容易踩哪些坑？

### 误区一：能找到头文件就算依赖接入成功

还要匹配链接库、传递依赖、运行时产物和 ABI 配置。

### 误区二：固定 Git 标签就绝对不可变

标签可能被重指。高要求项目使用完整提交/hash、镜像与内容校验。

### 误区三：vcpkg baseline 就是传统精确 lockfile

它固定 registry 中的一组基线版本，但 resolution 还受 version constraints、overrides、port revisions 和 registry 配置影响。

### 误区四：包管理器可以替 CMake 设计 target 边界

包管理器提供依赖，项目仍要正确使用 imported target 和 PUBLIC/PRIVATE。

### 误区五：Debug/Release 二进制可以随意混用

运行时、迭代器调试、CRT 和 ABI 可能不兼容。配置必须进入 package ID/cache key。

### 误区六：依赖多就同时引入多个包管理器

多工具会产生重复解析、版本冲突和缓存复杂度。先统一主路径，只为明确边界保留例外。

## 13. 什么时候保持简单更好？

单仓库中两个一起发布的小模块使用 `add_subdirectory` 就够了；无需为了“包化”搭建私有 remote。反过来，十个项目复制 Git URL 和 CMake options，也说明应该形成真正的内部包与版本策略。

依赖方案应随复用范围和构建矩阵增长，而不是预先建设未使用的平台。最小目标始终是：新机器按文档执行有限命令，得到与 CI 一致且可追溯的产物。

## 14. 总结

开头绝对路径只记录了某台机器的安装结果，没有记录依赖版本、构建配置和 target 使用要求，所以无法迁移。

1. CMake 通过 imported/normal target 表达 include、定义和链接传播，包管理器负责让 target 可获得；
2. FetchContent 适合少量源码依赖，vcpkg manifest 管端口生态，Conan 适合复杂二进制配置与私有包；
3. 版本标签、registry baseline、profile、recipe 和工具链共同决定可复现性；
4. 第三方类型不进入公共 API 时，依赖应尽量保持 PRIVATE；
5. 离线镜像、hash、许可证、安全更新和缓存权限都是依赖供应链的一部分。

审查一个新依赖时，先要求提交者回答：“target 名是什么、版本从哪里锁定、哪些 ABI 配置构建、公共 API 是否暴露它、断网能否重建？”这五个答案比“已经在我电脑安装成功”更接近真正的依赖管理。

## 15. 官方参考

- [CMake FetchContent](https://cmake.org/cmake/help/latest/module/FetchContent.html)
- [vcpkg manifest 与版本机制](https://learn.microsoft.com/en-us/vcpkg/users/versioning)
- [Conan 2 CMake 集成](https://docs.conan.io/2/integrations/cmake.html)
