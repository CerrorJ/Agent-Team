import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  realpathSync,
  symlinkSync,
  readdirSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { ownedTempDirectory } from './helpers/owned-temp-directory.js'
import { localKernelFixture } from './helpers/local-kernel-fixture.js'
import { workspaceFixture } from './helpers/run-fixture.js'
import { inspectProjectRepository } from '../src/kernel/git-workspace.js'
import { validateBackupTarget } from '../src/kernel/backup-validation.js'
import {
  createWorkspaceBackup,
  restoreWorkspaceBackup,
} from '../src/kernel/workspace-backup.js'
import { WorkspaceStore } from '../src/kernel/workspace-store.js'

const initializeGit = (directory: string) => {
  mkdirSync(directory)

  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: directory,
      windowsHide: true,
      stdio: 'ignore',
    })

  git(['init', '-b', 'main'])
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'baseline',
  ])
}

const aliasDirectory = (target: string, alias: string) =>
  symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')

test('真实路径别名解析为同一物理Git根，子目录仍不能冒充根', () => {
  const temporary = ownedTempDirectory('weftpilot-native-root-')
  const physical = join(temporary.directory, 'physical')
  const alias = join(temporary.directory, 'alias')
  try {
    initializeGit(physical)
    aliasDirectory(physical, alias)

    const report = inspectProjectRepository({
      repositoryPath: alias,
      defaultBranch: 'main',
    })

    assert.equal(report.repositoryPath, realpathSync.native(physical))
    mkdirSync(join(physical, 'nested'))
    assert.throws(
      () =>
        inspectProjectRepository({
          repositoryPath: join(alias, 'nested'),
          defaultBranch: 'main',
        }),
      /GIT_ROOT_REQUIRED/,
    )
  } finally {
    temporary.remove()
  }
})

test('临时目录别名夹具构造真实备份，恢复TEMP后仍按创建时物理范围清理', async () => {
  const temporary = ownedTempDirectory('weftpilot-native-temp-')
  const physical = join(temporary.directory, 'physical')
  const alias = join(temporary.directory, 'alias')
  mkdirSync(physical)
  aliasDirectory(physical, alias)
  const names = ['TEMP', 'TMP', 'TMPDIR'] as const
  const previous = names.map((name) => process.env[name])
  let fixture: Awaited<ReturnType<typeof localKernelFixture>> | undefined
  try {
    for (const name of names) process.env[name] = alias
    fixture = await localKernelFixture(async () => {
      throw new Error('NO_CLI_ALLOWED')
    })
  } finally {
    names.forEach((name, index) => {
      const value = previous[index]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    })
  }
  try {
    assert.ok(fixture)
    assert.equal(dirname(fixture.directory), realpathSync.native(physical))

    const database = new DatabaseSync(
      join(fixture.dataDirectory, 'kernel.sqlite'),
    )

    try {
      const manifest = createWorkspaceBackup({
        store: new WorkspaceStore(database),
        dataDirectory: fixture.dataDirectory,
        targetDirectory: join(fixture.directory, 'backup'),
        sourceCommit: 'a'.repeat(40),
        backupId: randomUUID(),
      })

      assert.equal(manifest.files[0]?.path, 'kernel.sqlite')
      const source = join(fixture.directory, 'backup')
      const files = readdirSync(source).sort()
      const bytes = files.map((name) => readFileSync(join(source, name)))
      const target = join(source, 'forbidden-inside-source')
      const dataDirectory = fixture.dataDirectory
      const sourceAlias = join(alias, basename(fixture.directory), 'backup')
      assert.throws(
        () =>
          restoreWorkspaceBackup({
            store: new WorkspaceStore(database),
            dataDirectory,
            backupDirectory: sourceAlias,
            targetDirectory: target,
          }),
        /BACKUP_TARGET_INVALID/,
      )
      assert.equal(existsSync(target), false)
      assert.deepEqual(readdirSync(source).sort(), files)
      assert.deepEqual(
        files.map((name) => readFileSync(join(source, name))),
        bytes,
      )
    } finally {
      database.close()
    }
    await fixture.cleanup()
    fixture = undefined
  } finally {
    if (fixture) await fixture.cleanup()
    temporary.remove()
  }
})

test(
  'Windows原生8.3别名：Git根不误拒绝，备份仍禁止写进同一物理数据目录',
  { skip: process.platform !== 'win32' },
  (context) => {
    const temporary = ownedTempDirectory('纬舟 native short 中文 ')
    try {
      // PowerShell原生管道的码页不能假定UTF-8，用ASCII信封保留中文短名。
      const encoded = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$taskFso = New-Object -ComObject Scripting.FileSystemObject; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($taskFso.GetFolder($env:WEFTPILOT_SHORT_ROOT).ShortPath))',
        ],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 15000,
          env: { ...process.env, WEFTPILOT_SHORT_ROOT: temporary.directory },
        },
      ).trim()

      const short = Buffer.from(encoded, 'base64').toString('utf8')

      assert.equal(realpathSync.native(short), temporary.directory)

      if (short === temporary.directory) {
        context.skip('此文件系统未提供8.3短路径，不能冒认原生短名验证')
        return
      }
      const repositoryPath = join(short, 'repository')
      initializeGit(repositoryPath)

      const inspected = inspectProjectRepository({
        repositoryPath,
        defaultBranch: 'main',
      })

      assert.equal(
        inspected.repositoryPath,
        join(temporary.directory, 'repository'),
      )
      mkdirSync(join(temporary.directory, 'data'))
      const f = workspaceFixture({ persistRun: false, repositoryPath })
      try {
        assert.throws(
          () =>
            validateBackupTarget({
              target: join(temporary.directory, 'data', 'forbidden'),
              dataDirectory: join(short, 'data'),
              snapshot: f.store.snapshot(),
            }),
          /BACKUP_TARGET_INVALID/,
        )
      } finally {
        f.database.close()
      }
    } finally {
      temporary.remove()
    }
  },
)
