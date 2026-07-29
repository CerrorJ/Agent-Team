---
type: Reference
title: 源码地图
description: Agent-Team 仓库完整文件树与每个源文件的职责说明、关键接口和导出汇总
tags: [reference, source-map, navigation]
---

# 源码地图

## 文件树

```
Agent-Team/
├── src/
│   ├── index.ts              # 应用入口，启动 bot + 消息处理业务逻辑
│   ├── probe-cli.ts          # AI CLI headless 输出解析工具（独立运行）
│   └── im/
│       ├── lark.ts           # 飞书 SDK 封装：WS 连接 + 事件分发 + Bot 接口
│       ├── message-parser.ts # 消息解析纯函数：@ 提及还原 + 资源提取
│       └── card.ts           # 飞书卡片构建 + 节流更新机制
├── docs/
│   └── ClaudeCode和Codex在headless输出结构.md  # 两种 CLI 输出对照表
├── .github/
│   └── workflows/
│       └── openwiki-update.yml    # OpenWiki 文档自动更新工作流
├── .env.example              # 环境变量模板
├── .gitignore                # 忽略 node_modules/ dist/ .env data/ *.log
├── CLAUDE.md                 # AI Agent 约定 + 运行说明 + 错题本
├── AGENTS.md                 # OpenWiki 引用说明
├── package.json              # 项目配置与脚本
├── pnpm-lock.yaml            # 锁定依赖版本
├── pnpm-workspace.yaml       # pnpm 工作区配置（允许构建的原生依赖）
└── tsconfig.json             # TypeScript 编译配置
```

## 源文件职责详解

### src/index.ts — 应用入口

**职责：** 读取环境变量 → 启动飞书 bot → 定义消息处理业务逻辑

**关键导出：** 无（入口文件，直接执行）

**核心逻辑：**
- `DEMO_STEPS`：8 步模拟任务数组（未来替换为真实 AI CLI 调用）
- `runCardDemo()`：模拟任务执行 + 卡片节流更新演示
- `startBot({ onMessage })`：启动飞书连接并注册消息回调

**参见：** [消息处理流程](workflows/message-flow.md)

### src/im/lark.ts — 飞书 SDK 封装

**职责：** WebSocket 长连接、事件分发、Bot REST API 封装

**关键导出：**

| 导出 | 类型 | 说明 |
|------|------|------|
| `IncomingMessage` | interface | 标准化飞书消息结构 |
| `BotOptions` | interface | 启动 bot 的配置（appId, appSecret, onMessage） |
| `Bot` | interface | bot 能力接口（reply, replyCard, updateCard, downloadResource） |
| `startBot` | function | 创建 Lark.Client + 注册 dispatcher + 启动 WS 连接 |

**内部函数：**
- `extractText()` — 从 text/post 消息中提取纯文本
- `resourceExtension()` — 推断下载资源的文件扩展名
- `getHeader()` — 兼容不同 headers 类型的响应头读取

**参见：** [架构总览](architecture/overview.md)

### src/im/message-parser.ts — 消息解析

**职责：** @ 提及解析与还原、消息资源 key 提取（全部为纯函数）

**关键导出：**

| 导出 | 类型 | 说明 |
|------|------|------|
| `Mention` | interface | 提及信息（key, name, openId） |
| `parseMentions` | function | 从飞书事件 mentions 数组提取结构化信息 |
| `resolveMentions` | function | 将 `@_user_N` 占位符替换为 `@显示名` |
| `extractResourceKeys` | function | 从消息内容提取 image_key / file_key |

### src/im/card.ts — 任务卡片系统

**职责：** 飞书 Schema 2.0 卡片构建 + 节流更新机制

**关键导出：**

| 导出 | 类型 | 说明 |
|------|------|------|
| `CardJson` | type | 卡片 JSON 结构（`Record<string, unknown>`） |
| `TaskStatus` | type | 任务状态：`running` / `success` / `failed` |
| `TaskCardOptions` | interface | 构建卡片的输入参数 |
| `buildTaskCard` | function | 根据 options 构建飞书卡片 JSON |
| `ThrottledCardUpdater` | class | 2 秒窗口节流 + 串行更新的卡片更新器 |

**参见：** [任务卡片系统](domain/task-card.md)

### src/probe-cli.ts — AI CLI 输出解析工具

**职责：** 从 stdin 读取 Claude Code / Codex 的 JSON 事件流，格式化输出

**关键逻辑：** 按 `ev.type` 路由到 Claude Code（`system` / `assistant` / `result`）或 Codex（`thread.started` / `item.completed` / `turn.completed`）的处理分支。

**参见：** [AI CLI 输出解析](domain/ai-cli-probe.md)

## 配置文件

### package.json

- **项目名：** Agent-Team v1.0.0
- **类型：** ESM (`"type": "module"`)
- **Node 要求：** >= 22
- **包管理：** pnpm >= 11

### tsconfig.json

- `target`: ES2022
- `module`: ES2022
- `moduleResolution`: bundler
- `strict`: true
- `rootDir`: src / `outDir`: dist

### pnpm-workspace.yaml

允许构建的原生依赖：`esbuild`、`protobufjs`

## 未提交的变更

以下文件在初始提交后有未提交的修改（`git diff` vs HEAD）：

| 文件 | 状态 | 说明 |
|------|------|------|
| `.env.example` | M | 环境变量模板更新 |
| `CLAUDE.md` | M | 约定文档更新 |
| `src/im/lark.ts` | M | 飞书集成改动 |
| `src/im/message-parser.ts` | M | 消息解析改动 |
| `src/index.ts` | M | 入口逻辑改动 |
| `src/im/card.ts` | 新增 | 卡片系统新文件 |
| `.github/` | 新增 | OpenWiki 工作流 |
| `AGENTS.md` | 新增 | OpenWiki 引用 |
