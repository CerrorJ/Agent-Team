import { readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ProductSpecRequest } from '../core/product-spec.js'

/**
 * 展示产物卡片前先做落盘校验：Spec 必须是文件，Tickets 必须是目录且至少含一个
 * 独立 ticket 的 .md 文件。CLI 声称写完但文件缺失时不允许进入确认环节。
 */
export const assertProductSpecDocuments = async (
  workspaceDir: string,
  request: ProductSpecRequest,
): Promise<void> => {
  const missing: string[] = []

  try {
    const info = await stat(resolve(workspaceDir, request.specPath))
    if (!info.isFile()) missing.push(`Spec: ${request.specPath}`)
  } catch {
    missing.push(`Spec: ${request.specPath}`)
  }

  try {
    const ticketsDir = resolve(workspaceDir, request.ticketsPath)
    const info = await stat(ticketsDir)

    const entries = info.isDirectory()
      ? await readdir(ticketsDir, { withFileTypes: true })
      : []

    const hasTicket = entries.some(
      (entry) => entry.isFile() && entry.name.endsWith('.md'),
    )

    if (!info.isDirectory() || !hasTicket) {
      missing.push(`Tickets: ${request.ticketsPath}`)
    }
  } catch {
    missing.push(`Tickets: ${request.ticketsPath}`)
  }

  if (missing.length) {
    throw new Error(
      [
        '产品方案尚未完整写入工作区，不能展示。',
        ...missing.map((item) => `- ${item}`),
      ].join('\n'),
    )
  }
}
