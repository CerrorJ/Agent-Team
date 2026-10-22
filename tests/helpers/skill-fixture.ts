import { createHash } from 'node:crypto'
import type { SkillFetch } from '../../src/kernel/skill-download.js'

export const skillFixtureFiles = {
  'skills/test-skill/SKILL.md':
    '---\nname: test-skill\ndescription: |\n  多行技能描述\n---\nRead references/proof.txt and use its exact content.\n',
  'skills/test-skill/references/proof.txt':
    'weftpilot-independent-skill-proof\n',
  LICENSE: 'MIT License\nCopyright (c) WeftPilot synthetic test fixture\n',
}

/** 合成HTTP端口只用于错误与恢复测试；真实来源与CLI验收另行执行。 */
export const skillFixtureFetch = (
  options: {
    files?: Record<string, string>
    mutateBody?: boolean
  } = {},
): SkillFetch => {
  const files: Record<string, string> = options.files ?? skillFixtureFiles
  return async (url, init) => {
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const target = String(url)
    if (target.startsWith('https://api.github.com/repos/')) {
      return new Response(
        JSON.stringify({
          truncated: false,
          tree: Object.entries(files).map(([path, body]) => {
            const bytes = Buffer.from(body)
            return {
              path,
              type: 'blob',
              mode: '100644',
              size: bytes.length,
              sha: createHash('sha1')
                .update(`blob ${bytes.length}\0`)
                .update(bytes)
                .digest('hex'),
            }
          }),
        }),
      )
    }
    const path = new URL(target).pathname.split('/').slice(4).join('/')
    const body = files[path]
    if (body === undefined) return new Response('', { status: 404 })
    return new Response(options.mutateBody ? body.replace('MIT', 'BAD') : body)
  }
}
