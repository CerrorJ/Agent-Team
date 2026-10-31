# 纬舟macOS通知无凭据对照关联

2026-10-31，桌面`fix/macos-notification-probe/83006e419fabea9611a263e2b135280fae5bd1c7`只增诊断CI、原生测试探针及交接，不改产品源码或本仓内核。当前运行产物仍固定`73b4498966954b64b1d622ba50fb983a3e62ce2f / 0.13.1 / protocol1 / schema12 / 143文件`，归档SHA-256 `d9ce0b501f1d025559a6888d882b6fb9db8b0335eee2d009f44111312d1a402d`，不从本docs HEAD重打旧版本。

原6b35官方Mac通知test.failed保留。固定Electron42原文要求Mac应用签名；本轮将原.app复制到自有RUNNER_TEMP，同一路径记录签名前身份/有效性与原生反馈，再以无证书`codesign --sign -`对临时副本作ad-hoc开发签名。保留执行entitlements/flags，签后strict校验及dist全文件SHA对比，真正shown才接受签后正例。不触默认发行包、正式签名凭据、已安装应用或线上服务，不将开发签名当Developer ID或发行验收。

当前Windows探针真实shown/空业务不变/正常退出，独立Tester记录七个PID/CreationDate终态缺席，四资源/四锁/143文件摘要通过，随后Reviewer限定APPROVE。验证中发现的shell管道掩盖codesign退出码问题已通过显式bash/pipefail修正；不是通知产品源码缺陷。Root另用未改6b35包真实Codex/Claude人工等待重启、同Run续接与人工验收2/2通过，不等于真实飞书或全部审批类型通过。

[原生对照41184747174](https://github.com/CerrorJ/weftpilot/actions/runs/41184747174)及[常规双平台41184747138](https://github.com/CerrorJ/weftpilot/actions/runs/41184747138)已触发，结果待独立核验，不能预写ad-hoc有效。后续原始JSON、签名信息、payload摘要与退出证据以确切提交为准；Mac用户设备、横幅/点击、正式签名/公证、真实租户及发行继续待验。原独立飞书服务入口与生产配置不变，生成OpenWiki未编辑。
