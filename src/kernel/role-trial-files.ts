import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Run, RoleVersion } from './business-contracts.js'

/** 随机挑战仅写入本次拥有的 worktree，不放入模型提示，验证确实读写而非口头宣称成功。 */
export const prepareTrialInput = (run: Run): void => {
  if (!run.trial) return
  writeFileSync(
    join(run.workDirectory, run.trial.inputFile),
    `${run.trial.challenge}\n`,
    { flag: 'wx', mode: 0o600 },
  )
}

export const trialSucceeded = (run: Run, answer: string): boolean => {
  if (!run.trial) return true
  if (!run.trial.outputFile) return answer.includes(run.trial.challenge)
  try {
    const file = join(run.workDirectory, run.trial.outputFile)
    if (!lstatSync(file).isFile()) return false
    return readFileSync(file, 'utf8').trim() === run.trial.challenge
  } catch {
    return false
  }
}

export const executionPrompt = (run: Run): string => {
  const trial = run.trial

  const goal = trial
    ? `这是一次独立的角色配置读写检查。读取当前目录的 ${trial.inputFile}，${trial.outputFile ? `用文件写入工具把其内容原样保存为 ${trial.outputFile}` : '原样返回文件中的内容'}。完成后立即结束，仅简短报告结果；不要扫描仓库或继续其他工作。不得访问网络、安装软件、读写其他目录或提交代码。`
    : `${run.goalSnapshot}\n验收条件：${run.acceptanceSnapshot}\n此前退回意见：${run.feedbackSnapshot || '无'}`

  const requirement = run.requirementSnapshot

  const context = requirement
    ? `\n固定需求 ${requirement.title} / v${requirement.version}：\n${requirement.body}\n需求验收条件：${requirement.acceptanceCriteria}`
    : ''

  const role = run.roleSnapshot

  const requirements = trial ? '' : roleExpectations(role)

  return `职责：${role.responsibility}${requirements}\n任务：${goal}${context}${trial ? '' : projectContext(run)}`
}

const projectContext = (run: Run): string => {
  const project = run.projectContextSnapshot

  if (!project?.goal && !project?.description) return ''
  return `\n固定项目 ${project.name} / v${project.projectVersion}：${project.goal ? `\n项目目标：${project.goal}` : ''}${project.description ? `\n项目描述：${project.description}` : ''}`
}

/** 仅注入该快照明确保存的要求；旧Run缺省字段时保持原提示，不补造配置。 */
const roleExpectations = (role: RoleVersion): string =>
  [
    role.inputRequirements ? `\n输入要求：${role.inputRequirements}` : '',
    role.deliveryRequirements ? `\n交付要求：${role.deliveryRequirements}` : '',
  ].join('')
