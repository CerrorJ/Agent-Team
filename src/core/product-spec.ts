import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { CollaborationOrigin } from './collaboration.js'

// 路径只允许是工作区内的相对路径：拒绝绝对路径与 .. 穿越，防止 CLI 提交工作区外的文件
const WorkspaceDocumentPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) => !value.startsWith('/') && !value.split(/[\\/]/).includes('..'),
    '文档路径必须位于当前工作目录内',
  )

const ProductSpecBaseSchema = z.object({
  title: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(500),
})

// 只认飞书 Docx 链接（评论区流程暂不支持 wiki 形态），其他链接直接拒绝
const LarkDocumentUrlSchema = z
  .url()
  .refine(
    (value) => /\/docx\//.test(new URL(value).pathname),
    'documentUrl 必须是飞书 Docx 文档链接',
  )

export const LocalProductSpecRequestSchema = ProductSpecBaseSchema.extend({
  deliveryMode: z.literal('local'),
  specPath: WorkspaceDocumentPathSchema,
  ticketsPath: WorkspaceDocumentPathSchema,
}).strict()

export const LarkProductSpecRequestSchema = ProductSpecBaseSchema.extend({
  deliveryMode: z.literal('lark-doc'),
  documentUrl: LarkDocumentUrlSchema,
}).strict()

// 交付方式二选一：local=落盘工作区的 Spec/Tickets 文件；lark-doc=飞书云文档链接
export const ProductSpecRequestSchema = z.discriminatedUnion('deliveryMode', [
  LocalProductSpecRequestSchema,
  LarkProductSpecRequestSchema,
])

export type ProductSpecRequest = z.infer<typeof ProductSpecRequestSchema>
export type LocalProductSpecRequest = z.infer<
  typeof LocalProductSpecRequestSchema
>

// MCP SDK 的 normalizeObjectSchema 无法识别顶层 z.discriminatedUnion，
// 会静默降级为 { type: 'object', properties: {} } 导致 AI 无法传参。
// 此 Schema 用于向 MCP 暴露具有明确 properties 的顶层对象，运行时仍由 ProductSpecRequestSchema 做鉴别联合校验。
export const ProductSpecToolInputSchema = z.object({
  deliveryMode: z
    .enum(['local', 'lark-doc'])
    .describe(
      '交付方式：local=落盘工作区的 Spec/Tickets 文件；lark-doc=飞书云文档链接',
    ),
  title: z.string().trim().min(1).max(80).describe('方案标题'),
  summary: z.string().trim().min(1).max(500).describe('方案摘要'),
  specPath: WorkspaceDocumentPathSchema.optional().describe(
    '本地 Spec Markdown 文件相对路径（deliveryMode=local 时必填）',
  ),
  ticketsPath: WorkspaceDocumentPathSchema.optional().describe(
    '本地 Tickets Markdown 文件相对路径（deliveryMode=local 时必填）',
  ),
  documentUrl: LarkDocumentUrlSchema.optional().describe(
    '飞书云文档链接（deliveryMode=lark-doc 时必填）',
  ),
})

export type ProductSpecToolInput = z.infer<typeof ProductSpecToolInputSchema>

export interface ProductSpecFlow {
  token: string
  taskId: string
  botId: string
  sessionId: string
  ownerOpenId: string
  ownerUnionId?: string
  collaboration?: CollaborationOrigin
  request: ProductSpecRequest
  status: 'pending' | 'approved' | 'expired'
  approvedAt?: string
}

export interface CreateProductSpecFlowOptions {
  taskId: string
  botId: string
  sessionId: string
  ownerOpenId: string
  ownerUnionId?: string
  collaboration?: CollaborationOrigin
  request: ProductSpecRequest
}

// 从后往前找最近一次通过校验的调用（CLI 可能重试或提交多份，只认最后一份）
export const findProductSpecRequest = (
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): ProductSpecRequest | undefined => {
  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index]
    if (call?.toolName !== 'request_spec_approval') continue

    const cleanInput =
      typeof call.input === 'object' && call.input !== null
        ? Object.fromEntries(
            Object.entries(call.input).filter(
              ([_, v]) => v !== undefined && v !== '',
            ),
          )
        : call.input

    const parsed = ProductSpecRequestSchema.safeParse(cleanInput)
    if (parsed.success) return parsed.data
  }
  return undefined
}

// unionId 优先：同一个人在不同飞书应用下 openId 不同，unionId 才是稳定身份（同 isClarificationOwner）
export const isProductSpecOwner = (
  flow: Pick<ProductSpecFlow, 'ownerOpenId' | 'ownerUnionId'>,
  operator: { operatorOpenId: string; operatorUnionId?: string },
): boolean => {
  if (flow.ownerUnionId && operator.operatorUnionId) {
    return flow.ownerUnionId === operator.operatorUnionId
  }
  return flow.ownerOpenId === operator.operatorOpenId
}

export class ProductSpecFlowStore {
  private readonly flows = new Map<string, ProductSpecFlow>()

  constructor(initialFlows: ProductSpecFlow[] = []) {
    for (const flow of initialFlows) {
      this.flows.set(flow.token, flow)
    }
  }

  // 同一任务 + bot 只保留一个待确认的流程；重新提交会让旧卡片上的 token 失效
  create(options: CreateProductSpecFlowOptions): ProductSpecFlow {
    for (const flow of this.flows.values()) {
      if (
        flow.taskId === options.taskId &&
        flow.botId === options.botId &&
        flow.status === 'pending'
      ) {
        flow.status = 'expired'
      }
    }

    const flow: ProductSpecFlow = {
      token: randomUUID().replaceAll('-', ''),
      ...options,
      status: 'pending',
    }

    this.flows.set(flow.token, flow)
    return flow
  }

  get(token: string): ProductSpecFlow | undefined {
    return this.flows.get(token)
  }

  // 评论事件只带 file_token：从待确认流程里反查 documentUrl token 匹配的那条
  findPendingByDocument(
    botId: string,
    fileToken: string,
  ): ProductSpecFlow | undefined {
    for (const flow of this.flows.values()) {
      if (
        flow.botId === botId &&
        flow.status === 'pending' &&
        flow.request.deliveryMode === 'lark-doc' &&
        documentToken(flow.request.documentUrl) === fileToken
      )
        return flow
    }
    return undefined
  }

  approve(token: string): ProductSpecFlow | undefined {
    const flow = this.flows.get(token)
    if (!flow || flow.status !== 'pending') return undefined
    flow.status = 'approved'
    flow.approvedAt = new Date().toISOString()
    return flow
  }

  // 给持久化子类用：导出当前内存状态 / 失败时整体回滚
  protected snapshot(): ProductSpecFlow[] {
    return structuredClone([...this.flows.values()])
  }

  protected restore(flows: ProductSpecFlow[]): void {
    this.flows.clear()
    for (const flow of flows) {
      this.flows.set(flow.token, flow)
    }
  }
}

// 从飞书 Docx URL 提取文件 token，与文档评论事件里的 file_token 对齐
const documentToken = (documentUrl: string): string | undefined => {
  const match = /^\/docx\/([A-Za-z0-9_-]+)\/?$/.exec(
    new URL(documentUrl).pathname,
  )

  return match?.[1]
}
