import type { Writable } from 'node:stream'

/** 先接管管道错误再发送提示；错误不能逃逸成宿主崩溃，也不回传提示或原始系统错误。 */
export const writeCliInput = (input: {
  stream: Writable
  prompt: string | undefined
  failed: () => void
}): void => {
  let reported = false

  const failed = () => {
    // finish表示正文已写完；晚到的断管不反写成输入失败。工具请求本身不证明已送达。
    if (reported || input.prompt === undefined || input.stream.writableFinished)
      return
    reported = true
    input.failed()
  }

  input.stream.on('error', failed)
  try {
    if (input.prompt === undefined) input.stream.end()
    else input.stream.end(input.prompt, 'utf8')
  } catch {
    failed()
  }
}
