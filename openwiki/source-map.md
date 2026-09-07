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
│   ├── index.ts              # 应用入口，AppRuntime 组装 + 多 bot 启动 + 消息编排
│   ├── probe-cli.ts          # AI CLI headless 输出解析工具（独立运行）
│   ├── probe-app-tool.ts     # 验证两家 CLI 都能注册应用层 MCP 工具（pnpm probe:tool）
│   ├── im/
│   │   ├── lark.ts           # 飞书 SDK 封装：WS 连接 + 事件分发 + Bot 接口
│   │   ├── message-parser.ts # 消息解析纯函数：@ 提及还原 + 资源提取
│   │   └── card.ts           # 飞书卡片构建 + 节流更新机制
│   ├── core/
│   │   ├── bot-registry.ts   # bots.json 解析校验 + 凭证环境变量解析 + buildBotPrompt 提示词组装
│   │   ├── team-registry.ts  # TeamRegistry 团队注册表：名单上下文 + Skill 缺失检查
│   │   ├── clarification.ts  # 需求澄清：数据模型 + ClarificationFlowStore
│   │   ├── collaboration.ts  # bot 间协作交接单 + 共享收件箱 CollaborationInbox
│   │   ├── session-manager.ts # 会话状态机（botId:chatId:threadId → 会话）
│   │   ├── session-store.ts   # 会话 JSON 持久化（zod 校验 + 原子写 + 旧记录迁移）
│   │   ├── topic-task.ts     # chatId+话题 → 稳定短任务 id（澄清流程归属）
│   │   ├── task-progress.ts   # CLI 事件 → 进度快照
│   │   ├── task-abort.ts      # 停止任务的权限校验
│   │   ├── command-parser.ts  # 斜杠命令与 /claude /codex 引擎选择解析
│   │   └── workspace.ts       # 工作目录解析与存在性校验
│   ├── app/
│   │   ├── runtime.ts            # AppRuntime 共享状态容器
│   │   ├── command-handler.ts    # 斜杠命令处理
│   │   ├── card-action-handler.ts # 卡片回调：澄清作答/恢复会话/停止任务
│   │   ├── clarification-runner.ts # 澄清答案收齐后的 CLI 续跑
│   │   ├── cli-execution.ts      # runCli 薄封装
│   │   ├── notification-service.ts # @ 发起人的结果通知
│   │   └── session-view.ts       # /status 渲染 + 会话 idle 回落
│   ├── mcp/
│   │   └── clarification-server.ts # stdio MCP 服务：注册 request_clarification
│   └── cli/
│       ├── types.ts           # CliAdapter / CliEvent 统一事件协议 + 压缩计划与会话摘要
│       ├── app-tools.ts       # 应用层 MCP 工具的注册参数（Claude --mcp-config / Codex -c）
│       ├── registry.ts        # 按 CliId 取适配器（claude / codex）
│       ├── claude-adapter.ts  # Claude Code 输出 → 统一事件
│       ├── codex-adapter.ts   # Codex 输出 → 统一事件
│       ├── runner.ts          # CLI 子进程生命周期（spawn/超时/取消/工具调用收集）
│       ├── native-compact.ts  # /compact 原生上下文压缩（Claude stream-json / Codex app-server）
│       ├── native-sessions.ts # /resume 会话清单（Claude 本地 JSONL / Codex app-server thread/list）
│       ├── spawn-cli.ts       # 跨平台 spawn：Windows shell 启动 + 进程树清理
│       └── timeout.ts         # armTimeout 钳制 setTimeout 上限
├── config/
│   └── bots.example.json      # bot 注册文件模板（teamLeader + bots 数组）
├── docs/
│   ├── ClaudeCode和Codex在headless输出结构.md  # 两种 CLI 输出对照表
│   └── 完整的内部交接单.md    # bot 间协作设计文档
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

**职责：** 读取 bots.json → 构建 TeamRegistry 并检查 Skill → 校验工作目录 → 恢复会话 → 组装 `AppRuntime` → 逐 bot 启动飞书连接 → 编排消息业务逻辑

**关键导出：** 无（入口文件，直接执行）

**核心逻辑：**
- `startConfiguredBot`：为每个 bot 调 `startBot` 建立独立长连接，注册同一套业务回调，并把 `BotRuntime`（config + bot + identity）登记进 `botRuntimes`
- `sendCollaborationMessage`：协作派发——登记交接单、回复协作卡片、@ 目标 bot（带 12 位任务编号），失败回滚收件箱
- `onCardAction`：由 `src/app/card-action-handler.ts` 提供，处理澄清作答 / 恢复会话 / 停止任务三类回调
- `onMessage`：命令与引擎选择解析 → 澄清补充并入 → 会话守卫 → 下载资源 → 回复初始卡片 → 后台 `executeCli` → 进度心跳驱动卡片刷新 → 澄清/协作/成功三分支收尾
- `activeRuns` / `contextWindows` / `botRuntimes` / `clarificationFlows` 等共享状态统一挂在 `AppRuntime` 上

**参见：** [消息处理流程](workflows/message-flow.md)

### src/im/lark.ts — 飞书 SDK 封装

**职责：** WebSocket 长连接、事件分发、Bot REST API 封装

**关键导出：**

| 导出 | 类型 | 说明 |
|------|------|------|
| `IncomingMessage` | interface | 标准化飞书消息结构（含 `senderUnionId`） |
| `CardAction` | interface | 卡片回调：操作者 openId/unionId、messageId、按钮 value、`formValue` 表单值 |
| `CardActionResponse` | interface | 回调应答：toast 与卡片更新 |
| `BotOptions` | interface | 启动 bot 的配置（appId, appSecret, onMessage, onCardAction） |
| `Bot` | interface | bot 能力接口（reply, replyCard, updateCard, replyMention, downloadResource, getIdentity） |
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
| `buildResumeCard` | function | `/resume` 的会话选择卡片（每条会话一行，非当前会话带「恢复」按钮） |
| `buildSessionNoticeCard` | function | `/new` 与 `/compact` 的轻量通知卡片 |
| `buildTeamCard` | function | `/team` 的团队成员卡片 |
| `buildCollaborationCard` | function | bot 间协作交接卡片（[多 bot 协作](domain/collaboration.md)） |
| `buildClarificationCard` / `buildClarificationContinuingCard` / `buildClarificationSupersededCard` | function | 澄清问答、整理中、已被新消息取代三种卡片（[需求澄清](domain/clarification.md)） |
| `answerNeedsContinuation` / `answerContinuation` / `splitLongText` | function | 超长回答的卡片截断与续发拆分 |
| `ThrottledCardUpdater` | class | 1 秒窗口节流 + 串行更新的卡片更新器 |

**参见：** [任务卡片系统](domain/task-card.md)

### src/core/ — 会话与任务核心域

| 文件 | 关键导出 | 说明 |
|------|----------|------|
| `bot-registry.ts` | `loadAgentOsConfig` / `parseAgentOsConfig` / `buildBotPrompt` / `BotConfig` / `AgentOsConfig` | bots.json 的 zod 校验（含 teamLeader）、凭证环境变量解析、工作目录优先级、提示词组装（详见 [多 bot 注册](domain/bot-registry.md)） |
| `team-registry.ts` | `TeamRegistry` / `MissingSkill` | 团队名单上下文、Skill 缺失检查、`/team` 数据源 |
| `clarification.ts` | `ClarificationRequestSchema` / `ClarificationFlowStore` / `findClarificationRequest` / `isClarificationOwner` | 需求澄清数据模型、按任务存储的流程状态机（详见 [需求澄清](domain/clarification.md)） |
| `session-manager.ts` | `SessionManager` / `Session` / `SessionStatus` | 话题级会话状态机，`resolve` 按 `botId:chatId:threadId` 查找或创建，`transition` 校验合法流转，`setWorkspaceDir` 切目录时清空 `cliSessionId` |
| `session-store.ts` | `JsonSessionStore` / `SessionStore` | zod 校验 + 临时文件重命名的原子写 + 串行写队列，重启时把 creating/active 恢复为 idle，`migrateLegacySession` 给旧记录补 `botId` / `workspaceDir` |
| `topic-task.ts` | `topicTaskId` / `topicIdOf` | chatId + 话题哈希成稳定短任务 id，澄清流程按它归属话题 |
| `task-progress.ts` | `TaskProgressTracker` / `TaskProgressSnapshot` | 以 `toolUseId` 配对 tool_start/tool_end，维护最近 12 条活动与上下文 token 基线 |
| `task-abort.ts` | `requestTaskAbort` / `ActiveRun` / `AbortTaskOutcome` | 停止任务时的存在性/发起人/重复取消校验 |
| `command-parser.ts` | `parseCommand` / `parseCliRequest` / `SlashCommand` / `CliRequest` | 匹配 `/close /status /help /team /new /resume /cd` 命令与 `/claude` `/codex` 引擎选择 |
| `workspace.ts` | `resolveWorkspacePath` / `ensureWorkspaceDirectory` | 工作目录路径解析（相对路径基于基准目录）与存在性校验 |

**参见：** [会话与任务管理](domain/session.md)

### src/app/ — 应用编排层

| 文件 | 关键导出 | 说明 |
|------|----------|------|
| `runtime.ts` | `AppRuntime` / `BotRuntime` | 共享状态容器：入口组装一次，传给各处理模块 |
| `command-handler.ts` | `handleSessionCommand` / `CommandOutcome` | 斜杠命令处理，返回 `handled`（已答复）或 `continue`（仅 `/compact` 继续走执行管线） |
| `card-action-handler.ts` | `createCardActionHandler` | 卡片回调：`answer_clarification`（含表单/推荐作答）、`resume_cli_session`、`abort_task` |
| `clarification-runner.ts` | `continueClarificationFlow` | 答案收齐后拼 prompt 回原话题续跑 CLI，支持多轮澄清 |
| `cli-execution.ts` | `executeCli` | `runCli` 薄封装 |
| `notification-service.ts` | `sendResultNotification` | @ 目标（发起人或协作 bot）的结果通知 |
| `session-view.ts` | `formatSessionStatus` / `markSessionIdle` | `/status` 文本渲染、收尾 idle 回落（不覆盖 closed 终态） |

### src/mcp/ — 应用层 MCP 服务

| 文件 | 说明 |
|------|------|
| `clarification-server.ts` | stdio MCP 服务（`agent_os`）：向两家 CLI 注册 `request_clarification` 工具，返回值只是给 CLI 的确认文案，真正的卡片渲染在应用层 |

### src/cli/ — CLI 执行层

| 文件 | 关键导出 | 说明 |
|------|----------|------|
| `types.ts` | `CliAdapter` / `CliEvent` / `CliRunResult` / `CliRunStats` / `CliCompactPlan` / `CliSessionSummary` / `promptInputForPlatform` | 统一事件协议：session / tool_start / tool_end / context / result / error / tool_call（应用层工具原始入参）；Windows 下 prompt 走 stdin；压缩计划与会话摘要类型 |
| `app-tools.ts` | `CLARIFICATION_TOOL_NAME` / `claudeAppToolArgs` / `codexAppToolArgs` | 应用层 MCP 工具注册：Claude 用 `--mcp-config` JSON，Codex 用 `-c` 配置覆盖；开发态借 tsx 跑 .ts 服务，编译产物用 node 跑 .js |
| `registry.ts` | `getCliAdapter` / `listCliAdapters` / `parseCliId` | 按 `CliId` 取适配器（claude / codex）并列出引擎清单 |
| `claude-adapter.ts` | `ClaudeAdapter` | `claude -p --output-format stream-json --verbose` 的参数组装与逐行事件翻译；`mcp__agent_os__request_clarification` 归一为统一工具名后吐 `tool_call` |
| `codex-adapter.ts` | `CodexAdapter` | `codex exec --json --skip-git-repo-check --yolo` 的参数组装与事件翻译（Windows 用 stdin prompt 与 `--dangerously-bypass-approvals-and-sandbox`）；`agent_os` 的 `mcp_tool_call` 吐 `tool_call` |
| `runner.ts` | `runCli` / `RunCliOptions` | spawn 子进程、readline 逐行读、10 分钟默认超时、AbortSignal 取消；`tool_call` 按 toolUseId 去重收集，失败调用剔除 |
| `native-compact.ts` | `compactCliSession` / `CompactCliSessionResult` | `/compact` 的原生上下文压缩：Claude 走 `-p - --resume` + stream-json，Codex 走 app-server JSON-RPC |
| `native-sessions.ts` | `listNativeCliSessions` / `CliSessionSummary` | `/resume` 的会话清单：Claude 扫 `~/.claude/projects` JSONL，Codex 走 app-server `thread/list` |
| `spawn-cli.ts` | `spawnCli` / `killCli` | Windows 下 shell 启动 `.cmd` 包装的 CLI；`killCli` 用 `taskkill /t /f` 连进程树清理避免孤儿进程 |
| `timeout.ts` | `armTimeout` / `TIMEOUT_MAX_MS` | 钳制 setTimeout 延迟在 2^31-1ms 内，防溢出被改成 1ms 立即触发 |

**参见：** [AI CLI 输出解析](domain/ai-cli-probe.md)、[消息处理流程](workflows/message-flow.md)

### src/probe-cli.ts — AI CLI 输出解析工具

**职责：** 从 stdin 读取 Claude Code / Codex 的 JSON 事件流，格式化输出

**关键逻辑：** 按 `ev.type` 路由到 Claude Code（`system` / `assistant` / `result`）或 Codex（`thread.started` / `item.completed` / `turn.completed`）的处理分支。

**参见：** [AI CLI 输出解析](domain/ai-cli-probe.md)

### src/probe-app-tool.ts — 应用层工具探测

**职责：** 验证两家 CLI 都能注册 `agent_os` MCP 服务，且 `request_clarification` 的入参能以统一工具名通过 zod 校验（`pnpm probe:tool <claude|codex> [工作目录]`）。出现未统一的工具名或没有合法澄清请求时直接抛错。

**参见：** [需求澄清](domain/clarification.md)

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
