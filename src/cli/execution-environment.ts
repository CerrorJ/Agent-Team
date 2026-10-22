/** 自定义提供方不继承其他账户密钥、代理认证或供应商切换变量；保留启动 CLI 所需系统路径。 */
export const cliEnvironment = (
  mode: 'inherit' | 'isolated' | undefined,
): NodeJS.ProcessEnv => {
  if (mode !== 'isolated') return process.env

  const allowed = new Set([
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMDATA',
    'HOMEDRIVE',
    'HOMEPATH',
    'LANG',
    'LC_ALL',
    'TERM',
    'TERM_PROGRAM',
  ])

  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      allowed.has(key.toUpperCase()),
    ),
  )
}
