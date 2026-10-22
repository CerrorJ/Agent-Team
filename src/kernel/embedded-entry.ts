import { readFileSync } from 'node:fs'
import { createKernel } from './kernel.js'
import { CredentialChannel } from './credential-channel.js'

interface ParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: { data: unknown }) => void): void
}

// Electron 仅提供传输端口；内核本身不导入 Electron。
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort })
  .parentPort

if (!parentPort) throw new Error('嵌入式入口需要宿主的私有消息端口')
const dataDirectory = process.argv[2]
if (!dataDirectory) throw new Error('缺少独立数据目录')

const manifest = JSON.parse(
  readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'),
) as { sourceCommit: string }

const credentials = new CredentialChannel((message) =>
  parentPort.postMessage(message),
)

const kernel = createKernel({
  dataDirectory,
  sourceCommit: manifest.sourceCommit,
  credentials: credentials.resolve,
  onEvent: (event) => parentPort.postMessage({ kind: 'event', event }),
})

parentPort.on('message', async ({ data }) => {
  if (credentials.receive(data)) return
  const response = await kernel.dispatch(data)
  parentPort.postMessage({ kind: 'response', response })
  if (response.status === 'completed' && kernelStateStopped(response.result)) {
    process.exitCode = 0
    setImmediate(() => process.exit(0))
  }
})

const kernelStateStopped = (result: unknown): boolean =>
  typeof result === 'object' &&
  result !== null &&
  'state' in result &&
  result.state === 'stopped'
