import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  ProductSpecRequestSchema,
  ProductSpecFlowStore,
  type CreateProductSpecFlowOptions,
  type ProductSpecFlow,
} from './product-spec.js'

const ProductSpecFlowSchema = z.object({
  token: z.string().min(1),
  taskId: z.string().min(1),
  botId: z.string().min(1),
  sessionId: z.string().min(1),
  ownerOpenId: z.string().min(1),
  ownerUnionId: z.string().min(1).optional(),
  request: ProductSpecRequestSchema,
  status: z.enum(['pending', 'approved', 'expired']),
  approvedAt: z.iso.datetime().optional(),
})

/**
 * ProductSpecFlowStore 的 JSON 持久化版本：流程状态落盘到 data/ 下，
 * 进程重启后旧的待确认卡片仍然可以审批。
 */
export class JsonProductSpecFlowStore extends ProductSpecFlowStore {
  constructor(private readonly filePath: string) {
    super(loadFlows(filePath))
  }

  override create(options: CreateProductSpecFlowOptions): ProductSpecFlow {
    return this.mutate(() => super.create(options))
  }

  override approve(token: string): ProductSpecFlow | undefined {
    return this.mutate(() => super.approve(token))
  }

  // 每次变更后立即落盘；写盘失败时回滚内存快照，保证文件与内存一致
  private mutate<T>(operation: () => T): T {
    const previous = this.snapshot()
    try {
      const result = operation()
      this.persist()
      return result
    } catch (error) {
      this.restore(previous)
      throw error
    }
  }

  // 先写临时文件再原子改名，半截写入不会破坏原状态文件
  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(this.snapshot(), null, 2)}\n`,
      'utf8',
    )
    renameSync(temporaryPath, this.filePath)
  }
}

// 文件不存在视为还没有流程；无法解析的坏行直接丢弃，不阻断启动
const loadFlows = (filePath: string): ProductSpecFlow[] => {
  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const rows: unknown = JSON.parse(content)
  if (!Array.isArray(rows)) {
    throw new Error(`产品方案状态文件格式错误: ${filePath}`)
  }
  return rows.flatMap((row) => {
    const result = ProductSpecFlowSchema.safeParse(row)
    return result.success ? [result.data] : []
  })
}
