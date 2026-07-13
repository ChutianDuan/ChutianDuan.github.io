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
  const name = fileName(post);
  if (/^README$/i.test(name)) return -1;
  const match = name.match(/^\[(\d+)]/);
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
  return collator.compare(fileName(left), fileName(right));
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

function displayOrder(post, index) {
  const order = explicitOrder(post);
  return String(order === null || order < 0 ? index + 1 : order).padStart(2, '0');
}

function shortTitle(post, series) {
  const name = fileName(post).replace(/^\[\d+]\s*/, '').trim();
  return /^README$/i.test(name) ? `${series.label}学习指南` : name;
}

function guidePost(posts) {
  return posts.find(post => explicitOrder(post) === -1 || explicitOrder(post) === 0) || posts[0];
}

function arrowIcon(direction = 'right') {
  const path = direction === 'left' ? 'M15 4 9 10l6 6M9 10h9' : 'm9 4 6 6-6 6m6-6H6';
  return `<svg aria-hidden="true" viewBox="0 0 24 20"><path d="${path}"></path></svg>`;
}

function knowledgeMap(groups) {
  const total = SERIES.reduce((sum, series) => sum + groups.get(series.key).length, 0);
  const rows = SERIES.map((series, seriesIndex) => {
    const posts = groups.get(series.key);
    const guide = guidePost(posts);
    const featured = posts.filter(post => post !== guide).slice(0, 3);
    return `
      <section class="knowledge-row" id="${series.anchor}">
        <div class="knowledge-topic">
          <span class="knowledge-number">${String(seriesIndex + 1).padStart(2, '0')}</span>
          <h2>${escapeHtml(series.label)}</h2>
          <span class="knowledge-count">${posts.length}</span>
        </div>
        <p class="knowledge-description">${escapeHtml(series.description)}</p>
        <a class="knowledge-guide" href="${postHref(guide)}">${escapeHtml(shortTitle(guide, series))} ${arrowIcon()}</a>
        <div class="knowledge-featured">${featured.map(post => `<a href="${postHref(post)}">${escapeHtml(shortTitle(post, series))}</a>`).join('')}</div>
      </section>`;
  }).join('');

  return `<div class="engineering-page knowledge-map">
    <header class="engineering-page-header">
      <div>
        <h1>知识地图</h1>
        <p>围绕 AI 应用、C++ 后端与系统工程整理的学习路径。</p>
        <span>${SERIES.length} 个专题 · ${total} 篇文章</span>
      </div>
      <nav aria-label="知识地图辅助导航">
        <a href="/articles/">全部文章</a>
        <a href="/timeline/">按时间浏览</a>
      </nav>
    </header>
    <div class="knowledge-columns" aria-hidden="true"><span>专题</span><span>描述</span><span>指南文章</span><span>精选文章（示例）</span></div>
    <div class="knowledge-list">${rows}</div>
  </div>`;
}

function articleIndex(groups) {
  const total = SERIES.reduce((sum, series) => sum + groups.get(series.key).length, 0);
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
        <p>按专题浏览 ${total} 篇工程笔记。</p>
      </div>
      <nav aria-label="文章索引辅助导航">
        <a href="/archives/">返回知识地图</a>
        <a href="/timeline/">按时间浏览</a>
      </nav>
    </header>
    <nav class="article-index-jumps" aria-label="跳转到专题">${jumps}</nav>
    ${sections}
  </div>`;
}

hexo.extend.generator.register('engineering-notebook', locals => {
  const groups = groupedPosts(locals.posts.toArray());
  return [
    {
      path: 'archives/index.html',
      layout: ['page'],
      data: { title: '知识地图', header: false, sidebar: false, comments: false, content: knowledgeMap(groups) }
    },
    {
      path: 'articles/index.html',
      layout: ['page'],
      data: { title: '全部文章', header: false, sidebar: false, comments: false, content: articleIndex(groups) }
    }
  ];
});

hexo.extend.helper.register('engineering_post_meta', function(post) {
  const key = seriesKey(post);
  const series = SERIES_BY_KEY.get(key);
  const posts = series ? groupedPosts(this.site.posts.toArray()).get(key) : [];
  const index = posts.findIndex(item => item.path === post.path);
  const category = series ? `<a href="/archives/#${series.anchor}">${escapeHtml(series.label)} / ${displayOrder(post, index)}</a>` : escapeHtml(key);
  return `<div class="engineering-post-meta"><span>${category}</span><span>更新于 ${formatDate(post.updated || post.date)}</span><span>预计阅读 ${readingMinutes(post)} 分钟</span></div>`;
});

hexo.extend.helper.register('engineering_series_nav', function(post) {
  const key = seriesKey(post);
  const series = SERIES_BY_KEY.get(key);
  let navigation = '';
  if (series) {
    const posts = groupedPosts(this.site.posts.toArray()).get(key);
    const index = posts.findIndex(item => item.path === post.path);
    const previous = index > 0 ? posts[index - 1] : null;
    const next = index >= 0 && index < posts.length - 1 ? posts[index + 1] : null;
    navigation = `<nav class="engineering-series-nav" aria-label="系列文章导航">
      <div class="series-progress"><span>${escapeHtml(series.label)} · ${displayOrder(post, index)} / ${posts.length}</span><a href="/archives/#${series.anchor}">返回系列目录</a></div>
      <div class="series-links">
        <div>${previous ? `<a href="${postHref(previous)}">${arrowIcon('left')}<span><small>上一篇</small>${escapeHtml(shortTitle(previous, series))}</span></a>` : ''}</div>
        <div>${next ? `<a href="${postHref(next)}"><span><small>下一篇</small>${escapeHtml(shortTitle(next, series))}</span>${arrowIcon()}</a>` : ''}</div>
      </div>
    </nav>`;
  }
  return `${navigation}<p class="engineering-license">本文采用 CC BY-NC-SA 4.0 许可协议，转载请注明出处。</p>`;
});
