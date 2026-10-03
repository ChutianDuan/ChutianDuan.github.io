---
title: "OpenCV 工件定位：PCA、旋转框与局部坐标系"
date: 2026-10-03 17:03:25
updated: 2026-10-03 17:03:25
categories:
  - "学习"
  - "Linux 与 C++ 工程化"
permalink: /notes/liunx-c-工程化/14-opencv工件定位与局部坐标系/
series: "Linux 与 C++ 工程化"
series_order: 14
---

同一枚螺钉转过 30°，轴对齐矩形的宽度明显变化。工件并没有变长，变化来自测量方向。要使尺寸跟随工件，需要先找到主轴，再把点转换到工件自己的坐标系。

本文对应 ScrewMetrology `6782dfd` 的定位与投影测量实现，使用 C++17 / OpenCV。项目运行环境为 OpenCV 5.0.0；OpenCV 5 的二维几何类型位于 `geometry` 模块。[返回系列导读](/notes/liunx-c-工程化/12-opencv实战导读/)。

## 1. 质心、旋转框中心不是同一个点

轮廓矩的面积质心为：

```text
O = (m10 / m00, m01 / m00)
```

只有 `m00` 有效时才能除。大头部会使质心偏向头部；旋转框中心则是包围矩形中心。项目输出 `center` 表示质心，`rotated_box.center` 表示框中心，定位评价的中心误差使用后者。

最小面积框的角度还需要统一：`RotatedRect.angle` 对应 width 轴，若 height 更长，项目加 90° 后取长边方向。直接把 angle 当成螺钉方向容易在宽高交换时跳变。

## 2. 三种主轴都需要正确的输入

| 方法 | 使用的信息 | 可能的偏差 |
| --- | --- | --- |
| `minAreaRect` | 包住外轮廓的最小面积框 | 少量突出点改变长边方向 |
| PCA | 填充外轮廓后的全部前景像素 | 头部、遮挡或粘连改变面积分布 |
| `fitLine` | 外轮廓点的拟合方向 | 采样密度和形状影响点分布 |

PCA 对中心化二维样本构造协方差矩阵，最大特征值对应的特征向量代表变化最大的方向。项目先在包围 ROI 内填充外轮廓，再对所有非零点做 PCA；这与直接对边界点做 PCA 不是同一份统计。

```cpp
// 核心片段：samples 每行是一个前景像素的 (x,y)，类型 CV_64F。
cv::PCA pca(samples, cv::Mat(), cv::PCA::DATA_AS_ROW);
cv::Vec2d axis(pca.eigenvectors.at<double>(0, 0),
               pca.eigenvectors.at<double>(0, 1));
double theta = std::atan2(axis[1], axis[0]);
```

两特征值之比接近 1，说明没有明显长轴。近圆螺母仍能返回一个数值角度，但小噪声就可能改变它。项目使用 `axis_ratio` 标记 `axis_ambiguous`，而不是把任何角度都视作可信姿态。

## 3. 从图像坐标到局部坐标

设原点是质心 O，沿主轴的单位向量为 eₓ，垂直向量为 eᵧ：

```text
eₓ = (cosθ, sinθ)
eᵧ = (−sinθ, cosθ)
s  = (P − O) · eₓ
t  = (P − O) · eᵧ
P  = O + s·eₓ + t·eᵧ
```

图像 y 向下，`atan2` 的正角度在显示中表现为顺时针。项目把角度归一化为 `[0°,180°)`，因为 PCA 返回的是无向主轴：0° 和 180° 是同一条轴。主轴正端不保证指向尖端，需要独立的头杆识别才能解释朝向。

### 3.1 可独立运行的坐标往返示例

把下面保存为 `local_coordinates.cpp`。它仅依赖 C++ 标准库，用于验证公式；运行失败时抛出异常，成功时误差应接近浮点舍入级别。

```cpp
#include <cmath>
#include <iostream>
#include <stdexcept>

struct Point { double x, y; };
Point toLocal(Point p, Point o, double theta) {
    const double c = std::cos(theta), s = std::sin(theta);
    p.x -= o.x; p.y -= o.y;
    return {p.x*c + p.y*s, -p.x*s + p.y*c};
}
Point toImage(Point p, Point o, double theta) {
    const double c = std::cos(theta), s = std::sin(theta);
    return {o.x + p.x*c - p.y*s, o.y + p.x*s + p.y*c};
}
int main() {
    const double theta = 17.0 * std::acos(-1.0) / 180.0;
    Point origin{120, 90}, image{153.4, 108.7};
    Point local = toLocal(image, origin, theta);
    Point recovered = toImage(local, origin, theta);
    const double error = std::hypot(recovered.x-image.x,
                                    recovered.y-image.y);
    if (error > 1e-10) throw std::runtime_error("round trip failed");
    std::cout << "round-trip error: " << error << " px\n";
}
```

```sh
c++ -std=c++17 -Wall -Wextra -pedantic local_coordinates.cpp -o local_coordinates
./local_coordinates
```

## 4. 投影尺寸为何不受原点平移影响

轮廓点转换为 `(s,t)` 后，总长与最大宽度为：

```text
length = max(s) − min(s)
width  = max(t) − min(t)
```

更换原点只会让投影整体加上一个常数，最大值与最小值之差保持不变。更换主轴则会改变范围，因此轴向偏差会传递到尺寸。

最大宽度经常由头部决定，不能当成杆宽。项目把候选掩膜旋转到局部 ROI，按列提取横向范围得到 `width(s)`，用中位数平滑后检查是否恰好一端明显变宽，再找连续变窄的位置作为头杆分界。

旋转二值掩膜使用最近邻插值，避免生成中间灰度；这一 ROI 用于几何剖面，亚像素测量仍回到原始灰度图。没有明显头杆差异时保留不可测字段，而不是强行套用螺钉模型。

## 5. 三种方法的同图对比

按导读构建并生成合成图后运行：

```sh
build/screw_metrology measure --input data/synthetic/images/rotation_1.png \
  --config config/synthetic.yaml --axis pca --no-subpixel \
  --output result/learn/axis-pca
build/screw_metrology measure --input data/synthetic/images/rotation_1.png \
  --config config/synthetic.yaml --axis rect --no-subpixel \
  --output result/learn/axis-rect
build/screw_metrology measure --input data/synthetic/images/rotation_1.png \
  --config config/synthetic.yaml --axis fitline --no-subpixel \
  --output result/learn/axis-fitline
```

对照 `comparison_angles_deg`、`angle_deg`、`pixel`，检查角度和尺寸如何联动。无向角误差应按 180° 周期计算，例如 179° 与 1° 相差 2°，不是 178°。

## 6. 定位成功以后仍可能不能测量

触及图像边缘的轮廓可能被截断，低 solidity 可能表示粘连，近圆形可能没有稳定主轴。这些目标仍可以画框、显示可见范围，但不应被当作完整工件作公差判定。

几何质量判断是启发式，可能漏掉一些重叠。换成另一种主轴不能恢复已经缺失的尖端，也不能拆开合并轮廓。遇到三种方法都异常时，优先返回掩膜检查输入。

## 7. 参考资料

- [对应定位源码](https://github.com/ChutianDuan/ScrewMetrology/blob/6782dfd337169fb6c77dc7378b9eafd44ff530ce/src/locator.cpp)。
- [OpenCV PCA](https://docs.opencv.org/4.13.0/d3/d8d/classcv_1_1PCA.html)。
- [OpenCV 轮廓、旋转框与 fitLine](https://docs.opencv.org/4.13.0/d3/dc0/group__imgproc__shape.html)。
