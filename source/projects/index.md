---
title: 项目
date: 2026-06-29 20:05:00
comments: false
sidebar: false
---

{% raw %}
<link rel="stylesheet" href="/assets/portfolio/portfolio.css">

<section class="portfolio-page">
  <section class="portfolio-section">
    <div class="portfolio-section-heading">
      <p class="portfolio-eyebrow">Projects</p>
      <h1>核心项目</h1>
      <p>这里集中展示与求职方向最相关的项目：AI 应用后端、C++ 网络服务和视觉部署。</p>
    </div>

    <article id="rag-agent-platform" class="portfolio-project">
      <div>
        <p class="portfolio-project-index">01</p>
        <h2>RAG / Agent 平台</h2>
        <p>面向知识库问答与工具调用场景的 AI 应用平台。整体采用 C++ Drogon 网关 + Python RAG Service 的双服务结构，兼顾工程可控性与模型生态。</p>
        <p>Drogon 负责对外 API、会话、状态治理和内部服务代理；FastAPI / Celery 负责文档解析、切块、索引构建和 RAG 推理任务；Redis / MySQL 负责任务状态、缓存、会话与元数据持久化。</p>
        <ul class="portfolio-link-list">
          <li>检索链路：向量检索、BM25、重排序、引用返回。</li>
          <li>输出链路：SSE 流式响应、任务状态查询、Agent Trace。</li>
          <li>工程重点：可部署、可追踪、可回归评估的 AI 应用后端。</li>
        </ul>
        <div class="portfolio-tags">
          <span>C++17</span><span>Drogon</span><span>FastAPI</span><span>Celery</span><span>Redis</span><span>MySQL</span><span>RAG</span><span>Agent</span>
        </div>
      </div>
      <figure class="portfolio-figure">
        <img src="/assets/rag/architecture.png" alt="RAG / Agent 平台架构图">
        <figcaption>RAG / Agent 平台架构示意</figcaption>
      </figure>
    </article>

    <article id="yolo-tracking-service" class="portfolio-project">
      <div>
        <p class="portfolio-project-index">02</p>
        <h2>YOLO ONNX Tracking Service</h2>
        <p>基于 ONNX Runtime C++、OpenCV、ByteTrack 和 LK 光流的 Linux CPU 视频目标检测与跟踪服务。</p>
        <p>通过动态抽帧检测和光流中间帧传播减少 ONNX 推理次数，并用轨迹管理维持 Track ID 的连续性。</p>
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
        <div class="portfolio-tags">
          <span>ONNX Runtime</span><span>OpenCV</span><span>ByteTrack</span><span>Optical Flow</span><span>HTTP Inference</span><span>Linux CPU</span>
        </div>
      </div>
      <figure class="portfolio-figure">
        <img src="/assets/yolo/tracking-flow.svg" alt="YOLO 检测跟踪服务流程图">
        <figcaption>真实检测演示 GIF 可后续替换到这个位置。</figcaption>
      </figure>
    </article>

    <article id="libevent-chat-server" class="portfolio-project">
      <div>
        <p class="portfolio-project-index">03</p>
        <h2>Libevent Chat Server</h2>
        <p>基于 libevent 的事件驱动 TCP 聊天服务，采用 Acceptor-Worker 架构、JSON 协议、连接管理与背压控制。</p>
        <p>项目重点是理解并实现 Reactor 模型、非阻塞 I/O、多线程任务分发、连接生命周期管理和服务端可测试结构。</p>
        <div class="portfolio-tags">
          <span>C++</span><span>libevent</span><span>TCP</span><span>Reactor</span><span>多线程</span><span>CMake</span>
        </div>
        <div class="portfolio-actions compact">
          <a class="portfolio-button primary" href="/notes/linux高性能服务器编程/1-libevent/">阅读 libevent 笔记</a>
        </div>
      </div>
    </article>

    <article id="rollback-netcode-demo" class="portfolio-project secondary-project">
      <div>
        <p class="portfolio-project-index">More</p>
        <h2>Rollback Netcode Demo</h2>
        <p>服务端权威的多人同步系统，实现客户端预测、状态回滚、UDP 通信与状态哈希校验。</p>
        <p>它不是首页主卡片，但能补充展示实时系统、状态一致性和 C++ 工程拆解能力。</p>
        <div class="portfolio-actions compact">
          <a class="portfolio-button" href="/notes/实时竞技游戏开发/fighting-netcode-项目知识笔记/">阅读项目笔记</a>
        </div>
      </div>
    </article>
  </section>
</section>
{% endraw %}
