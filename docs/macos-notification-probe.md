# 纬舟macOS通知无凭据对照关联

2026-10-31，桌面`fix/macos-notification-probe/83006e419fabea9611a263e2b135280fae5bd1c7`只增诊断CI、原生测试探针及交接，不改产品源码或本仓内核。当前运行产物仍固定`73b4498966954b64b1d622ba50fb983a3e62ce2f / 0.13.1 / protocol1 / schema12 / 143文件`，归档SHA-256 `d9ce0b501f1d025559a6888d882b6fb9db8b0335eee2d009f44111312d1a402d`，不从本docs HEAD重打旧版本。

原6b35官方Mac通知test.failed保留。固定Electron42原文要求Mac应用签名；本轮将原.app复制到自有RUNNER_TEMP，同一路径记录签名前身份/有效性与原生反馈，再以无证书`codesign --sign -`对临时副本作ad-hoc开发签名。保留执行entitlements/flags，签后strict校验及dist全文件SHA对比，真正shown才接受签后正例。不触默认发行包、正式签名凭据、已安装应用或线上服务，不将开发签名当Developer ID或发行验收。

当前Windows探针真实shown/空业务不变/正常退出，独立Tester记录七个PID/CreationDate终态缺席，四资源/四锁/143文件摘要通过，随后Reviewer限定APPROVE。验证中发现的shell管道掩盖codesign退出码问题已通过显式bash/pipefail修正；不是通知产品源码缺陷。Root另用未改6b35包真实Codex/Claude人工等待重启、同Run续接与人工验收2/2通过，不等于真实飞书或全部审批类型通过。

[原生对照41184747174](https://github.com/CerrorJ/weftpilot/actions/runs/41184747174) attempt1 exact83006e限定PASS/独立Reviewer APPROVE。baseline并非完全无签名：实际Identifier=Electron/linker-ad-hoc，Info未绑定、资源未密封、strict失败；本地应用级重签后io.weftpilot.desktop/有效adhoc/strict通过/原生shown，157载荷与143内核不变。只证明该runner开发重签对照有效，不是必须使用正式证书，也不等于默认包、Keychain、横幅/点击或用户设备已修。专用一ZIP/七成员与原始日志摘要/CRC/字节核验完成，无逐PID声明。

[常规双平台41184747138](https://github.com/CerrorJ/weftpilot/actions/runs/41184747138)实际整体FAIL：Win成功、Mac包内59通过2失败18跳过，失败为Keychain保存及返回项目焦点；Mac开发61通过18跳过，来源专项因失败未执行。独立Tester/Reviewer核七ZIP/58PNG摘要，Tester仅实际看八设置图、Reviewer另看两图，不借旧60全看。失败元数据仅描述时点，不定根因，不把专用对照成功混入整轮。桌面事实docs `0df375f4340a6f237ce911373ac7a740b9a2ddbd`已推送，下一分支继续修默认Mac开发包身份/归焦与开发系统凭据隔离。

Root另外在匿名tree限流重置、同一固定URL由403/remaining0变为200/remaining41后定向复验，原6b35 Windows包真实技能3/3通过，含Codex/Claude固定资源逐字节交付；先前0P3F限流日志保留，不算模型已经执行。当前运行内核不变，Mac用户设备、横幅/点击、正式签名/公证、真实租户及发行继续待验。原独立飞书入口与生产配置不变，生成OpenWiki未编辑。
