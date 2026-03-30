---
title: Hexo 博客部署与推送
date: 2026-03-30 20:15:00
tags:
  - "Hexo"
  - "GitHub Pages"
  - "环境配置"
categories:
  - "杂七杂八"
thumbnail: /img/covers/cover2.jpg
---

# 前言

这篇文章整理一下我当前博客的部署方式，避免以后每次改完博客都要重新回忆一遍。  
这套方案的核心思路很简单：

1. `hexo` 分支保存博客源码
2. `main` 分支保存生成后的静态页面
3. 平时写文章、改主题、换头像，都是在源码分支完成
4. 最后通过 `hexo deploy` 把静态文件发布到 GitHub Pages

---

# 当前博客结构

我现在这个仓库的配置大致如下：

```yml
# _config.yml
theme: next

deploy:
  type: git
  repository: https://github.com/ChutianDuan/ChutianDuan.github.io.git
  branch: main
```

也就是说：

- `hexo` 分支负责维护源码
- `main` 分支负责网站发布
- GitHub Pages 最终读取的是 `main` 分支内容

这种做法的好处是源码和生成产物分离，日常维护会清晰很多。

---

# 需要的环境

先保证本地安装好 Node.js 和 npm。  
然后在博客目录执行依赖安装：

```bash
npm install
```

当前项目里比较关键的依赖有：

```json
"hexo": "^7.3.0",
"hexo-deployer-git": "^4.0.0",
"hexo-theme-next": "^8.27.0"
```

其中 `hexo-deployer-git` 很重要，如果没有它，执行部署时会报找不到 `git deployer`。

---

# 日常写博客的流程

## 1. 编写或修改文章

文章都放在 `source/_posts/` 下面，例如：

```bash
source/_posts/hello-world.md
source/_posts/杂七杂八/内网穿透.md
```

如果是图片资源，一般放在：

```bash
source/img/
```

比如头像目前就是：

```bash
source/img/me.jpg
```

---

## 2. 本地预览

写完文章后，可以先在本地启动预览服务：

```bash
npm run server
```

然后浏览器打开：

```text
http://localhost:4000
```

这样可以先检查下面这些内容有没有问题：

- 标题和分类是否正常
- 封面图是否能显示
- Markdown 排版是否错乱
- 代码块高亮是否正常
- 图片路径是否写对

---

## 3. 生成静态页面

确认内容没问题后，先执行一次生成：

```bash
npm run build
```

它实际对应的是：

```bash
hexo generate
```

这一步主要是提前发现问题，比如：

- 配置文件写错
- 文章 front matter 格式错误
- 主题模板引用异常
- 图片路径或资源处理问题

如果这里都能通过，后面的部署一般就比较稳。

---

## 4. 提交源码分支

这一步不要省。  
很多人只执行了部署，却忘了把源码推到远程，结果换台电脑后博客改动全没了。

我的源码分支是 `hexo`，所以常用流程如下：

```bash
git status
git add .
git commit -m "更新博客文章"
git push origin hexo
```

这一步推送的是：

- 文章源码
- 主题配置
- 页面配置
- 图片资源
- 其他博客工程文件

也就是说，这一步是在“保存你的工作过程”。

---

## 5. 部署到 GitHub Pages

源码推送完成后，再执行：

```bash
npm run deploy
```

它实际对应的是：

```bash
hexo deploy
```

根据当前配置，Hexo 会做下面几件事：

1. 读取 `public/` 里的生成结果
2. 把这些静态文件提交到部署目录
3. 推送到远程仓库的 `main` 分支

这一步完成后，GitHub Pages 就会从 `main` 分支发布网站。

---

# 一套完整命令

如果只是日常更新一篇文章，我现在一般直接按这个顺序执行：

```bash
npm run build
git add .
git commit -m "更新博客"
git push origin hexo
npm run deploy
```

可以理解成两次推送：

- 第一次把源码推到 `hexo`
- 第二次把生成后的静态站点推到 `main`

---

# 为什么要分两个分支

这个问题很常见。

如果把源码和静态页面都混在一个分支里，会出现几个明显问题：

- 仓库里会同时出现 Hexo 源码和大量生成后的静态文件
- 每次提交都会混入很多无关改动
- 后续维护主题、文章、配置时容易混乱
- 回滚也不方便

分开后逻辑就很清楚：

- `hexo` 是“项目源代码”
- `main` 是“构建产物”

这和普通前端项目里“源码目录”和“打包产物目录”分离是一样的道理。

---

# 常见问题

## 1. 执行 `hexo deploy` 失败

优先检查有没有安装部署插件：

```bash
npm install hexo-deployer-git --save
```

然后确认 `_config.yml` 里的 `deploy` 配置是否正确。

---

## 2. 页面没有立刻更新

这通常不是部署失败，而是 GitHub Pages 还没刷新完成。  
一般等几十秒到几分钟即可。

还可以检查：

- `main` 分支是否已经收到最新提交
- GitHub Pages 配置是否指向正确分支
- 浏览器是否有缓存

---

## 3. 本地构建成功，但线上图片不显示

这种问题通常出在路径。

例如站点资源推荐写成：

```text
/img/me.jpg
```

而不是本地绝对路径，也不要写成 Windows 文件系统路径。

---

## 4. 只部署了页面，没有保存源码

这是最容易踩的坑。  
如果你只执行了 `npm run deploy`，远程网站可能已经更新，但源码分支并没有保存。

正确顺序应该是：

1. 先提交并推送 `hexo` 分支
2. 再部署到 `main`

---

# 结语

对于个人博客来说，这套流程已经足够稳定：

- 平时在 `hexo` 分支维护文章和配置
- 用 `npm run build` 检查生成结果
- 用 `git push origin hexo` 保存源码
- 用 `npm run deploy` 发布站点

这样做的优点是简单、清晰、容易回溯，后续不管是换主题、换头像，还是新增文章，都能沿着同一套流程继续维护。
