---
title: 简历
description: 无名的视觉部署与 C++ 系统开发实践，附项目代码、技术笔记和验证记录。
date: 2026-06-29 20:10:00
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
      <h1>无名</h1>
      <p>视觉模型部署与 C++ 系统开发</p>
    </div>

    <div class="portfolio-focus-grid">
      <div>
        <h2>视觉与端侧部署</h2>
        <p>C++17 · RK3588 · RKNN · INT8 / FP16 · V4L2 · DMA-BUF · RGA / MPP。实现模型量化、视频预处理、NPU 并发与目标跟踪。</p>
      </div>
      <div>
        <h2>C++ 网络与并发</h2>
        <p>C++17/20 · Linux · Drogon · libevent · TCP / UDP。处理连接分发、有界队列、背压，以及游戏状态预测与回滚。</p>
      </div>
      <div>
        <h2>AI 应用与图像处理</h2>
        <p>FastAPI · Celery · MySQL · Redis · LanceDB；实现文档问答、Agent 工具调用和流式回答。使用 OpenCV 做工件定位与亚像素测量。</p>
      </div>
      <div>
        <h2>工程验证</h2>
        <p>CMake · CTest / GoogleTest · ONNX Runtime / OpenVINO。记录同模型 CPU 基准、板端长测与冻结配置评估，在结果旁保留环境和统计口径。</p>
      </div>
    </div>

    <div class="portfolio-actions">
      <a class="portfolio-button primary" href="/projects/">查看项目</a>
      <a class="portfolio-button" href="/articles/">查看文章</a>
      <a class="portfolio-button" href="https://github.com/ChutianDuan">GitHub</a>
      <a class="portfolio-button" href="mailto:3383006954@qq.com">邮件</a>
    </div>
  </section>

  <section class="portfolio-section" aria-labelledby="resume-projects-title">
    <div class="portfolio-section-heading">
      <h2 id="resume-projects-title">项目与验证记录</h2>
      <p>主要实现与对应的工程证据。</p>
    </div>
    <ul class="portfolio-link-list">
      <li><a href="/projects/#yolo-tracking-service">RK3588 Edge Vision / VisionTrack</a>：混合精度量化、DMA-BUF 共享缓冲与三 Worker 并发，附板端 10 分钟长测和部署记录。<a href="/projects/rk3588/">阅读工程专题</a></li>
      <li><a href="/projects/#rag-agent-platform">RAG Gateway Stack</a>：C++ 网关与 Python 文档服务，包含任务处理、检索重排、流式回答及引用追踪。</li>
      <li><a href="/projects/#libevent-chat-server">Libevent Chat Server</a>：Acceptor / Worker 连接分发、房间消息与慢连接背压。</li>
      <li><a href="/projects/#fighting-authoritative-server">Fighting Netcode</a>：60Hz 权威模拟、UDP 输入冗余、客户端预测与回滚重放。</li>
      <li><a href="/projects/#screw-metrology">ScrewMetrology</a>：工件分割、主轴定位与亚像素测量，附冻结配置的定位评价和合成尺寸验证。</li>
    </ul>
  </section>
</section>
{% endraw %}
