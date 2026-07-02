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
      <h1>核心项目</h1>
      <p>围绕 AI 应用后端、视觉部署、C++ 网络服务和实时同步四条工程主线。</p>
    </div>

    <article id="rag-agent-platform" class="portfolio-project">
      <div>
        <p class="portfolio-project-index">01</p>
        <h2>RAG Gateway Stack</h2>
        <p>一个带循环工具调用编排、引用追踪和会话记忆的 RAG Agent 后端项目。外部请求进入 C++ Drogon Gateway，内部业务由 FastAPI、Celery、MySQL、Redis、LanceDB 和 OpenAI-compatible LLM / vLLM 协同完成。</p>
        <ul class="portfolio-link-list">
          <li>文档链路：上传、去重、解析、切片、向量化、索引构建和任务状态查询。</li>
          <li>问答链路：向量召回、chunk 回表、CrossEncoder rerank、Prompt 组装、引用落库。</li>
          <li>Agent 链路：只读工具调用、Trace、SSE 事件、会话记忆和 React Workbench 观测。</li>
        </ul>
        <div class="portfolio-tags">
          <span>C++17</span><span>Drogon</span><span>FastAPI</span><span>Celery</span><span>MySQL</span><span>Redis</span><span>LanceDB</span><span>React</span><span>Agent</span>
        </div>
        <div class="portfolio-actions compact">
          <a class="portfolio-button primary" href="https://github.com/ChutianDuan/Repo">GitHub 仓库</a>
          <a class="portfolio-button" href="/notes/ai模型开发/开发进度记录/">开发记录</a>
        </div>
      </div>
      <figure class="portfolio-figure">
        <img src="/assets/rag/architecture.png" alt="RAG / Agent 平台架构图">
        <figcaption>C++ Gateway、FastAPI、Celery、数据库、向量索引和工作台分层</figcaption>
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
        <div class="portfolio-actions compact">
          <a class="portfolio-button primary" href="https://github.com/ChutianDuan/Yolo">GitHub 仓库</a>
        </div>
      </div>
      <figure class="portfolio-figure">
        <img src="/assets/yolo/tracking-flow.svg" alt="YOLO 检测跟踪服务流程图">
        <figcaption>原始视频、检测框、Track ID、光流传播与性能统计</figcaption>
      </figure>
    </article>

    <article id="libevent-chat-server" class="portfolio-project">
      <div>
        <p class="portfolio-project-index">03</p>
        <h2>Libevent Chat Server</h2>
        <p>基于 libevent 的聊天服务器，采用 1 个接入线程与 N 个 Worker。接入线程负责 accept，通过 UNIX socketpair 分发 fd；每个 Worker 拥有独立 event_base 并处理连接 I/O。</p>
        <ul class="portfolio-link-list">
          <li>协议：一行一条 JSON，支持 nick、join、leave、msg 和 pm。</li>
          <li>可靠性：per-connection 队列、低水位续写、慢连接截断和连接清理。</li>
          <li>工程重点：锁内维护共享状态，锁外发送，减少长时间占锁。</li>
        </ul>
        <div class="portfolio-tags">
          <span>C++</span><span>libevent</span><span>TCP</span><span>Reactor</span><span>socketpair</span><span>CMake</span>
        </div>
        <div class="portfolio-actions compact">
          <a class="portfolio-button primary" href="https://github.com/ChutianDuan/chat_server">GitHub 仓库</a>
          <a class="portfolio-button" href="/notes/linux高性能服务器编程/1-libevent/">阅读 libevent 笔记</a>
        </div>
      </div>
    </article>

    <article id="rollback-netcode-demo" class="portfolio-project secondary-project">
      <div>
        <p class="portfolio-project-index">More</p>
        <h2>Rollback Netcode Demo</h2>
        <p>C++20 实时动作游戏网络同步 Demo，聚焦 server authoritative、client prediction、rollback/replay、UDP 输入冗余和确定性状态 hash。</p>
        <div class="portfolio-tags">
          <span>C++20</span><span>UDP</span><span>libevent</span><span>SDL2</span><span>Rollback</span><span>CTest</span>
        </div>
        <div class="portfolio-actions compact">
          <a class="portfolio-button primary" href="https://github.com/ChutianDuan/Fighting">GitHub 仓库</a>
          <a class="portfolio-button" href="/notes/实时竞技游戏开发/fighting-netcode-项目知识笔记/">阅读项目笔记</a>
        </div>
      </div>
    </article>
  </section>
</section>
{% endraw %}
