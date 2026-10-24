# CLI版本与默认账户检查

2026-10-24，从干净的`e6c33e97e18859453b441fccaff63442cda07333`建立`feat/cli-inspection`。拟增量0.8.0/协议1/schema8；桌面最新角色卡片提交`2cb75c12326ba740b50d943372e2b3c38500b487`仍固定070产物，未使用本工作区未提交源码。

`kernel.cliCheck`仅接受`input: { cli: 'codex' | 'claude', check: 'version' | 'sign-in' }`。执行固定的`--version`、`codex login status`或`claude auth status --json`，不接受任意命令、环境或路径，不自动登录、安装或更新，不发起模型调用。工作目录为本内核数据目录，不进入用户项目或业务Run目录。CLI自身读取本机已有配置；内核不复制或直接读取登录文件。

先核对本机帮助和官方参考：[Codex命令](https://developers.openai.com/codex/cli/reference/)、[Claude Code命令](https://code.claude.com/docs/en/cli-reference)。本机帮助为codex-cli0.163.0、Claude Code2.1.309，均支持上述命令。未知/旧CLI输出不按退出码推断成功。

响应只包含检查时间、状态/固定错误码、安全提取的版本、进程确认状态。CLI原始输出不持久化、不回传；邮箱、目录、账户标识与部分密钥均不会进入协议。登录仅表示CLI默认账户状态，不证明凭据仍有效、不替代固定模型配置或真实模型试运行；`modelConnection`始终`unverified`。检查不写角色就绪证明、业务对象、事件、命令回执或Run。

内核持有探针进程，同一个CLI只允许一个在途检查。输出上限32KiB、默认10秒超时；超限/超时仅终止自己创建的进程树。终止失败时返回`uncertain`并保持占用，后续root关闭不抹掉整树不确定性，禁止重复检查。完全退出必须等待探针确认终止，不能先发`kernel.stopped`。此增量没有为既有业务Run停止故障修复或自动对账；检查未知后的人工恢复界面及跨重启诊断进程记录仍未覆盖，不冒充业务恢复证明。

当前新增8项测试，完整135/135、类型/lint/规模/格式、原独立服务构建及内核构建均通过。真实Windows协议专项分别调用本机Codex和Claude的版本/登录状态，共4项均通过；全部SQLite表前后相同，仅退出时追加既有生命周期事件，确认`kernel.started`/`kernel.stopped`。这些只读CLI命令没有发起模型调用或形成试运行就绪证明。

独立Tester已在活内核限定范围PASS：另行真实4固定CLI检查、每项并发防重及全部业务SQLite表不写，缺CLI/严格输入拒绝通过；11项相关回归和类型/内核构建通过。独立真实Node父子进程的超时、超量和在途关闭均核对根/子PID消失；受控终止false加真实root自然关闭仍保持未知、防重和关闭拒绝。另在自有EmbeddedKernel中仅替换检查端口，真实shutdown协议拒绝且没有`kernel.stopped`或成功ACK，没有改写故障夹具伪造停止。这些范围不当作真实CLI模型任务或跨崩溃恢复证明。

独立Reviewer最终APPROVE，无新增P0—P3；另行类型与测试类型、全仓lint/规模/diff、相关11测试及改动文件格式检查通过，并复核上述独立真实查询、父子进程和受控拒绝证据。跨崩溃无持久探针意图/身份对账在当前固定只读命令范围记录为非阻塞限制，不代表已具备恢复能力；扩展副作用命令、跨重启自动重试或安全回收前必须先补充。

本内核限定范围已独立验收；桌面桥接、固定产物重建与实际应用验收另在纬舟记录，不将API写成角色六步分项检查已交付。版本化固定模型连接仍需真实受控试运行，专用模型服务凭据待外部提供。复现：`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm test`、`pnpm build`、`pnpm build:kernel`；定向为`pnpm exec tsx --test tests/cli-inspection.test.ts tests/cli-check-protocol.test.ts`。
