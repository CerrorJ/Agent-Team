<!-- OPENWIKI:START -->

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with `openwiki/quickstart.md`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->

## 纬舟 WeftPilot 内核协同开发

- 用户已明确指定：Agent-Team 打包作为纬舟桌面产品的内核。Agent-Team 继续维护内核唯一源码和共享协议，纬舟消费锁定版本的产物，不复制或重写一套执行内核。
- 用户已授权：开发纬舟时，如 Agent-Team 需要修改，可以同步修改。正常的内核解耦、嵌入式入口、命令/事件、持久化、跨平台兼容、测试和打包无需逐项重复询问。
- 保留现有独立飞书服务入口；抽出的内核不依赖 Electron/React，不应在导入时自动建立飞书连接，嵌入模式允许无飞书配置启动。
- 角色/团队、项目/需求/任务、Run、调度、审批、CLI、Git、Skill、交付与业务持久化属于本仓内核；窗口、托盘、页面、凭据系统桥接和内核宿主属于纬舟。
- 两仓分别保护已有改动、提交和测试，记录关联提交、协议版本与内核产物；先形成可追踪内核，再更新纬舟锁定版本。发行不得依赖未提交的相邻目录源码。
- 首版覆盖 macOS、Windows。关闭窗口可继续执行，完全退出应用时停止并确认在途进程；原生兼容和打包后运行分别验证。
- 适量中文注释解释公共接口、事务/锁、状态机、恢复和平台差异的原因与边界，不逐行翻译直白代码；遵循单一职责、可读性与明确副作用边界。
- 联动新增代码按纬舟开发规范控制规模：普通源码最多 300 有效行且 500 物理行，函数最多 50 有效行，嵌套最多 3 层、圈复杂度最多 10、参数最多 4 个。测试/生成代码有精确例外；历史大文件按基线和修改范围渐进治理，不做无关全仓重构。
- 保证数据库命令与事件/幂等回执的事务原子性；文件更新和安装先验证再切换。跨进程、网络与两仓提交通过幂等、对账、补偿和兼容发布衔接，不能假定天然原子。
- 架构与详细规范：[纬舟内核集成方案](https://github.com/CerrorJ/weftpilot/blob/main/docs/architecture/kernel-integration.md)、[开发规范](https://github.com/CerrorJ/weftpilot/blob/main/docs/development/standards.md)。当前架构/规范整理在设计设备完成，正式业务开发由另一台设备的 Codex 按用户开发指令开展。
- 同步改源码不等于切换生产服务，不默认修改真实配置、凭据、运行数据或飞书应用。OpenWiki 生成区保持由工作流维护，不手工改写。
