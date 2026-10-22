import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

test(
  'Windows npm Codex 直接持有原生程序，不以可提前退出的 Node 包装器充当进程树根',
  { skip: process.platform !== 'win32' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'weftpilot-native-codex-'))
    const packageRoot = join(directory, 'node_modules/@openai/codex')
    const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64'

    const binaryDirectory = join(
      packageRoot,
      'vendor',
      `${architecture}-pc-windows-msvc`,
      'bin',
    )

    try {
      await mkdir(join(packageRoot, 'bin'), { recursive: true })
      await writeFile(
        join(packageRoot, 'bin/codex.js'),
        '// fixture, must not be executed',
      )
      assert.throws(
        () => windowsCommand('codex', { env: { Path: directory } }),
        /CLI_UNAVAILABLE/,
      )
      await mkdir(binaryDirectory, { recursive: true })
      const executable = join(binaryDirectory, 'codex.exe')
      await copyFile(process.execPath, executable)
      assert.deepEqual(windowsCommand('codex', { env: { Path: directory } }), {
        command: executable,
        prefix: [],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)
