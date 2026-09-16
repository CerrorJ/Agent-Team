// 需求澄清流程：CLI 调用 request_clarification 工具 -> 应用层截获 tool_call
// -> 渲染飞书卡片逐题收集答案 -> 答案拼进下一轮 prompt 继续任务。
// 本文件只放数据模型、校验与流程存储，卡片交互在 im/ 与 app/ 层。
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { CollaborationOrigin } from './collaboration.js'

const OptionSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  label: z.string().trim().min(1).max(100),
})

const QuestionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
    prompt: z.string().trim().min(1).max(300),
    options: z.array(OptionSchema).min(2).max(4),
    recommendedOptionId: z
      .string()
      .regex(/^[a-z0-9_-]{1,32}$/)
      .optional(),
  })
  .superRefine((question, ctx) => {
    const optionIds = question.options.map((option) => option.id)
    if (new Set(optionIds).size !== optionIds.length) {
      ctx.addIssue({
        code: 'custom',
        message: '同一道问题的选项 ID 不能重复',
        path: ['options'],
      })
    }
    if (
      question.recommendedOptionId &&
      !optionIds.includes(question.recommendedOptionId)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: '推荐项必须指向当前问题中的选项',
        path: ['recommendedOptionId'],
      })
    }
  })

export const ClarificationRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(80).default('需求澄清'),
    intro: z.string().trim().max(300).optional().default(''),
    questions: z.array(QuestionSchema).min(1).max(5),
  })
  .superRefine((request, ctx) => {
    const questionIds = request.questions.map((question) => question.id)
    if (new Set(questionIds).size !== questionIds.length) {
      ctx.addIssue({
        code: 'custom',
        message: '同一份澄清请求的问题 ID 不能重复',
        path: ['questions'],
      })
    }
  })

export type ClarificationRequest = z.infer<typeof ClarificationRequestSchema>

export interface ClarificationAnswer {
  questionId: string
  prompt: string
  answer: string
  source: 'user' | 'agent'
}

export interface ClarificationFlow {
  token: string
  taskId: string
  botId: string
  sessionId: string
  ownerOpenId: string
  ownerUnionId?: string
  collaboration?: CollaborationOrigin
  originalMessageId: string
  cardMessageId?: string
  replyInThread: boolean
  request: ClarificationRequest
  currentIndex: number
  answers: ClarificationAnswer[]
}

export interface CreateClarificationFlowOptions {
  taskId: string
  botId: string
  sessionId: string
  ownerOpenId: string
  ownerUnionId?: string
  collaboration?: CollaborationOrigin
  originalMessageId: string
  cardMessageId?: string
  replyInThread: boolean
  request: ClarificationRequest
}

// 从后往前找最近一次通过校验的调用（CLI 可能重试或提交多份，只认最后一份）
export const findClarificationRequest = (
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): ClarificationRequest | undefined => {
  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index]
    if (call?.toolName !== 'request_clarification') continue
    const parsed = ClarificationRequestSchema.safeParse(call.input)
    if (parsed.success) return parsed.data
  }
  return undefined
}

// unionId 优先：同一个人在不同飞书应用下 openId 不同，unionId 才是稳定身份
export const isClarificationOwner = (
  flow: Pick<ClarificationFlow, 'ownerOpenId' | 'ownerUnionId'>,
  operator: { operatorOpenId: string; operatorUnionId?: string },
): boolean => {
  if (flow.ownerUnionId && operator.operatorUnionId) {
    return flow.ownerUnionId === operator.operatorUnionId
  }
  return flow.ownerOpenId === operator.operatorOpenId
}

export const formatClarificationAnswers = (flow: ClarificationFlow): string => {
  const lines = flow.answers.map((answer, index) =>
    [
      `${index + 1}. ${answer.prompt}`,
      answer.source === 'agent'
        ? `Agent 采用推荐方案：${answer.answer}`
        : `用户回答：${answer.answer}`,
    ].join('\n'),
  )

  return [
    '用户已经通过飞书卡片回答了上一轮需求澄清问题。',
    ...lines,
    '请基于这些答案继续工作。如果仍有会实质影响方案的未决问题，再次调用 request_clarification；否则直接整理清晰、可验收的产品结论。',
  ].join('\n\n')
}

export const formatClarificationMessage = (
  flow: ClarificationFlow,
  message: string,
): string => {
  const confirmed = flow.answers.length
    ? formatClarificationAnswers(flow)
    : '此前还没有确认任何选项。'

  const currentQuestion = flow.request.questions[flow.currentIndex]
  return [
    '用户没有继续点击上一张需求澄清卡片，而是在同一个飞书话题里补充了新的信息。旧卡片已经失效，这条消息仍属于同一个任务。',
    confirmed,
    currentQuestion ? `上一张卡片正在询问：${currentQuestion.prompt}` : '',
    `用户的新消息：${message}`,
    '请优先理解这条新消息对既有需求的修正。如果仍有关键歧义，重新调用 request_clarification；信息已经足够时，直接整理可验收的需求结论。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export class ClarificationFlowStore {
  private readonly flows = new Map<string, ClarificationFlow>()

  // 同一任务 + bot 只保留一个进行中的流程；重新提问会让旧卡片上的 token 失效
  create(options: CreateClarificationFlowOptions): ClarificationFlow {
    for (const [token, flow] of this.flows) {
      if (flow.taskId === options.taskId && flow.botId === options.botId) {
        this.flows.delete(token)
      }
    }

    const flow: ClarificationFlow = {
      token: randomUUID().replaceAll('-', ''),
      ...options,
      currentIndex: 0,
      answers: [],
    }

    this.flows.set(flow.token, flow)
    return flow
  }

  get(token: string): ClarificationFlow | undefined {
    return this.flows.get(token)
  }

  findForTask(taskId: string, botId: string): ClarificationFlow | undefined {
    for (const flow of this.flows.values()) {
      if (flow.taskId === taskId && flow.botId === botId) return flow
    }
    return undefined
  }

  delete(token: string): void {
    this.flows.delete(token)
  }

  // 只接受"当前题"的答案：旧卡片或乱序点击（questionId 对不上）直接返回 undefined
  answer(
    token: string,
    questionId: string,
    answer: string,
    source: ClarificationAnswer['source'] = 'user',
  ): { flow: ClarificationFlow; complete: boolean } | undefined {
    const flow = this.flows.get(token)
    const question = flow?.request.questions[flow.currentIndex]
    const normalized = answer.trim()
    if (!flow || !question || question.id !== questionId || !normalized) {
      return undefined
    }
    flow.answers.push({
      questionId: question.id,
      prompt: question.prompt,
      answer: normalized,
      source,
    })
    flow.currentIndex += 1
    return {
      flow,
      complete: flow.currentIndex >= flow.request.questions.length,
    }
  }

  // 一键采用推荐项作答：allRemaining=false 只补当前题，true 把剩余题全部按推荐项收尾
  answerWithRecommendation(
    token: string,
    allRemaining: boolean,
  ): { flow: ClarificationFlow; complete: boolean } | undefined {
    const flow = this.flows.get(token)
    if (!flow) return undefined

    do {
      const question = flow.request.questions[flow.currentIndex]
      if (!question) break

      const recommended =
        question.options.find(
          (option) => option.id === question.recommendedOptionId,
        ) ?? question.options[0]

      if (!recommended) return undefined
      const result = this.answer(token, question.id, recommended.label, 'agent')
      if (!result || result.complete || !allRemaining) return result
    } while (flow.currentIndex < flow.request.questions.length)

    return {
      flow,
      complete: flow.currentIndex >= flow.request.questions.length,
    }
  }
}
