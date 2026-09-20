import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sessionLimitTracker } from './session-limit-tracker.js'
import type { BotConfig } from './bot-registry.js'

export interface MissingSkill {
  botId: string
  skill: string
  searchedPaths: string[]
}

export class TeamRegistry {
  private readonly configs = new Map<string, BotConfig>()

  constructor(
    readonly leaderBotId: string,
    configs: BotConfig[],
  ) {
    for (const config of configs) this.configs.set(config.id, config)
    if (!this.configs.has(leaderBotId)) {
      throw new Error(`Team Leader 不存在: ${leaderBotId}`)
    }
  }

  get leader(): BotConfig {
    return this.configs.get(this.leaderBotId)!
  }

  get members(): BotConfig[] {
    return [...this.configs.values()]
  }

  get(botId: string): BotConfig | undefined {
    return this.configs.get(botId)
  }

  // 获取指定 bot 所在分组的所有成员（未指定 group 则自身单独成组）
  getGroupMembers(botId: string): BotConfig[] {
    const current = this.configs.get(botId)
    if (!current) return []
    const groupName = current.group ?? current.id
    return this.members.filter((m) => (m.group ?? m.id) === groupName)
  }

  // 获取指定 bot 所在分组中当前可用的备用成员列表（排除自身及已受限成员）
  getAvailableFallbackMembers(botId: string): BotConfig[] {
    const groupMembers = this.getGroupMembers(botId)
    return groupMembers.filter(
      (m) => m.id !== botId && !sessionLimitTracker.isLimited(m.id),
    )
  }

  contextFor(currentBotId: string): string {
    const current = this.configs.get(currentBotId)
    if (!current) throw new Error(`团队成员不存在: ${currentBotId}`)

    const roster = this.members.map((member) => {
      const leader = member.id === this.leaderBotId ? '（Team Leader）' : ''

      const skills =
        member.skills.length > 0
          ? `；Skills：${member.skills.map((skill) => `$${skill}`).join('、')}`
          : ''

      return `- ${member.id}${leader}：${member.role}${skills}`
    })

    return [
      '你所在的 Agent 团队：',
      ...roster,
      `你当前以 ${current.id} 的身份工作。只处理交给你的职责；需要其他成员参与时，清楚说明希望交给谁以及期望结果。`,
      // 明确提示由宿主自动接管跨 Bot 协作流转，禁止 Bot 私下通过 SendMessage 互发消息造成状态脱管
      '团队名单中的成员都是真实的飞书 bot。跨 bot 协作与结果交接由 Agent Team 宿主系统自动处理，不要使用 SendMessage 等内部通信工具尝试向团队成员发消息。CLI 内部子 Agent 仅适合处理临时单机分工，不能冒充这些长期团队成员。',
      '需要把任务交给其他成员时，使用 dispatch_task 工具，由 Agent Team 发送协作卡片并真正 @ 对方。只有 CEO 助理可以在运行时调用该工具；targetBotId 必须来自上面的团队名单，不能填写自己。',
      '用户需要定时执行任务时，使用 schedule_manage 工具（action=add）把需求转换成 targetBotId、prompt 和 rule；到点后 Agent Team 会自动派发。',
    ].join('\n')
  }

  async findMissingSkills(): Promise<MissingSkill[]> {
    const missing: MissingSkill[] = []
    for (const config of this.members) {
      for (const skill of config.skills) {
        const searchedPaths = [
          join(config.workspaceDir, '.agents', 'skills', skill, 'SKILL.md'),
          join(config.workspaceDir, '.claude', 'skills', skill, 'SKILL.md'),
          join(homedir(), '.agents', 'skills', skill, 'SKILL.md'),
          join(homedir(), '.claude', 'skills', skill, 'SKILL.md'),
          join(homedir(), '.codex', 'skills', skill, 'SKILL.md'),
        ]

        if (!(await somePathExists(searchedPaths))) {
          missing.push({ botId: config.id, skill, searchedPaths })
        }
      }
    }
    return missing
  }
}

const somePathExists = async (paths: string[]): Promise<boolean> => {
  for (const path of paths) {
    try {
      await access(path)
      return true
    } catch {
      // 继续检查另一个项目级 Skill 目录。
    }
  }
  return false
}
