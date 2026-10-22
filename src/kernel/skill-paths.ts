import { resolve, relative, isAbsolute, sep } from 'node:path'

const reserved = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i
const forbidden = new Set(['.git', '.env', 'credentials.json', 'auth.json'])

/** 同一技能必须可移植到Windows；拒绝别名、保留名及凭据文件，不进行静默改名。 */
export const validateSkillPath = (path: string): string => {
  if (!path || path.length > 240 || path !== path.normalize('NFC'))
    throw new Error('SKILL_PATH_INVALID')
  const parts = path.split('/')
  if (parts.some(invalidPart)) throw new Error('SKILL_PATH_INVALID')
  return path
}

const invalidPart = (part: string): boolean =>
  !part ||
  part === '.' ||
  part === '..' ||
  /[\\<>:"|?*\x00-\x1f\x7f]/.test(part) ||
  /[. ]$/.test(part) ||
  reserved.test(part) ||
  forbidden.has(part.toLowerCase()) ||
  part.toLowerCase().startsWith('.env.')

export const ownedSkillPath = (root: string, path: string): string => {
  validateSkillPath(path)
  const target = resolve(root, ...path.split('/'))
  const local = relative(resolve(root), target)
  if (
    !local ||
    local.startsWith(`..${sep}`) ||
    local === '..' ||
    isAbsolute(local)
  )
    throw new Error('SKILL_PATH_INVALID')
  return target
}

/** 在大小写不敏感文件系统也不能出现覆盖；父目录/文件冲突同样拒绝。 */
export const validateSkillFileSet = (paths: string[]): void => {
  const names = new Set<string>()
  for (const path of paths) {
    const key = validateSkillPath(path).toLowerCase()
    if (names.has(key)) throw new Error('SKILL_PATH_INVALID')
    names.add(key)
  }
  for (const name of names) {
    const parts = name.split('/')
    while (parts.length > 1) {
      parts.pop()
      if (names.has(parts.join('/'))) throw new Error('SKILL_PATH_INVALID')
    }
  }
}
