# Claude Code 与 Codex：Headless 输出结构对比

横向对照两者在 headless（无界面）模式下的事件与字段结构，便于做统一封装。

| 概念 | Claude Code | Codex |
| ------ | ------------- | ------- |
| 会话标识 | `session_id`（出现在 `init` 事件） | `thread_id`（出现在 `thread.started` 事件） |
| 模型文本输出 | `assistant` 事件 | `item.completed` + `agent_message` |
| 执行命令 | `tool_use` 内容块 | `item.completed` + `command_execution` |
| 结束信号 | `result` 事件 | `turn.completed` 事件 |
| 成本信息 | `total_cost_usd`，直接给出金额 | 只给 token 用量，金额需自行折算 |
| 续接会话 | `--resume <id>` 参数 | `exec resume <id>` 子命令 |
