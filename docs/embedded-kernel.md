# 嵌入式内核 M4 开发版

正式开发授权日期：2026-10-22。独立飞书服务仍使用 `pnpm start:once`，
其入口、配置及生产数据未迁移。嵌入入口不加载该配置；飞书只通过另行显式绑定的专用应用连接，不自动连接已有服务。

`createKernel({dataDirectory, sourceCommit, onEvent})` 显式打开独立 SQLite 数据目录。
协议 1、schema 8（确切内核版本及提交见 manifest.json）；支持 handshake、health、events、shutdown，
以及 workspace.snapshot / command / run / delivery。项目、角色版本、Task/Run、
Codex/Claude 执行、隔离 worktree、停止/重试、交付/验收、对象版本和依赖团队已接入共享入口。
三类人工请求、同 Run 新段续接与飞书渠道适配已加入；真实飞书租户仍待专用凭据验证，不能以端口测试代替。
固定来源、技能预览/安装/卸载及Run副本已接入，详见[M4开发记录](m4-skills.md)。当前仍在桌面联调与阶段验收。
实例锁使用专用 SQLite 独占事务，关闭或进程死亡后释放；第二实例直接失败。
不允许指向旧服务 data 目录。导入模块没有飞书或进程启动副作用。

构建：`pnpm install --frozen-lockfile && pnpm build:kernel`。
产物 `dist-kernel/` 包含无第三方运行时安装依赖的 ESM bundle、协议类型、
来源 manifest 与许可说明；使用 Node 内建 SQLite，不引入额外原生 ABI 模块。
运行时要求 Node >=22.13 且提供 node:sqlite，桌面打包测试必须验证内嵌版本。
打包：先创建 artifacts 目录，在 dist-kernel 中执行 `npm pack --pack-destination ../artifacts`，避免根工程的 pnpm devEngines 限制。
正式消费必须从已提交的干净检出构建，锁定源提交和 tarball SHA-256。

校验：`pnpm build`、`pnpm lint`、`pnpm format:check`、`pnpm test`。
新增测试验证无飞书导入、输入拒绝、事件重启恢复、实例互斥与协议不兼容。
旧独立飞书入口仍保持兼容，不与新嵌入渠道共同消费同一应用事件或操作同一数据目录。
从旧 schema 升级前，使用 SQLite VACUUM INTO 保存一致备份；旧内核拒绝较新 schema。
默认测试不调用付费模型；真实 CLI 集成单独执行并记录。未知旧进程保留待确认，不自动重放。

0.8.0新增固定`kernel.cliCheck`版本/默认CLI账户状态检查；不调用模型、不自动登录，也不写角色就绪证明，详见[CLI检查边界](cli-inspection.md)。探针输出脱敏、限时限量及活内核内的进程归属/退出守卫不等于跨崩溃恢复，后者仍待补充。
