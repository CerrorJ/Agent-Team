import { readdir, readFile } from 'node:fs/promises'

const check = async (path) => {
  const count = (await readFile(path, 'utf8')).trimEnd().split('\n').length
  const limit = path.startsWith('tests/') ? 800 : 500
  if (count > limit) throw new Error(`${path}: ${count} 行，超过 ${limit} 行`)
}
const inspect = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) await inspect(path)
    else if (/\.(ts|mjs)$/.test(path)) await check(path)
  }
}
for (const directory of ['src/kernel', 'src/domain', 'tests', 'scripts'])
  await inspect(directory)
for (const file of [
  'windows-command',
  'controlled-codex',
  'controlled-claude',
  'bounded-lines',
  'process-stop',
])
  await check(`src/cli/${file}.ts`)
