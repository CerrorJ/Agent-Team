import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import {
  skillPackageSchema,
  skillSourceSchema,
  skillFileSchema,
  type SkillPackage,
} from './skill-contracts.js'
import { ownedSkillPath, validateSkillFileSet } from './skill-paths.js'

export const skillSha256 = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex')

/** 摘要只绑定不可变内容，不包括安装时间、启用状态和CAS版本。 */
export const skillContentDigest = (
  skill: Omit<SkillPackage, 'digest'>,
): string =>
  skillSha256(
    JSON.stringify({
      source: skillSourceSchema.parse(skill.source),
      directory: skill.directory,
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      licensePath: skill.licensePath,
      licenseText: skill.licenseText,
      files: skill.files.map((file) => skillFileSchema.parse(file)),
    }),
  )

export const verifySkillDirectory = (
  root: string,
  expected: SkillPackage,
): void => {
  const skill = skillPackageSchema.parse(expected)
  if (skillContentDigest(skill) !== skill.digest)
    throw new Error('SKILL_DIGEST_MISMATCH')
  validateSkillFileSet(skill.files.map((file) => file.path))
  const actual = listRegularFiles(root)
  if (
    actual.length !== skill.files.length + 1 ||
    !actual.includes('manifest.json')
  )
    throw new Error('SKILL_DIGEST_MISMATCH')

  const manifest = skillPackageSchema.parse(
    JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')),
  )

  if (
    manifest.id !== skill.id ||
    manifest.digest !== skill.digest ||
    skillContentDigest(manifest) !== skill.digest
  )
    throw new Error('SKILL_DIGEST_MISMATCH')
  for (const file of skill.files) {
    const bytes = readFileSync(ownedSkillPath(root, file.path))
    if (bytes.length !== file.size || skillSha256(bytes) !== file.sha256)
      throw new Error('SKILL_DIGEST_MISMATCH')
  }
}

const listRegularFiles = (root: string): string[] => {
  if (lstatSync(root).isSymbolicLink()) throw new Error('SKILL_PATH_INVALID')
  const canonical = realpathSync(root)
  const results: string[] = []
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      const local = relative(canonical, realpathSync(path))
      if (entry.isSymbolicLink() || isAbsolute(local) || local.startsWith('..'))
        throw new Error('SKILL_PATH_INVALID')
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile())
        results.push(relative(root, path).replaceAll('\\', '/'))
      else throw new Error('SKILL_PATH_INVALID')
    }
  }
  return results
}
