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

  /** 获取指定 bot 所在分组的所有成员（未指定 group 则自身单独成组） */
  getGroupMembers(botId: string): BotConfig[] {
    const current = this.configs.get(botId)
    if (!current) return []
    const groupName = current.group ?? current.id
    return this.members.filter((m) => (m.group ?? m.id) === groupName)
  }

  /** 获取指定 bot 所在分组中当前可用的备用成员列表（排除自身及已受限成员） */
  getAvailableFallbackMembers(botId: string): BotConfig[] {
    const groupMembers = this.getGroupMembers(botId)
    return groupMembers.filter(
      (m) => m.id !== botId && !sessionLimitTracker.isLimited(m.id),
    )
  }

  /** 判断指定 bot 所在分组是否全员限额不可用 */
  isGroupExhausted(botId: string): boolean {
    const groupMembers = this.getGroupMembers(botId)
    return (
      groupMembers.length > 0 &&
      groupMembers.every((m) => sessionLimitTracker.isLimited(m.id))
    )
  }

  contextFor(currentBotId: string): string {
    const current = this.configs.get(currentBotId)
    if (!current) throw new Error(`团队成员不存在: ${currentBotId}`)

    const roster = this.members.map((member) => {
      const leader = member.id === this.leaderBotId ? '（Team Leader）' : ''
      const limitInfo = sessionLimitTracker.getLimitInfo(member.id)

      const limitNote = limitInfo.isLimited
        ? `【当前会话限额不可用${limitInfo.resetsText ? `，${limitInfo.resetsText}` : ''}】`
        : ''

      const groupTag = member.group ? ` [分组:${member.group}]` : ''

      const skills =
        member.skills.length > 0
          ? `；Skills：${member.skills.map((skill) => `$${skill}`).join('、')}`
          : ''

      return `- ${member.id}${leader}${groupTag}：${member.role}${limitNote}${skills}`
    })

    const isLeader = current.id === this.leaderBotId

    // 动态扫描所有分组的限流状态，生成精准的 Leader 调度指引，不写死任何特定的 botId 或模型名称
    const groupPolicyNotices: string[] = []
    if (isLeader) {
      const groups = new Map<string, BotConfig[]>()
      for (const member of this.members) {
        const groupName = member.group ?? member.id
        const list = groups.get(groupName) ?? []
        list.push(member)
        groups.set(groupName, list)
      }

      for (const [groupName, members] of groups.entries()) {
        const limitedMembers = members.filter((m) =>
          sessionLimitTracker.isLimited(m.id),
        )

        if (limitedMembers.length === 0) continue

        const availableMembers = members.filter(
          (m) => !sessionLimitTracker.isLimited(m.id),
        )

        if (availableMembers.length === 0) {
          // 全员受限
          groupPolicyNotices.push(
            `重要提示：分组 "${groupName}" 内所有成员（${members.map((m) => m.id).join('、')}）均已触发会话限额不可用。严禁继续向该组派发任务。如果当前流程需要该组职能，请直接向用户汇报说明团队资源不可用，并请用户确认决策。`,
          )
        } else {
          // 部分受限，有备用成员
          groupPolicyNotices.push(
            `重要提示：分组 "${groupName}" 中的成员（${limitedMembers.map((m) => m.id).join('、')}）当前触发了会话限额不可用。涉及该分组职责的任务，必须使用 dispatch_task 派发给同组可用成员（${availableMembers.map((m) => `targetBotId="${m.id}"`).join(' 或 ')}）接续推进。派发时应提醒接替成员直接检查工作区现有改动，基于现场继续，避免从零重复劳动，以严格节省 Token。`,
          )
        }
      }
    }

    const leaderPolicy = isLeader
      ? [
          '团队协作标准流转链：需求澄清/方案(product) -> 代码实现(developer) -> 质量审查(reviewer) -> 冒烟测试与功能验收(tester) -> 汇总交付(ceo-assistant)。',
          '作为 Team Leader，你是组织与调度者，严禁自己直接使用 Bash 编写业务代码或执行冒烟测试。',
          '遇到涉及代码实现、代码审查或冒烟测试的任务时，必须调用 dispatch_task 工具派发给对应专业成员（冒烟与验收测试必须指定 targetBotId="tester"），等待对方回传结论后再向用户汇总。',
          ...groupPolicyNotices,
        ]
          .filter(Boolean)
          .join('\n')
      : ''

    return [
      '你所在的 Agent 团队：',
      ...roster,
      `你当前以 ${current.id} 的身份工作。只处理交给你的职责；需要其他成员参与时，清楚说明希望交给谁以及期望结果。`,
      '团队名单中的成员都是真实的飞书 bot。CLI 内部子 Agent 适合处理临时分工，不能冒充这些长期团队成员。',
      '需要把任务交给其他成员时，使用 dispatch_task 工具，由 Agent Team 发送协作卡片并真正 @ 对方。只有 CEO 助理可以在运行时调用该工具；targetBotId 必须来自上面的团队名单，不能填写自己。',
      leaderPolicy,
      '用户需要定时执行任务时，使用 schedule_manage 工具（action=add）把需求转换成 targetBotId、prompt 和 rule；到点后 Agent Team 会自动派发。',
    ]
      .filter(Boolean)
      .join('\n')
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
