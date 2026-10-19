---
title: 项目
date: 2026-06-29 20:05:00
comments: false
sidebar: false
toc:
  enable: false
header: false
---

{% raw %}
<link rel="stylesheet" href="/assets/portfolio/portfolio.css">

<section class="portfolio-page">
  <section class="portfolio-section">
    <div class="portfolio-section-heading">
      <h1>项目</h1>
      <p>这里放项目介绍、代码仓库和相关笔记。</p>
    </div>

    <article id="rag-agent-platform" class="portfolio-project">
      <div>
        <p class="portfolio-project-index">01</p>
        <h2>RAG Gateway Stack</h2>
        <p>导入文件和网页后，可以检索文档、提问，并查看回答引用和工具调用记录。C++ 网关负责对外接口，Python 服务处理文档、检索和回答生成。</p>
        <ul class="portfolio-link-list">
          <li>文件和网页共用文档解析与索引流程，Celery 后台处理任务，前端可以查看进度。</li>
          <li>LanceDB 检索相关片段，MySQL 提供正文，CrossEncoder 对结果重排后交给模型回答。</li>
          <li>Agent 结合用户记忆、会话摘要和近期消息调用只读工具，工作台展示调用记录与引用。</li>
          <li>SSE 逐步返回回答，支持断线续传；回答与引用保存到数据库，方便之后回查。</li>
        </ul>
        <div class="portfolio-tags">
          <span>C++17</span><span>Drogon</span><span>FastAPI</span><span>Celery</span><span>MySQL</span><span>Redis</span><span>LanceDB</span><span>React</span><span>Agent</span>
        </div>
        <div class="portfolio-actions compact">
          <a class="portfolio-button primary" href="https://github.com/ChutianDuan/Repo">GitHub 仓库</a>
          <a class="portfolio-button" href="/notes/ai模型开发/开发进度记录/">项目复盘</a>
          <a class="portfolio-button" href="/notes/ai模型开发/deep-research-report/">运行与验收</a>
        </div>
      </div>
      <figure class="portfolio-figure">
        <img src="/assets/rag/architecture-v2.svg" alt="RAG Gateway Stack 分层架构图">
        <figcaption>文档经过网关和后台任务入库，检索结果用于问答与 Agent 工具调用</figcaption>
      </figure>
    </article>

    <article id="yolo-tracking-service" class="portfolio-project">
      <div>
        <p class="portfolio-project-index">02</p>
        <h2>VisionTrack / YOLO Tracking</h2>
        <p>将 YOLO26 道路目标检测与 ByteTrack 跟踪部署到视美泰 RK3588。用 PTQ 混合精度缩小模型，通过 DMA-BUF 在采集、硬件解码、图像预处理和 NPU 之间共享缓冲，完成摄像头到轨迹输出的 C++ 流水线。</p>
        <ul class="portfolio-link-list">
          <li><strong>PTQ INT8 + 部分 FP16：</strong>先建立 INT8 基线，再按逐层分析将敏感位置保留为 FP16，使用 RKNN-Toolkit2 导出固定混合精度模型。</li>
          <li><strong>DMA-BUF 零拷贝路径：</strong>YUYV 采集直接交给 RGA / RKNN，稳态应用层上传为 0 字节；MJPEG 保留一次压缩包复制，解码后由 MPP / RGA / RKNN 共享图像缓冲。帧租约与 RAII 管理缓冲归还和资源释放。</li>
          <li><strong>RK3588 部署：</strong>MPP 硬件解码、RGA 颜色转换与 letterbox，三个独立 RKNN Context 分别绑定 NPU Core0 / 1 / 2，对单路视频的不同帧并发推理。</li>
          <li>采集、推理与输出使用有界队列，等待槽保留最新帧；ByteTrack 校正轨迹，按序号和时间水位拒绝迟到结果，JSONL 记录检测、轨迹和运行资源。</li>
        </ul>
        <div class="portfolio-metrics" aria-label="RK3588 混合精度模型运行指标">
          <span>有效检测 30.11 FPS</span>
          <span>模型 12.17 MiB</span>
          <span>平均 RSS 146.17 MiB</span>
        </div>
        <p class="portfolio-metric-note">2026-10-19，Hybrid 模型、单路交通 JPEG 回放、800×608 输入、三 Context split、关闭预览并保留画框与跟踪，连续运行 10 分钟，完成 18,066 / 18,066 帧检测。FPS 与 RSS 排除前 30 秒及末尾 30 帧；检测速度受约 30 FPS 的输入速率限制。模型比 FP16 缩小 42.62%。</p>
        <div class="portfolio-tags">
          <span>C++17</span><span>RK3588</span><span>PTQ INT8 / FP16</span><span>V4L2</span><span>DMA-BUF</span><span>MPP</span><span>RGA</span><span>RKNN</span><span>ByteTrack</span>
        </div>
        <div class="portfolio-actions compact">
          <a class="portfolio-button primary" href="https://github.com/ChutianDuan/Yolo">GitHub 仓库</a>
          <a class="portfolio-button" href="https://github.com/ChutianDuan/Yolo/blob/d527fd2ac416e52dbd37e10bbbfaf4ef3f268ab7/README_RK3588.md">板端部署与实测</a>
          <a class="portfolio-button" href="/notes/liunx-c-工程化/5-onnx模型导出与部署优化/">部署笔记</a>
        </div>
      </div>
      <div class="yolo-project-visual">
        <figure class="portfolio-figure">
          <a href="/assets/yolo/shimeta-rk3588.png" aria-label="查看视美泰 RK3588 开发板原图">
            <img src="/assets/yolo/shimeta-rk3588.png" width="1402" height="1122" loading="lazy" alt="用于 YOLO 部署的视美泰 RK3588 开发板，展示散热器、摄像头与外设接口">
          </a>
          <figcaption>视美泰 RK3588 · ARM64 Linux 部署平台</figcaption>
        </figure>
        <ol class="yolo-pipeline" aria-label="RK3588 摄像头处理流程">
          <li><span>01 / 采集与解码</span><strong>V4L2 / MPP</strong><small>YUYV 直通 / MJPEG 硬件解码</small></li>
          <li><span>02 / 共享缓冲与预处理</span><strong>DMA-BUF → RGA</strong><small>颜色转换 · RGB 800×608 · letterbox</small></li>
          <li><span>03 / 推理与跟踪</span><strong>RKNN → ByteTrack</strong><small>INT8 + 部分 FP16 · 三核分帧并发</small></li>
        </ol>
        <div class="yolo-calibration-tool">
          <h3>摄像头标定板</h3>
          <p>可调整内角点数量、全屏显示、锁定方格大小并导出 SVG。下载单个 HTML 即可离线使用。</p>
          <div class="portfolio-actions compact">
            <a class="portfolio-button primary" href="/tools/camera-calibration.html">打开标定板</a>
            <a class="portfolio-button" href="/tools/camera-calibration.html" download="摄像头标定板.html">下载 HTML</a>
          </div>
        </div>
      </div>
    </article>

    <article id="libevent-chat-server" class="portfolio-project">
      <div>
        <p class="portfolio-project-index">03</p>
        <h2>Libevent Chat Server</h2>
        <p>用 libevent 写的 TCP 聊天服务器，支持房间消息和私信，处理多线程连接分发与慢客户端积压。一个 Acceptor 接受连接，再把连接分给多个 Worker 处理。</p>
        <ul class="portfolio-link-list">
          <li>通过 socketpair 分发连接，每个 Worker 使用独立的 event_base 处理读写和连接清理。</li>
          <li>一行 JSON 对应一条消息，支持设置昵称、加入或离开房间、广播和私信。</li>
          <li>共享用户和房间数据使用互斥锁，广播时先取快照，再释放锁发送消息。</li>
          <li>发送缓冲超过上限时暂停写入并排队，缓冲回落后继续发送，持续积压的慢连接会被断开。</li>
        </ul>
        <div class="portfolio-tags">
          <span>C++</span><span>libevent</span><span>TCP</span><span>Reactor</span><span>socketpair</span><span>JSON</span><span>Backpressure</span><span>CMake</span>
        </div>
        <div class="portfolio-actions compact">
          <a class="portfolio-button primary" href="https://github.com/ChutianDuan/chat_server">GitHub 仓库</a>
          <a class="portfolio-button" href="/notes/linux高性能服务器编程/1-libevent/">阅读 libevent 笔记</a>
          <a class="portfolio-button" href="/notes/linux高性能服务器编程/3-socket基础与tcp编程/">Socket 与 TCP</a>
        </div>
      </div>
    </article>

    <article id="fighting-authoritative-server" class="portfolio-project">
      <div>
        <p class="portfolio-project-index">04</p>
        <h2>Fighting Netcode</h2>
        <p>C++20 动作游戏同步 Demo，客户端先响应输入，再根据服务器状态修正预测。用它查看网络延迟、丢包和预测偏差怎样影响游戏状态。</p>
        <ul class="portfolio-link-list">
          <li>服务器以 60Hz 推进模拟，并定期广播输入确认和游戏状态。</li>
          <li>客户端收到服务器状态后恢复快照，重放本地输入，追到当前逻辑帧。</li>
          <li>使用 UDP 传输，每个包重复携带最近几帧输入，减少丢包带来的输入缺失。</li>
          <li>用量化后的状态哈希检查客户端与服务器是否一致，测试覆盖编解码、延迟状态和大量回滚。</li>
        </ul>
        <div class="portfolio-tags">
          <span>C++20</span><span>UDP</span><span>libevent</span><span>SDL2</span><span>Rollback</span><span>Prediction</span><span>State Hash</span><span>CTest</span>
        </div>
        <div class="portfolio-actions compact">
          <a class="portfolio-button primary" href="https://github.com/ChutianDuan/Fighting">GitHub 仓库</a>
          <a class="portfolio-button" href="/notes/实时竞技游戏开发/fighting-netcode-项目知识笔记/">阅读项目笔记</a>
          <a class="portfolio-button" href="/notes/实时竞技游戏开发/网络/">UDP 抗丢包设计</a>
        </div>
      </div>
      <figure class="portfolio-figure">
        <img src="/assets/fighting/authoritative-server.png" alt="Fighting 权威服务器流程图">
        <figcaption>服务器推进模拟，客户端发送输入，并根据收到的状态回滚和重放</figcaption>
      </figure>
    </article>
    <article id="screw-metrology" class="portfolio-project">
      <div>
        <p class="portfolio-project-index">05</p>
        <h2>ScrewMetrology</h2>
        <p>用 OpenCV 定位离线图片中的螺钉，测量长度、头宽和杆宽。使用 C++17 实现，结果包括工件轮廓、测量叠加图和尺寸记录。</p>
        <ul class="portfolio-link-list">
          <li>用阈值、Lab 颜色和形态学处理分割工件，筛选轮廓并检查粘连、碎裂与背景误检。</li>
          <li>比较旋转框、PCA 和拟合直线得到的主轴，沿工件方向测量长度、头宽和杆宽。</li>
          <li>在原始灰度图上采样边缘，通过梯度峰拟合细化尺寸，保留像素与亚像素测量结果。</li>
          <li>按配置的尺度和公差配方进行判定，输出掩膜、叠加图、JSON 与报告。</li>
        </ul>
        <div class="portfolio-metrics" aria-label="2026-10-03 MVTec 冻结配置定位评价">
          <span>检出率 84.55%</span><span>精确率 83.31%</span>
        </div>
        <p class="portfolio-metric-note">2026-10-03 固定配置评估：384 张 MVTec 图像（含调参样例），按旋转框 IoU≥0.5 一对一匹配。</p>
        <div class="portfolio-tags">
          <span>C++17</span><span>OpenCV</span><span>PCA</span><span>Subpixel</span><span>Metrology</span><span>CMake</span><span>CTest</span>
        </div>
        <div class="portfolio-actions compact">
          <a class="portfolio-button primary" href="https://github.com/ChutianDuan/ScrewMetrology">GitHub 仓库</a>
          <a class="portfolio-button" href="/notes/liunx-c-工程化/12-opencv实战导读/">OpenCV 实战系列</a>
          <a class="portfolio-button" href="https://github.com/ChutianDuan/ScrewMetrology/blob/6782dfd337169fb6c77dc7378b9eafd44ff530ce/docs/validation.md">验证记录</a>
        </div>
      </div>
      <figure class="portfolio-figure">
        <img src="/assets/screw-metrology/measurement-flow.svg" alt="ScrewMetrology 从分割、定位到亚像素测量与公差判定的流程图" loading="lazy">
        <figcaption>分割螺钉轮廓、确定测量方向，再输出尺寸与公差结果</figcaption>
      </figure>
    </article>
  </section>
</section>
{% endraw %}
