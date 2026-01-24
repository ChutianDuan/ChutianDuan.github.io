---
title: "client"
date: 2026-01-21 15:25:43
tags:
  - "游戏开发"
  - "客户端"
  - "同步"
categories:
  - "学习"
  - "实时竞技游戏开发"
---
# Client 实现分析
time：2026_1_21


## app 依赖包
ClientRender
    可视化

GameConfig
    client 基础信息参数 后续可以扩展到server 公用一个确保准确

InputPredicition
    预测 x,y 的动作

## 主体部分

ClientCtx

    lab::net::UdpSocket sock; 发收
    lab::net::UdpAddr server{}; server 接受

    localHist 本地
    remoteHist 预测
    stateHist 权威

BuildCmdVec （localPid localCmd remoteCmds）
    通过pid识别是否是本段，保存一个vector<inputcmd>cmds size = 2的状态，本段保存输入，对端保存预测
    return （输入， 预测）// vector<inputcmd>cmds size 2

GetRemoteCmdForTick  ctx pid t

    return (预测)


ApplyAuthoritativeState ctx st

## 整理
主要就就两条思路 接受处理，发收处理维护不同的状态

OnUdp
Recv：只负责收包 -> 更新 ack/state -> 更新对手预测/触发回滚