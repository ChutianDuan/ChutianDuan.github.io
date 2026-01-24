---
title: "server"
date: 2026-01-20 10:39:22
tags:
  - "游戏开发"
  - "服务器"
  - "后端架构"
categories:
  - "学习"
  - "实时竞技游戏开发"
thumbnail: /img/covers/cover10.jpg
---
# 服务器分析
time：2026_1_20

ClientConn
    历史缓存
    tick
        最后输入tick
        最后权威tick
    最后输入包
    玩家数量

ServerCtx
    基础信息
        对局设置
        帧同步设置
        世界设置
    sock 网络
    clients 存储客户端状态
函数
    AssignSlot 分配id 1，2
    GetPlayer 从ServerCtx->clients 取出ClientConn
    OnlineCount 在线玩家统计
    GetCmdForTick 从ClientConn中获取动作信息，正常接受，如果出现延迟但小于延迟设置，着延续上一次包，但是出现过大延迟直接采用默认信息

    OnUdp 收包加入缓存
    MaybeStartMatch for pid 轮训发收start包，其中通过利用getplayer 吧serverctx中的clientconn取出，同时检测ctx中的状态已start则跳过

    OnTick 
        整体事件监听
        推进世界 + 给两边发 State/Ack
