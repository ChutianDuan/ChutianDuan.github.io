---
title: Chutian Duan
date: 2026-06-29 20:00:00
comments: false
sidebar: false
---

<link rel="stylesheet" href="/assets/portfolio/portfolio.css">

<section class="portfolio-page">
  <section class="portfolio-hero">
    <p class="portfolio-name">Chutian Duan</p>
    <h1>AI Application &amp; C++ Vision Deployment Engineer</h1>
    <p class="portfolio-stack">RAG / Agent · C++ Backend · Linux · ONNX Runtime · Computer Vision</p>
    <p class="portfolio-summary">构建从模型训练、检索增强、异步任务到 Linux 服务部署的端到端 AI 系统。</p>
    <div class="portfolio-actions">
      <a class="portfolio-button primary" href="#core-projects">查看核心项目</a>
      <a class="portfolio-button" href="https://github.com/ChutianDuan">GitHub 主页</a>
    </div>
  </section>

  <section id="core-projects" class="portfolio-section">
    <div class="portfolio-section-heading">
      <p class="portfolio-eyebrow">Core Projects</p>
      <h2>三个核心项目</h2>
    </div>

    <article id="rag-agent-platform" class="portfolio-project">
      <div>
        <p class="portfolio-project-index">01</p>
        <h3>RAG / Agent 平台</h3>
        <p>面向知识库问答与工具调用场景的 AI 应用平台，采用 C++ Drogon 网关承接对外请求，FastAPI / Celery 负责任务编排，Redis / MySQL 管理状态、会话与元数据。</p>
        <p>系统覆盖向量检索、BM25、重排序、SSE 流式输出与 Agent Trace，重点是把 RAG 链路做成可追踪、可评估、可部署的后端系统。</p>
        <div class="portfolio-tags">
          <span>C++17</span><span>Drogon</span><span>FastAPI</span><span>Redis</span><span>MySQL</span><span>Celery</span><span>RAG</span><span>Agent</span>
        </div>
        <div class="portfolio-actions compact">
          <a class="portfolio-button primary" href="/projects/#rag-agent-platform">查看项目</a>
          <a class="portfolio-button" href="#rag-architecture">查看架构</a>
          <a class="portfolio-button" href="https://github.com/ChutianDuan?tab=repositories">查看 GitHub</a>
        </div>
      </div>
      <figure id="rag-architecture" class="portfolio-figure">
        <img src="/assets/rag/architecture.png" alt="RAG / Agent 平台架构图">
        <figcaption>RAG / Agent 平台架构示意</figcaption>
      </figure>
    </article>

    <article id="yolo-tracking-service" class="portfolio-project">
      <div>
        <p class="portfolio-project-index">02</p>
        <h3>YOLO ONNX Tracking Service</h3>
        <p>基于 ONNX Runtime C++、OpenCV、ByteTrack 和 LK 光流的 Linux CPU 视频目标检测与跟踪服务。</p>
        <p>实现动态抽帧检测、光流中间帧传播、轨迹管理与 HTTP 推理接口，在保证跟踪效果的同时降低 ONNX 推理次数。</p>
        <div class="portfolio-tags">
          <span>ONNX Runtime</span><span>OpenCV</span><span>ByteTrack</span><span>Optical Flow</span><span>Linux</span><span>C++</span>
        </div>
        <div class="portfolio-table-wrap">
          <table class="portfolio-table">
            <thead>
              <tr><th>模式</th><th>ONNX 调用次数</th><th>加速比</th><th>F1</th></tr>
            </thead>
            <tbody>
              <tr><td>Full ONNX</td><td>962</td><td>1.0x</td><td>1.000</td></tr>
              <tr><td>Dynamic ONNX + Flow</td><td>278</td><td>2.99x</td><td>0.937</td></tr>
              <tr><td>Fixed ONNX + Flow</td><td>161</td><td>4.59x</td><td>0.910</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <figure class="portfolio-figure">
        <img src="/assets/yolo/tracking-flow.svg" alt="YOLO 检测跟踪服务流程图">
        <figcaption>原始视频 -> 检测框 -> Track ID -> 光流传播 -> 性能统计</figcaption>
      </figure>
    </article>

    <article id="libevent-chat-server" class="portfolio-project">
      <div>
        <p class="portfolio-project-index">03</p>
        <h3>Libevent Chat Server</h3>
        <p>基于 libevent 的事件驱动 TCP 聊天服务，采用 Acceptor-Worker 架构、JSON 协议、连接管理与背压控制。</p>
        <p>项目重点在非阻塞 I/O、Reactor 模型、多线程连接分发、缓冲区水位和可测试的 C++ 服务端结构。</p>
        <div class="portfolio-tags">
          <span>C++</span><span>libevent</span><span>TCP</span><span>Reactor</span><span>多线程</span><span>CMake</span>
        </div>
        <div class="portfolio-actions compact">
          <a class="portfolio-button primary" href="/projects/#libevent-chat-server">查看项目</a>
          <a class="portfolio-button" href="/notes/linux高性能服务器编程/1-libevent/">阅读笔记</a>
        </div>
      </div>
    </article>
  </section>

  <section class="portfolio-section">
    <div class="portfolio-section-heading">
      <p class="portfolio-eyebrow">Technical Focus</p>
      <h2>技术能力地图</h2>
    </div>
    <div class="portfolio-focus-grid">
      <div><h3>AI Application</h3><p>RAG · Agent · Retrieval · Rerank · SSE · vLLM</p></div>
      <div><h3>C++ Backend</h3><p>Drogon · libevent · CMake · Redis · MySQL · Linux</p></div>
      <div><h3>Vision Deployment</h3><p>YOLO · ONNX Runtime · OpenCV · ByteTrack · Optical Flow</p></div>
      <div><h3>Engineering</h3><p>CTest · GoogleTest · CI · Benchmark · Docker Basics</p></div>
    </div>
  </section>

  <section class="portfolio-section portfolio-split">
    <div>
      <p class="portfolio-eyebrow">Writing</p>
      <h2>技术文章入口</h2>
      <p>博客仍然保留，但它的角色是证明项目理解：记录架构拆解、性能权衡、测试设计和部署经验。</p>
      <ul class="portfolio-link-list">
        <li><a href="/archives/">全部技术文章</a></li>
        <li><a href="/notes/ai模型开发/开发进度记录/">RAG 平台开发进度记录</a></li>
        <li><a href="/notes/ai模型开发/知识点学习/框架/drogon/">Drogon 网关学习笔记</a></li>
        <li><a href="/notes/linux高性能服务器编程/1-libevent/">libevent Reactor 与 TCP 服务端</a></li>
      </ul>
    </div>
    <div>
      <p class="portfolio-eyebrow">Contact</p>
      <h2>联系方式</h2>
      <p>欢迎通过 GitHub 查看项目与笔记，也可以通过邮件联系。</p>
      <ul class="portfolio-link-list">
        <li><a href="https://github.com/ChutianDuan">github.com/ChutianDuan</a></li>
        <li><a href="mailto:3383006954@qq.com">3383006954@qq.com</a></li>
        <li><a href="/resume/">简历页</a></li>
      </ul>
    </div>
  </section>
</section>
