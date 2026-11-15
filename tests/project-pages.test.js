'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const ejsRenderer = require('hexo-renderer-ejs/lib/renderer');

global.hexo = { extend: { generator: { register() {} } } };
const { projectPages } = require('../scripts/project-pages');
delete global.hexo;

const data = yaml.load(fs.readFileSync(path.join(__dirname, '../source/_data/rk3588.yml'), 'utf8'));
const render = (template, locals) => ejsRenderer({ ...template, text: fs.readFileSync(template.path, 'utf8') }, locals);
const pages = () => projectPages(structuredClone(data), render);

test('project routes are unique NexT pages without article sidebar or automatic TOC', () => {
  const output = pages();
  assert.deepEqual(output.map(page => page.path), ['projects/index.html', 'projects/rk3588/index.html']);
  for (const page of output) {
    assert.deepEqual(page.layout, ['page']);
    assert.equal(page.data.sidebar, false);
    assert.equal(page.data.toc.enable, false);
    assert.equal(page.data.header, false);
    assert.equal((page.data.content.match(/<h1\b/g) || []).length, 1);
    assert.equal((page.data.content.match(/src="\/assets\/portfolio\/rk3588.js"/g) || []).length, 1);
  }
});

test('all five project descriptions and existing evidence remain directly readable', () => {
  const [index, detail] = pages().map(page => page.data.content);
  for (const id of ['yolo-tracking-service', 'rag-agent-platform', 'libevent-chat-server', 'fighting-authoritative-server', 'screw-metrology']) {
    assert.ok(index.includes(`id="${id}"`), id);
  }
  for (const evidence of ['socketpair', 'CrossEncoder', 'SSE', '状态哈希', '亚像素', '18,066', '146.17']) {
    assert.ok(index.includes(evidence), evidence);
  }
  for (const image of ['/assets/rag/architecture-v2.svg', '/assets/fighting/netcode-flow.svg', '/assets/screw-metrology/measurement-flow.svg']) {
    assert.ok(index.includes(image), image);
  }
  for (const html of [index, detail]) {
    assert.doesNotMatch(html, /<details\b|<summary\b|accordion|show.more/i);
    assert.ok(html.includes(data.sources.deployment));
    assert.ok(html.includes('未测试'));
    assert.ok(html.includes('原理示意'));
    assert.ok(html.includes('MMAP') && html.includes('MPP') && html.includes('DMA-BUF'));
  }
});

test('both pages use the same current benchmark data and preserve source context', () => {
  const changed = structuredClone(data);
  changed.benchmarks.find(run => run.id === 'hybrid').fps = 27.23;
  changed.replay.date = '2026-10-20';
  for (const page of projectPages(changed, render)) {
    assert.match(page.data.content, /27\.23/);
    assert.match(page.data.content, /2026-10-20/);
    assert.ok(page.data.content.includes(changed.sources.deployment));
    assert.match(page.data.content, /输入限制|输入速率限制/);
    assert.match(page.data.content, /30 秒/);
    assert.match(page.data.content, /600\.03/);
    assert.match(page.data.content, /202 张|202[\s\S]*?张/);
  }
});

test('missing experiment values stay untested instead of becoming zero or invalid bars', () => {
  const changed = structuredClone(data);
  changed.benchmarks.find(run => run.id === 'fp16').rssMib = null;
  for (const page of projectPages(changed, render)) {
    assert.match(page.data.content, /未测试/);
    assert.doesNotMatch(page.data.content, /NaN|Infinity/);
    const title = page.data.content.match(/<title[^>]*>平均 RSS[^<]*<\/title>/)?.[0];
    assert.ok(title?.includes('FP16 未测试'), title);
    assert.ok(!title?.includes('FP16 0.00'), title);
  }
});

test('all local section links and accessible SVG identifiers resolve without duplicates', () => {
  for (const page of pages()) {
    const html = page.data.content;
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(ids.length, new Set(ids).size, page.path);
    for (const [, href] of html.matchAll(/href="#([^"]+)"/g)) {
      assert.ok(ids.includes(decodeURIComponent(href)), href);
    }
    for (const [, labels] of html.matchAll(/aria-labelledby="([^"]+)"/g)) {
      assert.ok(labels.split(' ').every(id => ids.includes(id)), labels);
    }
  }
});
