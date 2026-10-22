import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { SkillSource } from './skill-contracts.js'
import { validateSkillFileSet, validateSkillPath } from './skill-paths.js'

export type SkillFetch = typeof fetch
export interface SkillBlob {
  path: string
  sha: string
  size: number
}

const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.string(),
      sha: z.string().regex(/^[a-f0-9]{40}$/),
      size: z.number().int().nonnegative().optional(),
    }),
  ),
})

const repositoryParts = (source: SkillSource): string => {
  const parts = source.repository.slice('https://github.com/'.length).split('/')
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part))
  )
    throw new Error('SKILL_SOURCE_INVALID')
  return parts.map(encodeURIComponent).join('/')
}

/** 固定Git提交；只允许公共GitHub HTTPS，无凭据、重定向或用户提供的任意端点。 */
export const downloadSkillTree = async (input: {
  source: SkillSource
  signal: AbortSignal
  fetcher: SkillFetch
}): Promise<SkillBlob[]> => {
  const url = `https://api.github.com/repos/${repositoryParts(input.source)}/git/trees/${input.source.commit}?recursive=1`
  const data = await downloadBytes({ ...input, url, limit: 12_000_000 })
  const tree = treeSchema.safeParse(JSON.parse(data.toString('utf8')))
  if (!tree.success || tree.data.truncated)
    throw new Error('SKILL_SOURCE_INVALID')
  return tree.data.tree
    .filter((entry) => entry.type !== 'tree')
    .map((entry) => {
      if (
        entry.type !== 'blob' ||
        !['100644', '100755'].includes(entry.mode) ||
        entry.size === undefined
      )
        throw new Error('SKILL_SOURCE_INVALID')
      return { path: entry.path, sha: entry.sha, size: entry.size }
    })
}

export const selectSkillFiles = (input: {
  tree: SkillBlob[]
  directory: string
  licensePath: string
}): SkillBlob[] => {
  validateSkillPath(input.directory)
  validateSkillPath(input.licensePath)

  const files = input.tree.filter((file) =>
    file.path.startsWith(`${input.directory}/`),
  )

  const license = input.tree.find((file) => file.path === input.licensePath)
  if (
    !license ||
    !files.some((file) => file.path === `${input.directory}/SKILL.md`)
  )
    throw new Error('SKILL_SOURCE_INVALID')
  if (!files.some((file) => file.path === license.path)) files.push(license)
  if (
    files.length > 201 ||
    files.some((file) => file.size > 2_000_000) ||
    files.reduce((sum, file) => sum + file.size, 0) > 10_000_000
  )
    throw new Error('SKILL_SIZE_LIMIT')
  validateSkillFileSet(files.map((file) => file.path))
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

export const downloadSkillBlob = async (input: {
  source: SkillSource
  blob: SkillBlob
  signal: AbortSignal
  fetcher: SkillFetch
}): Promise<Buffer> => {
  const path = validateSkillPath(input.blob.path)
    .split('/')
    .map(encodeURIComponent)
    .join('/')

  const url = `https://raw.githubusercontent.com/${repositoryParts(input.source)}/${input.source.commit}/${path}`

  const bytes = await downloadBytes({
    ...input,
    url,
    limit: Math.min(2_000_000, input.blob.size),
  })

  const digest = createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex')

  if (bytes.length !== input.blob.size || digest !== input.blob.sha)
    throw new Error('SKILL_DIGEST_MISMATCH')
  return bytes
}

const downloadBytes = async (input: {
  url: string
  limit: number
  signal: AbortSignal
  fetcher: SkillFetch
}): Promise<Buffer> => {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15_000)])

  const response = await input.fetcher(input.url, {
    redirect: 'error',
    signal,
    credentials: 'omit',
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'WeftPilot-Skill-Importer',
    },
  })

  if (!response.ok || !response.body) throw new Error('SKILL_DOWNLOAD_FAILED')
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > input.limit) throw new Error('SKILL_SIZE_LIMIT')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
