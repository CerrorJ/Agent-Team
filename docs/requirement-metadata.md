# 需求优先级与业务阶段（0.10.0开发候选）

2026-10-27。按固定原型c29扩展唯一内核的需求版本：优先级low/medium/high；阶段needs_clarification、awaiting_confirmation、plan_confirmed、implementing。阶段是所有者记录的需求意图，不代替人工请求决定、CLI执行、调度或交付验收；没有根据任务数量自动推断阶段。

`requirement.save`复用已有事务、版本CAS及幂等回执。新字段严格枚举，可显式null清除。旧渠道省略字段时继承上一版本已记录值；旧版本从未设置则保留缺省，不向历史需求、事件或Run补造medium/待澄清。每次修改仍追加需求版本，旧Task引用及Run快照不改写。

数据schema递增9：新旧需求JSON键兼容读取，但旧内核不能读新写入字段，故通过版本门禁拒绝回退。沿用迁移前一致性备份；v9迁移只提升门禁，不更新历史JSON。只读备份预览继续支持schema7/8/9，schema8备份源字节不变，仅恢复副本启动后升级。协议1不变，握手新增requirement-metadata能力；内核版本0.10.0须形成新的固定提交/产物，不覆盖094。

当前strict/lint/格式、164回归、原独立服务构建与嵌入内核构建通过。新增4项覆盖缺省/继承/null、旧Task与受控终态Run原始JSON、严格枚举/CAS/幂等、事件写失败的版本/outbox/回执整体回滚、schema8迁移/备份/重启/只读恢复。原角色schema7迁移回归继续运行到当前schema，未修改已发布的v8迁移。初轮新备份夹具缺少生命周期events表而被既有完整schema校验拒绝；修正测试夹具后通过，未降低备份校验。

独立Windows内核Tester PASS：7定向和5组真实JSON/Node IPC探针、7个自有子进程正常exit0；用固定094产物实际创建schema8与归档后验证升级9、预迁移备份8、094拒读9且DB摘要不变。跨094旧命令key重放/冲突、事件失败22表整体不变后同key显式重试、旧Task/受控Run/未来pending Human原始JSON不变、无human.decided且executeCalls=0。受控历史夹具不冒称模型执行。Reviewer独立24相关测试与类型/规范/源码及构建SHA核对后APPROVE，无P0—P3。两者只写ignored证据，未修改实现。

本源码通过后形成新提交/干净固定产物；桌面接入、真实飞书联调和整体M2/M4仍另验。复现：`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`、`pnpm build:kernel`。定向使用`pnpm exec tsx --test tests/requirement-metadata.test.ts tests/requirement-schema-migration.test.ts tests/role-schema-migration.test.ts`。
