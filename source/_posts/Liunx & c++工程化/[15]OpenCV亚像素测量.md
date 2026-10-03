---
title: "OpenCV 亚像素测量：从灰度剖面到边缘细化"
date: 2026-10-03 17:03:25
updated: 2026-10-03 17:03:25
categories:
  - "学习"
  - "Linux 与 C++ 工程化"
permalink: /notes/liunx-c-工程化/15-opencv亚像素测量/
series: "Linux 与 C++ 工程化"
series_order: 15
---

轮廓给出 199 px，JSON 的细化值却接近 200 px。多出来的小数不是凭空提高分辨率，而是借助灰度过渡估计连续边缘的位置。估计成立需要正确的粗边缘、采样方向和可辨识的亮度峰。

本文对应 ScrewMetrology `6782dfd` 的 `src/metrology.cpp`，项目实验使用 C++17 / OpenCV 5.0.0。[返回系列导读](/notes/liunx-c-工程化/12-opencv实战导读/)。

## 1. 粗轮廓与灰度边缘承担不同职责

二值轮廓定位候选边界，原始灰度用于细化。沿粗边缘的单位法线 n 采样：

```text
P(k) = P₀ + k·n
I(k) = gray(P(k))
g(k) = |I(k+1) − I(k−1)| / 2
```

总长两端沿主轴采样，截面两侧沿横向轴采样。方向偏离法线时测到的过渡会变宽，也可能把螺纹、阴影或反光当作端面。

`P(k)` 通常不是整数坐标，需要双线性插值。设整数格点是 `(x,y)`，小数偏移为 dx、dy，则：

```text
I = (1−dy)[(1−dx)I(x,y) + dx·I(x+1,y)]
  + dy[(1−dx)I(x,y+1) + dx·I(x+1,y+1)]
```

四个邻点都必须有效。越界不能继续读取，更不能用 0 填补后假装边缘可靠。项目搜索半径外额外采样一点，为中心差分保留邻点。

## 2. 用三点抛物线估计梯度峰

在离散梯度的最大值附近，设左、中、右三个值为 g₋、g₀、g₊。局部抛物线顶点相对整数峰的小数偏移为：

```text
δ = 0.5 · (g₋ − g₊) / (g₋ − 2g₀ + g₊)
```

分母对应局部曲率。峰应向下弯曲；曲率接近零表示不稳定，峰位于搜索端点则缺少邻点。项目还拒绝弱峰、较远的近等强多峰，以及绝对偏移过大的拟合。

### 2.1 可独立运行的峰拟合示例

这个小程序仅检查三点公式和关键拒绝路径，**不是完整图像边缘检测器**。保存为 `peak_fit.cpp`，用 C++17 编译运行。

```cpp
#include <cmath>
#include <iostream>
#include <optional>
#include <stdexcept>

std::optional<double> offset(double left, double mid, double right) {
    if (!std::isfinite(left) || !std::isfinite(mid) || !std::isfinite(right)
        || mid < 5.0 || mid < left || mid < right) return std::nullopt;
    const double curvature = left - 2*mid + right;
    if (curvature >= -1e-6) return std::nullopt;
    const double delta = 0.5*(left-right)/curvature;
    if (std::abs(delta) > 0.75) return std::nullopt;
    return delta;
}
int main() {
    // g(x)=20−4(x−0.25)^2 在 x=−1,0,1 的采样。
    const auto fitted = offset(13.75, 19.75, 17.75);
    if (!fitted || std::abs(*fitted-0.25) > 1e-12)
        throw std::runtime_error("peak recovery failed");
    if (offset(10,10,10) || offset(0.2,0.3,0.2))
        throw std::runtime_error("invalid peak accepted");
    std::cout << "peak offset: " << *fitted << " px\n";
}
```

```sh
c++ -std=c++17 -Wall -Wextra -pedantic peak_fit.cpp -o peak_fit
./peak_fit
```

真实测量还需要方向正确、采样有效、没有多峰，并保证两侧结果对应同一尺寸。

## 3. 两侧偏移怎样变成尺寸修正

项目让两侧都沿同一正轴采样。因此修正距离为：

```text
D_refined = D_pixel + offset_high − offset_low
```

起点向正方向移动会缩短距离，终点向正方向移动会增长距离，不能把两个偏移直接相加。返回值是相对粗边缘的有符号偏移，也不是最终图像坐标。

整体总长、最大投影宽度和杆宽各有自己的定义。项目不把“旋转 ROI 中最宽的一列”偷偷替换成“轮廓投影范围”。头部长度来自宽度剖面阈值分界，不是灰度边缘，所以不标称亚像素头长。

## 4. 为什么要允许降级

| 失败条件 | 含义 | 应对方式 |
| --- | --- | --- |
| 采样越界 | 缺少合法邻域 | 保留粗测量并记录失败 |
| 平坦或弱梯度 | 边缘信息不足 | 检查照明、对比度和模糊 |
| 多个近等强峰 | 无法唯一对应目标边缘 | 检查螺纹、反光或邻近目标 |
| 整体有效截面不足 | 大部分轮廓不支持细化 | 不输出伪精确的整体结果 |

项目整体细化要求长度两端有效，并且至少 60% 的尝试截面成功。整体长宽失败时保留像素值；头宽和杆宽还可能单独没有有效细化结果。读取 `preferred_px` 时应理解它是逐项优选，不是“全字段都来自亚像素”。

降级与几何不可靠也不同：前者说灰度细化未成功，后者说工件本身的完整性或方向不足以可靠判定。不能通过关闭质量检查把失败变成 OK。

## 5. 同图比较像素和亚像素

完成导读的构建与合成图生成后运行：

```sh
build/screw_metrology measure --input data/synthetic/images/rotation_0.png \
  --config config/synthetic.yaml --no-subpixel --output result/learn/pixel
build/screw_metrology measure --input data/synthetic/images/rotation_0.png \
  --config config/synthetic.yaml --output result/learn/subpixel
```

比较 `pixel`、`subpixel`、`preferred_px` 与 `subpixel_status`，再与 200、40、20 px 的名义总长、头宽、杆宽比较。不要只统计小数位数。

仓库 2026-10-03 的 39 张合成图报告中，杆宽 MAE 从 0.9359 px 降至 0.1030 px，总长 MAE 从 0.2645 px 降至 0.2476 px。收益取决于形状、噪声及尺寸定义，不能推广为所有图像上的固定精度提升。独立解析边缘测试也需要结合其真值和误差阈值解释。

## 6. 什么时候应先修复分割

如果粗轮廓落在木纹上，亚像素只会更精细地估计木纹；如果尖端被截断，细化无法补出隐藏的长度；如果尺度错误，精细像素仍会换算成错误毫米。

先证明“测的是正确工件和正确边缘”，再讨论细化收益。这也是下一篇尺度与误差评估的前提。

## 7. 参考资料

- [对应测量和边缘细化源码](https://github.com/ChutianDuan/ScrewMetrology/blob/6782dfd337169fb6c77dc7378b9eafd44ff530ce/src/metrology.cpp)。
- [解析边缘与失败路径测试](https://github.com/ChutianDuan/ScrewMetrology/blob/6782dfd337169fb6c77dc7378b9eafd44ff530ce/tests/test_core.cpp)。
- [合成尺寸验证记录](https://github.com/ChutianDuan/ScrewMetrology/blob/6782dfd337169fb6c77dc7378b9eafd44ff530ce/docs/validation.md)。
