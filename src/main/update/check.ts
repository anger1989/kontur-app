import { app, shell } from 'electron'
import {
  UPDATE_LATEST_API,
  UPDATE_RELEASES_URL,
  compareVersions,
  type UpdateInfo
} from '@shared/update'
import { logWarn } from '../log'

interface GhRelease {
  tag_name?: string
  html_url?: string
  body?: string
  assets?: { name?: string; browser_download_url?: string }[]
}

/**
 * Проверка обновлений через публичный GitHub Releases.
 * Без Developer ID: не подменяем .app, а отдаём ссылку на DMG / страницу релиза.
 */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const currentVersion = app.getVersion()
  const res = await fetch(UPDATE_LATEST_API, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': `Kontur/${currentVersion}`
    }
  })
  if (res.status === 404) {
    return {
      currentVersion,
      latestVersion: currentVersion,
      available: false,
      releaseUrl: UPDATE_RELEASES_URL,
      downloadUrl: UPDATE_RELEASES_URL,
      body: ''
    }
  }
  if (!res.ok) {
    throw new Error(`GitHub Releases: HTTP ${res.status}`)
  }
  const data = (await res.json()) as GhRelease
  const latestVersion = (data.tag_name ?? '').replace(/^v/i, '')
  if (!latestVersion) {
    throw new Error('В релизе нет tag_name')
  }
  const dmg =
    data.assets?.find((a) => /\.dmg$/i.test(a.name ?? ''))?.browser_download_url ??
    data.html_url ??
    UPDATE_RELEASES_URL
  const available = compareVersions(latestVersion, currentVersion) > 0
  return {
    currentVersion,
    latestVersion,
    available,
    releaseUrl: data.html_url ?? UPDATE_RELEASES_URL,
    downloadUrl: dmg,
    body: (data.body ?? '').slice(0, 2000)
  }
}

export async function openUpdateDownload(url?: string): Promise<void> {
  const target = url?.trim() || UPDATE_RELEASES_URL
  await shell.openExternal(target)
}

/** Тихий check при старте — только если есть новая версия. */
export async function silentCheckForUpdate(): Promise<UpdateInfo | null> {
  try {
    const info = await checkForUpdate()
    return info.available ? info : null
  } catch (e) {
    logWarn('update', e instanceof Error ? e.message : String(e))
    return null
  }
}
