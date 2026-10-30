# 纬舟工作台与窗口菜单接入

2026-10-30，本记录仅关联桌面增量，不改内核源码、原独立飞书入口或既有数据。

桌面`feat/workbench-overview/ab82b4aa483f8d779deb382225019fd0b9de1c23`已推送，独立Windows实际包GUI与后续代码审查限定PASS/APPROVE。工作台按固定c29呈现真实概览、独立待处理/近期、项目卡片与确切UUID入口；顶部窗口菜单按用户新要求移除，托盘打开/完全退出保留原停止确认。桌面只读共享快照，不另建任务状态或数据库写入；角色试运行不计入业务列表，失败/未知/验收状态分开。

运行产物仍锁定本仓源码`73b4498966954b64b1d622ba50fb983a3e62ce2f / 0.13.1 / protocol1 / schema12 / 143文件`，归档`weftpilot-agent-team-kernel-0.13.1.tgz`，SHA-256 `d9ce0b501f1d025559a6888d882b6fb9db8b0335eee2d009f44111312d1a402d`。宿主额外artifact-lock不混算正规文件；本docs HEAD不作为重打旧版本的来源。

[桌面CI40986263270](https://github.com/CerrorJ/weftpilot/actions/runs/40986263270) attempt1 exactab82双平台SUCCESS：Win核心189/单元61/装配8，Mac核心179通过10平台跳过/单元61/装配7通过1跳过；两平台开发和实际包各76项59通过17明确跳过，实际公共来源各1通过2CLI跳过，未签名NSIS和ARM64 DMG/ZIP装配通过。两工作台新用例四处通过，受控交付executor仍不是真实CLI证明。

独立CI Tester核官方日志、四ZIP摘要/大小及52张新图；Reviewer另核官方run/jobs/logs、缓存ZIP与两张图后批准限定事实，不冒称重复查看全52图。桌面`docs/workbench-validation/f017ece`汇总完整来源和限制，原048包侧栏失败/5ff与e4等Mac失败保留；本轮Mac备份加密通过仅属未复现，不关闭旧Keychain根因。用户安装升级、真实Mac CLI、飞书/自定义模型、签名/许可/更新仍单独验收，不等于整体M0—M4或公开发行完成。
