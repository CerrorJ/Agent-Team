import { statSync } from 'node:fs'
import type { WorkspaceStore } from './workspace-store.js'
import type { WorkspaceSnapshot } from './workspace-contracts.js'
import { verifySkillDirectory } from './skill-files.js'
import { skillStoragePath } from './skill-staging.js'
import { discoverTool } from './tool-discovery.js'
import {
  environmentDiagnosticsSchema,
  type DiagnosticCheck,
} from './diagnostic-contracts.js'

/** 所有检查只读；不会修复数据库、重放Run、切换工作目录或验证模型认证。 */
export const inspectWorkspaceEnvironment = (input: {
  store: WorkspaceStore
  dataDirectory: string
}) => {
  const snapshot = input.store.snapshot()
  return environmentDiagnosticsSchema.parse({
    formatVersion: 1,
    checkedAt: new Date().toISOString(),
    checks: [
      databaseCheck(input.store),
      ...workspaceChecks(snapshot),
      ...skillChecks(snapshot, input.dataDirectory),
    ],
    authentication: 'unchecked',
    tools: (['git', 'codex', 'claude'] as const).map((id) => ({
      id,
      found: discoverTool(id),
      version: 'unchecked',
    })),
  })
}

const workspaceChecks = (snapshot: WorkspaceSnapshot): DiagnosticCheck[] => {
  const uncertain = snapshot.runs.filter(
    (run) => run.processState === 'uncertain',
  )

  const missingProjects = snapshot.projects.filter(
    (project) => !directoryExists(project.repositoryPath),
  )

  return [
    {
      id: 'processes',
      state: uncertain.length ? 'attention' : 'passed',
      code: 'PROCESS_RECONCILIATION',
      count: uncertain.length,
    },
    {
      id: 'projects',
      state: missingProjects.length ? 'attention' : 'passed',
      code: 'PROJECT_DIRECTORIES',
      count: missingProjects.length,
    },
    {
      id: 'trials',
      state: 'unchecked',
      code: 'ROLE_TRIAL_REQUIRED',
      count: snapshot.roleReadiness.filter((role) => role.state === 'ready')
        .length,
    },
  ]
}

const skillChecks = (
  snapshot: WorkspaceSnapshot,
  dataDirectory: string,
): DiagnosticCheck[] => {
  const checks: DiagnosticCheck[] = []
  for (const skill of snapshot.skills.slice(0, 100)) {
    try {
      verifySkillDirectory(
        skillStoragePath(dataDirectory, skill.id, 'versions'),
        skill,
      )
      checks.push({
        id: `skill-${skill.id}`,
        objectId: skill.id,
        state: 'passed',
        code: 'SKILL_INTEGRITY',
      })
    } catch {
      checks.push({
        id: `skill-${skill.id}`,
        objectId: skill.id,
        state: 'failed',
        code: 'SKILL_INTEGRITY',
      })
    }
  }
  if (snapshot.skills.length > 100)
    checks.push({
      id: 'skill-limit',
      state: 'unchecked',
      code: 'SKILL_SCAN_LIMIT',
      count: snapshot.skills.length - 100,
    })
  return checks
}

const directoryExists = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const databaseCheck = (store: WorkspaceStore): DiagnosticCheck => {
  try {
    const healthy =
      store.database.prepare('PRAGMA quick_check(1)').get()?.quick_check ===
      'ok'

    const invalidForeignKey = store.database
      .prepare('PRAGMA foreign_key_check')
      .get()

    return {
      id: 'database',
      state: healthy && !invalidForeignKey ? 'passed' : 'failed',
      code: 'DATABASE_INTEGRITY',
    }
  } catch {
    return { id: 'database', state: 'failed', code: 'DATABASE_INTEGRITY' }
  }
}
