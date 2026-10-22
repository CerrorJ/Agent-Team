# 嵌入式内核 M0

正式开发授权日期：2026-10-22。独立飞书服务仍使用 `pnpm start:once`，
其入口、配置及生产数据未迁移。嵌入入口不加载该配置，不提供飞书连接能力。

`createKernel({dataDirectory, sourceCommit, onEvent})` 显式打开独立 SQLite 数据目录。
协议 1、内核 0.1.0、schema 1；仅支持 handshake、health、events、shutdown。
项目、角色、任务执行、审批与技能尚不在能力清单中，后续阶段增量接入现有执行器。
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
本阶段不声称原独立服务已与嵌入模式共享完整业务对象；该统一化在 M1—M3 完成。
