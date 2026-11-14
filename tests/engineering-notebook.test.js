'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const toc = require('hexo/dist/plugins/helper/toc');

const generators = new Map();
const helpers = new Map();
global.hexo = { extend: {
  filter: { register() {} },
  generator: { register(name, generate) { generators.set(name, generate); } },
  helper: { register(name, helper) { helpers.set(name, helper); } }
} };
const notebook = require('../scripts/engineering-notebook');
delete global.hexo;

function loadPosts(directory = path.join(__dirname, '../source/_posts')) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return loadPosts(file);
    if (!entry.name.endsWith('.md')) return [];
    const text = fs.readFileSync(file, 'utf8');
    const [, frontMatter, body] = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    const data = yaml.load(frontMatter);
    return [{ ...data, source: `_posts/${path.relative(path.join(__dirname, '../source/_posts'), file)}`, path: data.permalink.slice(1), content: body.replace(/^###? (.+)$/gm, '<h2>$1</h2>') }];
  });
}

const posts = loadPosts();
const catalog = notebook.buildCatalog(posts);

test('series order accepts zero and fractions, rejects invalid metadata, and keeps original numbers', () => {
  assert.equal(notebook.explicitOrder({ series_order: 0, source: '_posts/topic/[9]note.md' }), 0);
  assert.equal(notebook.explicitOrder({ series_order: '2.5', source: '_posts/topic/[2]note.md' }), 2.5);
  for (const series_order of ['', null, true, Infinity, 'invalid']) {
    assert.equal(notebook.explicitOrder({ series_order, source: '_posts/topic/[2]note.md' }), 2);
  }
  assert.equal(notebook.explicitOrder({ source: '_posts/topic/[02.5]note.md' }), 2.5);
  assert.equal(notebook.displayOrder({ series_order: 2.5, source: '_posts/topic/[2]note.md' }), '02');
});

test('duplicate orders are stable and dates never change the series sequence', () => {
  const items = [
    { source: '_posts/现代C++实践/b.md', path: 'b/', series_order: 2, date: '2020-01-01' },
    { source: '_posts/现代C++实践/a.md', path: 'a/', series_order: 2, date: '2030-01-01' },
    { source: '_posts/现代C++实践/intro.md', path: 'intro/', series_order: 0 },
    { source: '_posts/现代C++实践/insert.md', path: 'insert/', series_order: 2.5 }
  ];
  const sequence = values => notebook.groupedPosts(values).get('现代C++实践').map(post => post.path);
  assert.deepEqual(sequence(items), ['intro/', 'a/', 'b/', 'insert/']);
  assert.deepEqual(sequence(items.toReversed().map(post => ({ ...post, date: '2040-01-01' }))), sequence(items));
});

test('catalog preserves 107 routes and all 105 main-topic posts have an explicit reading order', () => {
  assert.equal(posts.length, 107);
  assert.equal(new Set(posts.map(post => post.path)).size, 107);
  assert.equal(catalog.ordered.length, 105);
  assert.ok(catalog.ordered.every(post => Number.isFinite(post.series_order)));
  const engineering = catalog.groups.get('Liunx & c++工程化');
  assert.deepEqual(engineering.slice(0, 6).map(post => post.series_order), [1, 2, 2.5, 2.6, 2.7, 3]);
});

test('first and last posts have only a valid in-series neighbor', () => {
  for (const group of catalog.groups.values()) {
    const first = notebook.seriesNeighbors(group[0], catalog);
    const last = notebook.seriesNeighbors(group.at(-1), catalog);
    assert.equal(first.previous, null);
    assert.equal(first.next, group[1]);
    assert.equal(last.next, null);
    assert.equal(last.previous, group.at(-2));
    assert.match(notebook.seriesNavigation(group[0], catalog), /第 1 篇，共/);
    assert.doesNotMatch(notebook.seriesNavigation(group.at(-1), catalog), /<small>下一篇<\/small>/);
  }
});

test('learning routes and editorial recommendations resolve, with no duplicate or neighboring recommendations', () => {
  for (const steps of Object.values(notebook.LEARNING_PATHS)) {
    for (const [, key] of steps) assert.ok(catalog.references.has(key), key);
  }
  for (const post of catalog.ordered) {
    const related = notebook.recommendedPosts(post, catalog);
    const { previous, next } = notebook.seriesNeighbors(post, catalog);
    assert.ok(related.length <= 3);
    assert.equal(new Set(related.map(item => item.path)).size, related.length);
    assert.ok(related.every(item => item.path !== post.path && item.path !== previous?.path && item.path !== next?.path));
  }
  const ctestRelated = notebook.recommendedPosts(catalog.references.get('ctest'), catalog);
  assert.equal(ctestRelated[0], catalog.references.get('sanitizer'));
  assert.equal(ctestRelated[1], catalog.references.get('logging'));
  assert.equal(ctestRelated[2], catalog.references.get('testing'));
  assert.equal(notebook.shortTitle(catalog.references.get('ctest')), 'TEST() 明明写了，为什么 CTest 却说没有测试？');
});

test('unrelated articles receive no filler recommendation', () => {
  const unrelated = { source: '_posts/现代C++实践/unrelated.md', path: 'unrelated/', title: '无共同知识点', content: '' };
  const extended = notebook.buildCatalog([...posts, unrelated]);
  assert.deepEqual(notebook.recommendedPosts(unrelated, extended), []);
});

test('knowledge-map topics link to their existing project practices', () => {
  const pages = generators.get('engineering-notebook')({ posts: { toArray: () => posts } });
  const map = pages.find(page => page.path === 'archives/index.html').data.content;
  const projectSource = fs.readFileSync(path.join(__dirname, '../source/projects/index.md'), 'utf8');
  const expected = {
    'modern-cpp': 'libevent-chat-server',
    'parallel-cpp': 'yolo-tracking-service',
    'linux-server': 'libevent-chat-server',
    'cpp-engineering': 'yolo-tracking-service',
    'ai-model': 'rag-agent-platform',
    'network-services': 'rag-agent-platform',
    'fighting-netcode': 'fighting-authoritative-server'
  };
  assert.equal((map.match(/class="knowledge-project"/g) || []).length, 7);
  for (const [topic, project] of Object.entries(expected)) {
    const row = map.match(new RegExp(`<section class="knowledge-row" id="${topic}">([\\s\\S]*?)</section>`));
    assert.ok(row, topic);
    assert.match(row[1], new RegExp(`class="knowledge-project" href="/projects/#${project}"`));
    assert.match(projectSource, new RegExp(`id="${project}"`));
  }
});

test('mobile article contents reuse H2/H3 IDs without numbering or auto-expansion', () => {
  const render = helpers.get('engineering_mobile_toc');
  const post = { content: '<h1 id="title">文章</h1><h2 id="queue">1. 队列</h2><h3 id="队列-退出">1.1 退出 &amp; 回收</h3><h4 id="detail">细节</h4>' };
  const output = render.call({ is_post: () => true, toc }, post);
  assert.match(output, /^<details class="engineering-mobile-toc"><summary>本篇目录<\/summary>/);
  assert.match(output, /class="toc-item toc-level-2"/);
  assert.match(output, /class="toc-item toc-level-3"/);
  assert.match(output, /退出 &amp; 回收/);
  assert.doesNotMatch(output, / open|toc-number|href="#title"|href="#detail"/);
  for (const [, encodedId] of output.matchAll(/href="#([^"]+)"/g)) {
    assert.ok(post.content.includes(`id="${decodeURIComponent(encodedId)}"`), encodedId);
  }
  assert.equal((output.match(/class="toc-link"/g) || []).length, 2);
});

test('mobile article contents are absent on pages and articles without eligible headings', () => {
  const render = helpers.get('engineering_mobile_toc');
  const context = { is_post: () => true, toc };
  assert.equal(render.call({ ...context, is_post: () => false }, { content: '<h2 id="page">页面</h2>' }), '');
  assert.equal(render.call(context, { toc: { enable: false }, content: '<h2 id="disabled">关闭目录</h2>' }), '');
  assert.equal(render.call(context, { content: '<h1 id="title">文章</h1><p>正文</p>' }), '');
  assert.equal(render.call(context, {}), '');
});
