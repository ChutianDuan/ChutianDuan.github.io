---
title: "OpenCV 图像分割：Otsu、自适应阈值与 Lab"
date: 2026-10-03 17:03:25
updated: 2026-10-03 17:03:25
categories:
  - "学习"
  - "Linux 与 C++ 工程化"
permalink: /notes/liunx-c-工程化/13-opencv图像分割/
series: "Linux 与 C++ 工程化"
series_order: 13
---

在木纹背景上找到八枚螺钉，为什么二值图里却出现了几十个白色区域？阈值算法只按亮度或颜色选像素，它不知道“螺钉”是什么。木纹、阴影、反光都可能满足条件。接下来即使 PCA 算出稳定角度，也只是稳定地测量了错误区域。

本文先把分割结果定义为 0/255 掩膜，再比较三种方法，最后解释形态学和候选筛选怎样改变测量输入。对应 ScrewMetrology `6782dfd` 的 `src/segmentation.cpp`，API 说明参考 OpenCV 4.13，项目实验环境为 OpenCV 5.0.0。[返回系列导读](/notes/liunx-c-工程化/12-opencv实战导读/)。

## 1. 图像类型和前景极性是第一份契约

`imread` 默认读入 `CV_8UC3` BGR 图像。灰度图通常是 `CV_8UC1`，阈值输出也是单通道。前景约定为 255、背景为 0；如果暗色金属是目标，常用 `THRESH_BINARY_INV`。

```cpp
// 核心片段：bgr 已通过 empty() 和 type() 检查。
cv::Mat filtered, gray, mask;
cv::GaussianBlur(bgr, filtered, cv::Size(3, 3), 0);
cv::cvtColor(filtered, gray, cv::COLOR_BGR2GRAY);
cv::threshold(gray, mask, 0, 255,
              cv::THRESH_BINARY_INV | cv::THRESH_OTSU);
```

这段是嵌入算法的片段，不是独立程序。高斯核必须是正奇数；核越大越容易稳定噪声，也越容易消除细杆、螺纹或尖端。用于分割的去噪图不要替代亚像素测量所需的原始灰度。

## 2. 三种分割方法分别假设了什么

### 2.1 Otsu：全图共用一个阈值

Otsu 搜索能使前景和背景类间方差较大的阈值。若阈值为 T，两类比例为 w₀、w₁，均值为 μ₀、μ₁，则目标可以写为：

```text
σ²_between(T) = w₀(T) · w₁(T) · [μ₀(T) − μ₁(T)]²
```

这是灰度统计目标，不是语义检测目标。干净合成图通常便于观察它；照明不均匀、背景存在大量深纹理时，一个全局阈值可能同时保留木纹并漏掉亮金属。

### 2.2 自适应阈值：局部均值减去偏置

```cpp
// 核心片段：gray 是非空 8 位单通道灰度图。
cv::adaptiveThreshold(gray, mask, 255,
    cv::ADAPTIVE_THRESH_GAUSSIAN_C, cv::THRESH_BINARY_INV, 51, 8);
```

每个位置使用邻域的高斯加权均值减去 C 作为阈值。窗口需要大于 1 的奇数。局部光照变化得到补偿，但窗口内的木纹也可能成为前景；窗口过小会把工件内部纹理拆成许多区域。它不会自动解决复杂背景。

### 2.3 Lab：利用颜色差异并保留暗部

```cpp
// 核心片段：filtered 是 8 位 BGR 图像。
cv::Mat lab;
cv::cvtColor(filtered, lab, cv::COLOR_BGR2Lab);
std::vector<cv::Mat> channels;
cv::split(lab, channels);
mask = (channels[2] <= 145) | (channels[0] <= 90);
```

项目规则取两个条件的并集：b 通道较低，或 L 通道较暗。偏黄木纹与部分金属的颜色差异有助于筛选，但暖色反光可能让金属边缘断裂。

145 和 90 对应 OpenCV 的 **8 位 Lab 编码**。浮点 Lab 的取值范围不同，不能直接复用；若使用浮点 BGR 转换，也需要满足颜色转换规定的输入范围。这里的阈值针对当前背景，不能直接当成通用金属检测参数。

## 3. 形态学会清理掩膜，也会改变尺寸

开运算先腐蚀后膨胀，常用于去掉小白点和细连接；闭运算先膨胀后腐蚀，常用于补裂缝。项目使用椭圆核，默认开运算 3×3、闭运算 11×11；配置为 1 相当于跳过。

| 改动 | 希望得到的效果 | 需要检查的副作用 |
| --- | --- | --- |
| 增大开运算核 | 减少小碎点 | 细杆和尖端被删除 |
| 增大闭运算核 | 连接反光裂缝 | 相邻螺钉连成一体 |
| 增大去噪核 | 减少亮度噪声 | 边界位置偏移、细节消失 |

“更干净”不等于“更适合测量”。至少同时观察目标数量、轮廓完整性和尺寸变化。

## 4. 从白像素到候选工件

`connectedComponentsWithStats` 使用 8 邻域，编号 0 为背景，先按前景像素数筛选区域。随后 `findContours` 使用 `RETR_EXTERNAL` 和 `CHAIN_APPROX_NONE`，得到外轮廓，再检查几何面积及凸包占比。

```text
solidity = contourArea(contour) / contourArea(convexHull(contour))
```

前景像素数与轮廓几何面积并不相等。带孔目标尤其明显：连通域统计真实白像素，外轮廓描述外形范围。该项目不会在此测量螺母内孔，也不会自动拆开已经连通的两个实例。

候选过滤与可靠性判断是两个阶段。默认 `min_solidity=0.25` 允许部分可疑目标进入展示，而定位阶段会把 solidity 低于 0.55 的目标标成疑似粘连。保留一个框不代表允许判定为 OK。

## 5. 可复现的单因素对比

先按导读完成构建与合成图生成。下面的命令从项目根目录运行，第一组看干净背景，第二组看真实木纹。

```sh
build/screw_metrology measure --input data/synthetic/images/rotation_1.png \
  --config config/synthetic.yaml --segmentation otsu \
  --output result/learn/seg-clean
build/screw_metrology measure --input data/mvtec_screws/images/screws_025.png \
  --config config/measurement.yaml --segmentation otsu \
  --output result/learn/seg-otsu
build/screw_metrology measure --input data/mvtec_screws/images/screws_025.png \
  --config config/measurement.yaml --segmentation adaptive \
  --output result/learn/seg-adaptive
build/screw_metrology measure --input data/mvtec_screws/images/screws_025.png \
  --config config/measurement.yaml --segmentation lab \
  --output result/learn/seg-lab
```

逐个回答：尖端是否完整？木纹是否变白？邻近工件是否连接？然后才比较框和尺寸。不同方法检出的数量更大，并不表示召回正确。

## 6. 遇到异常先检查哪一层

全图几乎变白时先检查阈值极性和通道范围；工件断裂先检查反光与颜色条件；目标合并先缩小闭运算核；小螺钉消失先检查面积阈值、开运算与分辨率。

一次只改变一个因素，并把学习配置保存成单独的 YAML。用于正式报告的冻结配置不要直接覆盖，改变参数后也不能继续引用旧报告作为新配置的成绩。

## 7. 参考资料

- [对应分割源码](https://github.com/ChutianDuan/ScrewMetrology/blob/6782dfd337169fb6c77dc7378b9eafd44ff530ce/src/segmentation.cpp)。
- [OpenCV 阈值处理](https://docs.opencv.org/4.13.0/d7/d4d/tutorial_py_thresholding.html)。
- [OpenCV 形态学 API](https://docs.opencv.org/4.13.0/d4/d86/group__imgproc__filter.html)。
- [OpenCV 颜色转换与取值范围](https://docs.opencv.org/4.13.0/d8/d01/group__imgproc__color__conversions.html)。
