import { readdir, mkdir, rename, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { shell } from 'electron'
import type { FsEntry, FsFavorite } from '@shared/types'
import { getConfig } from '../config/store'

const HIDDEN = (name: string): boolean => name.startsWith('.')

function home(): string {
  return homedir()
}

/** Нормализовать и проверить, что путь существует (для операций записи — вызывающий сам решает). */
export function resolvePath(p: string): string {
  const full = resolve(p)
  if (!full) throw new Error('Пустой путь')
  return full
}

export function favorites(): FsFavorite[] {
  const h = home()
  const list: FsFavorite[] = [
    { id: 'home', label: 'Домой', path: h },
    { id: 'desktop', label: 'Рабочий стол', path: join(h, 'Desktop') },
    { id: 'documents', label: 'Документы', path: join(h, 'Documents') },
    { id: 'downloads', label: 'Загрузки', path: join(h, 'Downloads') }
  ]
  const vault = getConfig().vaultPath
  if (vault) list.push({ id: 'vault', label: 'Заметки', path: vault })
  return list.filter((f) => existsSync(f.path))
}

export function homePath(): string {
  return home()
}

export async function list(dir: string): Promise<FsEntry[]> {
  const root = resolvePath(dir)
  const st = await stat(root)
  if (!st.isDirectory()) throw new Error('Не папка')

  const entries = await readdir(root, { withFileTypes: true })
  const out: FsEntry[] = []
  for (const e of entries) {
    if (HIDDEN(e.name)) continue
    const full = join(root, e.name)
    try {
      const s = await stat(full)
      const isDir = e.isDirectory() || s.isDirectory()
      out.push({
        name: e.name,
        path: full,
        kind: isDir ? 'dir' : 'file',
        size: isDir ? 0 : s.size,
        mtime: s.mtimeMs,
        ext: isDir ? '' : extname(e.name).replace(/^\./, '').toLowerCase()
      })
    } catch {
      /* нет прав / broken symlink */
    }
  }
  return out.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name, 'ru') : a.kind === 'dir' ? -1 : 1
  )
}

export async function openPath(p: string): Promise<void> {
  const err = await shell.openPath(resolvePath(p))
  if (err) throw new Error(err)
}

export function reveal(p: string): void {
  shell.showItemInFolder(resolvePath(p))
}

export async function makeDir(parent: string, name: string): Promise<string> {
  const safe = name.replace(/[\\/]/g, '').trim()
  if (!safe) throw new Error('Пустое имя')
  const full = join(resolvePath(parent), safe)
  await mkdir(full, { recursive: false })
  return full
}

export async function renamePath(from: string, newName: string): Promise<string> {
  const src = resolvePath(from)
  const safe = newName.replace(/[\\/]/g, '').trim()
  if (!safe) throw new Error('Пустое имя')
  const dest = join(dirname(src), safe)
  if (dest === src) return src
  if (existsSync(dest)) throw new Error('Уже существует')
  await rename(src, dest)
  return dest
}

export async function trash(p: string): Promise<void> {
  await shell.trashItem(resolvePath(p))
}

export function parentDir(p: string): string | null {
  const full = resolvePath(p)
  const parent = dirname(full)
  if (parent === full) return null
  return parent
}

export { basename }
