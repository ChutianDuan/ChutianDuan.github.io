---
title: 关于
description: 无名的技术方向与工程实践，记录视觉模型部署、C++ 系统开发和验证过程。
date: 2026-01-24 11:00:00
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
      <h1>关于</h1>
      <p>我是无名，主要做视觉模型部署与 C++ 系统开发。这里记录从模型推理、缓冲管理到网络服务的实现过程，也保留测试条件和调试记录。</p>
    </div>

    <div class="portfolio-focus-grid">
      <div><h2>视觉模型部署</h2><p>在 <a href="/projects/rk3588/">RK3588 Edge Vision</a> 中处理混合精度量化、DMA-BUF 缓冲共享和 NPU 并发，将检测与跟踪接到摄像头链路。也用 OpenCV 做离线图像定位与尺寸测量。</p></div>
      <div><h2>C++ 系统开发</h2><p>用 Drogon 和 libevent 写网络服务，处理连接分发、线程协作和慢客户端积压；通过游戏同步 Demo 理解预测、回滚与状态一致性。</p></div>
      <div><h2>AI 应用</h2><p>将文档解析、检索与回答生成接成服务，处理后台任务、流式回答，以及 Agent 的工具调用和引用记录。</p></div>
      <div><h2>实现与验证</h2><p>笔记从具体问题出发，记录可运行的实现、测试条件和排查过程。项目页链接到代码与验证记录，文章按专题整理，方便沿着问题继续查阅。</p></div>
    </div>

    <div class="portfolio-actions">
      <a class="portfolio-button primary" href="/projects/">查看项目</a>
      <a class="portfolio-button" href="/articles/">技术文章</a>
      <a class="portfolio-button" href="/resume/">简历</a>
      <a class="portfolio-button" href="https://github.com/ChutianDuan">GitHub</a>
      <a class="portfolio-button" href="mailto:3383006954@qq.com">邮件</a>
    </div>
  </section>
</section>
{% endraw %}
