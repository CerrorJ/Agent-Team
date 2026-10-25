# CLI 输入与取消生命周期（0.9.1 内核）

2026-10-25关联更新：内核源`aaeeeb41990920f3223f32a94b2c6e86ef7719a4`已先行推送，0.9.1/p1/schema8/128文件；tar SHA-256 `fcf11983a4b83918d0d9ee01a0deabd10107a1973be79125b58bf3ab0a6c3688`。纬舟独立检出重建一致，桌面本地提交`b75660ba6043de96812442ba200ed8cd9dd3e833`：43单元/7装配、实际Windows包36通过16跳过、真实Codex文件M1及独立Claude唯一trial/显式启用/正常退出通过，桌面Tester9断言PASS、Reviewer APPROVE。当前桌面Git传输失败，备用连接器写入403，远端仍26f；本增量无新远端CI/Mac实际CLI/安装器结论。后续仅记录关联的文档提交不是新内核产物，客户端仍锁定源aaee。下方拟版本/待接入为源提交时历史记录。

从干净`d86d0c6`（仅090关联文档，实际内核源码fb313df）在`fix/cli-stdin-lifecycle`继续。Windows真实本机Node探针：256KiB合成stdin、开始回调立即取消，触发Socket未捕获`write EOF`，执行宿主exit1。子进程有3秒自然结束上限、不派生后代、不调用模型，原失败日志/元信息在忽略的`.tmp/stdin-cancel-probe.*`保留，原PID已不在；没有接管旧255/128现场。

新输入模块在发送前监听管道error并捕获同步异常，只报告一次，不记录正文或原始系统错误。argv模式只空收口，断管不会伪装为未交付正文；已有取消不再写入正文。以Writable.writableFinished为正文写完证明，晚到的断管不反写为未送达；但工具请求本身不是输入送达证据。真实输入失败会请求终止，并拒绝CLI的result或人工工具请求。停止确认后为CLI_INPUT_FAILED；终止端口false/抛错均STATE_UNCERTAIN，根自然结束不构成整树已结束证明，不自动重试或生成交付。

拟版本0.9.1、protocol1/schema8；无对象格式或调度/审批状态变化，原独立飞书入口共用该Runner，仍允许无飞书启动。客户端目前固定090，未消费本未提交产物。

根代理首轮strict/lint/规模/格式、完整150/150及原服务/内核构建通过；原失败探针修复后正常exit0、实际taskkill确认0/取消，无uncaught。独立Tester进一步发现P1：最初以“终止已发起”为由忽略EOF，可能让未读取的大输入先发tool_call，最终在真实SQLite/协议形成waiting_approval。该轮没有发布或接入客户端，原独立失败库保留。

修复P1后不再仅因tool已发起终止而忽略输入失败，并新增提前人工工具+result的严格拒绝、写完后晚断管不误报，以及实际Node完整读取65536bytes再发工具/默认停止确认的正例。最新专项14/14与完整153/153、strict/lint/规模/格式、原服务及内核构建通过；专项包含4条流边界、7条Windows真实Node及3条原停止回归，流端口与Node受控适配器不是模型成功证明。

正向CLI_INPUT_FAILED的初始夹具误以为Node关闭stdin会立即断开Windows标准句柄，实际错误到自然退出才到达，默认taskkill已无法证明整树而正确返回STATE_UNCERTAIN；两次失败保留。只将该正向夹具明确改为不派生后代、等待所持child.close及真实exit0的受控终止确认，CLI_INPUT_FAILED/单次启动断言不放宽；生产终止逻辑不按根消失判成功。另两项仍严格要求false及抛错端口即使自然退出也unknown，取消两项实际使用默认Windows整树终止且检查PID消失。

独立Tester最终PASS，P1已复验关闭。真实文件SQLite/工作区协议的提前工具/结果均failed、CLI_INPUT_FAILED、无humanRequest/交付；false或抛错终止仍unknown/endedAt=null，重试RUN_ACTIVE、shutdown拒绝STATE_UNCERTAIN。独立正常人工工具确实读完368000bytes stdin，生产taskkill确认0后正常等待审批，取消前已知signal实测0bytes送入。五夹具22表无合成私有输入、停止异常或原始EOF/EPIPE泄漏。独立14专项、strict、独立服务/内核构建通过；原P1库未覆盖，未知夹具不改为已停止。

独立Reviewer最终APPROVE，无新增P0—P3；独立strict/test类型、lint/规模/格式及14项专项通过。下一步提交并从干净来源重建锁定产物，再验收客户端；此处尚无客户端091或新发行结果。历史taskkill255/128、原Claude完整超时及Keychain原生根因不因本EOF修复关闭。复现：`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm test`、`pnpm build`、`pnpm build:kernel`；定向`node --import tsx --test tests/cli-input-stream.test.ts tests/cli-input-native.test.ts tests/process-stop.test.ts tests/process-abort-race.test.ts`。
