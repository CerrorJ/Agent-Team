# 任务执行前检查

2026-10-24从`c7366baff2ef9de2fbeefb4e4c07fb625c2e861c`建立`feat/task-preflight`。本增量内核0.7.0、协议1、数据schema8，新增`task-preflight`能力；没有修改持久化Role/Run格式，不需要数据迁移。纬舟仍锁定0.6.0，须在内核独立验收、提交及干净重建后另行更新。

## 查询与确认

`workspace.preflight`接收严格校验的`input: { operation: 'start' | 'retry' | 'team', id, expectedVersion }`。start指向任务版本，retry指向最新Run版本，team指向团队父任务版本。不接受任意命令、路径、身份或自动修复选项。

查询共用真实启动规则，读取Git根目录、默认分支基线、当前分支/提交、固定需求引用、角色版本/模型快照/技能/权限/并发和重试反馈；团队响应包含实际子任务及依赖边。分离头指针返回`currentBranch: null`。分支及执行目录只在创建真实Run后产生，预检不制造拟用UUID或假工作目录。

结果区分`passed`、`blocked`、`waiting`和`unverified`。角色未试运行启用、脏仓库、旧版本/旧Run、状态未知进程属于阻塞；项目/角色/本机槽位及依赖未验收属于排队等待。CLI只定位文件，版本、登录和实际模型调用明确未验证，历史试运行也不充当当前认证成功。预检不创建Run、事件、outbox、幂等回执、工作目录或Git改动，不连接飞书、不读取登录文件。

可启动结果携带64位SHA-256 `configurationFingerprint`。新的`run.start`、`run.retry`、`team.start`可附`expectedConfigurationFingerprint`；省略时保持旧客户端兼容。摘要覆盖操作/版本、项目、实际Git检查结果、任务完整数据、固定角色/需求快照和反馈；不包含易变的队列槽位，不构成授权或资源预留。

## 原子性及外部边界

实际命令在prepare阶段再次读取Git，账本事务内重读业务配置并比较摘要。变化返回`PREFLIGHT_CHANGED`，事务内不留下Run、事件、outbox或成功回执，桌面必须重新检查并由用户确认，不能静默改用最新角色。

Git进程在写事务外执行；SQLite、Git和外部CLI不构成原子事务。仓库可能在检查后继续变化，调度准备worktree时沿用真实脏文件/基线校验并报告失败，禁止reset、clean、隐式提交或覆盖用户文件。确认后每次重试仍创建新Run，审批续接仍使用原Run，不混用预检摘要与审批决定。

## 验证与剩余工作

最终新增7项状态/事务/Git/嵌入协议测试通过，完整默认127项通过，类型、lint/规模、原独立服务构建和内核构建通过。固定模型/需求历史引用、团队整批创建与失败回滚均有专项覆盖。

独立Tester通过最终7项及文件SQLite/真实Git/嵌入协议探针：重复预检全部SQLite表和完整`.git`字节不变、精确DAG依赖边、同提交切换detached使摘要失效、旧团队摘要拒绝且全表不变、Git来源敏感段脱敏、排队等待与未知进程阻塞区分。另保留相关调度/团队/重试10项回归，未将其冒充完整默认测试。独立Reviewer批准，无待修P0—P3，另行9项回归及类型/lint/规模检查全部通过。最终干净重建及桌面关联另记纬舟交接文档；桌面尚未接入，不把API存在描述成界面完成。

`CONFIGURATION_READY`仅表示固定版本、角色启用及技能引用元数据可用，不证明技能目录文件此刻完整；桌面不能将其显示为“技能完整性通过”，实际执行准备仍核对目录摘要。认证/版本/模型调用也不借用该状态宣称通过。

受控执行端口和受控角色就绪证明仅验证边界，不作为真实CLI认证、模型调用或飞书联调证据。

复现：`pnpm install --frozen-lockfile`，`pnpm typecheck`，`pnpm lint`，`pnpm test`，`pnpm build`，`pnpm build:kernel`；定向执行`pnpm exec tsx --test tests/task-preflight.test.ts`。使用仓库锁定pnpm12.3.4。原独立飞书入口未切换，生产配置、凭据及旧停止故障现场保持原样。
