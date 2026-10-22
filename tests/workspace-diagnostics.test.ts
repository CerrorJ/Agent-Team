import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { environmentDiagnosticsSchema } from '../src/kernel/diagnostic-contracts.js'
import { inspectWorkspaceEnvironment } from '../src/kernel/workspace-diagnostics.js'
import { discoverTool } from '../src/kernel/tool-discovery.js'
import { workspaceFixture } from './helpers/run-fixture.js'
import { localKernelFixture } from './helpers/local-kernel-fixture.js'
import { skillFixtureFetch } from './helpers/skill-fixture.js'
import { setTimeout as delay } from 'node:timers/promises'

test('诊断只读报告待核对进程和缺失目录，不把找到CLI或历史就绪当认证通过', () => {
  const fixture = workspaceFixture()
  try {
    const uncertain = {
      ...fixture.run,
      version: 2,
      status: 'interrupted' as const,
      processState: 'uncertain' as const,
    }

    fixture.store.transaction(() => fixture.store.updateRun(uncertain))
    const before = fixture.store.snapshot()

    const diagnostics = inspectWorkspaceEnvironment({
      store: fixture.store,
      dataDirectory: 'unused',
    })

    assert.equal(diagnostics.authentication, 'unchecked')
    assert.deepEqual(
      diagnostics.checks.find((item) => item.id === 'processes'),
      {
        id: 'processes',
        state: 'attention',
        code: 'PROCESS_RECONCILIATION',
        count: 1,
      },
    )
    assert.equal(
      diagnostics.checks.find((item) => item.id === 'projects')?.state,
      'attention',
    )
    assert.equal(
      diagnostics.checks.find((item) => item.id === 'database')?.state,
      'passed',
    )
    assert.equal(
      diagnostics.checks.find((item) => item.id === 'trials')?.state,
      'unchecked',
    )
    assert.ok(diagnostics.tools.every((item) => item.version === 'unchecked'))
    assert.deepEqual(fixture.store.snapshot(), before)
    assert.equal(
      JSON.stringify(diagnostics).includes(fixture.run.goalSnapshot),
      false,
    )
  } finally {
    fixture.database.close()
  }
})

test('固定工具发现尊重显式PATH，既不执行同名文件也不读登录内容', () => {
  const directory = mkdtempSync(join(tmpdir(), 'weftpilot-tool-discovery-'))
  try {
    mkdirSync(join(directory, 'empty'))
    assert.equal(discoverTool('git', { PATH: join(directory, 'empty') }), false)

    const path = join(
      directory,
      process.platform === 'win32' ? 'git.exe' : 'git',
    )

    writeFileSync(path, 'not executable content; discovery only', {
      mode: 0o700,
    })
    assert.equal(discoverTool('git', { PATH: directory }), true)
    assert.equal(discoverTool('codex', { PATH: directory }), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('诊断协议拒绝自定义命令或路径，导出投影没有业务文本或绝对本机目录', async () => {
  const fixture = await localKernelFixture(async () => {
    throw new Error('CLI must not run')
  })

  try {
    const request = {
      protocolVersion: 1,
      requestId: randomUUID(),
      method: 'kernel.diagnostics',
    }

    const result = await fixture.kernel.dispatch(request)
    assert.equal(result.status, 'completed')
    const report = environmentDiagnosticsSchema.parse(result.result)
    assert.equal(
      report.checks.find((item) => item.id === 'projects')?.state,
      'passed',
    )
    assert.equal(JSON.stringify(report).includes(fixture.directory), false)
    assert.equal(
      (await fixture.kernel.dispatch({ ...request, command: 'whoami' })).status,
      'rejected',
    )
    assert.equal(
      (await fixture.kernel.dispatch({ ...request, path: fixture.directory }))
        .status,
      'rejected',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('已安装技能逐文件检查；损坏报告失败但不改写可用性或历史记录', async () => {
  const fixture = await localKernelFixture(
    async () => {
      throw new Error('CLI must not run')
    },
    { skillFetch: skillFixtureFetch() },
  )

  try {
    const sourceId = await fixture.command({
      type: 'skill.source.save',
      expectedVersion: 0,
      name: '诊断合成来源',
      repository: 'https://github.com/example/skills',
      commit: 'a'.repeat(40),
    })

    const importId = await fixture.command({
      type: 'skill.import',
      sourceId,
      sourceVersion: 1,
      directory: 'skills/test-skill',
      licensePath: 'LICENSE',
    })

    let item = (await fixture.snapshot()).skillImports.find(
      (item) => item.id === importId,
    )
    for (
      let count = 0;
      count < 100 && item?.state !== 'preview_ready';
      count++
    ) {
      await delay(20)
      item = (await fixture.snapshot()).skillImports.find(
        (item) => item.id === importId,
      )
    }
    assert.ok(item?.package)
    await fixture.command({
      type: 'skill.activate',
      id: importId,
      expectedVersion: item.version,
      digest: item.package.digest,
    })
    for (
      let count = 0;
      count < 100 && !(await fixture.snapshot()).skills.length;
      count++
    )
      await delay(20)
    const skill = (await fixture.snapshot()).skills[0]
    assert.ok(skill)

    const request = {
      protocolVersion: 1,
      requestId: randomUUID(),
      method: 'kernel.diagnostics',
    }

    const first = await fixture.kernel.dispatch(request)
    assert.equal(first.status, 'completed')
    assert.equal(
      environmentDiagnosticsSchema
        .parse(first.result)
        .checks.find((item) => item.objectId === skill.id)?.state,
      'passed',
    )
    writeFileSync(
      join(
        fixture.dataDirectory,
        'skills/versions',
        skill.id,
        'skills/test-skill/references/proof.txt',
      ),
      'tampered synthetic skill',
    )
    const before = await fixture.snapshot()
    const second = await fixture.kernel.dispatch(request)
    assert.equal(second.status, 'completed')
    assert.equal(
      environmentDiagnosticsSchema
        .parse(second.result)
        .checks.find((item) => item.objectId === skill.id)?.state,
      'failed',
    )
    assert.deepEqual(await fixture.snapshot(), before)
  } finally {
    await fixture.cleanup()
  }
})
