import type {
  HumanActor,
  HumanDecision,
  HumanRequest,
} from './human-contracts.js'

/** 回答必须覆盖本次请求的确切题目，推荐项不能自动当作用户答案。 */
export const assertHumanDecision = (
  request: HumanRequest,
  response: HumanDecision,
): void => {
  if (response.decision === 'rejected') return
  if (request.payload.kind !== 'clarification') {
    if (response.decision !== 'approved')
      throw new Error('HUMAN_DECISION_INVALID')
    return
  }
  if (response.decision !== 'answered')
    throw new Error('HUMAN_DECISION_INVALID')
  const ids = response.answers.map((answer) => answer.questionId)
  const questions = request.payload.request.questions
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== questions.length ||
    questions.some((question) => !ids.includes(question.id))
  )
    throw new Error('HUMAN_DECISION_INVALID')
}

export const decidedRequest = (input: {
  request: HumanRequest
  response: HumanDecision
  actor: HumanActor
}): HumanRequest => ({
  ...input.request,
  version: input.request.version + 1,
  status: input.response.decision,
  decision: input.response,
  actor: input.actor,
  decidedAt: new Date().toISOString(),
  resolutionReason:
    input.response.decision === 'rejected' ? input.response.reason : null,
})

export const continuationPrompt = (request: HumanRequest): string => {
  const response = request.decision
  if (!response) throw new Error('HUMAN_DECISION_INVALID')
  if (response.decision === 'answered')
    return `本次澄清的所有者回答：\n${JSON.stringify(response.answers)}\n按这些回答继续当前任务。不要修改已有配置快照。`
  return `所有者已确认本次${request.payload.kind === 'operation' ? '单次操作请求' : '方案'}，请求摘要 ${request.digest}。\n${JSON.stringify(request.payload)}\n仅本请求有效，原工具权限保持；不要把本次确认当作其他操作的授权。继续当前任务。`
}
