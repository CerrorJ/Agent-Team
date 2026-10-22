import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()
const output = 'dist-kernel'
await mkdir(output, { recursive: true })
await build({
  entryPoints: {
    'embedded-entry': 'src/kernel/embedded-entry.ts',
    kernel: 'src/kernel/kernel.ts',
    protocol: 'src/kernel/protocol.ts',
  },
  outdir: output,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  legalComments: 'eof',
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
await writeFile(
  `${output}/THIRD-PARTY-NOTICES.txt`,
  'Agent-Team: ISC (package.json), source https://github.com/CerrorJ/Agent-Team\n' +
    'Node.js SQLite: supplied by host Node/Electron runtime; not vendored.\n\n' +
    'Zod: https://github.com/colinhacks/zod\n' +
    (await readFile('node_modules/zod/LICENSE', 'utf8')),
)
