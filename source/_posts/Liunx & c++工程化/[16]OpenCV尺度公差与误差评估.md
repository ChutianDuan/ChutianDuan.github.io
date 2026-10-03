---
title: "OpenCV 尺度与公差：怎样判断测量是否可信"
date: 2026-10-03 17:03:25
updated: 2026-10-03 17:03:25
categories:
  - "学习"
  - "Linux 与 C++ 工程化"
permalink: /notes/liunx-c-工程化/16-opencv尺度公差与误差评估/
series: "Linux 与 C++ 工程化"
series_order: 16
---

检测到一枚长度 200 px 的螺钉，就能判断它符合 20 mm 规格吗？还缺至少两件事：这次拍摄下的像素尺度，以及“20 mm 附近多大的偏差被接受”的配方。更早的分割、截断和方向问题也可能使这个数值没有判定意义。

本文对应 ScrewMetrology `6782dfd` 的尺度、公差与评价实现，实验使用 C++17 / OpenCV 5.0.0。[返回系列导读](/notes/liunx-c-工程化/12-opencv实战导读/)。

## 1. 两点尺度解决的是受限条件下的换算

选择两个参考点，其像素距离是 d，已知物理距离是 L，则：

```text
mm_per_px = L / d
dimension_mm = preferred_dimension_px · mm_per_px
```

项目要求参考点有限且在图像内、距离至少 1 px、毫米距离为正，加载文件时会重新计算尺度并检查一致性。过短参考距离会放大选点误差。

适用前提是固定拍摄设置、同一测量平面和近似正视。分辨率相同只是必要条件，不能自动证明焦距、距离、裁切和工件平面都相同。单个比例系数不会修正镜头畸变和透视变化。

### 1.1 在合成图上验证换算链路

完成导读的构建后，在项目根目录执行：

```sh
build/screw_metrology calibrate-scale \
  --input data/synthetic/images/rotation_0.png \
  --p1 100,100 --p2 300,100 --mm 20 --output result/learn/scale.yaml
build/screw_metrology measure --input data/synthetic/images/rotation_0.png \
  --config config/synthetic.yaml --scale result/learn/scale.yaml \
  --mode single --recipe config/example_recipe_mm.yaml \
  --output result/learn/inspection
```

200 px 对应 20 mm，得到 0.1 mm/px。这是人为规定的合成尺度，验证软件换算和判定流程；它不是一次实物标定，也不能证明相机测量达到某个毫米精度。

## 2. 公差判定之前先检查前提

项目先选择有效亚像素尺寸，否则逐项使用像素结果，再按以下顺序检查：

```text
是否为单规格模式？
  → 是否提供配方？
  → 几何是否可靠？
  → 毫米配方是否存在适用尺度？
  → 每个必需尺寸是否可测且在范围内？
```

`--mode single` 表示使用者确认按单规格检验，不是自动识别了工件型号。配方上下界包含边界。至少一项必需尺寸缺失时保持 `NOT_EVALUATED`，即使其他项已经越界，也不声称完成了整份配方的检验。

| 状态 | 含义 | 常见原因 |
| --- | --- | --- |
| `OK` | 所有配置项均可测且在范围内 | `all_configured_limits_passed` |
| `NG` | 判定前提满足，存在越界项 | 某尺寸 `out_of_range` |
| `NOT_EVALUATED` | 无法完成可靠判定 | 无配方、尺度不适用、几何不可靠、尺寸缺失 |

混料展示模式、没有配方和无尺度不是同一个问题。检查 `reasons`，避免把所有未判定都通过放宽尺寸上下界“修好”。

## 3. 不可测字段为什么保留 null

头杆结构不明显时，头长、头宽或杆宽可能不可测。如果把缺失转换为 0，一个只设置上限的配方就可能错误通过。输出中的 `null` 保留信息缺失，毫米换算也应继续保留缺失。

同样，分辨率不一致会使尺度失效；无尺度时仍然可以输出像素测量和质量信息。展示有结果与检验有结论是两个层次。

## 4. 用失败样例检查判定的边界

```sh
build/screw_metrology measure --input data/synthetic/edge_cases/truncated.png \
  --config config/synthetic.yaml --mode single \
  --recipe config/example_recipe_px.yaml --output result/learn/truncated
build/screw_metrology measure --input data/synthetic/edge_cases/touching.png \
  --config config/synthetic.yaml --mode single \
  --recipe config/example_recipe_px.yaml --output result/learn/touching
```

截断目标可能仍有可见长度，粘连目标可能仍有稳定旋转框，但都应结合 `reliable`、`quality_issues` 和 `reasons` 检查未判定行为。没有目标时应输出空对象集合，坏图应记录错误；不能把二者当作“零尺寸合格”。

## 5. 三类评价分别回答三个问题

### 5.1 定位评价：是否找到正确工件

真实 MVTec 数据使用旋转框 IoU≥0.5 降序一对一匹配，统计 TP、FP、FN：

```text
precision = TP / (TP + FP)
recall    = TP / (TP + FN)
```

仓库 2026-10-03 冻结报告的 384 张图像有 4427 条标注，TP=3743、FP=750、FN=684，对应 83.31% 精确率和 84.55% 检出率。官方数据页面与实际包的标注数量差异在报告中保留说明。

中心与方向误差只统计成功匹配目标；方向按 180° 周期计算并排除近圆真值框。这些数字不能描述漏检目标的定位误差，更不能替代毫米精度。

### 5.2 尺寸评价：与几何真值相差多少

用独立几何真值计算有符号误差、MAE 和最大误差：

```text
eᵢ = measurementᵢ − truthᵢ
MAE = sum(|eᵢ|) / N
```

合成图可以提供精确几何真值，方便检查旋转、离散轮廓、亚像素及降级路径。报告应说明哪些字段和样例缺失，不能只统计成功细化的尺寸再宣称整体精度。

### 5.3 重复性评价：相同条件下波动多大

项目的 30 次固定形状叠加模拟噪声实验测的是模拟重复性。真实相机还会受到照明、装夹、焦距、操作者及温漂影响。小标准差不表示没有系统偏差，也不表示真实重复性或 GR&R 已经验证。

## 6. 从像素到毫米的误差传播

设尺度 k=L/d、像素尺寸为 p，毫米结果 M=kp。在变量独立且误差较小时，一阶近似为：

```text
Var(M) ≈ k² Var(p) + p² Var(k)
Var(k) ≈ Var(L)/d² + L² Var(d)/d⁴
```

这个式子用于理解影响，不是完整不确定度报告。尺度与像素测量可能相关，透视和畸变可能产生位置相关的系统误差。增加像素结果的小数位并不能降低参考距离误差。

若物理尺度随位置变化，下一步应考虑相机标定和测量平面映射；如果需要把视觉结果交给机械臂，再考虑手眼标定。它们不能被一个 `mm_per_px` 替代。

## 7. 参考资料

- [尺度与配方源码](https://github.com/ChutianDuan/ScrewMetrology/blob/6782dfd337169fb6c77dc7378b9eafd44ff530ce/src/calibration.cpp)。
- [评价源码](https://github.com/ChutianDuan/ScrewMetrology/blob/6782dfd337169fb6c77dc7378b9eafd44ff530ce/src/evaluation.cpp)。
- [验证记录及统计口径](https://github.com/ChutianDuan/ScrewMetrology/blob/6782dfd337169fb6c77dc7378b9eafd44ff530ce/docs/validation.md)。
- [继续阅读：张正友相机标定](/notes/liunx-c-工程化/17-张正友相机标定/)。
