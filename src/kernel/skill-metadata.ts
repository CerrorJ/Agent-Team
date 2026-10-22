import { parseDocument } from 'yaml'
import { z } from 'zod'

const metadataSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().trim().min(1).max(1024),
    license: z.string().max(2000).optional(),
    compatibility: z.string().max(500).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    'allowed-tools': z.string().max(2000).optional(),
  })
  .strict()

/** YAML只提供描述；allowed-tools不会修改角色权限，也不会执行安装脚本。 */
export const readSkillMetadata = (input: {
  text: string
  directory: string
}) => {
  if (Buffer.byteLength(input.text) > 64_000)
    throw new Error('SKILL_METADATA_INVALID')

  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
    input.text,
  )?.[1]

  if (!frontmatter || Buffer.byteLength(frontmatter) > 8000)
    throw new Error('SKILL_METADATA_INVALID')
  try {
    const document = parseDocument(frontmatter, {
      strict: true,
      uniqueKeys: true,
    })

    if (document.errors.length || document.warnings.length)
      throw new Error('Invalid YAML')
    const parsed = metadataSchema.parse(document.toJS({ maxAliasCount: 0 }))
    if (parsed.name !== input.directory.split('/').at(-1))
      throw new Error('Directory mismatch')
    return parsed
  } catch {
    throw new Error('SKILL_METADATA_INVALID')
  }
}
