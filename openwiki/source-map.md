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
│   ├── index.ts              # 应用入口，多 bot 启动 + 消息/卡片回调业务编排
│   ├── probe-cli.ts          # AI CLI headless 输出解析工具（独立运行）
│   ├── im/
│   │   ├── lark.ts           # 飞书 SDK 封装：WS 连接 + 事件分发 + Bot 接口
│   │   ├── message-parser.ts # 消息解析纯函数：@ 提及还原 + 资源提取
│   │   └── card.ts           # 飞书卡片构建 + 节流更新机制
│   ├── core/
│   │   ├── bot-registry.ts   # bots.json 解析校验 + 凭证环境变量解析 + systemPrompt 拼接
│   │   ├── session-manager.ts # 会话状态机（botId:chatId:threadId → 会话）
│   │   ├── session-store.ts   # 会话 JSON 持久化（zod 校验 + 原子写 + 旧记录迁移）
│   │   ├── task-progress.ts   # CLI 事件 → 进度快照
│   │   ├── task-abort.ts      # 停止任务的权限校验
│   │   ├── command-parser.ts  # 斜杠命令与 /claude /codex 引擎选择解析
│   │   └── workspace.ts       # 工作目录解析与存在性校验
│   └── cli/
│       ├── types.ts           # CliAdapter / CliEvent 统一事件协议
│       ├── registry.ts        # 按 CliId 取适配器（claude / codex）
│       ├── claude-adapter.ts  # Claude Code 输出 → 统一事件
│       ├── codex-adapter.ts   # Codex 输出 → 统一事件
│       ├── runner.ts          # CLI 子进程生命周期（spawn/超时/取消）
│       └── spawn-cli.ts       # 跨平台 spawn：Windows shell 启动 + 进程树清理
├── config/
│   └── bots.example.json      # bot 注册文件模板（id、凭证变量名、defaultCli、systemPrompt）
├── docs/
│   └── ClaudeCode和Codex在headless输出结构.md  # 两种 CLI 输出对照表
├── .github/
│   └── workflows/
│       └── openwiki-update.yml    # OpenWiki 文档自动更新工作流
├── .env.example              # 环境变量模板（BOTS_CONFIG、FEISHU_* 凭证、CLI_WORKDIR）
├── .gitignore                # 忽略 node_modules/ dist/ .env data/ *.log
├── .prettierrc / .prettierignore  # Prettier 格式化配置
├── eslint.config.js          # ESLint：箭头函数 + 声明间空行规则
├── CLAUDE.md                 # AI Agent 约定 + 运行说明 + 错题本
├── AGENTS.md                 # OpenWiki 引用说明
├── package.json              # 项目配置与脚本
├── pnpm-lock.yaml            # 锁定依赖版本
├── pnpm-workspace.yaml       # pnpm 工作区配置（允许构建的原生依赖）
└── tsconfig.json             # TypeScript 编译配置
```

## 源文件职责详解

### src/index.ts — 应用入口

**职责：** 读取 bots.json → 校验工作目录 → 恢复会话 → 逐 bot 启动飞书连接 → 编排消息与卡片回调业务逻辑

**关键导出：** 无（入口文件，直接执行）

**核心逻辑：**
- `startConfiguredBot`：为每个 bot 调 `startBot` 建立独立长连接，注册同一套业务回调
- `onCardAction`：处理卡片「停止任务」回调，调用 `requestTaskAbort` 并映射 toast
- `onMessage`：命令与引擎选择解析 → 会话守卫 → 下载资源 → 回复初始卡片 → 后台 `executeCli`（`runCli` + 所选适配器）→ 进度心跳驱动卡片刷新 → 成功/取消/失败三分支收尾
- `activeRuns` / `contextWindows` 两个内存 Map：登记运行中任务、记住各会话上下文窗口大小

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
- `extractMessageText()` — 从 text/post 消息中提取纯文本
- `parseCardAction()` — 从卡片回调数据中取出操作者、消息 id 和按钮 value
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
| `TaskStatus` | type | 任务状态：`running` / `success` / `failed` / `cancelled` |
| `TaskCardOptions` | interface | 构建卡片的输入参数 |
| `buildTaskCard` | function | 根据 options 构建飞书卡片 JSON |
| `answerNeedsContinuation` / `answerContinuation` / `splitLongText` | function | 超长回答的卡片截断与续发拆分 |
| `ThrottledCardUpdater` | class | 1 秒窗口节流 + 串行更新的卡片更新器 |

**参见：** [任务卡片系统](domain/task-card.md)

### src/core/ — 会话与任务核心域

| 文件 | 关键导出 | 说明 |
|------|----------|------|
| `bot-registry.ts` | `loadBotConfigs` / `parseBotConfigs` / `buildBotPrompt` / `BotConfig` | bots.json 的 zod 校验、凭证环境变量解析、工作目录优先级、角色提示词拼接（详见 [多 bot 注册](domain/bot-registry.md)） |
| `session-manager.ts` | `SessionManager` / `Session` / `SessionStatus` | 话题级会话状态机，`resolve` 按 `botId:chatId:threadId` 查找或创建，`transition` 校验合法流转，`setWorkspaceDir` 切目录时清空 `cliSessionId` |
| `session-store.ts` | `JsonSessionStore` / `SessionStore` | zod 校验 + 临时文件重命名的原子写 + 串行写队列，重启时把 creating/active 恢复为 idle，`migrateLegacySession` 给旧记录补 `botId` / `workspaceDir` |
| `task-progress.ts` | `TaskProgressTracker` / `TaskProgressSnapshot` | 以 `toolUseId` 配对 tool_start/tool_end，维护最近 12 条活动与上下文 token 基线 |
| `task-abort.ts` | `requestTaskAbort` / `ActiveRun` / `AbortTaskOutcome` | 停止任务时的存在性/发起人/重复取消校验 |
| `command-parser.ts` | `parseCommand` / `parseCliRequest` / `SlashCommand` / `CliRequest` | 匹配 `/close /status /help /cd` 命令与 `/claude` `/codex` 引擎选择 |
| `workspace.ts` | `resolveWorkspacePath` / `ensureWorkspaceDirectory` | 工作目录路径解析（相对路径基于基准目录）与存在性校验 |

**参见：** [会话与任务管理](domain/session.md)

### src/cli/ — CLI 执行层

| 文件 | 关键导出 | 说明 |
|------|----------|------|
| `types.ts` | `CliAdapter` / `CliEvent` / `CliRunResult` / `CliRunStats` / `promptInputForPlatform` | 统一事件协议：session / tool_start / tool_end / context / result / error；Windows 下 prompt 走 stdin |
| `registry.ts` | `getCliAdapter` / `listCliAdapters` / `parseCliId` | 按 `CliId` 取适配器（claude / codex）并列出引擎清单 |
| `claude-adapter.ts` | `ClaudeAdapter` | `claude -p --output-format stream-json --verbose` 的参数组装与逐行事件翻译 |
| `codex-adapter.ts` | `CodexAdapter` | `codex exec --json --skip-git-repo-check --yolo` 的参数组装与事件翻译（Windows 用 stdin prompt 与 `--dangerously-bypass-approvals-and-sandbox`） |
| `runner.ts` | `runCli` / `RunCliOptions` | spawn 子进程、readline 逐行读、10 分钟默认超时、AbortSignal 取消 |
| `spawn-cli.ts` | `spawnCli` / `killCli` | Windows 下 shell 启动 `.cmd` 包装的 CLI；`killCli` 用 `taskkill /t /f` 连进程树清理避免孤儿进程 |

**参见：** [AI CLI 输出解析](domain/ai-cli-probe.md)、[消息处理流程](workflows/message-flow.md)

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
