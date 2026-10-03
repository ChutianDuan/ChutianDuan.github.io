---
title: "AX=XB 手眼标定：坐标变换与 OpenCV 实践"
date: 2026-10-03 17:09:47
updated: 2026-10-03 17:09:47
categories:
  - "学习"
  - "Linux 与 C++ 工程化"
permalink: /notes/liunx-c-工程化/18-ax-xb手眼标定/
series: "Linux 与 C++ 工程化"
series_order: 18
---

相机已经标定，PnP 也求出工件位置，为什么机械臂仍然不能直接使用这个坐标？因为视觉输出在相机坐标系，机器人控制通常在基座坐标系。相机安装在末端时，两者之间还有一个未知但固定的刚体变换。

本文以眼在手上、标定板固定在基座环境中为主线，从坐标闭环推导 `AX=XB`，再用合成数据验证 OpenCV 接口。它是 ScrewMetrology 的进阶知识，项目当前没有机械臂接口或手眼标定实现。[返回系列导读](/notes/liunx-c-工程化/12-opencv实战导读/)。

API 说明参考 OpenCV 4.13；可运行示例已在 C++17、AppleClang 21、OpenCV 5.0.0 下验证，4.x 兼容分支未实测。

## 1. 先固定坐标与变换记法

本文约定 `T_a_b` 将 b 系中的坐标转换到 a 系，使用列向量和左乘。四个坐标系如下：

| 符号 | 坐标系 | 如何获得关系 |
| --- | --- | --- |
| b | 机器人基座 base | 机器人运动学的参考系 |
| g | 末端 gripper | 每个姿态提供 `T_b_g` |
| c | 相机 camera | 与末端刚性安装，未知 `T_g_c` |
| t | 标定板 target | 图像与 PnP 提供 `T_c_t` |

刚体变换用 4×4 齐次矩阵表示：

```text
T = [ R t ]       T⁻¹ = [ Rᵀ −Rᵀt ]
    [ 0 1 ]             [  0    1  ]
```

旋转逆是转置，平移逆不是简单地取负；还需要乘 `Rᵀ`。旋转向量使用弧度，机器人平移与标定板对象点使用统一长度单位。欧拉角的旋转顺序、内旋或外旋需要在转换前核对，不能直接拿三个角当 Rodrigues 向量。

## 2. 从固定标定板闭环推导 AX=XB

第 i 个机器人姿态满足：

```text
Gᵢ = T_b_g(i)
Cᵢ = T_c_t(i)
X  = T_g_c            未知且固定
Y  = T_b_t            标定板固定，因此也是常量

Gᵢ X Cᵢ = Y
```

拿两个姿态 i、j，消去 Y：

```text
Gᵢ X Cᵢ = Gⱼ X Cⱼ
Gⱼ⁻¹ Gᵢ X = X Cⱼ Cᵢ⁻¹

Aᵢⱼ = Gⱼ⁻¹ Gᵢ
Bᵢⱼ = Cⱼ Cᵢ⁻¹
Aᵢⱼ X = X Bᵢⱼ
```

A 和 B 是配对的**相对运动**，不是任意两条绝对位姿。调换姿态顺序可以得到另一套一致方程，但不能只把 A 或 B 的顺序反过来。

这个推导还说明了采集要求：末端移动、相机跟随，标定板在环境中保持固定。如果标定板自己移动，Y 不再是常量，当前模型就失效。

## 3. 旋转和位移怎样被约束

把 AX=XB 展开：

```text
R_A R_X = R_X R_B
(R_A − I)t_X = R_X t_B − t_A
```

先求旋转时，要让多组相对旋转提供足够独立的轴向信息。得到旋转后，可堆叠第二式求解位移。如果所有旋转都绕同一轴，某些分量缺少约束；只有平移、旋转太小或者姿态重复也会使估计退化或病态。

OpenCV 提供 Tsai、Park、Horaud、Andreff、Daniilidis 方法。本文示例固定使用 Park，优先验证数据方向和闭环；实际有噪声时再比较算法与独立验证误差，不能只按训练残差选择看起来最好的方法。

## 4. calibrateHandEye 接收什么、返回什么

眼在手上时，接口对应：

| 参数 | 本文记法 | 方向 |
| --- | --- | --- |
| `R_gripper2base`、`t_gripper2base` | Gᵢ | 末端 → 基座 |
| `R_target2cam`、`t_target2cam` | Cᵢ | 标定板 → 相机 |
| `R_cam2gripper`、`t_cam2gripper` | X | 相机 → 末端 |

```cpp
// 核心片段：同一索引的机器人位姿与相机观测已经配对。
cv::Mat R_cam2gripper, t_cam2gripper;
cv::calibrateHandEye(R_gripper2base, t_gripper2base,
    R_target2cam, t_target2cam,
    R_cam2gripper, t_cam2gripper, cv::CALIB_HAND_EYE_PARK);
```

API 接收每个姿态的绝对变换列表，会在算法中使用相对运动；不要先构造 A/B，再把它们当成这四个输入列表。对旋转使用 3×3 矩阵或合法的 Rodrigues 向量，平移使用 3×1 向量。

采集时还要对齐时间。机械臂尚未停止、图像曝光与机器人位姿不同步，会让正确矩阵形式对应错误物理状态。数据应该记录配对 ID、单位和方向，避免只保留几列没有语义的数字。

## 5. 可运行的已知变换恢复实验

示例预设真值 `X=T_g_c`，固定 `Y=T_b_t`，生成 12 个不同末端姿态 G，然后按闭环反算相机观测：

```text
Cᵢ = X⁻¹ Gᵢ⁻¹ Y
```

这使输入严格满足眼在手上模型，不需要相机或机械臂。下载 [CMakeLists.txt](/assets/screw-metrology/examples/CMakeLists.txt)、[camera_calibration.cpp](/assets/screw-metrology/examples/camera_calibration.cpp) 和 [handeye_calibration.cpp](/assets/screw-metrology/examples/handeye_calibration.cpp)，放在同一目录运行：

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j 4
./build/handeye_calibration
ctest --test-dir build --output-on-failure
```

无法自动找到 OpenCV 时设置 `OpenCV_DIR`。CMake 在 OpenCV 5 下选择 `calib`、`geometry`，在 4.x 下选择 `calib3d`。

程序验证三件事：恢复旋转和平移接近真值；所有 `GᵢXCᵢ` 接近固定 Y；相对运动满足 AX−XB 接近零。旋转矩阵差、位移毫米误差和矩阵残差分别输出。最后一个矩阵残差混合旋转与平移，只用于这个无噪声合成用例的数值一致性，不作为真实系统统一的物理误差指标。

### 5.1 退化运动的预期拒绝

```sh
./build/handeye_calibration --degenerate
```

这一分支只绕 z 轴旋转。程序将有效相对旋转向量归一化，检查是否存在足够不平行的两条轴；不足时在调用求解器前返回 1。CTest 通过 `WILL_FAIL` 将预期拒绝纳入验收。

该预检查能覆盖同轴与缺少旋转，但不是完整条件数或不确定度分析。真实采集需要更多姿态、不同旋转轴和足够旋转幅度，避免只平移或重复小动作。至少三个姿态和两个不平行旋转只是最低可观测条件，实践中应采集更多有效配对。

## 6. 怎么验证真实手眼结果

拿独立保留的机器人姿态与图像观测计算：

```text
Yᵢ = Gᵢ X Cᵢ
```

固定标定板意味着这些 Yᵢ 应一致。对旋转用相对旋转角，对平移用欧氏距离，分别报告分布、最大值及样本数；不要把毫米与弧度直接相加。若有独立测量真值，再比较绝对定位偏差。

只有求解样本上的小残差可能掩盖过拟合、机器人运动学误差和错误单位。若结果整体偏离但残差尚小，优先检查方向、求逆、欧拉角转换、长度单位、PnP 板尺寸及机器人末端定义。

眼在手外的链路不同：相机相对基座固定，标定板通常随末端移动。需要重新建立闭环、核对输入转换和未知 X 的含义，不能把眼在手上的数据原样套进去。

## 7. 由相机点到基座点还有什么前提

对于已经具有三维相机坐标的点 P_c，眼在手上可以计算：

```text
P_b = T_b_g · T_g_c · P_c
```

但一个二维像素本身只有视线方向，没有深度。要得到 P_c，还需要深度、已知平面约束或对象几何。ScrewMetrology 的二维质心和无向主轴不能直接当成六自由度抓取位姿；AX=XB 也不会替系统补出这些信息。

## 8. 参考资料

- [OpenCV calibrateHandEye：方向定义及眼在手上/手外推导](https://docs.opencv.org/4.13.0/d9/d0c/group__calib3d.html)。
- [OpenCV 官方手眼标定测试](https://github.com/opencv/opencv/blob/4.13.0/modules/calib3d/test/test_calibration_hand_eye.cpp)。
- [前置知识：张正友相机标定](/notes/liunx-c-工程化/17-张正友相机标定/)。
