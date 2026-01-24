---
title: "cmake环境构建注意事项"
date: 2025-12-25 20:37:25
tags:
  - "CMake"
  - "构建系统"
  - "环境配置"
categories:
  - "杂七杂八"
---
# cmake环境构建注意事项

后续要装更多包：通用“镜像下载 + 安装模板”

你以后新增包基本分三类：CMake / Autotools / 纯 Make。建议统一规则：

下载：都落到 /opt/tp-downloads

解压构建：都在 /opt/src_clean/<pkg>

安装：统一 --prefix=/opt/tp 或 -DCMAKE_INSTALL_PREFIX=/opt/tp

使用：工程端统一 CMAKE_PREFIX_PATH=/opt/tp

7.1 通用下载函数（带镜像）

建议你写个小函数（放到 ~/.bashrc 或单独脚本）：

fetch_gh () {
  # 用法：fetch_gh owner repo ref output.tar.gz
  # 例：fetch_gh sewenew redis-plus-plus refs/tags/1.3.15 redis-plus-plus-1.3.15.tar.gz
  local owner="$1" repo="$2" ref="$3" out="$4"
  mkdir -p /opt/tp-downloads
  curl -L --fail \
    "https://gh-proxy.org/https://github.com/${owner}/${repo}/archive/${ref}.tar.gz" \
    -o "/opt/tp-downloads/${out}"
}

7.2 CMake 类包安装模板
source /opt/tp/env.sh
cd /opt/src_clean/<pkg>
rm -rf build && mkdir build && cd build
/opt/tp/bin/cmake .. -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=/opt/tp \
  -DCMAKE_PREFIX_PATH=/opt/tp
/opt/tp/bin/cmake --build . -j"$(nproc)"
/opt/tp/bin/cmake --install .

7.3 Autotools 类包安装模板
./configure --prefix=/opt/tp
make -j"$(nproc)"
make install


1) 下载 redis-plus-plus（走 GitHub 镜像）

redis-plus-plus 最新 release/tag 是 1.3.15。 
GitHub

mkdir -p /opt/tp-downloads
cd /opt/tp-downloads

curl -L --fail \
  "https://gh-proxy.org/https://github.com/sewenew/redis-plus-plus/archive/refs/tags/1.3.15.tar.gz" \
  -o redis-plus-plus-1.3.15.tar.gz

2) 解压、编译、安装到 /opt/tp

关键 CMake 选项：

-DREDIS_PLUS_PLUS_BUILD_TEST=OFF：不编测试，加速且避免额外依赖 
GitHub
+1

-DCMAKE_PREFIX_PATH=/opt/tp：让它找到你已装的 hiredis（以及未来其他依赖）

source /opt/tp/env.sh

cd /opt/src_clean
rm -rf redis-plus-plus-1.3.15
tar -xf /opt/tp-downloads/redis-plus-plus-1.3.15.tar.gz
cd redis-plus-plus-1.3.15

rm -rf build
mkdir -p build
cd build

/opt/tp/bin/cmake .. -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=/opt/tp \
  -DCMAKE_PREFIX_PATH=/opt/tp \
  -DREDIS_PLUS_PLUS_BUILD_TEST=OFF

/opt/tp/bin/cmake --build . -j"$(nproc)"
/opt/tp/bin/cmake --install .