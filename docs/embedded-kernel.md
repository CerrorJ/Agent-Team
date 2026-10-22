# 嵌入式内核 M1 开发版

正式开发授权日期：2026-10-22。独立飞书服务仍使用 `pnpm start:once`，
其入口、配置及生产数据未迁移。嵌入入口不加载该配置，不提供飞书连接能力。

`createKernel({dataDirectory, sourceCommit, onEvent})` 显式打开独立 SQLite 数据目录。
协议 1、内核 0.2.0、schema 2；支持 handshake、health、events、shutdown，
以及 workspace.snapshot / command / run / delivery。项目、角色版本、Task/Run、
单 Codex 执行、隔离 worktree、停止/重试、交付/验收已经接入共享应用入口。
团队、飞书和技能尚未接入，不在能力清单中。当前仍在桌面联调与阶段验收。
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
本阶段不声称原独立飞书入口已与嵌入模式共享新对象；渠道统一在 M3 验证。
从 schema 1 升级前，使用 SQLite VACUUM INTO 保存一致备份；旧内核拒绝 schema 2。
默认测试不调用付费模型；真实 CLI 集成单独执行并记录。未知旧进程保留待确认，不自动重放。
