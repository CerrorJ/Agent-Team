---
type: Overview
title: Agent-Team 快速开始
description: 飞书多 bot AI 编程指挥台——项目定位、快速运行、核心概念导航
tags: [entrypoint, overview, chinese]
---

# Agent-Team 快速开始

## 项目定位

Agent-Team 把**飞书**变成 AI 编程 CLI（Claude Code / Codex）的**指挥台**。核心理念：

- **一个话题 = 一个任务**——飞书 thread 即任务上下文
- **Bot 互相 @ 协作**——多 agent 分工
- **任务进度实时可视化**——通过可刷新的飞书卡片展示

> **当前阶段：** 项目处于早期。飞书 WS 长连接收消息、卡片进度展示已就绪；真正的 AI CLI 调度和多 bot 协作尚未接入，当前用模拟步骤演示卡片刷新。详见 [AI CLI 输出解析](domain/ai-cli-probe.md)。

## 技术栈

| 技术 | 版本/约束 | 用途 |
|------|----------|------|
| TypeScript | ES2022, strict | 主语言 |
| Node.js | >= 22 | 运行时 |
| pnpm | >= 11 | 包管理 |
| @larksuiteoapi/node-sdk | ^1.71 | 飞书 SDK |
| tsx | ^4.23 | TS 直接执行（ESM） |
| zod | ^4.4 | 数据校验（引入中） |

ESM only，所有源文件使用 `import` 语法。

## 快速运行

```bash
# 1. 安装依赖
pnpm install

# 2. 配置飞书凭证
cp .env.example .env
# 填入 BOT_A_APP_ID, BOT_A_APP_SECRET, OWNER_OPEN_ID

# 3. 启动（watch 模式，自动重载）
pnpm dev

# 或单次运行
pnpm start:once

# 类型检查 + 编译
pnpm build
```

启动后控制台输出 `Agent Team 启动，正在建立飞书长连接…`，随后监听飞书消息。在飞书中向 bot 发送消息即可看到卡片进度演示。

## 核心概念导航

| 概念 | 说明 | 文档 |
|------|------|------|
| 架构总览 | 三层架构：WS 收消息 → 事件分发 → REST 回消息 | [架构总览](architecture/overview.md) |
| 消息处理流程 | 从收到消息到卡片更新的完整链路 | [消息处理流程](workflows/message-flow.md) |
| 任务卡片系统 | 飞书卡片构建 + 节流刷新机制 | [任务卡片系统](domain/task-card.md) |
| AI CLI 输出解析 | Claude Code / Codex headless 输出解析工具 | [AI CLI 输出解析](domain/ai-cli-probe.md) |
| 运维手册 | 环境变量、运行命令、飞书配置、排查 | [运维手册](operations/runbook.md) |
| 源码地图 | 文件树与职责索引 | [源码地图](source-map.md) |

## 消息生命周期概览

当用户在飞书中发送消息时，系统经历以下流程（详见 [消息处理流程](workflows/message-flow.md)）：

```mermaid
flowchart LR
    A["飞书消息"] --> B["WS 长连接"]
    B --> C["EventDispatcher"]
    C --> D["onMessage 回调"]
    D --> E["解析消息"]
    E --> F["回复初始卡片"]
    F --> G["后台模拟更新"]
    G --> H["节流刷新卡片"]
```

从消息到达到卡片更新的完整链路。

## Backlog

以下领域已被识别但尚未实现或在代码中未体现：

| 领域 | 锚点 | 延后原因 |
|------|------|----------|
| AI CLI 调度 | `src/index.ts` 中 `DEMO_STEPS` 为硬编码模拟 | Claude Code / Codex 实际调用逻辑尚未实现 |
| 多 bot 协作 | `CLAUDE.md` 中 "bot 之间可互相 @" | 代码中仅有一个 bot，多 agent 路由未实现 |
| Cron 定时巡检 | `CLAUDE.md` 中 "cron 定时巡检" | 代码中无定时任务 |
| 测试体系 | 无测试文件 | 当前无测试目录和测试框架 |
| 部署/CI | `.github/workflows/openwiki-update.yml` | 仅有 OpenWiki 文档自动更新，无应用部署 CI |
