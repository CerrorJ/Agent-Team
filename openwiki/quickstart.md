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

> **当前阶段：** 飞书消息已经可以真实驱动 Claude Code 执行任务：会话按话题持久化、卡片实时展示工具级进度、发起人可从卡片停止任务。Codex 适配、多 bot 协作尚未接入。整体链路见 [消息处理流程](workflows/message-flow.md)，CLI 事件解析见 [AI CLI 输出解析](domain/ai-cli-probe.md)。

## 技术栈

| 技术 | 版本/约束 | 用途 |
|------|----------|------|
| TypeScript | ES2022, strict | 主语言 |
| Node.js | >= 22 | 运行时 |
| pnpm | >= 11 | 包管理 |
| @larksuiteoapi/node-sdk | ^1.71 | 飞书 SDK |
| tsx | ^4.23 | TS 直接执行（ESM） |
| zod | ^4.4 | 会话持久化数据校验（`src/core/session-store.ts`） |

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

启动后控制台输出 `Agent OS 启动，正在建立飞书长连接…` 与 `[会话] 已恢复 N 个会话`，随后监听飞书消息。本机需要安装 `claude` CLI 并已登录，任务会通过子进程在 `CLAUDE_WORKDIR`（默认当前目录）中执行。

## 核心概念导航

| 概念 | 说明 | 文档 |
|------|------|------|
| 架构总览 | 分层架构：WS 收消息 → 核心会话/任务 → CLI 执行 → REST 回消息 | [架构总览](architecture/overview.md) |
| 消息处理流程 | 从收到消息到卡片更新的完整链路（含 CLI 执行与取消） | [消息处理流程](workflows/message-flow.md) |
| 会话与任务管理 | 话题级会话状态机、持久化、斜杠命令、任务中止 | [会话与任务管理](domain/session.md) |
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
    D --> E["解析命令与会话"]
    E --> F["回复初始卡片"]
    F --> G["后台执行 Claude Code"]
    G --> H["节流刷新卡片"]
```

从消息到达到卡片更新的完整链路。

## Backlog

以下领域已被识别但尚未实现或在代码中未体现：

| 领域 | 锚点 | 延后原因 |
|------|------|----------|
| Codex 适配器 | `src/cli/types.ts` 中 `CliId` 目前只有 `'claude'` | Codex 输出结构已有调研但适配器未实现 |
| 多 bot 协作 | `CLAUDE.md` 中 "bot 之间可互相 @" | 代码中仅有一个 bot，多 agent 路由未实现 |
| Cron 定时巡检 | `CLAUDE.md` 中 "cron 定时巡检" | 代码中无定时任务 |
| 测试体系 | 无测试文件 | 当前无测试目录和测试框架 |
| 部署/CI | `.github/workflows/openwiki-update.yml` | 仅有 OpenWiki 文档自动更新，无应用部署 CI |
