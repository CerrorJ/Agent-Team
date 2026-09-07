import { randomUUID } from 'node:crypto'
import { z } from 'zod'

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

export const ProductSpecRequestSchema = z.object({
  title: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(500),
  specPath: WorkspaceDocumentPathSchema,
  ticketsPath: WorkspaceDocumentPathSchema,
})

export type ProductSpecRequest = z.infer<typeof ProductSpecRequestSchema>

export interface ProductSpecFlow {
  token: string
  taskId: string
  botId: string
  ownerOpenId: string
  ownerUnionId?: string
  request: ProductSpecRequest
  status: 'pending' | 'approved' | 'expired'
  approvedAt?: string
}

export interface CreateProductSpecFlowOptions {
  taskId: string
  botId: string
  ownerOpenId: string
  ownerUnionId?: string
  request: ProductSpecRequest
}

// 从后往前找最近一次通过校验的调用（CLI 可能重试或提交多份，只认最后一份）
export const findProductSpecRequest = (
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): ProductSpecRequest | undefined => {
  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index]
    if (call?.toolName !== 'request_spec_approval') continue
    const parsed = ProductSpecRequestSchema.safeParse(call.input)
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

  approve(token: string): ProductSpecFlow | undefined {
    const flow = this.flows.get(token)
    if (!flow || flow.status !== 'pending') return undefined
    flow.status = 'approved'
    flow.approvedAt = new Date().toISOString()
    return flow
  }
}
