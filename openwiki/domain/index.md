# Files

- [AI CLI 输出解析](ai-cli-probe.md) - Claude Code 和 Codex headless 模式的 JSON 事件流结构对比，以及 probe-cli.ts 解析工具的工作原理
- [多 bot 注册](bot-registry.md) - config/bots.json 注册多个飞书 bot——zod 校验、凭证环境变量解析、默认执行引擎与工作目录优先级、systemPrompt 拼接、每个 bot 独立长连接与会话隔离
- [需求澄清](clarification.md) - request_clarification 工具闭环——CLI 经 stdio MCP 提交结构化问题、应用层截获 tool_call 转飞书卡片逐题收集答案、答案拼回 prompt 续跑、多轮追问与话题新消息作废旧卡片
- [多 bot 协作](collaboration.md) - reviewBy 触发的 bot 间独立审查协作——taskId/dispatchId/round 交接模型、CollaborationInbox 取件码领取、飞书重推去重与轮次上限收尾
- [会话与任务管理](session.md) - 话题级会话状态机（creating/active/idle/closed）、JSON 持久化与重启恢复、斜杠命令、运行中任务登记与停止任务权限校验
- [任务卡片系统](task-card.md) - 飞书交互卡片的构建逻辑、四种任务状态、工具级进度渲染、超长回答折叠与续发，以及 ThrottledCardUpdater 节流刷新机制
