import {
  mkdirSync,
  writeFileSync,
  existsSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { SkillImport, SkillPackage } from './skill-contracts.js'
import {
  downloadSkillTree,
  selectSkillFiles,
  downloadSkillBlob,
  type SkillFetch,
} from './skill-download.js'
import { ownedSkillPath } from './skill-paths.js'
import { readSkillMetadata } from './skill-metadata.js'
import {
  skillContentDigest,
  skillSha256,
  verifySkillDirectory,
} from './skill-files.js'

export const skillStoragePath = (
  dataDirectory: string,
  id: string,
  area: 'staging' | 'versions',
): string => join(dataDirectory, 'skills', area, z.string().uuid().parse(id))

/** staging按导入意图独占；网络中断可清理重做，永不覆盖已安装的版本目录。 */
export const stageSkill = async (input: {
  dataDirectory: string
  item: SkillImport
  signal: AbortSignal
  fetcher: SkillFetch
}): Promise<SkillPackage> => {
  const { item, dataDirectory } = input
  const root = skillStoragePath(dataDirectory, item.id, 'staging')
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true, mode: 0o700 })

  const tree = await downloadSkillTree({
    source: item.source,
    signal: input.signal,
    fetcher: input.fetcher,
  })

  const files = selectSkillFiles({
    tree,
    directory: item.directory,
    licensePath: item.licensePath,
  })

  const manifest: SkillPackage['files'] = []
  for (const blob of files) {
    input.signal.throwIfAborted()

    const bytes = await downloadSkillBlob({
      source: item.source,
      blob,
      signal: input.signal,
      fetcher: input.fetcher,
    })

    const path = ownedSkillPath(root, blob.path)
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
    manifest.push({
      path: blob.path,
      size: bytes.length,
      sha256: skillSha256(bytes),
    })
  }
  return finishStaging({ item, root, files: manifest })
}

const finishStaging = (input: {
  item: SkillImport
  root: string
  files: SkillPackage['files']
}): SkillPackage => {
  const { item, root, files } = input

  // 前面已限制下载大小；这里只读取本导入意图自己的普通文件。
  const metadata = readSkillMetadata({
    text: readText(root, `${item.directory}/SKILL.md`),
    directory: item.directory,
  })

  const base = {
    id: item.id,
    version: 1,
    source: item.source,
    directory: item.directory,
    name: metadata.name,
    description: metadata.description,
    instructions: readText(root, `${item.directory}/SKILL.md`),
    licensePath: item.licensePath,
    licenseText: readText(root, item.licensePath),
    files,
    available: true,
    installedAt: new Date().toISOString(),
  }

  const skill = { ...base, digest: skillContentDigest(base) }
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(skill), {
    flag: 'wx',
    mode: 0o600,
  })
  verifySkillDirectory(root, skill)
  return skill
}

import { readFileSync } from 'node:fs'

const readText = (root: string, path: string): string => {
  const bytes = readFileSync(ownedSkillPath(root, path))
  if (bytes.length > 64_000) throw new Error('SKILL_SIZE_LIMIT')
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/** 目录原子rename后才入库；崩溃后按原意图核对已存在目录，不能将存在等同安装成功。 */
export const activateSkillFiles = (input: {
  dataDirectory: string
  skill: SkillPackage
}): void => {
  const staged = skillStoragePath(
    input.dataDirectory,
    input.skill.id,
    'staging',
  )

  const target = skillStoragePath(
    input.dataDirectory,
    input.skill.id,
    'versions',
  )

  if (!existsSync(target)) {
    verifySkillDirectory(staged, input.skill)
    mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 })
    renameSync(staged, target)
  }
  verifySkillDirectory(target, input.skill)
}
