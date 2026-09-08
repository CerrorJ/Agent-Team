// 定时任务到期后的分发入口：目前只有「直接执行」一条路，
// 单独留这一层是为了以后能接入队列、并发上限等分发策略。
import type { AppRuntime } from './runtime.js'
import type { ScheduledTask } from '../core/schedule.js'
import { runScheduledTaskDirectly } from './scheduled-task-runner.js'

export const dispatchScheduledTask = async (options: {
  runtime: AppRuntime
  task: ScheduledTask
  scheduledFor: string
  defaultProductDeliveryMode: 'local' | 'lark-doc'
}): Promise<{ sessionId?: string }> => {
  return runScheduledTaskDirectly(options)
}
