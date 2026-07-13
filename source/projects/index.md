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
      <h1>核心项目</h1>
      <p>围绕 AI 应用后端、视觉部署、C++ 网络服务和权威服务器同步四条工程主线。</p>
    </div>

    <article id="rag-agent-platform" class="portfolio-project">
      <div>
        <p class="portfolio-project-index">01</p>
        <h2>RAG Gateway Stack</h2>
        <p>面向全局文档知识库问答的分层式 RAG / Agent 后端。C++ Drogon Gateway 统一承载外部 API，FastAPI、Celery、MySQL、Redis、LanceDB 与 OpenAI-compatible LLM / vLLM 组成内部业务链路。</p>
        <ul class="portfolio-link-list">
          <li>文档链路：上传、去重、解析、切片、向量化、全局索引构建和异步任务状态查询。</li>
          <li>检索链路：LanceDB 召回 chunk id，MySQL 批量回表正文，再经 CrossEncoder rerank 组装 Prompt 与 citations。</li>
          <li>Agent 链路：循环决策只读工具，注入用户长期记忆、会话摘要与近期对话，并记录 SSE、citations 和 Trace。</li>
        </ul>
        <div class="portfolio-tags">
          <span>C++17</span><span>Drogon</span><span>FastAPI</span><span>Celery</span><span>MySQL</span><span>Redis</span><span>LanceDB</span><span>React</span><span>Agent</span>
        </div>
        <div class="portfolio-actions compact">
          <a class="portfolio-button primary" href="https://github.com/ChutianDuan/Repo">GitHub 仓库</a>
          <a class="portfolio-button" href="/notes/ai模型开发/开发进度记录/">项目复盘</a>
          <a class="portfolio-button" href="/notes/ai模型开发/知识点学习/框架/faiss/">检索设计</a>
        </div>
      </div>
      <figure class="portfolio-figure">
        <img src="/assets/rag/architecture-v2.svg" alt="RAG Gateway Stack 分层架构图">
        <figcaption>C++ 网关、FastAPI 业务层、异步任务、全局检索与 Agent 观测链路</figcaption>
      </figure>
    </article>

    <article id="yolo-tracking-service" class="portfolio-project">
      <div>
        <p class="portfolio-project-index">02</p>
        <h2>YOLO Tracking</h2>
        <p>面向 BDD100K 道路场景的 C++ 图片与视频检测跟踪服务，使用 ONNX Runtime / OpenVINO、OpenCV、ByteTrack 和 LK 光流交付可观测的动态监测结果。</p>
        <ul class="portfolio-link-list">
          <li>高低分辨率协同：高分辨率模型维护权威状态，低分辨率模型更频繁地进行轻量刷新。</li>
          <li>质量感知调度：动态 stride 根据光流质量、尺度 / 速度突变、重复轨迹和类别冲突触发 low / high 紧急刷新。</li>
          <li>时间连续性：LK 光流传播检测间隔的轨迹，ByteTrack 管理 ID 与生命周期，异步旧帧结果返回后先做时间补偿。</li>
        </ul>
        <div class="portfolio-metrics" aria-label="YOLO 三场景回归通过指标">
          <span>三场景 F1 0.7726</span>
          <span>FP -63.2%</span>
        </div>
        <p class="portfolio-metric-note">指标口径为 IoU=0.5，以 full high-res 结果作为伪标签的三场景回归。</p>
        <div class="portfolio-tags">
          <span>YOLO26</span><span>ONNX Runtime</span><span>OpenVINO</span><span>OpenCV</span><span>ByteTrack</span><span>LK Flow</span><span>Drogon</span><span>Linux CPU</span>
        </div>
        <div class="portfolio-actions compact">
          <a class="portfolio-button primary" href="https://github.com/ChutianDuan/Yolo">GitHub 仓库</a>
          <a class="portfolio-button" href="https://github.com/ChutianDuan/Yolo/blob/main/docs/reports/%E4%BC%98%E5%8C%96%E8%AE%A1%E5%88%92.md">回归报告</a>
          <a class="portfolio-button" href="/notes/liunx-c-工程化/5-onnx模型导出与部署优化/">部署笔记</a>
        </div>
      </div>
      <figure class="portfolio-figure">
        <img src="/assets/yolo/tracking-flow.svg" alt="YOLO 检测跟踪服务流程图">
        <figcaption>高低分辨率模型、质量感知调度、LK / ByteTrack 与权威轨迹管理</figcaption>
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
          <a class="portfolio-button" href="/notes/linux高性能服务器编程/3-socket基础与tcp编程/">Socket 与 TCP</a>
        </div>
      </div>
    </article>

    <article id="fighting-authoritative-server" class="portfolio-project">
      <div>
        <p class="portfolio-project-index">04</p>
        <h2>Fighting Netcode</h2>
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
          <a class="portfolio-button" href="/notes/实时竞技游戏开发/网络/">UDP 抗丢包设计</a>
        </div>
      </div>
      <figure class="portfolio-figure">
        <img src="/assets/fighting/authoritative-server.png" alt="Fighting 权威服务器流程图">
        <figcaption>权威服务器推进、客户端输入、Ack / State 广播与回滚重放</figcaption>
      </figure>
    </article>
  </section>
</section>
{% endraw %}
