---
type: Runbook
title: 运维手册
description: Agent-Team 环境变量配置、运行命令、飞书应用配置要点、常见问题排查指南
tags: [operations, runbook, configuration, troubleshooting]
---

# 运维手册

## 环境变量配置

所有凭证通过 `.env` 文件管理（已 gitignore）。参考 `.env.example`：

| 变量名 | 用途 | 必需 |
|--------|------|------|
| `BOT_A_APP_ID` | 飞书自建应用 App ID | 是 |
| `BOT_A_APP_SECRET` | 飞书自建应用 App Secret | 是 |
| `CLAUDE_WORKDIR` | Claude Code 执行任务的项目目录，默认 Agent Team 当前目录 | 否 |
| `OWNER_OPEN_ID` | 应用所有者的 open_id（预留，当前代码未使用） | 否 |

> Bot B（`BOT_B_APP_ID` / `BOT_B_APP_SECRET`）与 `TEST_CHAT_ID` 在 `.env.example` 中预留，代码尚未使用。Claude Code 的模型后端由 `~/.claude/settings.json` 管理，不经过本项目环境变量。

### 安全约定

- **凭证只放 `.env`**：不硬编码、不提交（`CLAUDE.md` 明确要求）
- `.env` 已在 `.gitignore` 中
- 复制模板：`cp .env.example .env`，然后填入真实值

## 运行命令

| 命令 | 等价脚本 | 用途 |
|------|----------|------|
| `pnpm dev` | `tsx watch --include .env src/index.ts` | 开发模式，文件变更自动重载，.env 变更也触发重启 |
| `pnpm start` | 同 dev | 启动应用 |
| `pnpm start:once` | `tsx src/index.ts` | 单次运行（无 watch） |
| `pnpm build` | `tsc` | 类型检查 + 编译到 `dist/` |
| `pnpm probe:cli` | `tsx src/probe-cli.ts` | 运行 AI CLI 输出解析工具 |

### 启动检查

启动成功标志：控制台输出 `Agent Team 启动，正在建立飞书长连接…`、`[CLI] command=claude cwd=...` 和 `[会话] 已恢复 N 个会话`。

启动失败常见原因：

| 现象 | 原因 | 解决 |
|------|------|------|
| `缺少 BOT_A_APP_ID / BOT_A_APP_SECRET` | 环境变量未配置 | 检查 `.env` 文件 |
| 连接超时 | 网络问题或凭证错误 | 确认 App ID / Secret 正确，网络可达飞书 OpenAPI |
| 任务一直不执行 | 本机没有 `claude` CLI 或未登录 | `claude --version` 验证安装，先在本机跑通 `claude -p "hi"` |
| `Claude Code 执行超时` | 单任务超过 10 分钟（`runner.ts` 的 `DEFAULT_TIMEOUT_MS`） | 拆小任务或调大超时 |

## 飞书应用配置

### 创建自建应用

1. 在 [飞书开放平台](https://open.feishu.cn/) 创建自建应用
2. 获取 App ID 和 App Secret
3. 配置以下权限和功能：

### 必需配置

| 配置项 | 说明 |
|--------|------|
| **机器人能力** | 启用机器人功能 |
| **消息权限** | `im:message`（接收消息）、`im:message:send_as_bot`（发送消息） |
| **事件订阅** | 订阅 `im.message.receive_v1` 事件 |
| **连接方式** | 使用 WebSocket 长连接模式（非 HTTP 回调） |

### 文件下载权限

如果需要下载消息中的图片/文件，确保应用有 `im:resource` 权限。

### 版本与发布

应用需创建版本并发布，或至少在测试企业中启用。

## 项目约定

来自 `CLAUDE.md` 的约定（适用于开发者和 AI Agent）：

- **ESM only**，Node 22+，pnpm
- **凭证安全**：绝不硬编码、绝不提交
- **错题本**：`CLAUDE.md` 中有错题本区域，踩坑后追加一行：现象 → 原因 → 正确做法

## 数据目录

图片和文件默认下载到 `data/downloads/` 目录。该目录：

- 已在 `.gitignore` 中（`data/`）
- 首次下载时自动创建（`mkdir(saveDir, { recursive: true })`）
- 文件名格式：`{file_key}.{extension}`

会话持久化在 `data/sessions.json`（原子写入，重启自动恢复，详见 [会话与任务管理](../domain/session.md)），同样在 `data/` 下被 gitignore。

## 日志与调试

应用运行时输出结构化日志：

```
Agent Team 启动，正在建立飞书长连接…
[CLI] command=claude cwd=/path/to/workdir
[会话] 已恢复 2 个会话
[收到] chat=oc_xxx threadId= rootId= sender=ou_xxx
  原文: @_user_1 帮我看看
  还原: @MyBot 帮我看看
  mentions: @_user_1=MyBot(ou_xxx)
  [会话] 新建 id=uuid status=creating
[下载] image → data/downloads/img_xxx.png
[卡片] 已发送 message_id=om_xxx inThread=false
[CLI] 完成 session_id=claude-session-id
```

### 关键日志含义

| 日志 | 含义 |
|------|------|
| `[CLI] command=...` | 启动时打印将要调用的 CLI 命令与工作目录 |
| `[会话] 已恢复 N 个会话` | 从 `data/sessions.json` 恢复的会话数量 |
| `[收到]` | 收到飞书消息，含会话/话题/发送者信息 |
| `原文 vs 还原` | @ 提及还原前后对比 |
| `[会话] 新建/复用` | 按话题解析会话的结果与当前状态 |
| `[卡片] 已发送` | 初始卡片回复成功，获得 message_id |
| `[CLI] 完成` | Claude Code 执行成功，含其会话 id |
| `[CLI] 任务已取消` | 停止任务或 `/close` 触发 abort |
| `[CLI] 执行失败` | CLI 报错或非 0 退出，附错误信息 |
| `[下载]` | 图片/文件下载成功，含本地路径 |
| `[下载失败]` | 资源下载异常 |
| `[会话] 保存空闲状态失败` | 收尾时持久化失败（会话可能停留在 active，重启后会回落 idle） |

## OpenWiki 自动更新

项目配置了 GitHub Actions 工作流（`.github/workflows/openwiki-update.yml`）：

- 在 push 到 `main` 和手动 `workflow_dispatch` 时运行
- 使用 OpenWiki CLI 更新 `openwiki/` 文档
- 自动创建 PR 到 `openwiki/update` 分支
- 需要配置 `OPENAI_COMPATIBLE_API_KEY` 密钥（`LANGSMITH_API_KEY` 可选，用于追踪）
