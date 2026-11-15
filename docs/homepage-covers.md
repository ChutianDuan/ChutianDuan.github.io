# 首页项目封面

五组封面由内置 Image Gen 生成，作为项目主题的视觉示意；不代表项目运行截图、实际开发板照片、游戏画面或测量结果。页面中的“视觉示意”、项目名称、性能数字和交互控件由代码呈现。

资源位于 `source/assets/portfolio/covers/`，每组提供 480×300 和 960×600 WebP；通过本地已有 Pillow 转换尺寸和压缩，合计约 207 KB。首个封面优先加载，其他封面在切换前解码。

## 生成提示

共同方向：standalone production project-cover illustration, not a website screenshot; true white studio background, cool neutral materials, soft realistic shadows, a pale blue angular plane, engineering blue `#075cff` functional accents; centered wide composition with comfortable margins; no website UI, captions, branding or invented measurements.

- **rk3588**：前景为黑色 PCB、散热片及金属 USB/网口的板卡渲染；背景为三辆车的城市道路，蓝色检测框及虚线轨迹。以已确认的首页概念稿为视觉参考，去除全部界面文字与控件。
- **rag**：白色文档叠页，通过蓝色箭头连接回答面板；面板包含灰色段落线与 `[1]`、`[2]` 引用标记。
- **chat**：三个笔记本连接节点通过蓝色消息路径连接紧凑服务器，右侧终端呈现 `$ ./chat_server`、`> connected`、`> hello`。
- **fighting**：两名原创蓝黑像素风对战角色；下方为帧刻度、关键帧和回退/重放方向箭头，不包含真实游戏或性能数字。
- **screw**：横放的金属六角头螺钉、灰色轮廓线和蓝色长度/宽度尺寸箭头，不显示测量值。

后四张以第一张板卡封面为配色、光影和材质参考，保持同一视觉体系。生产图片不从完整页面截图中裁切 UI。
