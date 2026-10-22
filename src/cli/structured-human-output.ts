import { z } from 'zod'
import { humanPayloadSchema } from '../domain/human-request.js'
import type { CliEvent } from './types.js'
import { claudeJsonSchema } from './claude-json-schema.js'

const structuredOutputSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('result'),
        answer: z.string().min(1).max(200_000),
      })
      .strict(),
    ...humanPayloadSchema.options,
  ])
  .describe(
    '正常完成输出 kind=result 和简短 answer；需要所有者澄清、确认方案或单次操作时，输出对应 clarification/plan/operation 请求并停止工作，不得自答或先执行待批准操作。',
  )

const envelopeSchema = z.object({ outcome: structuredOutputSchema }).strict()

export const humanOutputJsonSchema = (): string =>
  // CLI 需要根对象和 draft-7；领域联合放在 outcome 中，完整约束留在返回边界。
  JSON.stringify(
    claudeJsonSchema(z.toJSONSchema(envelopeSchema, { target: 'draft-7' })),
  )

/** Claude 安全模式保留；原生结构化请求自然结束，不伪装为曾调用 MCP 工具。 */
export const parseStructuredHumanOutput = (value: unknown): CliEvent => {
  const parsed = envelopeSchema.safeParse(value)
  if (!parsed.success)
    return { type: 'error', message: 'CLI_STRUCTURED_OUTPUT_INVALID' }
  const outcome = parsed.data.outcome
  if (outcome.kind === 'result')
    return { type: 'result', answer: outcome.answer }
  return {
    type: 'result',
    answer: '等待所有者处理本次请求',
    humanRequest: outcome,
  }
}
