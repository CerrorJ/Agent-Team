const messages: Record<string, string> = {
  VALIDATION_FAILED: '输入格式或协议版本不兼容',
  KERNEL_STOPPED: '内核正在停止或已停止',
  VERSION_CONFLICT: '数据已变化，请刷新后操作',
  IDEMPOTENCY_CONFLICT: '同一命令键对应了不同内容',
  NOT_FOUND: '对象不存在',
  GIT_DIRTY: '仓库存在未提交改动，请先保留并处理已有文件',
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
