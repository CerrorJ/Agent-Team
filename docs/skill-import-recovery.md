# 纬舟技能手动恢复关联

2026-10-31，桌面`feat/skill-import-recovery/ded64b677604ee4f2b30520b286c71c66455b874`已推送。失败详情增加显式按原来源版本重下，仍只调用本仓现有skill.import用例：创建新UUID，固定旧source id/version/目录/许可证路径，保留原失败，不自动使用同名来源最新版本，不自动安装或继承许可同意。UI本地回执不成为权威下载状态，内核继续拥有全部业务裁决。

本仓源码、协议、schema、生成OpenWiki及原独立飞书入口不改。运行产物仍`73b4498966954b64b1d622ba50fb983a3e62ce2f / 0.13.1 / protocol1 / schema12 / 143文件`，归档SHA-256 `d9ce0b501f1d025559a6888d882b6fb9db8b0335eee2d009f44111312d1a402d`，不从docs HEAD重打版本。

Root最终Win包恢复2项2P（9796ms），含真实公共下载/显式许可安装/重启，旧failed和source版本不变，0Run；初始429与截断tree是受控kernel fixture，不冒实际GitHub限流证明。严格检查、71单元/9装配及相关4P1跳过通过。独立Tester14项PASS，实际agent-browser双击仅一个新UUID、原v1不随已有v2变、未同意安装不写入、显式安装后三文件字节/SHA吻合、重启完整快照深等，三个应用周期正常退出。随后独立Reviewer限定APPROVE；新确切提交CI待验，不能套本机或旧e9f结果。

旧e9f Mac来源SKILL_DOWNLOAD_RATE_LIMITED、02f通知波动、Keychain/Windows未知现场与用户设备发行条件继续保留；新入口不是这些根因已经修复。桌面复现与限制见`docs/development/skill-import-recovery.md`。

## ded64实际CI与审批补验

桌面[Desktop41200634442](https://github.com/CerrorJ/weftpilot/actions/runs/41200634442) attempt1/head ded64，两平台SUCCESS。固定本仓73产物回归Win189P、Mac179P10平台跳过；桌面71单元、装配Win9P/Mac8P1平台跳过；每平台开发/实际包82项63P19明确跳过、公共技能5项3P2真实CLI跳过，0F0取消。Mac原始native outcome success；不是仅凭continue-on-error后的conclusion。六官方ZIP/70PNG/四有限JSON已独立核元数据，实际看八代表图；新Mac157 aggregate仅核sidecar声明和本轮归属，未上传完整payload供独立重建。Win名为installed的图仍显示安装中，不据文件名证明最终态；成功安装和重启依据passed case的原始严格断言。最终CI Reviewer补审另记，不提前宣称。

Root另在同一最终Win包用现有Codex执行真实方案确认及单次操作审批，1批含两场景1P/exit0、88736ms：等待重启、错误版本与已决定请求拒绝、同Run/attempt1和角色权限快照不变、UTF-8文件trim后匹配、交付先待验再显式验收完成。原临时记录器误按Acceptance.runId汇总为空，保留原记录；改deliveryId后另跑，核恰一条accepted及完整阶段快照。独立Tester只读核此证据，不冒称独立GUI/模型重跑或CI覆盖，详见桌面`docs/development/approval-continuation-validation.md`。本仓业务源码、协议、生成页和锁定产物仍不变。

最终桌面CI独立补审为Tester限定PASS、Reviewer限定APPROVE，Reviewer另核官方元数据/全文日志/六ZIP及四张代表图，审批两类快照关系作只读审核；前述“补审另记”为报告前时点。两仓文档分别在桌面`docs/skill-recovery-validation`与本仓`docs/skill-import-recovery`提交推送；不合并、不发布，不从docs HEAD重打内核。
