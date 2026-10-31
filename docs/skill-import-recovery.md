# 纬舟技能手动恢复关联

2026-10-31，桌面`feat/skill-import-recovery/ded64b677604ee4f2b30520b286c71c66455b874`已推送。失败详情增加显式按原来源版本重下，仍只调用本仓现有skill.import用例：创建新UUID，固定旧source id/version/目录/许可证路径，保留原失败，不自动使用同名来源最新版本，不自动安装或继承许可同意。UI本地回执不成为权威下载状态，内核继续拥有全部业务裁决。

本仓源码、协议、schema、生成OpenWiki及原独立飞书入口不改。运行产物仍`73b4498966954b64b1d622ba50fb983a3e62ce2f / 0.13.1 / protocol1 / schema12 / 143文件`，归档SHA-256 `d9ce0b501f1d025559a6888d882b6fb9db8b0335eee2d009f44111312d1a402d`，不从docs HEAD重打版本。

Root最终Win包恢复2项2P（9796ms），含真实公共下载/显式许可安装/重启，旧failed和source版本不变，0Run；初始429与截断tree是受控kernel fixture，不冒实际GitHub限流证明。严格检查、71单元/9装配及相关4P1跳过通过。独立Tester14项PASS，实际agent-browser双击仅一个新UUID、原v1不随已有v2变、未同意安装不写入、显式安装后三文件字节/SHA吻合、重启完整快照深等，三个应用周期正常退出。随后独立Reviewer限定APPROVE；新确切提交CI待验，不能套本机或旧e9f结果。

旧e9f Mac来源SKILL_DOWNLOAD_RATE_LIMITED、02f通知波动、Keychain/Windows未知现场与用户设备发行条件继续保留；新入口不是这些根因已经修复。桌面复现与限制见`docs/development/skill-import-recovery.md`。
