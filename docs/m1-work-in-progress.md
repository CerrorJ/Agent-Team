# M1 基础草稿（未交付）

2026-10-22：纬舟 M0 的本机原生与打包验证通过后开始准备 M1。
随后发现 Agent-Team 实际为私有仓库，纬舟远端 Windows/macOS CI 缺少跨仓读取凭据。
当前先补齐 M0 授权接线，不宣布 M0 远端验收或 M1 通过。

本分支保存已写的 M1 草稿，避免交接依赖未提交文件；**没有接入嵌入入口，不更新纬舟锁定产物**。
纬舟仍消费 M0 源码提交 8a1491aeab5b6dd194083fb3b1e7a94afa1c3ce9。

## 已有基础与验证

- 项目、不可变角色版本、Task/Run、交付与验收的 Zod 合同。
- 独立领域状态约束：停止请求不等于已停止，终态不重置，未知进程状态禁止重试。
- SQLite 表、CAS、事务与命令幂等回执；状态、事件和 outbox 同事务提交。
- Git/worktree 适配器，中文/空格/# 路径测试，脏主目录阻塞并保留既有文件。
- CodexAdapter 新增显式受控策略，保留旧入口默认行为；新路径不 bypass，不写用户 MCP profile，忽略用户配置与规则文件。
- CLI 现有代码补充可选字段省略与匹配组校验，使内核构建保持 exactOptionalPropertyTypes/noUncheckedIndexedAccess。
- 当前 typecheck、lint、format:check、build:kernel 通过；41/41 默认测试通过。
- 人工执行的独立、合成输入 CLI 探针：Windows MXC 只读连通成功；受控 workspace-write 在临时测试仓库生成指定 hello.txt，内容匹配，并实际收到 session/tool/result/stats 事件。未把探针当作产品任务闭环。

## 尚未接入与已知待办

- kernel/protocol 未暴露 M1 命令，createKernel 尚未组装 WorkspaceStore、调度器或执行用例；桌面没有业务页面。
- LocalScheduler、run-execution、run-outcome 等是待完成的编排草稿，尚无完整集成测试和独立评审，不可作为已验证执行器发布。
- 必须补持久进程/执行片段证据、停止等待与进程树终止验证、停止/启动竞争、日志上限和脱敏，以及失败恢复的集成验证。
- 必须完善 schema 迁移/兼容握手，明确未实现/不支持能力，不让草稿表自动进入既有 M0 数据目录。
- 还需接入角色就绪/试运行约束、任务启动、重试新 Run、验收/退回和桌面真实流程；不以存储单测代替这些验收。
- M0 的专用 CI 凭据到位并完成远端验证后，再继续按阶段推进。M2—M4 未开始。

生成的 OpenWiki、生产配置、原服务 .env、数据和在线服务均未改动。
