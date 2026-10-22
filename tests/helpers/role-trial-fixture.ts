import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CliRunResult } from '../../src/cli/types.js'

/** 端口集成测试的文件往返夹具；不将此夹具作为真实模型试运行证据。 */
export const fulfillTrial = (input: {
  cwd: string
  prompt: string
}): CliRunResult | undefined => {
  const file = readdirSync(input.cwd).find((name) =>
    /^weftpilot-trial-[a-f0-9-]+\.input\.txt$/.test(name),
  )

  if (!file) return undefined
  const challenge = readFileSync(join(input.cwd, file), 'utf8').trim()
  if (input.prompt.includes('用文件写入工具'))
    writeFileSync(
      join(input.cwd, file.replace('.input.', '.output.')),
      `${challenge}\n`,
    )
  return { answer: challenge }
}
