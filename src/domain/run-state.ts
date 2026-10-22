export type ExecutionState =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'waiting_input'
  | 'waiting_approval'
  | 'stopping'
  | 'stopped'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

const transitions: Record<ExecutionState, readonly ExecutionState[]> = {
  queued: ['preparing', 'cancelled', 'failed'],
  preparing: ['running', 'stopping', 'failed'],
  running: [
    'stopping',
    'waiting_input',
    'waiting_approval',
    'succeeded',
    'failed',
  ],
  waiting_input: ['queued', 'stopped', 'failed'],
  waiting_approval: ['queued', 'stopped', 'failed'],
  stopping: ['stopped', 'failed'],
  stopped: [],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
}

/** 终态不能重置；恢复为中断是对账路径，不能冒充普通执行状态转换。 */
export const assertExecutionTransition = (
  from: ExecutionState,
  to: ExecutionState,
): void => {
  if (!transitions[from].includes(to))
    throw new Error(`INVALID_STATE: 不允许 ${from} → ${to}`)
}

export const isTerminalExecution = (state: ExecutionState): boolean =>
  transitions[state].length === 0

export const assertRetryableExecution = (input: {
  state: ExecutionState
  processState: 'not_started' | 'active' | 'confirmed_ended' | 'uncertain'
}): void => {
  if (!isTerminalExecution(input.state))
    throw new Error('RUN_ACTIVE: 当前执行尚未结束')
  if (
    input.processState !== 'confirmed_ended' &&
    input.processState !== 'not_started'
  ) {
    throw new Error('STATE_UNCERTAIN: 必须先确认旧执行已停止')
  }
}
