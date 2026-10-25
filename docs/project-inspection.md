# 项目仓库只读检查（0.9.2 开发中）

基于091/aaee源码及f5ebff0关联文档，在`feat/project-inspection`实现`workspace.project.inspect`，协议1/schema8不变，增加`project-inspection`握手能力。新查询仅接受已保存projectId，不接收路径或Git参数；返回格式1、项目版本、检查时间、已登记工作区及当前脱敏origin，Git成功时分别提供默认/当前提交与当前分支（分离HEAD为null）、脏状态，无法确认时明确unavailable及稳定码。

Git检查在业务事务外，只读不写项目/Run/游标/回执。与原工作区共用根路径/分支验证、URL脱敏和Git原生命令执行；执行用默认15秒及raw/input语义保留，新查询的Git子命令共享8秒剩余预算，采用单调时钟，不因系统校时或某一步重新获得完整时限；文件系统读取本身没有取消事务，不能宣称所有外部I/O天然在8秒内原子完成。禁用fsmonitor和可选索引写锁，不经shell、不访问网络、不重置/暂存/提交。检测到HEAD/默认基准在检查期间变化时不拼接verified结果。Git不是跨命令事务；瞬时快照不能授权执行，开始任务仍会重新预检。

根代理4项真实Git/协议专项、157项完整、strict/lint/规模/格式及原独立飞书服务/内核构建通过；首次新增测试有TS断言缩窄后的冗余分支，已删除后全量157通过。最终改用单调时钟后根4专项/lint通过，独立Tester与Reviewer分别12项专项/类型/规模/格式通过，最终PASS/APPROVE，无新增P0—P3；157属于时钟修改前，不冒称最终全量重跑。独立真实文件SQLite多项目22表、Git全文件/索引SHA保持不变；真实Git期间墙钟±1h不影响预算递减，受控HEAD/默认变化不形成verified，真实有界Node超时及实际构建embedded入口IPC查询/ACK/stopped/exit0均分别留证，受控端口不冒充真实Git整树终止证明。

下一步从干净提交形成092锁定产物再验收桌面；本增量尚无远端CI。本机Git传输/备用连接器写权限阻塞沿用[091记录](cli-input-lifecycle.md)，继续本地开发不将其写成新设备可获取或发行成功。Windows专项和受控Git端口不是macOS用户设备或真实CLI证明。复现`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm test`、`pnpm build`、`pnpm build:kernel`；定向`node --import tsx --test tests/project-inspection.test.ts tests/task-preflight.test.ts tests/project-preflight-edges.test.ts`（以仓库实际用例文件为准）。
