import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** 夹具始终使用物理路径；清理捕获创建时父目录，不随TEMP恢复而改变范围。 */
export const ownedTempDirectory = (prefix: string) => {
  if (!prefix || /[/\\]/.test(prefix)) throw new Error('FIXTURE_PREFIX_INVALID')
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  const parent = dirname(directory)
  return {
    directory,
    remove: () => {
      if (
        realpathSync.native(directory) !== directory ||
        dirname(directory) !== parent ||
        !basename(directory).startsWith(prefix)
      )
        throw new Error('FIXTURE_SCOPE_CHANGED')
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
