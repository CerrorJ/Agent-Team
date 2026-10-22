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
  throw new Error(`缺少捆绑依赖许可：${root}`)
}
