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
| `BOTS_CONFIG` | bot 注册文件路径，默认 `config/bots.json` | 否 |
| `FEISHU_*_APP_ID` / `FEISHU_*_APP_SECRET` | 各 bot 的飞书自建应用凭证；具体变量名由 `bots.json` 中每个 bot 的 `appIdEnv` / `appSecretEnv` 决定。未配置专属凭证的 bot 回退系统级 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`（README 的「极简模式」，单套凭证跑全员、按 appId 共享一条长连接），两种模式可混用 | 是（专属或系统级二选一） |
| `CLI_WORKDIR` | 全局默认工作目录（bot 未配 `workspace` 时使用；旧键 `CLAUDE_WORKDIR` 仍兼容作兜底） | 否 |
| `CLAUDE_TIMEOUT_MS` / `CODEX_TIMEOUT_MS` | 按引擎覆盖 CLI 子进程超时（默认 2 小时）；也可用统一 `CLI_TIMEOUT_MS`，设 0 或非法值回退默认，**不支持不限时** | 否 |
| `SCHEDULE_API_PORT` / `SCHEDULE_API_TOKEN` | 定时任务本地 HTTP 管理接口的端口（默认 3101）与 `x-api-token` 鉴权令牌；未配置 token 时接口完全不设防，只当本机接口用 | 否 |
| `TEST_CHAT_ID` / `OWNER_OPEN_ID` | 测试群与所有者 open_id；bot 消息（外部派活）场景下 `OWNER_OPEN_ID` 兜底作为发起人 | 否 |
| `CEO_ZHIPU_ANTHROPIC_*` 等被 `cliEnv` 引用的变量 | per-bot CLI 模型后端覆盖：`bots.json` 里 `cliEnv` 映射的 source 变量（模板把 ceo-assistant 的 11 个 `ANTHROPIC_*` 键指向 `CEO_ZHIPU_*`），值留空会启动报错；变量名自定义，见 [多 bot 注册](../domain/bot-registry.md) | 否（配置了 cliEnv 才必需） |
| `PROVIDER_ERROR_CONFIG` | 多厂家后端错误分类的扩展规则文件路径，默认 `config/provider-errors.json`（仓库自带空规则模板，可用 `endpointPattern` / `codePattern` / `messagePattern` / `status` 匹配自定义厂商错误码，修改后重启生效）；冷却默认值也在此文件调整，见 [后端故障恢复](../domain/provider-recovery.md) | 否 |
| `AGENT_TEAM_QUOTA_GROUP` | 可选的额度组合并键：CLI 内部 profile 或代理网关背后的共享额度无法凭环境变量推断时，把该键加进 bot 的 `cliEnv` 映射（值放 `.env`），让不同端点/引擎共享账号级冷却，见 [后端故障恢复](../domain/provider-recovery.md) | 否 |
| `PATROL_WEBHOOK_URL` | 运维群自定义机器人 webhook，demo-server 巡检推送用；只被 `demo-server/scripts/notify.mjs` 读取，主进程不消费，留空时巡检跳过推送 | 否 |

首次配置需要三步：`cp .env.example .env` 填凭证，`cp config/bots.example.json config/bots.json` 注册 bot（字段含义见 [多 bot 注册](../domain/bot-registry.md)），再按根 README 的技能对照表安装 bots.json 声明的工作流 Skills（全局装到 `~/.agents/skills/`，或从 `workspace-template/` 复制定制版）。

> Claude Code 与 Codex 的模型后端默认使用各自的用户级配置（如 `~/.claude/settings.json` 或 CC Switch），不经过本项目环境变量；仅当 bot 在 `bots.json` 配置了 `cliEnv` 时才按 bot 覆盖（如 CEO 走智谱直连、其他 Claude bot 继续跟随 CC Switch），机制见 [多 bot 注册](../domain/bot-registry.md) 的 per-bot CLI 模型配置一节。运行期还可用 `/model` 卡片在 `cliEnv` 之上做免重启热调，持久化在 `data/bot-model-overrides.json`（按 botId + cliId 隔离），见 [角色模型动态配置](../domain/model-config.md)。

### 安全约定

- **凭证只放 `.env`**：不硬编码、不提交（`CLAUDE.md` 明确要求）
- `.env` 已在 `.gitignore` 中
- 复制模板：`cp .env.example .env`，然后填入真实值

## 运行命令

| 命令 | 等价脚本 | 用途 |
|------|----------|------|
| `pnpm dev` | `tsx watch --include .env --include "config/*.json" src/index.ts` | 开发模式，源码、`.env`、bot 配置变更均自动重载 |
| `pnpm start` | 同 dev | 启动应用 |
| `pnpm start:once` | `tsx src/index.ts` | 单次运行（无 watch） |
| `pnpm build` | `tsc` | 类型检查 + 编译到 `dist/` |
| `pnpm agent-team <cmd>` | `tsx src/deploy-cli.ts` | pm2 常驻部署封装：`doctor`（检查 node/pnpm/pm2/claude/codex 与配置文件）、`start` / `stop` / `restart` / `status` / `logs`；`start` 缺 `dist/` 时自动 build，详见 `SETUP.md`（含国内 ECS 部署与 `pm2 startup` 开机自启） |
| `pnpm demo:server` / `pnpm demo:traffic` | `pnpm --filter agent-team-demo-server start/traffic` | 启动故障注入演示服务与流量场景脚本（normal / slow / error-spike / repeated-error / db-down） |
| `pnpm probe:cli` | `tsx src/probe-cli.ts` | 运行 AI CLI 输出解析工具 |
| `pnpm probe:tool` | `tsx src/probe-app-tool.ts` | 验证两家 CLI 能注册 `agent_team` MCP 服务且 `request_clarification` 入参通过校验（详见 [需求澄清](../domain/clarification.md)） |
| `pnpm lint` / `pnpm lint:fix` | `eslint . [--fix]` | 检查/修复箭头函数与声明间空行规则（`eslint.config.js`） |
| `pnpm test` | `tsc -p tsconfig.test.json && node --import tsx --test "tests/*.test.ts"` | 回归测试（node:test runner，详见下方测试一节） |
| `pnpm format` / `pnpm format:check` | `prettier --write/--check .` | 格式化/检查格式（`.prettierrc`） |

### 启动检查

启动成功标志：控制台输出 `Agent Team 启动，正在建立飞书长连接…`、`[配置] 已注册 N 个 bot，Team Leader=...，已恢复 M 个会话`、各 `[CLI] id=... command=...` 引擎行与 `[Bot XXX] 已连接`。

启动失败常见原因：

| 现象 | 原因 | 解决 |
|------|------|------|
| `找不到 bot 配置文件` | 未创建 `config/bots.json` | `cp config/bots.example.json config/bots.json` 后填写 |
| `bot xxx 缺少环境变量 XXX` | `.env` 缺少该 bot 的凭证变量，且未配置系统级 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 回退 | 补齐专属变量，或改用极简模式只配系统级凭证 |
| `bot xxx 的 CLI 环境变量 X 缺少 Y` | `cliEnv` 映射的 source 变量在 `.env` 里缺失或为空（严格校验，留空即报错） | 补上 `Y` 的值；不启用该 bot 的模型覆盖就从 `bots.json` 删掉这条映射 |
| `bot id 不能重复` / 校验失败 | `bots.json` 结构不合法（如缺 `teamLeader`、bot 缺 `role`） | 对照 zod 校验规则，见 [多 bot 注册](../domain/bot-registry.md) |
| `工作目录不存在` | bot `workspace` / `CLI_WORKDIR` 指向的路径无效 | 修正路径或创建目录 |
| 连接超时 | 网络问题或凭证错误 | 确认 App ID / Secret 正确，网络可达飞书 OpenAPI |
| 任务一直不执行 | 本机没有对应 CLI 或未登录 | `claude --version` / `codex --version` 验证安装，先在本机跑通一次 |
| `Claude Code 执行超时` | 任务超过默认 2 小时上限（`runner.ts` 的 `DEFAULT_TIMEOUT_MS`，可用 `CLAUDE_TIMEOUT_MS` / `CODEX_TIMEOUT_MS` / `CLI_TIMEOUT_MS` 覆盖）或任务被外部中止 | 调大对应引擎的超时环境变量，或用卡片「停止任务」手动中止；环境变量设 0 或非法值会回退默认，不支持不限时 |
| 任务失败提示「已移交 Team Leader 接续派发」 | 该 bot 的模型后端被判定为故障（限流重试耗尽 / 额度耗尽 / 计费 / 认证 / 配置 / 服务不可用），已按后端域登记冷却；冷却时长优先取服务端提示（`Retry-After` / `retry_after` 等），否则用各类别默认值（限流 60 秒、额度 5 分钟等），状态在内存中重启即清零 | 等待冷却结束或重启进程；分类与自定义厂家规则见 [后端故障恢复](../domain/provider-recovery.md)，同组（`group`）配了独立后端备用成员的会自动代班，见 [多 bot 协作](../domain/collaboration.md) 的后端故障一节 |
| 多个 bot 头像名称相同 | 这些 bot 复用了同一套凭证（共享 appId，只建一条长连接） | 需要独立身份就为各 bot 配独立 `appIdEnv` / `appSecretEnv`（多应用独立模式） |

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

## 测试

测试用 Node 内置的 `node:test` runner（无第三方测试框架），入口 `pnpm test`：先 `tsc -p tsconfig.test.json` 做类型检查（`tsconfig.test.json` 在主配置基础上 `noEmit` 且把 `tests/` 纳入 `include`），再用 `node --import tsx --test "tests/*.test.ts"` 直接跑 TS 源文件。

- **现有覆盖：** 三组 node:test 回归——`tests/product-spec-submission.test.ts` 针对 [产品方案交付](../domain/product-spec.md) 的提交链路（local 落盘校验（拒绝把汇总 Markdown 当 `ticketsPath`、缺 Spec/缺 Tickets/空目录）、`ensureProductSpecSubmission` 的兜底重跑（合法提交不重跑、被拒提交带真实原因重跑一次且不得改交付方式）、`request_spec_approval` 的 MCP 入参 schema 与工作区预检（真实拉起 stdio MCP 服务端验证 isError 回传）、以及 `runCli` 把失败的应用层工具调用单独收集进 `rejectedToolCalls`）；`tests/provider-error.test.ts` 针对 [后端故障恢复](../domain/provider-recovery.md) 的分类（多厂家文案/状态码/错误码、包装层结构化字段提取、重试提示解析、自定义规则优先于内置 429）与冷却作用域（账号/模型隔离、到期清除、quota group 合并、备用成员排除共享后端、两家适配器保留结构化错误）；`tests/cli-recovery.test.ts` 用真实子进程 fixture 验证 runner 的重试策略（限流先重试后冷却、最多两次、不重复已执行工作的副作用、保留会话 ID、长重试窗口不截短、取消不登记故障、停止型工具不触发重试、CLI 自行恢复时不重放成功任务）
- **写新测试时注意两个已知坑**（`CLAUDE.md` 错题本）：TypeScript 7 原生编译器不自动引入 `node_modules/@types`，需要时 tsconfig 显式写 `"types": ["node"]`；Node 22+ 把 `--test` 的位置参数当 glob，目录会被当模块加载，应使用 `"tests/*.test.ts"` 这类文件 glob
- **风格：** 与源码一致（ESM、箭头函数、Prettier），测试文件同样受 `pnpm lint` / `pnpm format:check` 约束

## 项目约定

来自 `CLAUDE.md` 的约定（适用于开发者和 AI Agent）：

- **ESM only**，Node 22+，pnpm
- **凭证安全**：绝不硬编码、绝不提交；bot 凭证变量名写在 `bots.json`，值只放 `.env`
- **代码风格**：格式以 `.prettierrc` 为准；箭头函数（不用 `function` 声明）与声明间空行由 ESLint 强制；提交前跑 `pnpm lint` 与 `pnpm format:check`。`.gitattributes`（`* text=auto eol=lf`）把检出统一为 LF，与 `.prettierrc` 的 `endOfLine: "lf"` 对齐，避免 Windows `core.autocrlf=true` 检出 CRLF 后 `format:check` 失败
- **错题本**：`CLAUDE.md` 中有错题本区域，踩坑后追加一行：现象 → 原因 → 正确做法（如 pnpm v11 需在 `pnpm-workspace.yaml` 放行 `esbuild` 构建脚本）

## 数据目录

图片和文件默认下载到 `data/downloads/` 目录。该目录：

- 已在 `.gitignore` 中（`data/`）
- 首次下载时自动创建（`mkdir(saveDir, { recursive: true })`）
- 文件名格式：`{file_key}.{extension}`

会话持久化在 `data/sessions.json`（原子写入，重启自动恢复，详见 [会话与任务管理](../domain/session.md)），同样在 `data/` 下被 gitignore。定时任务的存储也在 `data/`：`schedules.json`（任务清单，支持热更新对账）、`schedule-runs.json`（运行记录，每任务保留最近 100 条）；审批与产品方案流程分别持久化在 `data/approval-flows.json` 与 `data/product-spec-flows.json`；bot 身份缓存写入 `data/bot-identities.json`（详见 [定时任务调度](../domain/scheduling.md) 与 [产品方案交付](../domain/product-spec.md)）。

## 日志与调试

应用运行时输出结构化日志：

```
Agent Team 启动，正在建立飞书长连接…
[配置] 已注册 2 个 bot，Team Leader=developer，已恢复 3 个会话
[CLI] id=claude command=claude
[CLI] id=codex command=codex
[Bot DEVELOPER] default_cli=claude workspace=/path/to/workdir
[Bot DEVELOPER] 已连接
[收到] chat=oc_xxx threadId= rootId= sender=ou_xxx
  原文: @_user_1 帮我看看
  还原: @MyBot 帮我看看
  mentions: @_user_1=MyBot(ou_xxx)
  [会话] 新建 id=uuid status=creating
[下载] image → data/downloads/img_xxx.png
[卡片] 已发送 message_id=om_xxx inThread=false
[CLI] claude 完成 session_id=claude-session-id
```

### 关键日志含义

| 日志 | 含义 |
|------|------|
| `[配置] 已注册 N 个 bot` | 从 `bots.json` 启用的 bot 数量、Team Leader 与恢复的会话数量 |
| `[CLI] id=... command=...` | 启动时打印已注册的执行引擎清单 |
| `[Bot XXX] 已连接` | 该 bot 的 WS 长连接建立成功 |
| `[收到]` | 收到飞书消息，含会话/话题/发送者信息 |
| `原文 vs 还原` | @ 提及还原前后对比 |
| `[会话] 新建/复用` | 按话题解析会话的结果与当前状态 |
| `[卡片] 已发送` | 初始卡片回复成功，获得 message_id |
| `[协作] task=... A -> B round=1/2` | 协作交接消息已投递：task 归属、来源与目标 bot、轮次（见 [多 bot 协作](../domain/collaboration.md)） |
| `[协作] 忽略非目标 bot 消息` / `[协作] 忽略重复消息` | 收件箱领取失败或轮次去重命中，协作消息被安全跳过 |
| `[澄清] 已发送交互卡片 questions=N` | CLI 发起 `request_clarification`，已转成飞书澄清卡片（见 [需求澄清](../domain/clarification.md)） |
| `[Skill] bot=... 找不到 <skill>` | 启动时该 bot 声明的 Skill 在五级候选路径（工作区 `.agents/skills` / `.claude/skills` 与全局 `~/.agents/skills` / `~/.claude/skills` / `~/.codex/skills`）都不存在，只告警不阻断 |
| `[定时] task=... succeeded / 执行失败` | 定时任务到期执行的结果（见 [定时任务调度](../domain/scheduling.md)） |
| `[定时] schedules.json 已热更新` | 文件对账检测到任务增删改并已应用到内存调度器 |
| `[API] 定时任务管理接口已启动` | 本地 HTTP 管理接口（默认 `http://localhost:3101/api/schedules`）已监听 |
| `[审批] 已展示审批卡 flow=...` | 开发者请求高危操作，已转成审批卡等待用户拍板（见 [高危操作审批](../domain/approval.md)） |
| `[产品文档] 已展示待确认产物` | 产品方案确认卡已发出（见 [产品方案交付](../domain/product-spec.md)） |
| `[产品评论]` | 待确认方案的评论区评论处理（忽略 / 排队 / 失败回写） |
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
