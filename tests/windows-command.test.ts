import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnCli } from '../src/cli/spawn-cli.js'
import { windowsCommand } from '../src/cli/windows-command.js'

test(
  'Windows 使用调用方 PATH 与 cwd，参数中的 shell 字符保持原样',
  { skip: process.platform !== 'win32' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), '纬舟 cli # '))
    try {
      await mkdir(join(directory, 'bin'))
      const executable = join(directory, 'bin/codex.exe')
      await copyFile(process.execPath, executable)
      assert.equal(
        windowsCommand('codex', { env: { Path: 'bin' }, cwd: directory })
          .command,
        executable,
      )

      const result = await new Promise<string>((resolve, reject) => {
        const child = spawnCli(
          'codex',
          ['-e', 'console.log(process.argv[1])', 'a & b | %PATH%'],
          {
            cwd: directory,
            env: { ...process.env, PATH: join(directory, 'bin') },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )

        let output = ''
        child.stdout.on('data', (chunk) => {
          output += String(chunk)
        })
        child.once('error', reject)
        child.once('close', (code) =>
          code === 0
            ? resolve(output.trim())
            : reject(new Error(`退出 ${code}`)),
        )
      })

      assert.equal(result, 'a & b | %PATH%')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)
