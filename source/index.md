---
layout: page
title: 视觉部署与 C++ 系统实践
description: 无名的工程笔记，记录 RK3588 视觉模型部署、C++ 网络服务与 AI 应用的实现、调试和性能验证。
date: 2026-06-29 20:00:00
comments: false
sidebar: false
toc:
  enable: false
header: false
---

{% raw %}
<link rel="stylesheet" href="/assets/portfolio/portfolio.css">

<div class="home-shell" id="top">
  <section class="home-hero section-shell" aria-labelledby="hero-title">
    <div class="hero-copy reveal">
      <h1 id="hero-title"><span>视觉部署与</span><span>C++ 系统实践</span></h1>
      <p class="hero-intro">我是无名，记录视觉模型部署与 C++ 网络服务的实现、调试和性能验证，也整理 RAG / Agent 应用的工程笔记。</p>
      <div class="project-metrics hero-metrics" aria-label="RK3588 混合精度模型实测">
        <span><b>30.11 <small>FPS</small></b>有效检测速率</span>
        <span><b>12.17 <small>MiB</small></b>混合精度模型</span>
      </div>
      <p class="hero-evidence-note">2026-10-19 · Hybrid · 800×608 · 单路 JPEG 回放 10 分钟，检测速率受约 30 FPS 输入限制。<a href="https://github.com/ChutianDuan/Yolo/blob/d527fd2ac416e52dbd37e10bbbfaf4ef3f268ab7/README_RK3588.md">查看实测记录 ↗</a></p>
      <div class="hero-actions">
        <a class="portfolio-button primary" href="/projects/#yolo-tracking-service">
          查看视觉部署项目
          <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M4 10h12m-4-4 4 4-4 4"></path></svg>
        </a>
        <a class="portfolio-button" href="/articles/">
          阅读技术笔记
          <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M4 10h12m-4-4 4 4-4 4"></path></svg>
        </a>
      </div>
    </div>

    <figure class="system-visual reveal" aria-labelledby="vision-flow-title">
      <div class="visual-heading">
        <span class="visual-title mono" id="vision-flow-title">RK3588 / VISIONTRACK</span>
        <span class="visual-subtitle">摄像头到轨迹输出</span>
      </div>
      <div class="vision-input">
        <div><strong>YUYV 采集</strong><span>V4L2</span></div>
        <span class="vision-arrow" aria-hidden="true">→</span>
        <div><strong>共享图像缓冲</strong><span>DMA-BUF</span></div>
      </div>
      <p class="vision-dispatch"><span aria-hidden="true">↓</span> 不同帧分发至 3 个 Worker</p>
      <ol class="vision-workers" aria-label="三个并行推理 Worker">
        <li><strong>Worker 0</strong><span>RGA → RKNN</span><small>Context 0<br>NPU Core0</small></li>
        <li><strong>Worker 1</strong><span>RGA → RKNN</span><small>Context 1<br>NPU Core1</small></li>
        <li><strong>Worker 2</strong><span>RGA → RKNN</span><small>Context 2<br>NPU Core2</small></li>
      </ol>
      <p class="vision-dispatch"><span aria-hidden="true">↓</span> 按序汇合 · 拒绝迟到结果</p>
      <div class="vision-output"><strong>ByteTrack</strong><span>目标跟踪 → 轨迹 / JSONL</span></div>
      <figcaption>YUYV 共享缓冲路径；Worker 各自复用预处理与推理缓冲。</figcaption>
    </figure>
  </section>

  <section class="home-section section-shell" id="projects" aria-labelledby="projects-title">
    <div class="section-heading reveal">
      <div>
        <p class="section-index mono">01 / 项目</p>
        <h2 id="projects-title">项目</h2>
      </div>
      <p>最近做的几个项目，代码和实现笔记都在这里。</p>
    </div>

    <div class="project-grid">
      <a class="project-card project-card-featured reveal" href="/projects/#yolo-tracking-service">
        <div class="project-card-top">
          <span class="project-number mono">01</span>
        </div>
        <div class="project-card-copy">
          <p class="project-type mono">目标检测与跟踪</p>
          <h3>VisionTrack / YOLO Tracking</h3>
          <p>将 YOLO 检测与跟踪部署到 RK3588，结合混合精度量化和设备间共享缓冲处理摄像头视频。</p>
        </div>
        <ul class="project-highlight-list">
          <li>PTQ INT8 + 部分 FP16，缩小模型与运行内存占用</li>
          <li>DMA-BUF 零拷贝路径，MPP / RGA / NPU 协同处理</li>
        </ul>
        <div class="project-card-footer"><span>RK3588</span><span>INT8 / FP16</span><span>DMA-BUF</span><span>RKNN</span><b aria-label="查看项目">↗</b></div>
      </a>

      <a class="project-card reveal" href="/projects/#rag-agent-platform">
        <div class="project-card-top">
          <span class="project-number mono">02</span>
        </div>
        <div class="project-card-copy">
          <p class="project-type mono">知识库问答</p>
          <h3>RAG Gateway Stack</h3>
          <p>导入文件和网页后，可以检索文档、提问，并查看回答引用和工具调用记录。</p>
        </div>
        <ul class="project-highlight-list">
          <li>C++ 网关接入 Python 服务，异步处理文档和索引</li>
          <li>检索结果重排、Agent 工具调用和流式回答</li>
        </ul>
        <div class="project-card-footer">
          <span>Drogon</span><span>FastAPI</span><span>LanceDB</span><span>Agent</span>
          <b aria-label="查看项目">↗</b>
        </div>
      </a>

      <a class="project-card reveal" href="/projects/#libevent-chat-server">
        <div class="project-card-top">
          <span class="project-number mono">03</span>
        </div>
        <div class="project-card-copy">
          <p class="project-type mono">TCP 聊天服务</p>
          <h3>Libevent Chat Server</h3>
          <p>用 libevent 写的 TCP 聊天服务器，支持房间消息和私信，处理多线程连接分发与慢客户端积压。</p>
        </div>
        <ul class="project-highlight-list">
          <li>一个线程接受连接，多个 Worker 分别处理读写</li>
          <li>按行传输 JSON，限制每个连接的发送缓冲</li>
        </ul>
        <div class="project-card-footer"><span>C++</span><span>libevent</span><span>Reactor</span><span>Backpressure</span><b aria-label="查看项目">↗</b></div>
      </a>

      <a class="project-card project-card-wide reveal" href="/projects/#fighting-authoritative-server">
        <div class="project-card-top">
          <span class="project-number mono">04</span>
        </div>
        <div class="project-card-copy">
          <p class="project-type mono">动作游戏同步</p>
          <h3>Fighting Netcode</h3>
          <p>C++20 动作游戏同步 Demo，客户端先响应输入，再根据服务器状态修正预测。</p>
        </div>
        <ul class="project-highlight-list">
          <li>服务器以 60Hz 推进模拟，UDP 重复携带近期输入</li>
          <li>客户端回滚并重放输入，用状态哈希检查一致性</li>
        </ul>
        <div class="project-card-footer"><span>C++20</span><span>UDP</span><span>Rollback</span><span>State Hash</span><b aria-label="查看项目">↗</b></div>
      </a>
      <a class="project-card reveal" href="/projects/#screw-metrology">
        <div class="project-card-top"><span class="project-number mono">05</span></div>
        <div class="project-card-copy">
          <p class="project-type mono">图像尺寸测量</p>
          <h3>ScrewMetrology</h3>
          <p>用 OpenCV 定位离线图片中的螺钉，测量长度、头宽和杆宽。</p>
        </div>
        <ul class="project-highlight-list">
          <li>分割工件轮廓，确定主轴和测量方向</li>
          <li>亚像素边缘测量，输出叠加图、尺寸与公差结果</li>
        </ul>
        <div class="project-card-footer"><span>C++17</span><span>OpenCV</span><span>Subpixel</span><span>CTest</span><b aria-label="查看项目">↗</b></div>
      </a>
    </div>

    <div class="section-action reveal">
      <a class="text-link" href="/projects/">查看全部项目 <span>→</span></a>
    </div>
  </section>

  <section class="home-section writing-section" id="writing" aria-labelledby="writing-title">
    <div class="section-shell">
      <div class="section-heading reveal">
        <div>
          <p class="section-index mono">02 / 笔记</p>
          <h2 id="writing-title">技术文章</h2>
        </div>
        <p>学习笔记、项目记录，以及实现和调试时遇到的问题。</p>
      </div>

      <div class="writing-list">
        <a class="writing-item reveal" href="/notes/ai模型开发/开发进度记录/">
          <span class="writing-number mono">01</span>
          <div><p>知识库问答</p><h3>RAG Gateway Stack：文档导入、问答与引用</h3></div>
          <time datetime="2026-10-03">2026.10</time><b>↗</b>
        </a>
        <a class="writing-item reveal" href="/notes/linux高性能服务器编程/1-libevent/">
          <span class="writing-number mono">02</span>
          <div><p>Linux 服务器</p><h3>libevent 服务端入门与 Reactor 模型</h3></div>
          <time datetime="2026-05-05">2026.05</time><b>↗</b>
        </a>
        <a class="writing-item reveal" href="/notes/liunx-c-工程化/5-onnx模型导出与部署优化/">
          <span class="writing-number mono">03</span>
          <div><p>模型部署</p><h3>PyTorch 模型导出 ONNX 与部署优化</h3></div>
          <time datetime="2026-07-10">2026.07</time><b>↗</b>
        </a>
        <a class="writing-item reveal" href="/notes/实时竞技游戏开发/fighting-netcode-项目知识笔记/">
          <span class="writing-number mono">04</span>
          <div><p>游戏同步</p><h3>Fighting Netcode 项目知识笔记</h3></div>
          <time datetime="2026-05-04">2026.05</time><b>↗</b>
        </a>
        <a class="writing-item reveal" href="/notes/liunx-c-工程化/12-opencv实战导读/">
          <span class="writing-number mono">05</span>
          <div><p>OpenCV 测量</p><h3>OpenCV 实战导读：从图像到螺钉测量结果</h3></div>
          <time datetime="2026-10-03">2026.10</time><b>↗</b>
        </a>
      </div>

      <div class="section-action reveal">
        <a class="text-link" href="/articles/">浏览全部文章 <span>→</span></a>
      </div>
    </div>
  </section>

  <section class="home-section about-section section-shell" id="about" aria-labelledby="about-title">
    <div class="about-layout reveal">
      <div>
        <p class="section-index mono">03 / 关于</p>
        <h2 id="about-title">关于我</h2>
      </div>
      <div class="about-copy">
        <p class="about-lead">从视觉模型部署到 C++ 网络服务，关注具体实现与验证。</p>
        <p>这里整理 RK3588 推理、Linux 网络编程和 AI 应用的实践，保留调试过程、测试条件与可以回查的代码。</p>
        <div class="capability-list">
          <span>视觉部署</span><span>C++ 系统</span><span>Linux</span><span>RAG 与 Agent</span>
        </div>
        <div class="about-links">
          <a class="portfolio-button primary" href="/about/">了解更多</a>
          <a class="text-link" href="mailto:3383006954@qq.com">发送邮件 <span>↗</span></a>
        </div>
      </div>
    </div>
  </section>

  <section class="home-cta">
    <div class="section-shell reveal">
      <p class="mono">代码仓库</p>
      <h2>项目代码在 GitHub</h2>
      <a href="https://github.com/ChutianDuan" target="_blank" rel="noreferrer">GitHub <span>↗</span></a>
    </div>
  </section>
</div>
{% endraw %}
