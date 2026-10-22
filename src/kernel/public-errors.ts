const messages: Record<string, string> = {
  TEAM_PLAN_INVALID: '团队计划包含重复或无效的子任务引用',
  TEAM_DEPENDENCY_CYCLE: '子任务不能形成循环依赖',
  TEAM_NOT_STARTED: '请先启动所属团队任务',
  TASK_NOT_TEAM: '该任务不是团队任务',
  DEPENDENCY_NOT_ACCEPTED: '上游子任务尚未通过人工验收',
  DEPENDENCY_PROJECT_MISMATCH: '上游交付不属于当前项目',
  DEPENDENCY_PATCH_CONFLICT: '上游代码贡献存在冲突，执行目录已保留，未启动 CLI',
  VALIDATION_FAILED: '输入格式或协议版本不兼容',
  KERNEL_STOPPED: '内核正在停止或已停止',
  VERSION_CONFLICT: '数据已变化，请刷新后操作',
  IDEMPOTENCY_CONFLICT: '同一命令键对应了不同内容',
  NOT_FOUND: '对象不存在',
  GIT_DIRTY: '仓库存在未提交改动，请先保留并处理已有文件',
  GIT_ROOT_REQUIRED: '请选择有效 Git 仓库的根目录',
  GIT_UNAVAILABLE: '未找到 Git，请安装并重启应用',
  GIT_BRANCH_INVALID: '默认分支无效或没有提交，请检查分支名称',
  GIT_BASELINE_CHANGED: '排队期间基准已改变，请创建新执行',
  STATE_UNCERTAIN: '旧执行状态待确认，禁止自动重跑',
  RUN_ACTIVE: '当前执行尚未结束',
  TASK_NOT_READY: '任务尚不可执行，请先处理当前交付',
  STALE_RUN: '请选择最新一次执行',
  STALE_DELIVERY: '旧交付不能改变当前执行',
  DELIVERY_NOT_PENDING: '交付已经处理或尚未就绪',
  REASON_REQUIRED: '退回必须填写原因',
  CAPABILITY_UNSUPPORTED: '当前配置包含尚不支持的能力',
  INTERNAL_ERROR: '操作未完成，请查看诊断；不要假定执行成功',
  MODEL_CONFIG_INVALID: '模型配置与 CLI 或接口地址不兼容',
  MODEL_CREDENTIAL_REQUIRED: '模型配置尚未提供可用的安全凭据',
  CLI_MODEL_MISMATCH: '所选模型配置与角色 CLI 不兼容',
  TEAM_CONFIG_INVALID: '团队成员必须唯一，协调者必须在成员中',
  CROSS_PROJECT_REFERENCE: '需求或依赖必须属于同一项目',
  ROLE_NOT_READY: '角色未通过本版本试运行或尚未启用',
  ROLE_TRIAL_ACTIVE: '该角色已有在途或状态待确认的试运行',
  TASK_NOT_EXECUTABLE: '此记录需要使用对应的试运行或团队入口',
}

/** 不把进程 stderr、SQL、配置或本机路径作为通用错误回传。 */
export const publicError = (error: unknown) => {
  const candidate =
    error instanceof Error ? error.message.split(':')[0] : undefined

  const code = candidate && messages[candidate] ? candidate : 'INTERNAL_ERROR'
  return {
    code,
    message: messages[code] ?? messages.INTERNAL_ERROR ?? '操作失败',
    retryable: false,
  }
}
