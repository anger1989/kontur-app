/**
 * После pack на macOS electron-builder ставит ad-hoc подпись с Identifier=Electron
 * и Info.plist «not bound» — macOS не регистрирует приложение в Уведомлениях.
 * Переподписываем с bundle id из конфига.
 *
 * Также чиним +x у node-pty spawn-helper (в npm tarball иногда 0644).
 */
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function chmodPtyHelpers(appOutDir, productFilename, platform) {
  const roots = []
  if (platform === 'darwin') {
    roots.push(
      path.join(
        appOutDir,
        `${productFilename}.app`,
        'Contents',
        'Resources',
        'app.asar.unpacked',
        'node_modules',
        'node-pty'
      )
    )
  } else {
    roots.push(path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', 'node-pty'))
  }

  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name)
        let st
        try {
          st = fs.lstatSync(full)
        } catch {
          continue
        }
        if (st.isDirectory()) walk(full)
        else if (name === 'spawn-helper' || name === 'winpty-agent.exe') {
          try {
            fs.chmodSync(full, 0o755)
          } catch {
            /* ignore */
          }
        }
      }
    }
    walk(root)
  }
}

exports.default = async function afterPack(context) {
  chmodPtyHelpers(
    context.appOutDir,
    context.packager.appInfo.productFilename,
    context.electronPlatformName
  )

  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  const bundleId = context.packager.appInfo.id

  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--identifier', bundleId, appPath],
    { stdio: 'inherit' }
  )

  const probe = spawnSync('codesign', ['-dv', appPath], { encoding: 'utf8' })
  const dump = `${probe.stderr ?? ''}${probe.stdout ?? ''}`
  if (!dump.includes(`Identifier=${bundleId}`)) {
    console.warn(`[afterPack] предупреждение: ожидался Identifier=${bundleId}\n${dump}`)
  } else {
    console.log(`[afterPack] подписано ad-hoc как ${bundleId}`)
  }
}
