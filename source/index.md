---
layout: page
title: AI Application & C++ Engineer
description: 无名的个人技术博客：AI 应用、C++ 后端与计算机视觉部署。
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
      <h1 id="hero-title"><span>把智能系统，</span><span>做成可靠的软件。</span></h1>
      <p class="hero-intro">
        我是无名，专注 AI 应用、C++ 后端与计算机视觉部署。记录从 RAG、Agent 到实时系统的工程实践。
      </p>
      <div class="hero-actions">
        <a class="portfolio-button primary" href="#projects">
          查看项目
          <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M4 10h12m-4-4 4 4-4 4"></path></svg>
        </a>
        <a class="portfolio-button" href="#writing">
          阅读文章
          <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M4 10h12m-4-4 4 4-4 4"></path></svg>
        </a>
      </div>
      <p class="identity-line">AI APPLICATION <i></i> C++ BACKEND <i></i> COMPUTER VISION</p>
    </div>

    <div class="system-visual reveal" role="img" aria-label="RAG 与 Agent 服务架构示意图">
      <div class="diagram-grid" aria-hidden="true"></div>
      <div class="visual-heading">
        <span class="visual-title mono">RAG / AGENT GATEWAY</span>
      </div>
      <div class="flow-row flow-row-main">
        <div class="flow-node client-node">Client<span>Web / App</span></div>
        <span class="flow-arrow" aria-hidden="true">→</span>
        <div class="gateway-frame">
          <span class="frame-label mono">GATEWAY</span>
          <div class="flow-node">Query<span>Router</span></div>
          <span class="flow-arrow" aria-hidden="true">→</span>
          <div class="flow-node">Retriever<span>Vector / Rerank</span></div>
          <span class="flow-arrow" aria-hidden="true">→</span>
          <div class="flow-node">LLM<span>Agent Loop</span></div>
        </div>
      </div>
      <div class="service-connector" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="flow-row flow-row-services">
        <div class="flow-node service-node">Redis<span>Cache / Session</span></div>
        <div class="flow-node service-node">LanceDB<span>Vector Store</span></div>
        <div class="flow-node service-node">Trace<span>Audit Log</span></div>
      </div>
      <div class="terminal" aria-hidden="true">
        <div class="terminal-bar"><span></span><span></span><span></span><b class="mono">gateway.trace</b></div>
        <div class="terminal-lines mono">
          <span><i>01</i> route <b>/v1/chat/completions</b></span>
          <span><i>02</i> retrieve <b>context + citations</b></span>
          <span><i>03</i> execute <b>tool trace</b></span>
          <span><i>04</i> status <em>ready</em><span class="cursor"></span></span>
        </div>
        <div class="terminal-mark mono">OBSERVABLE BY DESIGN</div>
      </div>
    </div>
  </section>

  <section class="home-section section-shell" id="projects" aria-labelledby="projects-title">
    <div class="section-heading reveal">
      <div>
        <p class="section-index mono">01 / FEATURED WORK</p>
        <h2 id="projects-title">核心项目</h2>
      </div>
      <p>从接口、并发到推理与观测，做完整的工程闭环。</p>
    </div>

    <div class="project-grid">
      <a class="project-card project-card-featured reveal" href="/projects/#rag-agent-platform">
        <div class="project-card-top">
          <span class="project-number mono">01</span>
        </div>
        <div class="project-card-copy">
          <p class="project-type mono">AI APPLICATION BACKEND</p>
          <h3>RAG Gateway Stack</h3>
          <p>C++ Drogon 网关统一承载外部 API，FastAPI 与 Celery 处理检索、异步任务和模型编排。</p>
        </div>
        <ul class="project-highlight-list">
          <li>LanceDB 召回、MySQL chunk 回表与 CrossEncoder rerank</li>
          <li>循环工具调用、三层记忆、citations 与 Agent Trace</li>
        </ul>
        <div class="project-card-footer">
          <span>C++17</span><span>Drogon</span><span>Celery</span><span>Agent</span>
          <b aria-label="查看项目">↗</b>
        </div>
      </a>

      <a class="project-card reveal" href="/projects/#yolo-tracking-service">
        <div class="project-card-top">
          <span class="project-number mono">02</span>
        </div>
        <div class="project-card-copy">
          <p class="project-type mono">COMPUTER VISION</p>
          <h3>YOLO Tracking</h3>
          <p>面向道路视频动态监测的 C++ 检测跟踪服务，以高低分辨率模型协同平衡检测质量与调用开销。</p>
        </div>
        <ul class="project-highlight-list">
          <li>动态 stride 与质量退化驱动 low / high 紧急刷新</li>
          <li>LK 光流、ByteTrack 与异步结果时间补偿维持连续轨迹</li>
        </ul>
        <div class="project-metrics" aria-label="YOLO 三场景回归通过指标"><span><b>0.7726</b>三场景 F1</span><span><b>-63.2%</b>误检数量</span></div>
        <div class="project-card-footer"><span>YOLO26</span><span>ONNX</span><span>LK Flow</span><span>ByteTrack</span><b aria-label="查看项目">↗</b></div>
      </a>

      <a class="project-card reveal" href="/projects/#libevent-chat-server">
        <div class="project-card-top">
          <span class="project-number mono">03</span>
        </div>
        <div class="project-card-copy">
          <p class="project-type mono">C++ NETWORK SERVICE</p>
          <h3>Libevent Chat Server</h3>
          <p>基于 libevent 的多线程 TCP 聊天服务，在最小实现中完成连接、协议、并发状态和慢连接治理。</p>
        </div>
        <ul class="project-highlight-list">
          <li>1 个 Acceptor + N 个 Worker，socketpair 轮询分发 fd</li>
          <li>line-delimited JSON、房间 / 私信与 per-connection 背压</li>
        </ul>
        <div class="project-card-footer"><span>C++</span><span>libevent</span><span>Reactor</span><span>Backpressure</span><b aria-label="查看项目">↗</b></div>
      </a>

      <a class="project-card project-card-wide reveal" href="/projects/#fighting-authoritative-server">
        <div class="project-card-top">
          <span class="project-number mono">04</span>
        </div>
        <div class="project-card-copy">
          <p class="project-type mono">AUTHORITATIVE SERVER</p>
          <h3>Fighting Netcode</h3>
          <p>C++20 实时动作游戏同步 Demo，以 60Hz 服务端权威模拟串起输入、预测、校正和一致性验证。</p>
        </div>
        <ul class="project-highlight-list">
          <li>UDP 每包携带最近 K 帧输入，降低丢包导致的缺输入</li>
          <li>本地预测、rollback / replay 与量化 state hash 验证收敛</li>
        </ul>
        <div class="project-card-footer"><span>C++20</span><span>UDP</span><span>Rollback</span><span>State Hash</span><b aria-label="查看项目">↗</b></div>
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
          <p class="section-index mono">02 / ENGINEERING NOTES</p>
          <h2 id="writing-title">技术文章</h2>
        </div>
        <p>记录选型、实现和调试中真正有复用价值的部分。</p>
      </div>

      <div class="writing-list">
        <a class="writing-item reveal" href="/notes/ai模型开发/开发进度记录/">
          <span class="writing-number mono">01</span>
          <div><p>RAG / AGENT</p><h3>RAG Gateway Stack 工程复盘</h3></div>
          <time datetime="2026-04-20">2026.04</time><b>↗</b>
        </a>
        <a class="writing-item reveal" href="/notes/linux高性能服务器编程/1-libevent/">
          <span class="writing-number mono">02</span>
          <div><p>LINUX SERVER</p><h3>libevent 服务端入门与 Reactor 模型</h3></div>
          <time datetime="2026-05-05">2026.05</time><b>↗</b>
        </a>
        <a class="writing-item reveal" href="/notes/liunx-c-工程化/5-onnx模型导出与部署优化/">
          <span class="writing-number mono">03</span>
          <div><p>MODEL DEPLOYMENT</p><h3>PyTorch 模型导出 ONNX 与部署优化</h3></div>
          <time datetime="2026-07-10">2026.07</time><b>↗</b>
        </a>
        <a class="writing-item reveal" href="/notes/实时竞技游戏开发/fighting-netcode-项目知识笔记/">
          <span class="writing-number mono">04</span>
          <div><p>REAL-TIME SYSTEM</p><h3>Fighting Netcode 项目知识笔记</h3></div>
          <time datetime="2026-05-04">2026.05</time><b>↗</b>
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
        <p class="section-index mono">03 / ABOUT</p>
        <h2 id="about-title">关于我</h2>
      </div>
      <div class="about-copy">
        <p class="about-lead">我喜欢把“能跑”继续做到“可靠、可观测、可维护”。</p>
        <p>目前的工作重心是 AI 应用后端、C++ 网络服务和视觉模型部署。这里放项目复盘，也放每次搞清楚的原理与工程细节。</p>
        <div class="capability-list">
          <span>RAG &amp; Agent</span><span>C++ Backend</span><span>Computer Vision</span><span>Linux Systems</span>
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
      <p class="mono">LET'S BUILD SOMETHING RELIABLE.</p>
      <h2>有想法，就把它变成工程。</h2>
      <a href="https://github.com/ChutianDuan" target="_blank" rel="noreferrer">GitHub <span>↗</span></a>
    </div>
  </section>
</div>
{% endraw %}
