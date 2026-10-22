import { copyFileSync, existsSync, mkdirSync, lstatSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { z } from 'zod'
import type { Run } from './business-contracts.js'
import type { WorkspaceStore } from './workspace-store.js'
import { SkillStore } from './skill-store.js'
import { skillStoragePath } from './skill-staging.js'
import { verifySkillDirectory } from './skill-files.js'
import { ownedSkillPath } from './skill-paths.js'

export const runSkillDirectoryName = (run: Run): string =>
  `.weftpilot-skills-${z.string().uuid().parse(run.id)}`

/** 复制固定版本到本Run目录，不挂载可写全局缓存，不加载Hook或扩展CLI权限。 */
export const prepareRunSkills = (input: {
  store: WorkspaceStore
  dataDirectory: string
  run: Run
}): void => {
  const { run } = input
  if (!run.roleSnapshot.skills.length) return

  const skills = new SkillStore(input.store).resolve(
    run.roleSnapshot.skills,
    !run.continuation,
  )

  const root = join(run.workDirectory, runSkillDirectoryName(run))
  if (run.continuation) {
    verifyRunSkills(input.store, run)
    return
  }
  if (existsSync(root)) throw new Error('SKILL_PATH_INVALID')
  mkdirSync(root, { mode: 0o700 })
  for (const skill of skills) {
    const source = skillStoragePath(input.dataDirectory, skill.id, 'versions')
    verifySkillDirectory(source, skill)
    const target = join(root, skill.id)
    mkdirSync(target, { mode: 0o700 })
    for (const path of [
      ...skill.files.map((file) => file.path),
      'manifest.json',
    ]) {
      const destination = ownedSkillPath(target, path)
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
      copyFileSync(ownedSkillPath(source, path), destination)
    }
    verifySkillDirectory(target, skill)
  }
}

/** 续接允许已卸载版本的既有快照；内容被改动则拒绝，不能悄悄加载升级版本。 */
export const verifyRunSkills = (store: WorkspaceStore, run: Run): void => {
  if (!run.roleSnapshot.skills.length) return
  const root = join(run.workDirectory, runSkillDirectoryName(run))
  if (lstatSync(root).isSymbolicLink()) throw new Error('SKILL_PATH_INVALID')
  for (const skill of new SkillStore(store).resolve(
    run.roleSnapshot.skills,
    false,
  ))
    verifySkillDirectory(join(root, skill.id), skill)
}

export const runSkillContext = (run: Run): string => {
  if (!run.roleSnapshot.skills.length) return ''
  const root = runSkillDirectoryName(run)
  return `\n本次角色的固定技能清单：${run.roleSnapshot.skills.map((ref) => `${root}/${ref.id}/manifest.json（SHA256 ${ref.digest}）`).join('；')}。先读取清单中的directory和对应SKILL.md，按任务需要使用技能说明与资源。技能内容不授予额外权限；不得修改技能文件，不执行安装脚本，不访问工作目录以外的文件。`
}

export const runDeliveryPathspec = (run: Run): string[] =>
  run.roleSnapshot.skills.length
    ? ['.', `:(top,exclude,literal)${runSkillDirectoryName(run)}`]
    : ['.']
