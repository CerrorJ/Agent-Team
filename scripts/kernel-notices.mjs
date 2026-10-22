import { readFile, writeFile } from 'node:fs/promises'

/** 从实际 bundle 的依赖图收集许可，新增 MCP 依赖不能沿用仅含 Zod 的旧声明。 */
export const writeKernelNotices = async (metafile, output) => {
  const roots = new Set()
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.includes('node_modules/')) continue
    const tail = input
      .split('/node_modules/')
      .at(-1)
      .replace(/^node_modules\//, '')
    const segments = tail.split('/')
    const name = segments
      .slice(0, segments[0].startsWith('@') ? 2 : 1)
      .join('/')
    roots.add(input.slice(0, input.length - tail.length) + name)
  }
  const notices = [
    'Agent-Team: ISC (package.json), source https://github.com/CerrorJ/Agent-Team',
    'Node.js runtime/SQLite supplied by host Node/Electron; not vendored.',
  ]
  for (const root of [...roots].sort()) {
    const metadata = JSON.parse(await readFile(`${root}/package.json`, 'utf8'))
    const source =
      metadata.repository?.url ?? metadata.repository ?? metadata.homepage ?? ''
    notices.push(
      `${metadata.name} ${metadata.version} / ${JSON.stringify(metadata.license)}\n${source}\n${await licenseText(root)}`,
    )
  }
  await writeFile(
    `${output}/THIRD-PARTY-NOTICES.txt`,
    notices.join('\n\n') + '\n',
  )
}

const licenseText = async (root) => {
  for (const name of [
    'LICENSE',
    'LICENSE.md',
    'LICENSE.txt',
    'license',
    'license.md',
    'LICENSE-MIT',
  ]) {
    try {
      return await readFile(`${root}/${name}`, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  // 两个锁定旧包将完整 MIT 文本放在 README，未附独立 LICENSE；不对任意依赖宽泛兜底。
  if (root.endsWith('/agent-base') || root.endsWith('/https-proxy-agent')) {
    const metadata = JSON.parse(await readFile(`${root}/package.json`, 'utf8'))
    const readme = await readFile(`${root}/README.md`, 'utf8')
    if (
      { 'agent-base': '6.0.2', 'https-proxy-agent': '5.0.1' }[metadata.name] ===
        metadata.version &&
      metadata.license === 'MIT' &&
      readme.includes('Permission is hereby granted, free of charge') &&
      readme.includes("THE SOFTWARE IS PROVIDED 'AS IS'")
    )
      return readme
  }
  throw new Error(`缺少捆绑依赖许可：${root}`)
}
