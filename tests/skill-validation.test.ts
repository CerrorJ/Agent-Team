import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  validateSkillPath,
  validateSkillFileSet,
} from '../src/kernel/skill-paths.js'
import { readSkillMetadata } from '../src/kernel/skill-metadata.js'
import {
  downloadSkillTree,
  selectSkillFiles,
} from '../src/kernel/skill-download.js'
import { randomUUID } from 'node:crypto'
import type { SkillSource } from '../src/kernel/skill-contracts.js'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { skillStoragePath } from '../src/kernel/skill-staging.js'

test('技能存储祖先为junction或symlink时拒绝，不清理外部目录', () => {
  const directory = mkdtempSync(join(tmpdir(), 'weftpilot-skill-junction-'))
  const data = join(directory, 'data')
  const outside = join(directory, 'outside')
  mkdirSync(data)
  mkdirSync(outside)
  symlinkSync(
    outside,
    join(data, 'skills'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  try {
    assert.throws(
      () => skillStoragePath(data, randomUUID(), 'staging'),
      /SKILL_PATH_INVALID/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('技能可移植路径拒绝遍历、Windows别名、凭据、Unicode和大小写覆盖', () => {
  for (const path of [
    '../bad',
    '/bad',
    'a\\b',
    'C:/bad',
    'a//b',
    'a/CON.txt',
    'a/b.',
    '.env',
    'a/auth.json',
    'e\u0301/a',
  ])
    assert.throws(() => validateSkillPath(path), /SKILL_PATH_INVALID/, path)
  assert.throws(
    () => validateSkillFileSet(['a/B.txt', 'a/b.txt']),
    /SKILL_PATH_INVALID/,
  )
  assert.throws(
    () => validateSkillFileSet(['a/b', 'a/b/c']),
    /SKILL_PATH_INVALID/,
  )
  assert.equal(
    validateSkillPath('中文技能/references/proof.txt'),
    '中文技能/references/proof.txt',
  )
})

test('SKILL YAML按规范读取多行描述，拒绝重复字段、别名与目录不匹配，不扩大权限', () => {
  const parse = (body: string) =>
    readSkillMetadata({
      directory: 'skills/test-skill',
      text: `---\n${body}\n---\nBody`,
    })

  assert.equal(
    parse('name: test-skill\ndescription: |\n  第一行\n  第二行')[
      'description'
    ],
    '第一行\n第二行',
  )
  assert.equal(
    parse('name: test-skill\ndescription: hello\nallowed-tools: Bash(*)')[
      'allowed-tools'
    ],
    'Bash(*)',
  )
  for (const body of [
    'name: other\ndescription: test',
    'name: test-skill\nname: test-skill\ndescription: test',
    'name: test-skill\ndescription: &text test\nlicense: *text',
    'name: test--skill\ndescription: test',
    'name: test-skill\ndescription: test\nunknown: unsafe',
  ])
    assert.throws(() => parse(body), /SKILL_METADATA_INVALID/)
})

test('公共来源边界拒绝截断树、symlink/submodule、缺许可证与数量超限', async () => {
  const source: SkillSource = {
    id: randomUUID(),
    version: 1,
    name: 'Synthetic',
    repository: 'https://github.com/example/skills',
    commit: 'a'.repeat(40),
    createdAt: new Date().toISOString(),
  }

  const signal = new AbortController().signal

  const fakeTree =
    (tree: unknown, truncated = false) =>
    async () =>
      new Response(JSON.stringify({ tree, truncated }))

  await assert.rejects(
    downloadSkillTree({ source, signal, fetcher: fakeTree([], true) }),
    /SKILL_SOURCE_INVALID/,
  )
  for (const mode of ['120000', '160000']) {
    await assert.rejects(
      downloadSkillTree({
        source,
        signal,
        fetcher: fakeTree([
          { path: 'a', mode, type: 'blob', sha: 'a'.repeat(40), size: 1 },
        ]),
      }),
      /SKILL_SOURCE_INVALID/,
    )
  }

  const file = {
    path: 'skills/test-skill/SKILL.md',
    sha: 'a'.repeat(40),
    size: 12,
  }

  assert.throws(
    () =>
      selectSkillFiles({
        tree: [file],
        directory: 'skills/test-skill',
        licensePath: 'LICENSE',
      }),
    /SKILL_SOURCE_INVALID/,
  )
  assert.throws(
    () =>
      selectSkillFiles({
        tree: [
          ...Array.from({ length: 202 }, (_, i) => ({
            ...file,
            path: `skills/test-skill/${i}`,
          })),
          file,
          { ...file, path: 'LICENSE' },
        ],
        directory: 'skills/test-skill',
        licensePath: 'LICENSE',
      }),
    /SKILL_SIZE_LIMIT/,
  )
})
