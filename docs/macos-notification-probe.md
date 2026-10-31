# 纬舟macOS通知无凭据对照关联

2026-10-31，桌面`fix/macos-notification-probe/83006e419fabea9611a263e2b135280fae5bd1c7`只增诊断CI、原生测试探针及交接，不改产品源码或本仓内核。当前运行产物仍固定`73b4498966954b64b1d622ba50fb983a3e62ce2f / 0.13.1 / protocol1 / schema12 / 143文件`，归档SHA-256 `d9ce0b501f1d025559a6888d882b6fb9db8b0335eee2d009f44111312d1a402d`，不从本docs HEAD重打旧版本。

原6b35官方Mac通知test.failed保留。固定Electron42原文要求Mac应用签名；本轮将原.app复制到自有RUNNER_TEMP，同一路径记录签名前身份/有效性与原生反馈，再以无证书`codesign --sign -`对临时副本作ad-hoc开发签名。保留执行entitlements/flags，签后strict校验及dist全文件SHA对比，真正shown才接受签后正例。不触默认发行包、正式签名凭据、已安装应用或线上服务，不将开发签名当Developer ID或发行验收。

当前Windows探针真实shown/空业务不变/正常退出，独立Tester记录七个PID/CreationDate终态缺席，四资源/四锁/143文件摘要通过，随后Reviewer限定APPROVE。验证中发现的shell管道掩盖codesign退出码问题已通过显式bash/pipefail修正；不是通知产品源码缺陷。Root另用未改6b35包真实Codex/Claude人工等待重启、同Run续接与人工验收2/2通过，不等于真实飞书或全部审批类型通过。

[原生对照41184747174](https://github.com/CerrorJ/weftpilot/actions/runs/41184747174) attempt1 exact83006e限定PASS/独立Reviewer APPROVE。baseline并非完全无签名：实际Identifier=Electron/linker-ad-hoc，Info未绑定、资源未密封、strict失败；本地应用级重签后io.weftpilot.desktop/有效adhoc/strict通过/原生shown，157载荷与143内核不变。只证明该runner开发重签对照有效，不是必须使用正式证书，也不等于默认包、Keychain、横幅/点击或用户设备已修。专用一ZIP/七成员与原始日志摘要/CRC/字节核验完成，无逐PID声明。

[常规双平台41184747138](https://github.com/CerrorJ/weftpilot/actions/runs/41184747138)实际整体FAIL：Win成功、Mac包内59通过2失败18跳过，失败为Keychain保存及返回项目焦点；Mac开发61通过18跳过，来源专项因失败未执行。独立Tester/Reviewer核七ZIP/58PNG摘要，Tester仅实际看八设置图、Reviewer另看两图，不借旧60全看。失败元数据仅描述时点，不定根因，不把专用对照成功混入整轮。桌面事实docs `0df375f4340a6f237ce911373ac7a740b9a2ddbd`已推送，下一分支继续修默认Mac开发包身份/归焦与开发系统凭据隔离。

Root另外在匿名tree限流重置、同一固定URL由403/remaining0变为200/remaining41后定向复验，原6b35 Windows包真实技能3/3通过，含Codex/Claude固定资源逐字节交付；先前0P3F限流日志保留，不算模型已经执行。当前运行内核不变，Mac用户设备、横幅/点击、正式签名/公证、真实租户及发行继续待验。原独立飞书入口与生产配置不变，生成OpenWiki未编辑。

## 默认开发包修复关联

桌面`fix/macos-validation/78449e45c2ff8fe653dd0baeb5ec6b7b06867ed5`已独立Tester限定PASS、Reviewer限定APPROVE后推送：项目显式UUID在React提交后归焦，开发应用名称/默认目录与打包身份隔离，新Mac应用目录包执行无凭据ad-hoc/strict/实际Identifier及全dist载荷不变校验。显式hostLock只允许匹配宿主锁，正式安装器白名单/manifest不改；不将WindowsDPAPI或签名设计视为Keychain历史根因证明。

Windows初fc0主文件完整79项61P18S；补显式开发默认目录后最终1986主文件仅定向10项7P3CLI跳过及开发身份单项1P，独立补最终namespace/桥接/合成密文重启和69单元/9装配。两包renderer字节相同，旧完整结果不反套新main；未接管真实无TEST默认profile或旧现场。新[双平台41190049143](https://github.com/CerrorJ/weftpilot/actions/runs/41190049143)当前待完整核验，不继承此前绿色；本仓只记录关联，运行产物仍73/0.13.1/p1/schema12/143/d9，无需新版本或重打归档。

该确切78449 CI现双平台SUCCESS：Win内核189P/单元69P/装配9P，Mac内核179P10平台跳过/单元69P/装配8P1平台跳过；两平台各开发与实际79项61P18S/0失败0取消，公共来源1P2真实CLI跳过。Mac默认新应用目录strict及157载荷不变、强制probe与默认通知回执均shown，原归焦及备份原断言都真实通过；不证明历史Keychain或正式旧密文升级根因已关闭。六官方ZIP/60PNG元数据及四有限JSON已独立Tester核验，实际只看12代表图；随后独立Reviewer核官方来源/原断言/归档并另看两图，限定APPROVE。正式installer/manifest、横幅/点击、用户设备及真实默认profile未借此扩大验收，本仓原独立飞书入口和运行产物不变。
