import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Run } from './business-contracts.js'

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
    ? `这是角色配置试运行。读取当前目录的 ${trial.inputFile}，${trial.outputFile ? `用文件写入工具把其内容原样保存为 ${trial.outputFile}` : '原样返回文件中的内容'}。不得访问网络、安装软件、读写其他目录或提交代码。`
    : `${run.goalSnapshot}\n验收条件：${run.acceptanceSnapshot}\n此前退回意见：${run.feedbackSnapshot || '无'}`

  const requirement = run.requirementSnapshot

  const context = requirement
    ? `\n固定需求 ${requirement.title} / v${requirement.version}：\n${requirement.body}\n需求验收条件：${requirement.acceptanceCriteria}`
    : ''

  return `职责：${run.roleSnapshot.responsibility}\n任务：${goal}${context}`
}
