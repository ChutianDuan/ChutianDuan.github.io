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
      <p>围绕 AI 应用后端、视觉部署、C++ 网络服务和权威服务器同步四条工程主线。</p>
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
        <p>基于 libevent 的聊天服务器，采用 1 个 Acceptor 与 N 个 Worker 的线程模型。Acceptor 只负责监听和接受 TCP 连接，并通过 UNIX socketpair 把 fd 分发给 Worker；每个 Worker 拥有独立 event_base，负责自己名下连接的 read/write callback、业务解析和连接生命周期。</p>
        <ul class="portfolio-link-list">
          <li>协议层：line-delimited JSON，一行一条消息，支持 nick、join、leave、msg、pm 和错误回执。</li>
          <li>并发模型：全局用户表、房间表、订阅表和发送队列受互斥锁保护；广播时先在锁内拍快照，再锁外写 bufferevent。</li>
          <li>背压控制：根据输出缓冲长度切换直接写、入队等待、低水位续写和慢连接截断，避免单个慢客户端拖垮 Worker。</li>
          <li>工程目标：把非阻塞 I/O、Reactor、多线程 fd 分发、连接清理和可测试 C++ 服务端结构串成一个最小闭环。</li>
        </ul>
        <div class="portfolio-tags">
          <span>C++</span><span>libevent</span><span>TCP</span><span>Reactor</span><span>socketpair</span><span>JSON</span><span>Backpressure</span><span>CMake</span>
        </div>
        <div class="portfolio-actions compact">
          <a class="portfolio-button primary" href="https://github.com/ChutianDuan/chat_server">GitHub 仓库</a>
          <a class="portfolio-button" href="/notes/linux高性能服务器编程/1-libevent/">阅读 libevent 笔记</a>
        </div>
      </div>
    </article>

    <article id="fighting-authoritative-server" class="portfolio-project secondary-project">
      <div>
        <p class="portfolio-project-index">04</p>
        <h2>Fighting Authoritative Server</h2>
        <p>基于 C++20 的实时动作游戏网络同步 Demo。项目核心不是完整游戏内容，而是把服务端权威、客户端预测、状态回滚、UDP 输入冗余和确定性状态校验做成可运行、可测试、可复盘的最小系统。</p>
        <ul class="portfolio-link-list">
          <li>权威服务端：<code>lab_server</code> 统一分配 player slot，以 60Hz tick 推进 <code>World::Step</code>，并周期性广播 Ack / State。</li>
          <li>客户端预测：<code>lab_client</code> 本地先响应输入，收到权威 State 后从快照恢复，并重放本地输入历史追到当前 tick。</li>
          <li>网络协议：UDP 包包含 magic、version、type、Input、Start、Ack 和 State，客户端每包携带最近 K 帧输入以降低丢包影响。</li>
          <li>一致性验证：用网络量化后的 state hash 检测分叉，配合 <code>lab_tests</code> 与 <code>lab_stress</code> 覆盖编解码、延迟 State、预测偏差和大量回滚。</li>
        </ul>
        <div class="portfolio-tags">
          <span>C++20</span><span>UDP</span><span>libevent</span><span>SDL2</span><span>Rollback</span><span>Prediction</span><span>State Hash</span><span>CTest</span>
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
