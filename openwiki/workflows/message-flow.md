---
type: Workflow
title: 消息处理流程
description: 从飞书消息接收到 Claude Code 执行、卡片进度更新与任务收尾的完整处理链路，包括命令解析、会话守卫、CLI 事件流与取消路径
tags: [workflow, message-handling, lark, claude-code]
---

# 消息处理流程

## 端到端时序

当用户在飞书中发送消息时，系统经历以下完整流程：

```mermaid
sequenceDiagram
    participant User as 飞书用户
    participant WS as WSClient
    participant Disp as EventDispatcher
    participant CB as onMessage
    participant SM as SessionManager
    participant Bot as Bot
    participant Run as runCli 子进程
    participant Card as card.ts

    User->>WS: 发送消息
    WS->>Disp: im.message.receive_v1 事件
    Disp->>CB: IncomingMessage 对象
    CB->>CB: resolveMentions 还原 @ 提及
    CB->>SM: resolve 按话题解析会话
    SM-->>CB: session + isNew
    alt 斜杠命令 /help /status /close /cd
        CB->>Bot: reply 文本，流程结束
    else 会话守卫拦截
        CB->>Bot: closed/creating/active 拒绝追问
    else 正常任务
        CB->>SM: transition active
        CB->>Bot: 下载图片/文件附件
        CB->>Bot: replyCard 初始卡片（含停止任务按钮）
        CB->>Run: 后台 spawn claude 或 codex
        Run-->>CB: 统一 CliEvent 事件流
        CB->>Card: TaskProgressTracker + 节流刷新
        Run-->>CB: result / error / 取消
        Card->>Bot: finish 最终卡片
    end
```

从消息接收、会话守卫、CLI 执行到卡片收尾的完整调用链。

## 消息接收与解析

### 事件结构

飞书 `im.message.receive_v1` 事件中的 `data.message` 包含：

| 字段 | 说明 |
|------|------|
| `message_id` | 消息唯一标识，用于回复 |
| `chat_id` / `chat_type` | 会话 ID 与类型（`p2p` 单聊 / `group` 群聊） |
| `message_type` | `text` / `image` / `file` / `post` 等 |
| `content` | JSON 字符串，结构随 message_type 变化 |
| `root_id` / `thread_id` | 话题标识，判断是否在 thread 中 |
| `mentions` | @ 提及列表 |

### 文本提取（extractMessageText）

`src/im/lark.ts` 中的 `extractMessageText()` 函数处理两种消息类型：

- **text**：直接取 `parsed.text`
- **post**（飞书富文本）：遍历 `content` 数组，拼接 `text` / `a` / `code` / `code_block` / `md` 元素文本，`br` 转换行，按段落用换行连接

### @ 提及还原

飞书消息中 @ 人的部分显示为占位符（如 `@_user_1`），需要用 `resolveMentions()` 还原为可读文本（如 `@MyBot`）。

> 原文与还原文本的区别（来自 `src/index.ts` 日志）：
> ```
> 原文: @_user_1 帮我看看这个文件
> 还原: @MyBot 帮我看看这个文件
> ```

### 斜杠命令

`src/core/command-parser.ts` 的 `parseCommand()` 用正则匹配「可选 @ 提及 + 一条命令」，只认 `/close`、`/status`、`/help`、`/cd` 四个命令；「帮我运行 /status 看看」这类句子不会命中。另有 `parseCliRequest()` 单独识别 `/claude <任务>` 与 `/codex <任务>` 的引擎选择请求。

| 命令 | 行为 |
|------|------|
| `/help` | 回复命令列表 |
| `/status` | 回复机器人、会话 id、状态、执行引擎、工作目录、CLI 会话 id、话题、更新时间 |
| `/cd` | 无参数查看当前工作目录；带参数切换话题工作目录（active 状态下拒绝，切换成功后清空 `cliSessionId`，下一条任务新建 CLI 会话） |
| `/close` | 中止运行中任务（`cancelMode = "close"`）并把会话置为 `closed` |
| `/claude` / `/codex` | 新话题显式选择执行引擎；已有话题引擎不同会被拒绝；不带任务文本时提示补写任务 |

### 资源提取与下载

`extractResourceKeys()` 从消息内容中提取图片和文件的 key：

| 消息类型 | 提取内容 |
|----------|----------|
| `image` | `image_key` |
| `file` | `file_key` + `file_name` |
| `post` | 富文本中所有 `img` 元素的 `image_key` |

下载通过 `Bot.downloadResource()` 调用飞书 `messageResource.get` API，根据 Content-Type 自动推断扩展名，保存到 `data/downloads/` 目录。扩展名推断优先级：原始文件名 > Content-Type 映射 > 默认值（image→`img`，file→`bin`）。

## 会话守卫

`onMessage` 在执行任务前先做会话级检查（详见 [会话与任务管理](../domain/session.md)）。此外有两个前置分支：

- **引擎切换守卫**：已有话题里用 `/claude` 或 `/codex` 请求了与会话当前不同的引擎时，回复「当前话题已经在使用 X。如需切换执行引擎，请新开一个话题」
- **空任务守卫**：`/claude` / `/codex` 后面没有任务文本时，提示补写任务示例

| 会话状态 | 处理 |
|----------|------|
| `closed` | 回复「会话已关闭，请新开话题」 |
| `creating`（非新建） | 回复「正在准备，请稍后再追问」 |
| `active` | 回复「还在执行，请等任务结束」 |
| `idle` / 新话题 | `transition active`，继续执行 |

这样保证一个话题同一时间只有一个 CLI 任务在跑，追问会排队提示而不是并发执行。

## 卡片回复与线程判断

```typescript
const hasThread = !!msg.threadId || !!msg.rootId;
```

- 如果消息在 thread 中（`threadId` 或 `rootId` 存在），回复时设置 `reply_in_thread: true`，使回复留在同一话题内
- 否则普通回复

回复初始卡片后获得 `message_id`，后续所有进度更新都通过 `updateCard()` 刷新这张卡片。初始卡片带 `abortSessionId`，渲染出「停止任务」按钮。

## CLI 执行与进度更新

后台执行链路由 [架构总览](../architecture/overview.md) 中的执行层组成：

1. `runCli()`（`src/cli/runner.ts`）`spawn` CLI 子进程，命令与参数由所选适配器的 `buildArgs` / `buildResumeArgs` 生成：Claude Code 为 `-p <prompt> --output-format stream-json --verbose`（续跑加 `--resume <sessionId>`），Codex 为 `exec --json --skip-git-repo-check --yolo <prompt>`（续跑为 `exec resume --json ... <sessionId>`；Windows 下以 stdin 传 prompt 并用 `--dangerously-bypass-approvals-and-sandbox` 替代 `--yolo`）
2. stdout 逐行进入适配器的 `parseEvents()`，翻译成统一 `CliEvent`（两套引擎的翻译对照见 [AI CLI 输出解析](../domain/ai-cli-probe.md)）
3. `onEvent` 回调只处理 `tool_start` / `tool_end` / `context` 三类事件，喂给 `TaskProgressTracker`
4. `TaskProgressTracker` 用 `toolUseId` 配对起止事件，维护当前工具、最近完成轨迹（上限 12 条）和上下文 token 基线，`snapshot()` 输出卡片所需快照
5. 每秒一次心跳 `renderProgress()` 把快照经 `ThrottledCardUpdater` 节流推送到飞书

### Claude Code 事件翻译

`ClaudeAdapter`（`src/cli/claude-adapter.ts`）：

| 原生事件 | 翻译为 | 说明 |
|----------|--------|------|
| `system` + `subtype=init` | `session` | 捕获 Claude 自己的会话 id |
| `assistant`（`message.usage`） | `context` | 运行时 token 用量，实时刷新卡片上下文行 |
| `assistant`（`tool_use` 块） | `tool_start` | 工具名映射中文标签，输入摘要做 detail（如文件短路径、命令描述） |
| `user`（`tool_result` 块） | `tool_end` | `is_error` 标记失败 |
| `result` | `result` | 最终回答 + 耗时/轮次/token 统计 |
| `result`（`is_error`） | `error` | 带错误信息 |

> `result.usage` 是整次执行的累计消耗（写入 `totalTokens`），与 `assistant.message.usage` 的运行时上下文用量是两回事；上下文窗口大小要等 `result.modelUsage` 才知道。

### Codex 事件翻译

`CodexAdapter`（`src/cli/codex-adapter.ts`）把 `codex exec --json` 的事件流翻成同一套 `CliEvent`：

| 原生事件 | 翻译为 | 说明 |
|----------|--------|------|
| `thread.started` | `session` | 捕获 Codex 的 `thread_id`，续跑用 `exec resume <id>` |
| `item.started`（command_execution / file_change / web_search / mcp_tool_call） | `tool_start` | 工具类型映射为 Bash / Edit / WebSearch / MCP 标签，command、path、query 等做 detail 摘要 |
| `item.completed`（同上） | `tool_end` | `status === "failed"` 或非 0 `exit_code` 标记失败 |
| `item.completed` + `agent_message` | `result` | 模型回答文本 |
| `turn.completed` | `result` | 仅 `usage` 统计（input/output/cached token），此时若无回答则不产生最终结果 |
| `error` / `turn.failed` | `error` | 取 `message` 或 `error.message` |

## 任务收尾的三条路径

```mermaid
flowchart TD
    DONE["runCli 结束"] --> AB{"signal.aborted?"}
    AB -->|是| CANCEL["cancelled 灰色卡片，文案按 cancelMode 区分"]
    AB -->|否| ERR{"有 error 或非 0 退出?"}
    ERR -->|是| FAILED["failed 红色卡片，错误详情折叠面板"]
    ERR -->|否| OK["success 绿色卡片，回答与执行详情"]
    OK --> LONG{"回答超过 6000 字符?"}
    LONG -->|是| CONT["卡片折叠完整回答，剩余拆条续发"]
    CANCEL --> FIN["注销 activeRuns，会话回落 idle"]
    FAILED --> FIN
    OK --> FIN
```

成功、失败、取消三条收尾路径的处理逻辑。

- **成功**：把 CLI 会话 id 补录进 Session（`setCliSessionId`），记录上下文窗口大小供下一轮进度计算，发 success 卡片；回答超过单卡上限时折叠展示并按 4000 字符拆条续发
- **取消**：卡片停止按钮或 `/close` 触发 `AbortController.abort()`，发 cancelled 卡片，文案按 `cancelMode`（`stop` / `close`）区分
- **失败**：发 failed 卡片，`technicalDetail` 放进「查看错误详情」折叠面板
- **收尾**：`finally` 中注销 `activeRuns` 登记并把会话从 `active` 回落 `idle`（仅 active 状态回落，避免覆盖 `closed` 终态）

## 停止任务

卡片上的「停止任务」按钮走 `card.action.trigger` 事件（`onCardAction` 回调），`requestTaskAbort()` 校验：

- 任务不存在 → toast「任务已经结束」
- 操作者不是发起人 → toast「只有任务发起人可以停止它」
- 已在取消中 → toast「正在停止任务，请稍候」
- 通过 → `controller.abort()`，toast「已发送停止指令」

## 源文件索引

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 入口，onMessage/onCardAction 业务逻辑，任务编排与收尾 |
| `src/im/lark.ts` | WS 连接、事件分发、Bot 接口实现、消息文本提取 |
| `src/im/message-parser.ts` | @ 提及解析、资源 key 提取（纯函数） |
| `src/im/card.ts` | 卡片构建与节流更新（详见 [任务卡片系统](../domain/task-card.md)） |
| `src/core/command-parser.ts` | 斜杠命令与 `/claude` `/codex` 引擎选择解析 |
| `src/core/task-progress.ts` | CLI 事件 → 进度快照 |
| `src/cli/registry.ts` | 按 `CliId` 取适配器 |
| `src/cli/runner.ts` | CLI 子进程生命周期 |
| `src/cli/claude-adapter.ts` | Claude Code 输出 → 统一事件 |
| `src/cli/codex-adapter.ts` | Codex 输出 → 统一事件 |
