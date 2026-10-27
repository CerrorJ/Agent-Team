import type { Task, Run } from './business-contracts.js'
import type { HumanRequest } from './human-contracts.js'

const text = (content: string) => ({
  tag: 'plain_text',
  content: content.slice(0, 4000),
})

const paragraph = (content: string) => ({ tag: 'div', text: text(content) })

/** 卡片是共享快照的投影；回调只能引用确切请求版本，不携带任意业务命令。 */
export const taskStatusCard = (input: {
  task: Task
  run?: Run
  request?: HumanRequest
  bindingVersion: number
  bindingId?: string
}) => ({
  schema: '2.0',
  config: { update_multi: true },
  header: { title: text(`纬舟 · ${input.task.title}`), template: 'blue' },
  body: {
    elements: [
      paragraph(
        `任务状态：${input.task.status}\n执行状态：${input.run?.status ?? '未执行'}\n任务 ID：${input.task.id}`,
      ),
      ...requestElements(input.request, input.bindingVersion, input.bindingId),
      paragraph('执行成功与验收分开。完整日志、交付与验收请在纬舟桌面查看。'),
    ],
  },
})

const requestElements = (
  request: HumanRequest | undefined,
  bindingVersion: number,
  bindingId?: string,
): unknown[] => {
  if (!request) return []

  const summary =
    request.payload.kind === 'clarification'
      ? `${request.payload.request.title}\n${request.payload.request.intro}`
      : request.payload.kind === 'plan'
        ? `${request.payload.title}\n${request.payload.summary}`
        : `${request.payload.request.operation}\n${request.payload.request.detail}\n影响：${request.payload.request.impact}\n回滚：${request.payload.request.rollback}`

  const content: unknown[] = [
    paragraph(
      `${summary}\n请求状态：${request.status}\n有效期：${request.expiresAt}`,
    ),
  ]

  if (request.status !== 'pending') return content
  if (request.payload.kind === 'operation')
    content.push(
      paragraph('确认只针对本次操作请求，原有工具权限保持，不放行其他操作。'),
    )
  // 卡片尺寸有限，不能在截断操作范围或方案后仍提供批准按钮。
  if (summary.length > 3500)
    return [
      ...content,
      paragraph('原文较长，卡片仅展示摘要；请在纬舟桌面完整查看并处理本请求。'),
    ]
  content.push(answerForm(request, bindingVersion, bindingId), {
    tag: 'form',
    name: 'reject_request',
    elements: [
      inputField('reason', '拒绝原因（必填）'),
      button(request, bindingVersion, 'rejected', bindingId),
    ],
  })
  return content
}

const answerForm = (
  request: HumanRequest,
  bindingVersion: number,
  bindingId?: string,
) => ({
  tag: 'form',
  name: 'resolve_request',
  elements:
    request.payload.kind === 'clarification'
      ? [
          ...request.payload.request.questions.flatMap((question) => [
            paragraph(
              `${question.prompt}\n${question.options.map((option) => `${option.id}：${option.label}`).join('\n')}`,
            ),
            inputField(`answer_${question.id}`, '填写自己的答案或选项文字'),
          ]),
          button(request, bindingVersion, 'answered', bindingId),
        ]
      : [button(request, bindingVersion, 'approved', bindingId)],
})

const inputField = (name: string, label: string) => ({
  tag: 'input',
  name,
  required: true,
  input_type: 'multiline_text',
  max_length: 1000,
  placeholder: text(label),
  label: text(label),
})

const button = (
  request: HumanRequest,
  bindingVersion: number,
  decision: 'approved' | 'rejected' | 'answered',
  bindingId?: string,
) => ({
  tag: 'button',
  name: `decision_${decision}`,
  form_action_type: 'submit',
  type: 'default',
  text: text(
    decision === 'rejected'
      ? '拒绝并结束'
      : decision === 'answered'
        ? '提交回答并继续'
        : '确认本次请求',
  ),
  behaviors: [
    {
      type: 'callback',
      value: {
        bindingVersion,
        ...(bindingId ? { bindingId } : {}),
        requestId: request.id,
        expectedVersion: request.version,
        expectedDigest: request.digest,
        decision,
      },
    },
  ],
})
