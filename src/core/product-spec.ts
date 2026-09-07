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
