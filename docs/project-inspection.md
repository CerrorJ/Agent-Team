# 项目仓库只读检查（0.9.2 Windows限定验收）

关联更新：内核实现`2925140575fc153e53eda82c11ce849d2e686b31`，文档修正后的固定源`3910834419f87287f398cb732a00d3540cd49f1a`，0.9.2/p1/schema8/131文件，tar SHA-256 `a450e82fae3cd1bfe8bad1970edda2c6d1fcc98e84d9c9017da92f0923ca5d20`。两份干净提交重建一致，桌面已固定产物；最终锁定源码157/157通过，包含最终单调时钟实现。纬舟关联本地提交`de97647223eba89918b282bb8ff169b28b589d0d`（`feat/project-overview`），44单元/7装配、功能修复实际包38通过16跳过，之后仅英文表头字典修正由最终包独立定向关闭，不冒称最终包全量重跑。

桌面独立Tester19断言PASS、Reviewer APPROVE；真实Git/项目/任务创建、文件与索引保护、重启/正常退出分别留证，历史Run投影与迟到回执门控明确属于受控夹具，092没有新增模型调用。两仓推送仍受本机Git传输及备用连接器403阻塞；Electron官方缓存与官方发行asset大小/摘要一致后仅本机离线装配，尚无远端CI、Mac真实CLI/用户设备或新正式身份安装器结论。本文关联更新属于文档提交，不生成或替换092产物；客户端继续锁定3910834。以下为原源提交验证时点。

基于091/aaee源码及f5ebff0关联文档，在`feat/project-inspection`实现`workspace.project.inspect`，协议1/schema8不变，增加`project-inspection`握手能力。新查询仅接受已保存projectId，不接收路径或Git参数；返回格式1、项目版本、检查时间、已登记工作区及当前脱敏origin，Git成功时分别提供默认/当前提交与当前分支（分离HEAD为null）、脏状态，无法确认时明确unavailable及稳定码。

Git检查在业务事务外，只读不写项目/Run/游标/回执。与原工作区共用根路径/分支验证、URL脱敏和Git原生命令执行；执行用默认15秒及raw/input语义保留，新查询的Git子命令共享8秒剩余预算，采用单调时钟，不因系统校时或某一步重新获得完整时限；文件系统读取本身没有取消事务，不能宣称所有外部I/O天然在8秒内原子完成。禁用fsmonitor和可选索引写锁，以参数直接调用Git，不主动执行远端Git命令或重置/暂存/提交。检测到HEAD/默认基准在检查期间变化时不拼接verified结果。Git不是跨命令事务；瞬时快照不能授权执行，开始任务仍会重新预检。

根代理4项真实Git/协议专项、157项完整、strict/lint/规模/格式及原独立飞书服务/内核构建通过；首次新增测试有TS断言缩窄后的冗余分支，已删除后全量157通过。最终改用单调时钟后根4专项/lint通过，独立Tester与Reviewer分别12项专项/类型/规模/格式通过，最终PASS/APPROVE，无新增P0—P3；157属于时钟修改前，不冒称最终全量重跑。独立真实文件SQLite多项目22表、Git全文件/索引SHA保持不变；真实Git期间墙钟±1h不影响预算递减，受控HEAD/默认变化不形成verified，真实有界Node超时及实际构建embedded入口IPC查询/ACK/stopped/exit0均分别留证，受控端口不冒充真实Git整树终止证明。

下一步从干净提交形成092锁定产物再验收桌面；本增量尚无远端CI。本机Git传输/备用连接器写权限阻塞沿用[091记录](cli-input-lifecycle.md)，继续本地开发不将其写成新设备可获取或发行成功。Windows专项和受控Git端口不是macOS用户设备或真实CLI证明。复现`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm test`、`pnpm build`、`pnpm build:kernel`；定向`node --import tsx --test tests/project-inspection.test.ts tests/task-preflight.test.ts`。
