import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureTaskConfiguration } from '../src/kernel/run-snapshots.js'
import { executionPrompt } from '../src/kernel/role-trial-files.js'
import { randomUUID } from 'node:crypto'
import { workspaceFixture } from './helpers/run-fixture.js'
import { WorkspaceService } from '../src/kernel/workspace-service.js'
import { ProductStore } from '../src/kernel/product-store.js'
import {
  roleVersionSchema,
  type BusinessCommand,
} from '../src/kernel/business-contracts.js'
import {
  modelProfileSchema,
  requirementVersionSchema,
} from '../src/kernel/product-contracts.js'

const modelInput = {
  type: 'model.save' as const,
  expectedVersion: 0,
  name: '本机模型',
  cli: 'codex' as const,
  provider: 'cli-managed' as const,
  model: 'test-model-v1',
  baseUrl: '',
  credentialRef: null,
  reasoningEffort: '' as const,
}

test('共享用例保存模型版本，角色固定确切模型配置，旧版本回执和冲突不污染快照', async () => {
  const { database, store } = workspaceFixture({ persistRun: false })
  const service = new WorkspaceService({ store, dataDirectory: 'unused' })

  const command = (value: BusinessCommand, key = randomUUID()) =>
    service.command({ key, command: value }).id

  try {
    const key = randomUUID()
    const id = command(modelInput, key)
    assert.equal(command(modelInput, key), id)

    const roleId = command({
      type: 'role.save',
      expectedVersion: 0,
      name: '版本角色',
      responsibility: '测试职责',
      cli: 'codex',
      model: '',
      modelProfileId: id,
      permission: 'read-only',
    })

    command({ ...modelInput, id, expectedVersion: 1, model: 'test-model-v2' })
    const role = store.get('role_versions', roleId, roleVersionSchema)
    assert.equal(role.model, 'test-model-v1')
    assert.equal(role.modelProfileSnapshot?.version, 1)
    const products = new ProductStore(store)
    assert.equal(
      products.get('model_profiles', { id }, modelProfileSchema).model,
      'test-model-v2',
    )
    assert.throws(
      () =>
        command({
          ...modelInput,
          id,
          expectedVersion: 1,
          model: 'conflicting',
        }),
      /VERSION_CONFLICT/,
    )
    assert.equal(products.list('model_profiles', modelProfileSchema).length, 2)
    assert.throws(
      () =>
        command({
          type: 'role.save',
          expectedVersion: 0,
          name: '错误CLI',
          responsibility: '测试',
          cli: 'claude',
          model: '',
          modelProfileId: id,
          permission: 'read-only',
        }),
      /CLI_MODEL_MISMATCH/,
    )
  } finally {
    await service.shutdown()
    database.close()
  }
})

test('需求版本不改写既有任务引用；跨项目需求拒绝，团队成员与协调者受验证', async () => {
  const { database, store, run } = workspaceFixture({ persistRun: false })
  const service = new WorkspaceService({ store, dataDirectory: 'unused' })

  const command = (value: BusinessCommand) =>
    service.command({ key: randomUUID(), command: value }).id

  try {
    const requirement = {
      type: 'requirement.save' as const,
      expectedVersion: 0,
      projectId: run.projectId,
      title: '需求',
      body: '原始需求',
      acceptanceCriteria: '原始条件',
    }

    const id = command(requirement)
    command({
      type: 'task.create',
      projectId: run.projectId,
      roleId: run.roleSnapshot.id,
      title: '关联任务',
      goal: '实现',
      acceptanceCriteria: '验收',
      requirementRef: { id, version: 1 },
    })
    command({ ...requirement, id, expectedVersion: 1, body: '新版需求' })
    const products = new ProductStore(store)
    assert.equal(
      products.get(
        'requirement_versions',
        { id, version: 1 },
        requirementVersionSchema,
      ).body,
      '原始需求',
    )
    assert.equal(store.snapshot().tasks.at(-1)?.requirementRef?.version, 1)

    const configuration = captureTaskConfiguration(
      store,
      store.snapshot().tasks.at(-1)!,
      run.id,
    )

    const prompt = executionPrompt({ ...run, ...configuration })
    assert.match(prompt, /原始需求/)
    assert.doesNotMatch(prompt, /新版需求/)
    const otherProject = randomUUID()
    store.transaction(() =>
      store.addProject({
        id: otherProject,
        version: 1,
        name: '另一个项目',
        repositoryPath: 'another',
        gitUrl: '',
        defaultBranch: 'main',
        createdAt: new Date().toISOString(),
      }),
    )
    assert.throws(
      () =>
        command({
          type: 'task.create',
          projectId: otherProject,
          roleId: run.roleSnapshot.id,
          title: '无效引用',
          goal: '测试',
          acceptanceCriteria: '测试',
          requirementRef: { id, version: 1 },
        }),
      /CROSS_PROJECT_REFERENCE/,
    )
    assert.throws(
      () =>
        command({
          type: 'team.save',
          expectedVersion: 0,
          name: '无效团队',
          roleIds: [run.roleSnapshot.id],
          coordinatorRoleId: randomUUID(),
        }),
      /TEAM_CONFIG_INVALID/,
    )
    command({
      type: 'team.save',
      expectedVersion: 0,
      name: '开发团队',
      roleIds: [run.roleSnapshot.id],
      coordinatorRoleId: run.roleSnapshot.id,
    })
    assert.equal(store.snapshot().teams.length, 1)
    assert.equal(store.snapshot().tasks.length, 2)
  } finally {
    await service.shutdown()
    database.close()
  }
})
