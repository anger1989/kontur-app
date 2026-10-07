/** Репозиторий релизов для проверки обновлений (без Developer ID). */
export const UPDATE_GITHUB_OWNER = 'anger1989'
export const UPDATE_GITHUB_REPO = 'kontur-app'
export const UPDATE_RELEASES_URL = `https://github.com/${UPDATE_GITHUB_OWNER}/${UPDATE_GITHUB_REPO}/releases`
export const UPDATE_LATEST_API = `https://api.github.com/repos/${UPDATE_GITHUB_OWNER}/${UPDATE_GITHUB_REPO}/releases/latest`

export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  available: boolean
  releaseUrl: string
  /** Прямая ссылка на .dmg (если есть в assets), иначе страница релиза. */
  downloadUrl: string
  body: string
}

/** Сравнить semver-подобные версии: 1 если a>b, -1 если a<b, 0 если равны. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}
