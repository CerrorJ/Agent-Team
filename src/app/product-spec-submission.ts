import type { ProductDeliveryMode } from '../core/bot-registry.js'
import {
  findProductSpecRequest,
  parseProductSpecInput,
  type ProductSpecRequest,
} from '../core/product-spec.js'
import { PRODUCT_SPEC_TOOL_NAME } from '../cli/app-tools.js'
import type { CliRunResult } from '../cli/types.js'
import { assertProductSpecDocuments } from './product-spec-documents.js'

export interface ProductSpecSubmission {
  result: CliRunResult
  request: ProductSpecRequest
}

// 一轮运行里 request_spec_approval 的结论：request 是最后一份可解析的提交；
// problem 非空表示这份提交不能展示（工具拒绝、参数无效或本地产物校验失败）
interface SubmissionInspection {
  input?: unknown
  request?: ProductSpecRequest
  problem?: string
}

const localDocumentProblem = async (
  workspaceDir: string,
  request: ProductSpecRequest,
): Promise<string | undefined> => {
  if (request.deliveryMode !== 'local') return undefined
  try {
    await assertProductSpecDocuments(workspaceDir, request)
    return undefined
  } catch (error) {
    return (error as Error).message
  }
}

// 先看工具接受的提交；没有时再看被工具拒绝的提交，按当前工作区复算拒绝原因。
// Codex 若没把 MCP isError 标成失败，被拒调用会留在 toolCalls 里，同样会在落盘校验处拦下。
const inspectSubmission = async (
  result: CliRunResult,
  workspaceDir: string,
): Promise<SubmissionInspection> => {
  const accepted = findProductSpecRequest(result.toolCalls)
  if (accepted) {
    return {
      input: accepted,
      request: accepted,
      problem: await localDocumentProblem(workspaceDir, accepted),
    }
  }

  const rejected = result.rejectedToolCalls
    ?.filter((call) => call.toolName === PRODUCT_SPEC_TOOL_NAME)
    .at(-1)

  if (!rejected) return {}

  const parsed = parseProductSpecInput(rejected.input)
  if (!parsed.success) {
    return {
      input: rejected.input,
      problem: `request_spec_approval 提交被拒绝，参数未通过校验：${parsed.reason}`,
    }
  }
  return {
    input: rejected.input,
    request: parsed.data,
    problem:
      (await localDocumentProblem(workspaceDir, parsed.data)) ??
      'request_spec_approval 提交被工具拒绝，且没有重新提交成功',
  }
}

// 缺少结构化提交或提交未通过校验时，带着具体原因沿原会话重跑一次。
// 重跑仍须通过工具提交和落盘校验，且不得改变上一轮已选定的交付方式。
export const ensureProductSpecSubmission = async (options: {
  result: CliRunResult
  defaultDeliveryMode: ProductDeliveryMode
  workspaceDir: string
  retry: (
    prompt: string,
    sessionId: string | undefined,
  ) => Promise<CliRunResult>
}): Promise<ProductSpecSubmission> => {
  const first = await inspectSubmission(options.result, options.workspaceDir)
  if (first.request && !first.problem) {
    return { result: options.result, request: first.request }
  }

  const retried = await options.retry(
    first.problem
      ? rejectedSubmissionPrompt(first.input, first.problem)
      : missingSubmissionPrompt(options.defaultDeliveryMode),
    options.result.sessionId,
  )

  const second = await inspectSubmission(retried, options.workspaceDir)
  if (!second.request || second.problem) {
    throw new Error(
      second.problem ??
        '产品方案已经整理完成，但产品经理没有调用 request_spec_approval',
    )
  }

  const expectedMode = first.request?.deliveryMode
  if (expectedMode && second.request.deliveryMode !== expectedMode) {
    throw new Error(
      `产品方案重新提交时交付方式从 ${expectedMode} 改成了 ${second.request.deliveryMode}，不能展示`,
    )
  }
  return { result: retried, request: second.request }
}

const rejectedSubmissionPrompt = (input: unknown, reason: string): string => {
  return [
    '上一轮产品方案提交未通过校验，尚未向用户展示确认卡。',
    reason,
    `上一轮提交：${JSON.stringify(input)}`,
    '请沿用已生成的方案，检查当前工作区中的真实文件并修正路径；缺失的产物请补写。保持上一轮的交付方式，不要改为飞书云文档来绕过校验。',
    'local 交付要求 specPath 指向已存在的 Spec 文件；ticketsPath 指向目录，目录内至少有一个独立 ticket 的 .md 文件。若上一轮提交了汇总 Markdown 文件，请将其中实现任务拆分到 Tickets 目录并提交目录路径。',
    '修正完成后必须实际调用 request_spec_approval 重新提交。工具调用成功后立即结束本轮，不要实现代码或派发团队任务。',
  ].join('\n\n')
}

const missingSubmissionPrompt = (
  defaultDeliveryMode: ProductDeliveryMode,
): string => {
  return [
    '上一轮已经完成产品方案整理，但没有完成 Agent Team 的结构化提交。',
    '不要继续解释。请沿用上一轮已经生成的唯一产物，立即调用 request_spec_approval。',
    `没有明确覆盖时，deliveryMode 使用 ${defaultDeliveryMode}。`,
    'local 交付时 specPath 填已存在的 Spec 文件，ticketsPath 填包含独立 ticket .md 文件的目录，不得填单个 Markdown 文件。工具返回校验失败时，按返回原因修正后重新提交。',
    '必须实际调用工具；不能只在普通回复中写出 deliveryMode、documentUrl、specPath 或 ticketsPath。',
    '工具调用成功后立即结束本轮。',
  ].join('\n\n')
}
