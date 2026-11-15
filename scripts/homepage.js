'use strict';

const path = require('node:path');

function homepagePage(homepage, rk, render) {
  if (!homepage?.projects?.length) throw new Error('Homepage project data missing: source/_data/homepage.yml');
  const hybrid = rk?.benchmarks?.find(run => run.id === 'hybrid');
  if (!hybrid) throw new Error('Homepage requires the shared RK3588 Hybrid benchmark');
  return {
    path: 'index.html',
    layout: ['page'],
    data: {
      title: homepage.title,
      description: homepage.description,
      __page: true,
      header: false,
      sidebar: false,
      toc: { enable: false },
      comments: false,
      content: render({ path: path.join(__dirname, '../templates/homepage.ejs') }, { homepage, rk, hybrid })
    }
  };
}

hexo.extend.generator.register('homepage', locals => [homepagePage(
  locals.data.homepage,
  locals.data.rk3588,
  (template, data) => hexo.render.renderSync(template, data)
)]);

module.exports = { homepagePage };
