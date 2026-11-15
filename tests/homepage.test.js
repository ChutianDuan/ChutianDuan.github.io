'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const ejsRenderer = require('hexo-renderer-ejs/lib/renderer');

global.hexo = { extend: { generator: { register() {} } } };
const { homepagePage } = require('../scripts/homepage');
delete global.hexo;

const home = yaml.load(fs.readFileSync(path.join(__dirname, '../source/_data/homepage.yml'), 'utf8'));
const rk = yaml.load(fs.readFileSync(path.join(__dirname, '../source/_data/rk3588.yml'), 'utf8'));
const render = (template, locals) => ejsRenderer({ ...template, text: fs.readFileSync(template.path, 'utf8') }, locals);
const page = () => homepagePage(structuredClone(home), structuredClone(rk), render);

test('homepage is one NexT page with a single heading and no article TOC', () => {
  const output = page();
  assert.equal(output.path, 'index.html');
  assert.deepEqual(output.layout, ['page']);
  assert.equal(output.data.header, false);
  assert.equal(output.data.sidebar, false);
  assert.equal(output.data.toc.enable, false);
  assert.equal((output.data.content.match(/<h1\b/g) || []).length, 1);
  assert.equal((output.data.content.match(/src="\/assets\/portfolio\/homepage.js"/g) || []).length, 1);
});

test('five projects keep their exact slogans, anchors, sources and tab-panel relationships', () => {
  const html = page().data.content;
  assert.equal(home.projects.length, 5);
  assert.equal((html.match(/role="tabpanel"/g) || []).length, 5);
  assert.equal((html.match(/role="tab"/g) || []).length, 5);
  for (const project of home.projects) {
    assert.ok(html.includes(project.name), project.name);
    assert.ok(project.slogan.every(line => html.includes(line)), project.id);
    assert.ok(html.includes(`href="${project.href}"`), project.href);
    assert.ok(html.includes(`href="${project.source}"`), project.source);
    assert.ok(html.includes(`aria-controls="showcase-panel-${project.id}"`));
    assert.ok(html.includes(`aria-labelledby="showcase-tab-${project.id}"`));
    assert.ok(html.includes(`/assets/portfolio/covers/${project.id}-480.webp 480w`));
    assert.ok(html.includes(`/assets/portfolio/covers/${project.id}-960.webp 960w`));
  }
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
});

test('the RK panel is initially readable and other panels remain hidden until selected', () => {
  const html = page().data.content;
  for (const [index, project] of home.projects.entries()) {
    const panel = html.match(new RegExp(`<section[^>]*id="showcase-panel-${project.id}"[^>]*>`))?.[0];
    assert.ok(panel, project.id);
    assert.equal(/\shidden(?:\s|>)/.test(panel), index !== 0);
  }
  assert.match(html, /<noscript>[\s\S]*?class="showcase-project-links"[\s\S]*?<\/noscript>/);
  assert.match(html, /class="showcase-rail"[^>]*\shidden/);
});

test('homepage RK metrics and provenance come from the shared benchmark', () => {
  const changed = structuredClone(rk);
  const hybrid = changed.benchmarks.find(run => run.id === 'hybrid');
  hybrid.fps = 27.23;
  hybrid.modelMib = 13.45;
  changed.replay.date = '2026-10-20';
  const html = homepagePage(home, changed, render).data.content;
  assert.match(html, /27\.23/);
  assert.match(html, /13\.45/);
  assert.match(html, /2026-10-20/);
  assert.ok(html.includes(changed.sources.deployment));
  assert.match(html, /单路交通 JPEG 回放 10 分钟/);
  assert.match(html, /约 30 FPS 输入限制/);
  assert.equal((html.match(/class="showcase-metrics"/g) || []).length, 1);
  assert.equal((html.match(/class="showcase-test-note"/g) || []).length, 1);
});
