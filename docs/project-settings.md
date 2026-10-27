# 项目配置与固定执行上下文（0.11.0）

2026-10-27。纬舟按固定原型扩展唯一内核的项目目标、描述和默认团队；仓库路径、Git地址及默认分支不属于配置更新命令。`project.configure`必须提交全部可编辑字段及expectedVersion，CAS拒绝过期修改；项目JSON、完整版本事件、outbox和幂等回执同一事务提交。每次修改版本加一；历史事件保留配置修订，不创建第二份权威项目状态。文本允许空字符串清空，默认团队只接受有效UUID或明确null，不规范化空白ID。`project.create`可选配置同事务保存，旧命令省略字段仍缺省并保持原幂等摘要。

默认团队绑定稳定团队ID。计划创建需明确expectedTeamVersion，新客户端同时提交expectedProjectVersion；核验后固定当前teamSnapshot。团队或项目后续更新不改旧计划。配置团队只验证对象存在，不启用角色、不执行任务、不改变已有任务或审批。

新Run在创建事务中保存projectContextSnapshot，包含项目ID、版本、名称及已提供的目标/描述/默认团队。任务提示只使用该固定上下文，不在执行或审批续接时查询实时项目；重试新建Run并捕获新上下文。角色试运行不注入项目上下文。提示不包含原仓库路径；未设置目标或描述时不增加项目上下文段落。配置变更也参与已有预检指纹，旧预检必须重新核对。

协议1，新增project-settings能力，内核0.11.0，数据schema10。旧内核严格解析不识别新Project/Run键，因此提高读取门禁。保留已发布v8/v9迁移语句，v10只提升门禁；升级前一致性备份，历史Project、Task、Run及事件不补写。备份7/8/9/10继续只读预览与恢复，恢复副本启动后才升级。

修复前独立Reviewer发现真实Git创建结果多带baselineCommit，strict项目契约拒绝创建；保留首次失败证据，已显式仅取repositoryPath/gitUrl并增加真实Git回归。修后最终170项内核回归、类型、lint/规模、格式及原独立飞书服务构建通过；包含schema9专项迁移/恢复和旧JSON逐字节核对。独立Tester真实JSON/Node IPC探针通过：以固定0100产物创建schema9库、升级前备份9、旧Project/Run SQL字节不变、22表回滚/重放、过期预检拒绝且executeCalls=0、团队/项目CAS、旧0100拒读10且数据库SHA不变、备份9只读预览及恢复副本升级10且源SHA不变；7个自有子进程均自然exit0。受控终态历史不冒称模型执行，旧反馈字段的读取默认值与原始JSON分别断言。独立审查保留首轮P1及修后关闭证据，最终结论记录于固定产物关联。此处不宣称真实CLI、飞书联调、桌面与整阶段验收完成。

独立Reviewer最终APPROVE，首轮P1已关闭，无未关闭P0—P3；亲自运行18个不同相关用例、真实Git复现修后及预检/固定Run探针，最终类型/规模/lint/格式通过。该结论仅覆盖内核源码，不继承为桌面、干净产物或平台发行结论。

复现：pnpm12.3.4，`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`；定向使用`pnpm exec tsx --test tests/project-settings.test.ts tests/project-create-settings.test.ts tests/project-schema-migration.test.ts tests/task-preflight.test.ts`。固定源码/摘要及桌面关联在独立测试与审查通过后记录，不覆盖0.10.0产物。

## 固定产物与桌面开发候选

固定源码`c960f484c706101410863e12349ba8341abe1f6b`已先提交推送，干净检出构建并从桌面隔离检出重复重建：0.11.0/protocol1/schema10/134文件，`weftpilot-agent-team-kernel-0.11.0.tgz` SHA-256 `b47da834a73b4e85b1bf3318cccad06184e2180f09450f04e04204f50e0979c9`一致。后续本关联文档HEAD不替代c960，不得在文档HEAD重建覆盖0110。

桌面候选`7b2954b52d2d0ad219e8575cdee26e93a40a73ac`锁定该产物，实际包内外manifest/lock和134文件逐SHA一致。strict/lint/格式、51单元、8装配通过；新增只读Run上下文之前的开发/实际包完整64项各47通过17条件跳过。两轮实际Windows CLI文件测试分别1/1通过，第二轮还实际打开历史快照确认旧项目UUID、不显示后续目标，执行成功仍待验收。模型测试为明确opt-in，CI跳过不算真实模型成功。

最终只读展示包追加完整回归出现两项Windows崩溃弹窗、尚未正常退出，不能记作通过；保留现场/日志并独立只读诊断，未指定根因、未强杀换绿。新[原生CI40442209173](https://github.com/CerrorJ/weftpilot/actions/runs/40442209173)及独立桌面Tester/Reviewer仍进行。此关联只记录已知事实，不将内核通过继承为桌面平台验收；M0—M4及飞书/用户设备/签名发行仍有未验项。

随后7b的该CI双平台SUCCESS：Win170核心/51单元/8装配，Mac160核心+10平台跳过/51单元/7装配+1平台跳过，各开发/实际应用64项47通过17明确跳过0失败0取消，未签名NSIS及ARM64 DMG/ZIP/blockmap装配通过。独立桌面Tester/Reviewer核真实GUI、13源/5包、两完整日志及16PNG/官方摘要后限定PASS/APPROVE，原清除团队导致草稿卸载的P2关闭；模型专项在CI跳过，真实上下文模型仍依据各自两轮本机文件/历史UI专项。该结果不关闭本机两个停止工作窗口及未结束的完整轮：只读库无Run/执行片段且记录kernel.stopped但主进程仍在；CrashSender错误与WeType/CrashRpt模块共存不证明因果，未取得相应事件1000/1001。保持现场与稳定性PENDING，整体M0—M4不封板。
