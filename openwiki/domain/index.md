# Files

- [AI CLI 输出解析](ai-cli-probe.md) - Claude Code 和 Codex headless 模式的 JSON 事件流结构对比，以及 probe-cli.ts 解析工具的工作原理
- [高危操作审批](approval.md) - request_approval 工具闭环——stopToolNames 立即停止 CLI、审批卡与超时自动拒绝、决定经卡片回调回传后沿原 CLI 会话续跑
- [多 bot 注册](bot-registry.md) - config/bots.json 注册多个飞书 bot——zod 校验、凭证环境变量解析、默认执行引擎与工作目录优先级、systemPrompt 拼接、每个 bot 独立长连接与会话隔离
- [需求澄清](clarification.md) - request_clarification 工具闭环——CLI 经 stdio MCP 提交结构化问题、应用层截获 tool_call 转飞书卡片逐题收集答案、答案拼回 prompt 续跑、多轮追问与话题新消息作废旧卡片
- [多 bot 协作](collaboration.md) - dispatch_task 工具与 CollaborationService 派发——taskId/dispatchId/round 交接模型、CollaborationInbox 取件码领取、飞书重推去重、轮次上限与完成后的路由分支
- [产品方案交付](product-spec.md) - request_spec_approval 唯一产物提交——local/lark-doc 两种交付模式、落盘校验与重跑兜底、用户确认卡，以及飞书云文档评论区 @bot 触发的方案修订流
- [定时任务调度](scheduling.md) - once/interval/cron 三类调度规则、Scheduler 内存计时器 + schedules.json 热更新对账、运行记录持久化与重启补账、schedule_manage 工具与本地 HTTP 管理接口
- [会话与任务管理](session.md) - 话题级会话状态机（creating/active/idle/closed）、JSON 持久化与重启恢复、斜杠命令、运行中任务登记与停止任务权限校验
- [任务卡片系统](task-card.md) - 飞书交互卡片的构建逻辑、四种任务状态、工具级进度渲染、超长回答折叠与续发，以及 ThrottledCardUpdater 节流刷新机制
