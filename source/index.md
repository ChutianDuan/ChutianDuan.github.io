---
title: Chutian Duan
date: 2026-06-29 20:00:00
comments: false
sidebar: false
---

{% raw %}
<link rel="stylesheet" href="/assets/portfolio/portfolio.css">

<section class="portfolio-page">
  <section class="portfolio-hero">
    <p class="portfolio-name">Chutian Duan</p>
    <h1>AI Application &amp; C++ Vision Deployment Engineer</h1>
    <p class="portfolio-stack">RAG / Agent · C++ Backend · Linux · ONNX Runtime · Computer Vision</p>
    <p class="portfolio-summary">把 RAG、视觉推理和网络服务做成可运行、可观测、可部署的工程系统。</p>
    <div class="portfolio-actions">
      <a class="portfolio-button primary" href="#core-projects">查看核心项目</a>
      <a class="portfolio-button" href="#blog-tracks">阅读技术文章</a>
      <a class="portfolio-button" href="https://github.com/ChutianDuan">GitHub 主页</a>
    </div>
  </section>

  <section id="core-projects" class="portfolio-section">
    <div class="portfolio-section-heading">
      <h2>核心项目</h2>
    </div>

    <article id="rag-agent-platform" class="portfolio-project">
      <div>
        <p class="portfolio-project-index">01</p>
        <h3>RAG Gateway Stack</h3>
        <p>C++ Drogon 网关、FastAPI、Celery、MySQL、Redis、LanceDB 与 React Workbench 组成的 RAG / Agent 后端项目，支持文档索引、引用追踪、会话记忆和工具调用 Trace。</p>
        <div class="portfolio-tags">
          <span>C++17</span><span>Drogon</span><span>FastAPI</span><span>Celery</span><span>MySQL</span><span>Redis</span><span>LanceDB</span><span>Agent</span>
        </div>
        <div class="portfolio-actions compact">
          <a class="portfolio-button primary" href="/projects/#rag-agent-platform">查看项目</a>
          <a class="portfolio-button" href="https://github.com/ChutianDuan/Repo">GitHub</a>
          <a class="portfolio-button" href="/notes/ai模型开发/开发进度记录/">开发记录</a>
        </div>
      </div>
      <figure class="portfolio-figure">
        <img src="/assets/rag/architecture.png" alt="RAG / Agent 平台架构图">
        <figcaption>网关、任务、检索、存储与工作台分层</figcaption>
      </figure>
    </article>

    <article id="yolo-tracking-service" class="portfolio-project">
      <div>
        <p class="portfolio-project-index">02</p>
        <h3>YOLO ONNX Tracking Service</h3>
        <p>基于 ONNX Runtime C++、OpenCV、ByteTrack 和 LK 光流的视频检测跟踪服务，用动态抽帧和中间帧传播减少 CPU 推理次数。</p>
        <div class="portfolio-metrics">
          <span>2.99x 加速</span><span>F1 0.937</span><span>278 次 ONNX 调用</span>
        </div>
        <div class="portfolio-tags">
          <span>ONNX Runtime</span><span>OpenCV</span><span>ByteTrack</span><span>Optical Flow</span><span>Linux CPU</span>
        </div>
        <div class="portfolio-actions compact">
          <a class="portfolio-button primary" href="/projects/#yolo-tracking-service">查看项目</a>
          <a class="portfolio-button" href="https://github.com/ChutianDuan/Yolo">GitHub</a>
        </div>
      </div>
      <figure class="portfolio-figure">
        <img src="/assets/yolo/tracking-flow.svg" alt="YOLO 检测跟踪服务流程图">
        <figcaption>检测框、Track ID、光流传播与性能统计链路</figcaption>
      </figure>
    </article>

    <article id="libevent-chat-server" class="portfolio-project">
      <div>
        <p class="portfolio-project-index">03</p>
        <h3>Libevent Chat Server</h3>
        <p>基于 libevent 的多线程 TCP 聊天服务，采用 Acceptor + N Worker、line-delimited JSON、房间/私信和背压控制。</p>
        <div class="portfolio-tags">
          <span>C++</span><span>libevent</span><span>TCP</span><span>Reactor</span><span>多线程</span><span>CMake</span>
        </div>
        <div class="portfolio-actions compact">
          <a class="portfolio-button primary" href="/projects/#libevent-chat-server">查看项目</a>
          <a class="portfolio-button" href="https://github.com/ChutianDuan/chat_server">GitHub</a>
          <a class="portfolio-button" href="/notes/linux高性能服务器编程/1-libevent/">阅读笔记</a>
        </div>
      </div>
    </article>
  </section>

  <section id="blog-tracks" class="portfolio-section">
    <div class="portfolio-section-heading">
      <h2>博客主线</h2>
    </div>
    <div class="portfolio-link-grid">
      <a class="portfolio-link-card" href="/notes/ai模型开发/开发进度记录/">
        <strong>AI 应用后端</strong>
        <span>RAG、Agent、FastAPI、Celery、Redis、检索与部署记录。</span>
      </a>
      <a class="portfolio-link-card" href="/notes/linux高性能服务器编程/">
        <strong>Linux 服务端</strong>
        <span>Socket、libevent、Reactor、线程模型与服务端调试。</span>
      </a>
      <a class="portfolio-link-card" href="/notes/现代c-实践/00-现代c-实践导读/">
        <strong>现代 C++ 实践</strong>
        <span>所有权、并发、协程、测试、CMake 和接口设计。</span>
      </a>
      <a class="portfolio-link-card" href="/notes/实时竞技游戏开发/fighting-netcode-项目知识笔记/">
        <strong>实时系统</strong>
        <span>UDP、客户端预测、回滚重放和状态一致性。</span>
      </a>
    </div>
  </section>

  <section class="portfolio-section portfolio-split">
    <div>
      <h2>常用入口</h2>
      <ul class="portfolio-link-list">
        <li><a href="/archives/">全部技术文章</a></li>
        <li><a href="/projects/">核心项目</a></li>
        <li><a href="/resume/">简历页</a></li>
        <li><a href="/link/">链接页</a></li>
      </ul>
    </div>
    <div>
      <h2>联系方式</h2>
      <ul class="portfolio-link-list">
        <li><a href="https://github.com/ChutianDuan">github.com/ChutianDuan</a></li>
        <li><a href="mailto:3383006954@qq.com">3383006954@qq.com</a></li>
      </ul>
    </div>
  </section>
</section>
{% endraw %}
