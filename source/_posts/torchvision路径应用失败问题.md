---
title: torchvision路径应用失败问题
date: 2024-09-05 09:17:06
tags: 
- Pytorch
categories: 
- 软件
thumbnail: /img/covers/cover5.jpg
---
# torchvision模块路径引用问题
前言：安装pytorch后可能会出现torch模块引用成功，而torchvision模块引用失败，失败原因为torchvision模块路径丢失。可能是三个问题导致的： 
1. torch和torchvision版本不匹配
1. pillow版本和torchvision版本不匹配
# torch和torchvision版本不匹配
建议从pytorch官网重新下载新版pytorch，或者查询历史版本重新选择一个版本进行下载
# pillow版本和torchvision版本不匹配
删除pillow 在重新下载pillow最新版
