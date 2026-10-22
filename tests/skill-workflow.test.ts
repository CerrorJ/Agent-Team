import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { createKernel, type EmbeddedKernel } from '../src/kernel/kernel.js'
import {
  localKernelFixture,
  issueCommand,
  readSnapshot,
  waitForRun,
} from './helpers/local-kernel-fixture.js'
import { skillFixtureFetch } from './helpers/skill-fixture.js'
import {
  skillStoragePath,
  activateSkillFiles,
} from '../src/kernel/skill-staging.js'
import { verifySkillDirectory } from '../src/kernel/skill-files.js'
import { runSkillDirectoryName } from '../src/kernel/run-skills.js'
import type { SkillImport } from '../src/kernel/skill-contracts.js'
import type { CliExecutionPort } from '../src/kernel/run-execution.js'
import type { SkillFetch } from '../src/kernel/skill-download.js'

const fakeCli: CliExecutionPort = async (options) => {
  const trial = /weftpilot-trial-[a-f0-9-]+\.input\.txt/.exec(
    options.prompt,
  )?.[0]

  if (trial)
    return {
      answer: readFileSync(join(options.cwd, trial), 'utf8'),
      sessionId: 'fixture',
    }
  assert.match(options.prompt, /本次角色的固定技能清单/)
  writeFileSync(join(options.cwd, 'result.txt'), 'actual fixture delivery\n')
  return { answer: 'finished', sessionId: 'fixture' }
}

const waitForImport = async (
  kernel: EmbeddedKernel,
  id: string,
  state: SkillImport['state'],
) => {
  for (let count = 0; count < 100; count++) {
    const item = (await readSnapshot(kernel)).skillImports.find(
      (item) => item.id === id,
    )

    if (item?.state === state) return item
    if (item?.state === 'failed' && state !== 'failed')
      throw new Error(item.failureCode ?? 'Import failed')
    await delay(20)
  }
  throw new Error('Import timeout')
}

const importSkill = async (kernel: EmbeddedKernel) => {
  const sourceId = await issueCommand(kernel, {
    type: 'skill.source.save',
    expectedVersion: 0,
    name: '合成测试技能源',
    repository: 'https://github.com/example/skills',
    commit: 'a'.repeat(40),
  })

  const key = randomUUID()

  const command = {
    type: 'skill.import' as const,
    sourceId,
    sourceVersion: 1,
    directory: 'skills/test-skill',
    licensePath: 'LICENSE',
  }

  const id = await issueCommand(kernel, command, key)
  assert.equal(await issueCommand(kernel, command, key), id)
  return waitForImport(kernel, id, 'preview_ready')
}

test('退出取消正在下载的网络，重启重做原下载意图而不自动安装', async () => {
  const blocked: SkillFetch = async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true },
      )
    })

  const fixture = await localKernelFixture(fakeCli, { skillFetch: blocked })
  let restarted: EmbeddedKernel | undefined
  try {
    const sourceId = await fixture.command({
      type: 'skill.source.save',
      expectedVersion: 0,
      name: '取消下载',
      repository: 'https://github.com/example/skills',
      commit: 'd'.repeat(40),
    })

    const id = await fixture.command({
      type: 'skill.import',
      sourceId,
      sourceVersion: 1,
      directory: 'skills/test-skill',
      licensePath: 'LICENSE',
    })

    await waitForImport(fixture.kernel, id, 'fetching')
    await fixture.kernel.shutdown()
    restarted = createKernel({
      dataDirectory: fixture.dataDirectory,
      sourceCommit: 'a'.repeat(40),
      skillFetch: skillFixtureFetch(),
    })
    await waitForImport(restarted, id, 'preview_ready')
    assert.equal((await readSnapshot(restarted)).skills.length, 0)
    assert.equal((await readSnapshot(restarted)).skillImports.length, 1)
  } finally {
    await restarted?.shutdown()
    await fixture.cleanup()
  }
})

test('技能预览不自动安装；原子激活、固定角色/Run、卸载保留历史，技能不混入交付', async () => {
  const fixture = await localKernelFixture(fakeCli, {
    skillFetch: skillFixtureFetch(),
  })

  try {
    const preview = await importSkill(fixture.kernel)
    assert.ok(preview.package)
    assert.equal((await fixture.snapshot()).skills.length, 0)

    const intent = {
      type: 'skill.activate' as const,
      id: preview.id,
      expectedVersion: preview.version,
      digest: preview.package.digest,
    }

    await assert.rejects(
      fixture.command({ ...intent, digest: 'b'.repeat(64) }),
      /SKILL_PREVIEW_REQUIRED/,
    )
    await fixture.command(intent)
    await waitForImport(fixture.kernel, preview.id, 'installed')
    const skill = (await fixture.snapshot()).skills[0]!
    verifySkillDirectory(
      skillStoragePath(fixture.dataDirectory, skill.id, 'versions'),
      skill,
    )

    const roleId = await fixture.command({
      type: 'role.save',
      expectedVersion: 0,
      name: '技能角色',
      responsibility: '验证固定技能',
      cli: 'codex',
      model: '',
      permission: 'read-only',
      skills: [{ id: skill.id, digest: skill.digest }],
    })

    const trialId = await fixture.command({
      type: 'role.trial',
      roleId,
      expectedRoleVersion: 1,
      projectId: fixture.projectId,
    })

    assert.equal(
      (await waitForRun(fixture.kernel, trialId)).status,
      'succeeded',
    )

    const state = (await fixture.snapshot()).roleReadiness.find(
      (item) => item.roleId === roleId,
    )!

    await fixture.command({
      type: 'role.setEnabled',
      roleId,
      expectedRoleVersion: 1,
      expectedReadinessVersion: state.version,
      enabled: true,
    })

    const taskId = await fixture.command({
      type: 'task.create',
      projectId: fixture.projectId,
      roleId,
      title: '固定技能',
      goal: 'Fixture run',
      acceptanceCriteria: 'File evidence',
    })

    const runId = await fixture.command({
      type: 'run.start',
      taskId,
      expectedVersion: 1,
    })

    const run = await waitForRun(fixture.kernel, runId)
    assert.equal(run.status, 'succeeded')
    assert.equal(run.roleSnapshot.skills[0]?.digest, skill.digest)

    const delivery = (await fixture.snapshot()).deliveries.find(
      (item) => item.runId === runId,
    )!

    assert.match(delivery.diff, /result.txt/)
    assert.doesNotMatch(
      delivery.diff,
      /weftpilot-skills|SKILL.md|manifest.json/,
    )
    const upgrade = await importSkill(fixture.kernel)
    assert.equal(upgrade.comparisonPackageId, skill.id)
    await fixture.command({
      type: 'skill.activate',
      id: upgrade.id,
      expectedVersion: upgrade.version,
      digest: upgrade.package!.digest,
    })
    await waitForImport(fixture.kernel, upgrade.id, 'installed')
    assert.equal(
      (await fixture.snapshot()).skillImports.find(
        (item) => item.id === preview.id,
      )?.comparisonPackageId,
      null,
    )
    await fixture.command({
      type: 'skill.uninstall',
      id: skill.id,
      expectedVersion: 1,
    })
    assert.equal((await fixture.snapshot()).skills[0]?.available, false)
    assert.ok(
      existsSync(skillStoragePath(fixture.dataDirectory, skill.id, 'versions')),
    )
    assert.deepEqual(
      (await fixture.snapshot()).runs.find((item) => item.id === runId)
        ?.roleSnapshot,
      run.roleSnapshot,
    )
    await assert.rejects(
      fixture.command({
        type: 'role.save',
        id: roleId,
        expectedVersion: 1,
        name: '旧技能',
        responsibility: '不能重新使用卸载版本',
        cli: 'codex',
        model: '',
        permission: 'read-only',
        skills: run.roleSnapshot.skills,
      }),
      /SKILL_NOT_AVAILABLE/,
    )
    writeFileSync(
      join(
        run.workDirectory,
        runSkillDirectoryName(run),
        skill.id,
        skill.directory,
        'SKILL.md',
      ),
      'tampered',
    )
    const { verifyRunSkills } = await import('../src/kernel/run-skills.js')

    const database = new DatabaseSync(
      join(fixture.dataDirectory, 'kernel.sqlite'),
    )

    const { WorkspaceStore } = await import('../src/kernel/workspace-store.js')
    try {
      assert.throws(
        () => verifyRunSkills(new WorkspaceStore(database), run),
        /SKILL_DIGEST_MISMATCH/,
      )
    } finally {
      database.close()
    }
  } finally {
    await fixture.cleanup()
  }
})

test('安装rename完成但事务尚未写入时，重启核对摘要后完成原意图，不重复安装', async () => {
  const fixture = await localKernelFixture(fakeCli, {
    skillFetch: skillFixtureFetch(),
  })

  let restarted: EmbeddedKernel | undefined
  try {
    const preview = await importSkill(fixture.kernel)
    assert.ok(preview.package)
    await fixture.kernel.shutdown()

    const database = new DatabaseSync(
      join(fixture.dataDirectory, 'kernel.sqlite'),
    )

    const next = {
      ...preview,
      state: 'activating',
      version: preview.version + 1,
    }

    database
      .prepare('UPDATE skill_imports SET version=?,data=? WHERE id=?')
      .run(next.version, JSON.stringify(next), preview.id)
    database.close()
    activateSkillFiles({
      dataDirectory: fixture.dataDirectory,
      skill: preview.package,
    })
    restarted = createKernel({
      dataDirectory: fixture.dataDirectory,
      sourceCommit: 'b'.repeat(40),
      skillFetch: skillFixtureFetch(),
    })
    await waitForImport(restarted, preview.id, 'installed')
    assert.equal((await readSnapshot(restarted)).skills.length, 1)
    verifySkillDirectory(
      skillStoragePath(fixture.dataDirectory, preview.id, 'versions'),
      preview.package,
    )
  } finally {
    await restarted?.shutdown()
    await fixture.cleanup()
  }
})

test('下载内容与Git blob不符时失败且无可用技能，不把预览当安装成功', async () => {
  const fixture = await localKernelFixture(fakeCli, {
    skillFetch: skillFixtureFetch({ mutateBody: true }),
  })

  try {
    const sourceId = await fixture.command({
      type: 'skill.source.save',
      expectedVersion: 0,
      name: '损坏下载',
      repository: 'https://github.com/example/skills',
      commit: 'c'.repeat(40),
    })

    const id = await fixture.command({
      type: 'skill.import',
      sourceId,
      sourceVersion: 1,
      directory: 'skills/test-skill',
      licensePath: 'LICENSE',
    })

    const failure = await waitForImport(fixture.kernel, id, 'failed')
    assert.equal(failure.failureCode, 'SKILL_DIGEST_MISMATCH')
    assert.equal((await fixture.snapshot()).skills.length, 0)
  } finally {
    await fixture.cleanup()
  }
})
