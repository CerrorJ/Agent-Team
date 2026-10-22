# 嵌入式飞书渠道增量（未完成真实租户验收）

开发版本 0.4.3 / 协议1 / schema6，分支 feat/human-workflows。新渠道完全在 Agent-Team 内核维护，桌面只持有系统加密密文与表单。原 src/index.ts 独立服务与 OpenWiki 不改，不加载/迁移旧生产配置或真实数据。

## 当前能力

`feishu.save` 通过共享命令回执事务保存应用、租户、唯一所有者 open_id、chat_id、启用状态及不可变密文引用；不保存 secret。版本 CAS 防止覆盖新绑定。`feishu.connect/disconnect/status` 显式控制专用 SDK 长连接，不自动连接线上应用。凭据通过私有宿主关联通道临时读取，绑定 appId，不向 renderer 提供读取接口。

新式 card.action.trigger 通过认证 WebSocket 接收；SDK 展平 header/event 后，仍校验应用、双方租户、所有者、会话和绑定版本。人工决定只允许请求ID/版本/摘要及回答/批准/带原因拒绝，进入同一 WorkspaceService 和命令事务。事件键稳定派生，重投复用回执；旧卡、旧绑定和非所有者无效。没有另建飞书任务状态机或任意执行命令入口。

状态卡是共享快照的投影。首次发送正文和 uuid 在网络前固定；网络结果未知时在55分钟保守窗口内使用同正文/uuid 重试，成功后在同一消息补齐最新状态。超过平台去重期限不能盲发，保留 FEISHU_DELIVERY_UNCERTAIN。其他任务继续投递，失败不回滚业务状态。配置改版关闭旧连接，退出前停止新回调并等待在途通知返回；HTTP请求15秒超时且不跟随重定向。SDK原始错误/请求头可能含凭据，故日志不会透传。

目前卡片支持三类人工决定；完整日志与交付验收仍从桌面操作。尚未提供飞书创建项目/角色、外部任意命令批准或通用聊天任务创建；不将这些未实现行为描述为可用。

## 依赖和官方依据

复用锁定的 @larksuiteoapi/node-sdk 1.71.1（MIT）。显式新增其已锁定传递依赖 axios 1.18.1（MIT），只为创建隔离 HTTP 实例设置超时和拒绝重定向，避免修改 SDK 全局 HTTP 配置影响旧服务；替代方案是自写 SDK HttpInstance 适配，会重复认证/错误处理。所有版本和完整依赖锁随代码提交，bundle从实际依赖图收集完整许可。agent-base 6.0.2 和 https-proxy-agent 5.0.1 的 npm 包只在 README 附完整 MIT，构建对这两个具体版本核验并保留该文本，其他缺许可依赖仍失败。

- [官方长连接回调](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/step-1-choose-a-subscription-mode/configure-callback-request-address.md)：新式卡片回调、3秒响应、客户端集群分配而非广播。
- [官方2.0表单](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/form-container.md)、[按钮](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/button.md)、[输入框](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/input.md)：form_action_type/behaviors、form_value、输入框最多1000字符。更长答案可在桌面填写。
- [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create.md)：同uuid一小时内最多发送一条、最长50字符；不能假定网络成功与本地游标提交天然原子。

端口测试覆盖共享用例、重复事件、非所有者、旧绑定、拒绝不续接、未知网络固定重发/补齐、超期禁止盲发。真实应用权限、卡片渲染、长连接重连和跨端竞争仍待专用凭据，不以合成端口当作真实租户通过。消息长期不确定的人工对账界面、桌面连接向导尚在开发。

Claude 0.4.2 打包复验发现模型偶尔以 kind=result 返回普通提问；这不会产生可批准请求，也不会自动验收。0.4.3 明确追加协议层级与三类示例，保留安全模式，新源码实际 CLI 同 Run 澄清续接已通过；仍需新打包复验。禁止按普通文本猜测并伪造人工请求。
