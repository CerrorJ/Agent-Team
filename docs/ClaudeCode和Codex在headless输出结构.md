概念 Claude Code Codex
会话标识 session_id（init 事件里） thread_id（thread.started 里）
模型说话 assistant 事件 item.completed + agent_message
执行命令 tool_use 内容块 item.completed + command_execution
结束信号 result 事件 turn.completed 事件
成本信息 total_cost_usd 直接给钱 只给 token 用量，钱要自己算
续接会话 --resume <id> 参数 exec resume <id> 子命令
