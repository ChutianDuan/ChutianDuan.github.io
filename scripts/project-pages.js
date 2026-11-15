'use strict';

const path = require('node:path');

function projectPages(rk, render) {
  if (!rk) throw new Error('RK3588 project data missing: source/_data/rk3588.yml');
  return [
    { pageKind: 'index', route: 'projects/index.html', title: '项目', description: '无名的视觉部署与 C++ 系统项目，包含 RK3588 实测、代码仓库和工程笔记。' },
    { pageKind: 'detail', route: 'projects/rk3588/index.html', title: rk.title, description: rk.summary }
  ].map(({ pageKind, route, title, description }) => ({
    path: route,
    layout: ['page'],
    data: {
      title,
      description,
      __page: true,
      header: false,
      sidebar: false,
      toc: { enable: false },
      comments: false,
      content: render({ path: path.join(__dirname, '../templates/projects', `${pageKind}.ejs`) }, { rk, pageKind })
    }
  }));
}

hexo.extend.generator.register('project-pages', locals => projectPages(
  locals.data.rk3588,
  (template, data) => hexo.render.renderSync(template, data)
));

module.exports = { projectPages };
