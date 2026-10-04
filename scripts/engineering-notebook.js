'use strict';

const SERIES = [
  {
    key: '现代C++实践',
    label: '现代 C++ 实践',
    anchor: 'modern-cpp',
    description: '聚焦现代 C++ 语言特性与工程实践，提升代码质量与可维护性。'
  },
  {
    key: '高性能C++并行编程',
    label: '高性能 C++ 并行编程',
    anchor: 'parallel-cpp',
    description: '系统讲解并发与并行编程模型，打造高性能、多核友好的 C++ 程序。'
  },
  {
    key: 'Linux高性能服务器编程',
    label: 'Linux 服务器编程',
    anchor: 'linux-server',
    description: '深入 Linux 系统调用与 I/O 模型，掌握高并发服务器开发核心技术。'
  },
  {
    key: 'Liunx & c++工程化',
    label: 'Linux 与 C++ 工程化',
    anchor: 'cpp-engineering',
    description: '构建稳定可靠的 C++ 工程体系，覆盖构建、测试、部署与工具链。'
  },
  {
    key: 'AI模型开发',
    label: 'AI 模型开发',
    anchor: 'ai-model',
    description: '从数据处理到模型训练、推理与 RAG 系统，记录 AI 应用开发实践。'
  },
  {
    key: '网络服务实战',
    label: '网络服务实战',
    anchor: 'network-services',
    description: '围绕网络协议、异步接口与服务架构，整理可复用的工程方法。'
  },
  {
    key: '实时竞技游戏开发',
    label: '实时竞技游戏开发',
    anchor: 'fighting-netcode',
    description: '从架构、同步到反作弊，构建稳定流畅的实时对战体验。'
  }
];

const SERIES_BY_KEY = new Map(SERIES.map(series => [series.key, series]));
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

// Editorial references resolve to each post's existing permalink, never a new route.
const NOTES = {
  life: '现代C++实践/[01]对象生命周期、特殊成员函数与移动语义.md',
  ownership: '现代C++实践/[02]智能指针与所有权.md',
  queue: '现代C++实践/[04]生产者-消费者模式与阻塞队列.md',
  api: '现代C++实践/[18]const正确性、API设计与现代属性.md',
  testing: '现代C++实践/[17]测试、调试与Sanitizer工具链.md',
  memory: '高性能C++并行编程/[01]C指针与内存模型.md',
  threads: '高性能C++并行编程/[08]C++11多线程编程.md',
  atomic: '高性能C++并行编程/[09]原子操作、内存序与无锁基础.md',
  locality: '高性能C++并行编程/[07]访存优化.md',
  benchmark: '高性能C++并行编程/[16]Benchmark与性能分析方法.md',
  socket: 'Linux高性能服务器编程/[3]Socket基础与TCP编程.md',
  tcp: 'Linux高性能服务器编程/[4]TCPIP协议族、IP与TCP协议详解.md',
  epoll: 'Linux高性能服务器编程/高性能服务器编程笔记一.md',
  libevent: 'Linux高性能服务器编程/[1]libevent.md',
  monitoring: 'Linux高性能服务器编程/[8]服务器调试、测试与系统监测.md',
  pool: 'Linux高性能服务器编程/[7]多进程、多线程与进程池线程池.md',
  cmake: 'Liunx & c++工程化/[1]cmake学习笔记.md',
  ctest: 'Liunx & c++工程化/[2]GoogleTest + CTest 工程实践.md',
  sanitizer: 'Liunx & c++工程化/Sanitizer + Fuzz 实战.md',
  logging: 'Liunx & c++工程化/日志系统.md',
  performance: 'Liunx & c++工程化/[3]liunx性能优化笔记.md',
  docker: 'Liunx & c++工程化/[10]docket.md',
  onnx: 'Liunx & c++工程化/[5]onnx模型导出与部署优化.md',
  inference: 'Liunx & c++工程化/[11]onnx模型加载.md',
  opencv: 'Liunx & c++工程化/[12]OpenCV实战导读.md',
  segmentation: 'Liunx & c++工程化/[13]OpenCV图像分割.md',
  subpixel: 'Liunx & c++工程化/[15]OpenCV亚像素测量.md',
  tolerance: 'Liunx & c++工程化/[16]OpenCV尺度公差与误差评估.md',
  data: 'AI模型开发/知识点学习/句子嵌入模型/数据处理与数据集评估.md',
  embedding: 'AI模型开发/知识点学习/句子嵌入模型/句子嵌入模型.md',
  retrieval: 'AI模型开发/知识点学习/框架/FAISS.md',
  chunk: 'AI模型开发/知识点学习/句子嵌入模型/Chunk学习笔记.md',
  database: 'AI模型开发/数据库关系.md',
  rag: 'AI模型开发/开发进度记录.md',
  acceptance: 'AI模型开发/deep-research-report.md',
  llm: 'AI模型开发/知识点学习/大模型部署/LLM.md',
  protocol: '网络服务实战/http常见端口及协议.md',
  proxy: '网络服务实战/HTTP 反向代理.md',
  async: '网络服务实战/线程模型、异步回调、协程接口.md',
  sse: '网络服务实战/SSE 流式转发.md',
  netcode: '实时竞技游戏开发/Fighting Netcode 项目知识笔记.md',
  simulation: '实时竞技游戏开发/模拟.md',
  network: '实时竞技游戏开发/网络.md',
  client: '实时竞技游戏开发/client.md',
  rendering: '实时竞技游戏开发/渲染.md'
};

const LEARNING_PATHS = {
  'modern-cpp': [['生命周期', 'life'], ['所有权', 'ownership'], ['并发队列', 'queue'], ['API 设计', 'api'], ['测试', 'testing']],
  'parallel-cpp': [['内存模型', 'memory'], ['多线程', 'threads'], ['原子与内存序', 'atomic'], ['访存优化', 'locality'], ['性能分析', 'benchmark']],
  'linux-server': [['Socket', 'socket'], ['TCP', 'tcp'], ['epoll', 'epoll'], ['libevent', 'libevent'], ['服务监测', 'monitoring']],
  'cpp-engineering': [['CMake', 'cmake'], ['CTest', 'ctest'], ['Sanitizer', 'sanitizer'], ['性能分析', 'performance'], ['容器部署', 'docker']],
  'ai-model': [['数据治理', 'data'], ['Embedding', 'embedding'], ['检索', 'retrieval'], ['RAG 工程', 'rag'], ['运行验收', 'acceptance']],
  'network-services': [['协议', 'protocol'], ['反向代理', 'proxy'], ['异步接口', 'async'], ['SSE', 'sse']],
  'fighting-netcode': [['系统总览', 'netcode'], ['模拟', 'simulation'], ['网络', 'network'], ['客户端校正', 'client'], ['渲染', 'rendering']]
};

const CURATED_RELATED = {
  ctest: ['sanitizer', 'cmake', 'logging', 'testing'],
  rag: ['database', 'chunk', 'sse'],
  libevent: ['socket', 'pool', 'proxy'],
  onnx: ['inference', 'llm', 'benchmark'],
  netcode: ['simulation', 'client', 'network'],
  opencv: ['subpixel', 'tolerance', 'segmentation']
};

// Match named concepts rather than generic words such as “工程” or “实践”.
const KNOWLEDGE_KEYWORDS = [
  /cmake|fetchcontent|vcpkg|conan/i,
  /ctest|googletest|googlemock|fixture|单元测试/i,
  /sanitizer|fuzz|asan|ubsan|tsan/i,
  /pytest|monkeypatch|testclient/i,
  /线程池|线程模型|thread|mutex|并发|多线程/i,
  /atomic|memory_order|内存序|无锁/i,
  /raii|智能指针|所有权|生命周期/i,
  /缓存行|访存|numa|simd|内存池|pmr/i,
  /benchmark|火焰图|性能分析|性能排查|perf\b/i,
  /socket|tcp|udp|epoll|libevent|bufferevent|reactor/i,
  /零拷贝|zero.copy|sendfile|splice/i,
  /http|https|tls|反向代理/i,
  /sse|流式|断线续传|背压/i,
  /协程|异步|async|drogon|fastapi|celery/i,
  /rag|chunk|embedding|嵌入|向量|faiss|检索|召回/i,
  /mysql|redis|数据库|幂等|租户/i,
  /llm|vllm|qwen|显存|大模型|lora/i,
  /onnx|openvino|rknn|量化|模型导出/i,
  /opencv|图像分割|亚像素|标定|公差|测量/i,
  /rollback|回滚|netcode|tick|权威|确定性|预测|渲染/i,
  /systemd|docker|容器|部署/i,
  /日志|logging|spdlog/i
];

let cachedCatalog;
hexo.extend.filter.register('before_generate', () => { cachedCatalog = null; });

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sourceName(post) {
  return String(post.source || '').replace(/^_posts\//, '');
}

function seriesKey(post) {
  return sourceName(post).split('/')[0];
}

function fileName(post) {
  const parts = sourceName(post).split('/');
  return (parts[parts.length - 1] || '').replace(/\.md$/i, '');
}

function explicitOrder(post) {
  const value = post.series_order;
  if ((typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value))) {
    return Number(value);
  }
  const name = fileName(post);
  if (/^README$/i.test(name)) return 0;
  const match = name.match(/^\[(\d+(?:\.\d+)?)\]/);
  return match ? Number(match[1]) : null;
}

function comparePosts(left, right) {
  const leftOrder = explicitOrder(left);
  const rightOrder = explicitOrder(right);
  if (leftOrder !== null || rightOrder !== null) {
    if (leftOrder === null) return 1;
    if (rightOrder === null) return -1;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  }
  return collator.compare(sourceName(left), sourceName(right)) || collator.compare(postHref(left), postHref(right));
}

function groupedPosts(posts) {
  const groups = new Map(SERIES.map(series => [series.key, []]));
  for (const post of posts) {
    const group = groups.get(seriesKey(post));
    if (group) group.push(post);
  }
  for (const group of groups.values()) group.sort(comparePosts);
  return groups;
}

function postHref(post) {
  return `/${String(post.path || '').replace(/^\//, '')}`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function readingMinutes(post) {
  const plain = String(post.content || '')
    .replace(/<pre[\s\S]*?<\/pre>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&\w+;/g, ' ');
  const chinese = (plain.match(/[\u3400-\u9fff]/g) || []).length;
  const words = (plain.replace(/[\u3400-\u9fff]/g, ' ').match(/[\w.+#-]+/g) || []).length;
  return Math.max(1, Math.ceil((chinese + words) / 400));
}

function displayOrder(post) {
  // The filename number is an existing article identifier, not its reading position.
  const match = fileName(post).match(/^\[(\d+(?:\.\d+)?)\]/);
  return match ? match[1].padStart(2, '0') : '—';
}

function shortTitle(post) {
  return String(post.title || fileName(post)).replace(/`/g, '');
}

function guidePost(posts, series, catalog) {
  if (series.anchor === 'ai-model') return catalog.references.get('rag');
  if (series.anchor === 'fighting-netcode') return catalog.references.get('netcode');
  return posts.find(post => explicitOrder(post) === 0) || posts[0];
}

function buildCatalog(posts) {
  const groups = groupedPosts(posts);
  const bySource = new Map(posts.map(post => [sourceName(post), post]));
  const references = new Map(Object.entries(NOTES).map(([key, source]) => {
    const post = bySource.get(source);
    if (!post) throw new Error(`Knowledge navigation target missing: ${source}`);
    return [key, post];
  }));
  const ordered = SERIES.flatMap(series => groups.get(series.key));
  const concepts = new Map(posts.map(post => {
    const headings = String(post.content || '').match(/<h[23]\b[^>]*>[\s\S]*?<\/h[23]>/gi) || [];
    const text = `${post.title || ''} ${sourceName(post)} ${headings.join(' ').replace(/<[^>]+>/g, ' ')}`;
    return [post.path, KNOWLEDGE_KEYWORDS.map((pattern, index) => pattern.test(text) ? index : -1).filter(index => index >= 0)];
  }));
  return { groups, references, ordered, concepts, total: posts.length };
}

function getCatalog(posts) {
  return cachedCatalog ||= buildCatalog(posts);
}

function seriesNeighbors(post, catalog) {
  const posts = catalog.groups.get(seriesKey(post)) || [];
  const index = posts.findIndex(item => item.path === post.path);
  return { posts, index, previous: index > 0 ? posts[index - 1] : null, next: index >= 0 ? posts[index + 1] || null : null };
}

function recommendedPosts(post, catalog) {
  const { previous, next } = seriesNeighbors(post, catalog);
  const excluded = new Set([post.path, previous?.path, next?.path]);
  const result = [];
  const curatedKey = Object.keys(CURATED_RELATED).find(key => catalog.references.get(key).path === post.path);
  for (const key of CURATED_RELATED[curatedKey] || []) {
    const target = catalog.references.get(key);
    if (!excluded.has(target.path)) {
      result.push(target);
      excluded.add(target.path);
    }
  }
  const ownConcepts = new Set(catalog.concepts.get(post.path) || []);
  const candidates = catalog.ordered.map((target, position) => ({
    target,
    position,
    score: (catalog.concepts.get(target.path) || []).filter(concept => ownConcepts.has(concept)).length,
    sameSeries: seriesKey(target) === seriesKey(post) ? 1 : 0
  })).filter(item => item.score > 0 && !excluded.has(item.target.path));
  candidates.sort((left, right) => right.score - left.score || right.sameSeries - left.sameSeries || left.position - right.position);
  for (const { target } of candidates) {
    if (result.length >= 3) break;
    result.push(target);
  }
  return result.slice(0, 3);
}

function statistics(catalog) {
  const total = catalog.ordered.length;
  return `<span>${SERIES.length} 个主专题 · ${total} 篇工程笔记</span><p class="engineering-statistics">全站 ${catalog.total} 篇笔记；另有 Redis 专项与代码练习，可通过<a href="/timeline/">时间归档</a>或搜索查找。</p>`;
}

function arrowIcon(direction = 'right') {
  const path = direction === 'left' ? 'M15 4 9 10l6 6M9 10h9' : 'm9 4 6 6-6 6m6-6H6';
  return `<svg aria-hidden="true" viewBox="0 0 24 20"><path d="${path}"></path></svg>`;
}

function knowledgeMap(catalog) {
  const { groups } = catalog;
  const rows = SERIES.map((series, seriesIndex) => {
    const posts = groups.get(series.key);
    const guide = guidePost(posts, series, catalog);
    const featured = posts.filter(post => post !== guide).slice(0, 3);
    return `
      <section class="knowledge-row" id="${series.anchor}">
        <div class="knowledge-topic">
          <span class="knowledge-number">${String(seriesIndex + 1).padStart(2, '0')}</span>
          <h2><a href="/articles/#${series.anchor}">${escapeHtml(series.label)}</a></h2>
          <span class="knowledge-count">${posts.length}</span>
        </div>
        <div class="knowledge-description"><p>${escapeHtml(series.description)}</p>
          <ol class="knowledge-learning-path" aria-label="${escapeHtml(series.label)}学习路线">${LEARNING_PATHS[series.anchor].map(([label, key]) => `<li><a href="${postHref(catalog.references.get(key))}">${escapeHtml(label)}</a></li>`).join('')}</ol>
        </div>
        <a class="knowledge-guide" href="${postHref(guide)}">${escapeHtml(shortTitle(guide, series))} ${arrowIcon()}</a>
        <div class="knowledge-featured">${featured.map(post => `<a href="${postHref(post)}">${escapeHtml(shortTitle(post, series))}</a>`).join('')}</div>
      </section>`;
  }).join('');

  return `<div class="engineering-page knowledge-map">
    <header class="engineering-page-header">
      <div>
        <h1>知识地图</h1>
        <p>围绕 AI 应用、C++ 后端与系统工程整理的学习路径。</p>
        ${statistics(catalog)}
      </div>
      <nav aria-label="知识地图辅助导航">
        <a href="/articles/">全部文章</a>
        <a href="/timeline/">按时间浏览</a>
      </nav>
    </header>
    <div class="knowledge-columns" aria-hidden="true"><span>专题</span><span>描述与学习路线</span><span>指南文章</span><span>精选文章</span></div>
    <div class="knowledge-list">${rows}</div>
  </div>`;
}

function articleIndex(catalog) {
  const { groups } = catalog;
  const jumps = SERIES.map(series => `<a href="#${series.anchor}">${escapeHtml(series.label)}</a>`).join('');
  const sections = SERIES.map(series => {
    const posts = groups.get(series.key);
    const rows = posts.map((post, index) => `<a class="article-index-row" href="${postHref(post)}">
      <span class="article-index-number">${displayOrder(post, index)}</span>
      <span class="article-index-title">${escapeHtml(shortTitle(post, series))}</span>
      <span class="article-index-path">${escapeHtml(series.label)}</span>
      <time datetime="${formatDate(post.updated || post.date)}">${formatDate(post.updated || post.date)}</time>
      ${arrowIcon()}
    </a>`).join('');
    return `<section class="article-index-series" id="${series.anchor}">
      <header><h2>${escapeHtml(series.label)}</h2><span>${posts.length} 篇</span></header>
      <div>${rows}</div>
    </section>`;
  }).join('');

  return `<div class="engineering-page article-index">
    <header class="engineering-page-header">
      <div>
        <h1>全部文章</h1>
        <p>搜索具体问题，或按专题查找文章。</p>
        ${statistics(catalog)}
      </div>
      <nav aria-label="文章索引辅助导航">
        <a href="/archives/">返回知识地图</a>
        <a href="/timeline/">按时间浏览</a>
      </nav>
    </header>
    <button class="engineering-search-button popup-trigger" type="button"><span>搜索文章标题与正文</span><kbd>⌘K / Ctrl+K</kbd></button>
    <nav class="article-index-jumps" aria-label="跳转到专题">${jumps}</nav>
    ${sections}
  </div>`;
}

hexo.extend.generator.register('engineering-notebook', locals => {
  const catalog = getCatalog(locals.posts.toArray());
  return [
    {
      path: 'archives/index.html',
      layout: ['page'],
      data: {
        title: '知识地图',
        header: false,
        sidebar: false,
        toc: { enable: false },
        comments: false,
        content: knowledgeMap(catalog)
      }
    },
    {
      path: 'articles/index.html',
      layout: ['page'],
      data: {
        title: '全部文章',
        header: false,
        sidebar: false,
        toc: { enable: false },
        comments: false,
        content: articleIndex(catalog)
      }
    }
  ];
});

hexo.extend.helper.register('engineering_post_meta', function(post) {
  const key = seriesKey(post);
  const series = SERIES_BY_KEY.get(key);
  const number = displayOrder(post);
  const category = series ? `<a href="/articles/#${series.anchor}">${escapeHtml(series.label)}${number === '—' ? '' : ` / ${number}`}</a>` : escapeHtml(key);
  return `<div class="engineering-post-meta"><span>${category}</span><span>更新于 ${formatDate(post.updated || post.date)}</span><span>预计阅读 ${readingMinutes(post)} 分钟</span></div>`;
});

hexo.extend.helper.register('engineering_breadcrumb', function(post) {
  const series = SERIES_BY_KEY.get(seriesKey(post));
  return `<nav class="engineering-breadcrumb" aria-label="当前位置"><ol>
    <li><a href="/">首页</a></li><li><a href="/archives/">知识地图</a></li>
    ${series ? `<li><a href="/articles/#${series.anchor}">${escapeHtml(series.label)}</a></li>` : ''}
    <li aria-current="page">${escapeHtml(shortTitle(post))}</li>
  </ol></nav>`;
});

function seriesNavigation(post, catalog) {
  const key = seriesKey(post);
  const series = SERIES_BY_KEY.get(key);
  const { posts, index, previous, next } = seriesNeighbors(post, catalog);
  const recommendations = recommendedPosts(post, catalog);
  const related = recommendations.length ? `<section class="engineering-related" aria-label="推荐继续阅读">
    <p class="related-label">推荐继续阅读</p><ul>${recommendations.map(target => `<li><a href="${postHref(target)}"><span>${escapeHtml(shortTitle(target))}</span>${arrowIcon()}</a></li>`).join('')}</ul>
  </section>` : '';
  let navigation = '';
  if (series && index >= 0) {
    navigation = `<nav class="engineering-series-nav" aria-label="系列文章导航">
      <div class="series-progress"><span>${escapeHtml(series.label)} · 第 ${index + 1} 篇，共 ${posts.length} 篇</span><a href="/articles/#${series.anchor}">返回系列目录</a></div>
      <p class="series-current">你正在阅读：${escapeHtml(shortTitle(post))}</p>
      ${related}
      <div class="series-links">
        <div>${previous ? `<a href="${postHref(previous)}">${arrowIcon('left')}<span><small>上一篇</small>${escapeHtml(shortTitle(previous, series))}</span></a>` : ''}</div>
        <div>${next ? `<a href="${postHref(next)}"><span><small>下一篇</small>${escapeHtml(shortTitle(next, series))}</span>${arrowIcon()}</a>` : ''}</div>
      </div>
    </nav>`;
  }
  return `${navigation || related}<p class="engineering-license">本文采用 CC BY-NC-SA 4.0 许可协议，转载请注明出处。</p>`;
}

hexo.extend.helper.register('engineering_series_nav', function(post) {
  return seriesNavigation(post, getCatalog(this.site.posts.toArray()));
});

module.exports = { explicitOrder, comparePosts, groupedPosts, buildCatalog, recommendedPosts, seriesNeighbors, seriesNavigation, displayOrder, shortTitle, LEARNING_PATHS, CURATED_RELATED, NOTES };
