---
title: "OpenCV 实战导读：从图像到螺钉测量结果"
date: 2026-10-03 17:03:25
updated: 2026-10-03 17:03:25
categories:
  - "学习"
  - "Linux 与 C++ 工程化"
permalink: /notes/liunx-c-工程化/12-opencv实战导读/
series: "Linux 与 C++ 工程化"
series_order: 12
---

一张照片里有几枚螺钉，画出框以后，能不能直接告诉使用者“长度合格”？不能。框只是算法找到的区域；它可能包含木纹、缺掉尖端，或者把两枚接触的螺钉合成一个目标。即使轮廓正确，像素距离也没有自动变成毫米。

`ScrewMetrology` 用 C++17 和 OpenCV 把这几个问题分开：先分割前景，再定位和建立工件坐标系，随后测量几何尺寸，最后在尺度和配方成立时作公差判定。这个系列面向已有 C++ 基础、希望理解传统视觉测量的读者，从可运行实验出发解释每个阶段。

本文源码核对版本为 [`6782dfd`](https://github.com/ChutianDuan/ScrewMetrology/tree/6782dfd337169fb6c77dc7378b9eafd44ff530ce)，核对日期为 2026-10-03。项目验证环境是 macOS arm64、AppleClang 21、C++17、OpenCV 5.0.0；OpenCV 4 的兼容分支需要在对应环境另外验证。

## 1. 先明确输入、输出和测量对象

输入是离线 BGR 图像，工件外轮廓是主要测量对象。输出包括二值掩膜、叠加图和 JSON。项目没有相机采集、机械臂控制或跨图追踪；每张图重新分配的目标编号不能当成轨迹 ID。

| 阶段 | 回答的问题 | 需要查看的证据 |
| --- | --- | --- |
| 分割 | 哪些像素属于工件？ | 掩膜是否完整、背景是否被选中 |
| 定位 | 工件在哪里、沿哪个方向？ | 质心、旋转框、主轴及质量原因 |
| 测量 | 沿工件轴向有多长、多宽？ | 像素值、亚像素值和尺寸定义 |
| 判定 | 是否满足指定规格？ | 适用尺度、配方、OK/NG/未判定原因 |

![ScrewMetrology 图像测量流程](/assets/screw-metrology/measurement-flow.svg)

两条图像路径尤其容易混淆：去噪后的图像用于分割；原始图像转灰度后用于亚像素采样。二值掩膜提供粗位置，原始灰度提供边缘附近的亮度变化。

## 2. 在合成图上跑通最小闭环

从仓库根目录执行下面的命令。OpenCV 已能被 CMake 找到时不需要设置 `OpenCV_DIR`，否则将它指向自己的 OpenCV CMake 配置目录。

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j 4
ctest --test-dir build --output-on-failure
build/generate_samples data/synthetic
build/screw_metrology measure --input data/synthetic/images/rotation_0.png \
  --config config/synthetic.yaml --output result/learn/first \
  --mode single --recipe config/example_recipe_px.yaml
```

生产算法依赖 `core`、`imgproc`、`imgcodecs`；OpenCV 5 还需要 `geometry`。手动窗口实验 `main_test` 额外使用 `highgui`，需要本机图形桌面。不要把窗口显示失败误认为测量算法无法运行。

先在 `result/learn/first` 查看掩膜，再看叠加图，最后打开 JSON。水平合成螺钉的名义长度为 200 px；轮廓像素中心的投影范围可能是 199 px。连续灰度边缘间的距离与离散轮廓范围是两个定义，不应给所有尺寸机械地加 1。

### 2.1 旋转图是最有价值的第二个实验

```sh
build/screw_metrology measure --input data/synthetic/images/rotation_1.png \
  --config config/synthetic.yaml --axis pca --no-subpixel \
  --output result/learn/rotation
```

这张图的名义角度是 17°，名义总长、头宽、杆宽仍为 200、40、20 px。观察主轴是否跟随工件，而尺寸是否只发生小幅栅格化变化。随后分别改成 `--axis rect` 和 `--axis fitline`，保持其他参数和输入不变。

## 3. 怎样读 JSON 而不误判结果

下面只是对象字段的阅读示意，省略了其他字段，不代表某一次运行的完整输出：

```json
{
  "reliable": true,
  "pixel": {"length": 199.0},
  "subpixel": {"length": 200.0},
  "preferred_px": {"length": 200.0},
  "mm": {"length": null},
  "subpixel_status": "refined",
  "status": "NOT_EVALUATED",
  "reasons": ["no_recipe"]
}
```

`pixel` 保留粗测量，`subpixel` 保留有效细化，`preferred_px` 逐项选择优先尺寸。`null` 表示没有适用结果，不能改成 0。`reliable` 是几何质量判断，`status` 是检验判断：几何可靠并不意味着已经满足某个公差。

默认混料展示模式不会输出可靠的 OK/NG；没有配方也是未判定。图中绿色框表示几何质量可用，不能解释为“检验合格”。诊断时先读 `quality_issues` 和 `reasons`，再决定应该修复哪一个前提。

## 4. 按数据流阅读代码

| 源码 | 重点 |
| --- | --- |
| `src/main.cpp` | 命令行参数、批次处理和阶段调用 |
| `src/segmentation.cpp` | 分割掩膜与候选过滤 |
| `src/locator.cpp` | 质心、三种主轴、局部坐标变换 |
| `src/metrology.cpp` | 投影、头杆剖面和亚像素细化 |
| `src/calibration.cpp` | 两点尺度、有效尺寸选择和公差判定 |
| `src/io.cpp`、`src/evaluation.cpp` | 输出契约与评价口径 |

`include/screw/types.hpp` 集中描述参数和结果结构。调试时沿这个顺序逐层看中间值，比同时修改所有参数更容易定位问题。`main_test.cpp` 的三行分割、三种定位对比可以辅助观察，但跨行候选 ID 不是同一工件的匹配关系。

## 5. 为什么必须把定位成绩和尺寸精度分开

仓库的 2026-10-03 冻结配置报告在 384 张 MVTec 图像上记录了 84.55% 检出率、83.31% 精确率。口径是旋转框 IoU≥0.5 的降序一对一匹配；代表样例参与了参数选择，因此全量成绩不属于独立测试集成绩。

真实数据没有实物毫米和头杆尺寸真值。项目另用合成几何检查尺寸误差与亚像素收益。框匹配成功、模拟噪声下重复性较小，都不能替代实物尺寸精度、真实相机重复性或 GR&R 验证。

## 6. 系列阅读目录

建议先完成前五篇的测量闭环，再阅读两篇标定延伸：

1. 本文：项目入口、输出契约和实验顺序。
2. [OpenCV 图像分割：Otsu、自适应阈值与 Lab](/notes/liunx-c-工程化/13-opencv图像分割/)。
3. [OpenCV 工件定位：PCA、旋转框与局部坐标系](/notes/liunx-c-工程化/14-opencv工件定位与局部坐标系/)。
4. [OpenCV 亚像素测量：从灰度剖面到边缘细化](/notes/liunx-c-工程化/15-opencv亚像素测量/)。
5. [OpenCV 尺度与公差：怎样判断测量是否可信](/notes/liunx-c-工程化/16-opencv尺度公差与误差评估/)。
6. [张正友相机标定：内参、畸变与重投影误差](/notes/liunx-c-工程化/17-张正友相机标定/)。
7. [AX=XB 手眼标定：坐标变换与 OpenCV 实践](/notes/liunx-c-工程化/18-ax-xb手眼标定/)。

后两篇介绍进一步处理镜头模型和机器人坐标关系的方法。它们是独立知识与示例，ScrewMetrology 当前并未实现这些功能。

## 7. 参考资料

- [ScrewMetrology 源码](https://github.com/ChutianDuan/ScrewMetrology/tree/6782dfd337169fb6c77dc7378b9eafd44ff530ce)。
- [冻结配置、定位与合成尺寸验证记录](https://github.com/ChutianDuan/ScrewMetrology/blob/6782dfd337169fb6c77dc7378b9eafd44ff530ce/docs/validation.md)。
- [OpenCV 4.13 图像处理 API](https://docs.opencv.org/4.13.0/d7/dbd/group__imgproc.html)。
