import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, copyFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeKernelNotices } from './kernel-notices.mjs'

const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()
const output = 'dist-kernel'
await mkdir(output, { recursive: true })
const options = {
  outdir: output,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  legalComments: 'eof',
  metafile: true,
}
const result = await build({
  ...options,
  entryPoints: {
    'embedded-entry': 'src/kernel/embedded-entry.ts',
    kernel: 'src/kernel/kernel.ts',
  },
  banner: {
    js: 'import { createRequire as bundleRequire } from "node:module"; const require = bundleRequire(import.meta.url);',
  },
})
const contract = await build({
  ...options,
  entryPoints: { protocol: 'src/kernel/protocol.ts' },
})
const mcp = await build({
  ...options,
  entryPoints: { 'human-mcp-entry': 'src/kernel/human-mcp-entry.ts' },
  banner: {
    js: 'import { createRequire as bundleRequire } from "node:module"; const require = bundleRequire(import.meta.url);',
  },
})
// 协议同时供 renderer 消费，实际 bundle 不得混入 Node/Electron 兼容注入。
await build({
  entryPoints: [`${output}/protocol.js`],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  write: false,
  logLevel: 'silent',
})
const { KERNEL_VERSION, PROTOCOL_VERSION, DATA_SCHEMA_VERSION } = await import(
  pathToFileURL(resolve(output, 'protocol.js')).href
)
await writeFile(
  `${output}/manifest.json`,
  JSON.stringify(
    {
      kernelVersion: KERNEL_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      dataSchemaVersion: DATA_SCHEMA_VERSION,
      sourceCommit,
      platform: 'any',
      arch: 'any',
      runtimeAbi: 'node:sqlite (Node >=22.13)',
    },
    null,
    2,
  ) + '\n',
)
await writeFile(
  `${output}/package.json`,
  JSON.stringify(
    {
      name: '@weftpilot/agent-team-kernel',
      version: KERNEL_VERSION,
      type: 'module',
      private: true,
      exports: {
        './protocol': {
          types: './types/kernel/protocol.d.ts',
          default: './protocol.js',
        },
        './kernel': {
          types: './types/kernel/kernel.d.ts',
          default: './kernel.js',
        },
      },
    },
    null,
    2,
  ) + '\n',
)
await copyFile('docs/embedded-kernel.md', `${output}/README.md`)
await writeKernelNotices(
  {
    inputs: {
      ...result.metafile.inputs,
      ...contract.metafile.inputs,
      ...mcp.metafile.inputs,
    },
  },
  output,
)
