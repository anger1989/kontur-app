import { readdir, readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, basename, relative, sep } from 'node:path'
import type { NoteDoc, NoteRef, NoteSearchHit, VaultNode } from '@shared/types'
import { getConfig, patchConfig } from '../config/store'
import { defaultVaultPath } from '../config/paths'

const MD = '.md'
const IGNORED = new Set(['.git', '.obsidian', 'node_modules', '.trash'])

/**
 * Хранилище — просто папка с markdown-файлами. Никакой базы и никакого
 * проприетарного формата: заметки остаются читаемыми чем угодно,
 * синкаются чем угодно и переживут это приложение.
 */
export function vaultRoot(): string {
  const configured = getConfig().vaultPath
  if (configured) return configured
  const fallback = defaultVaultPath()
  patchConfig({ vaultPath: fallback })
  return fallback
}

export async function ensureVault(): Promise<string> {
  const root = vaultRoot()
  // Welcome только при первом создании папки — иначе удаление «Добро пожаловать»
  // откатывается на каждом tree()/старте.
  const isNew = !existsSync(root)
  await mkdir(root, { recursive: true })
  if (isNew) {
    await writeFile(
      join(root, 'Добро пожаловать.md'),
      [
        '# Добро пожаловать',
        '',
        'Это ваше хранилище заметок. Обычная папка с markdown-файлами —',
        'её можно открыть в Obsidian, положить в git или синхронизировать чем угодно.',
        '',
        'Ссылки между заметками пишутся как [[Название заметки]].',
        'Внизу каждой заметки видно, кто ссылается на неё.',
        ''
      ].join('\n'),
      'utf8'
    )
  }
  return root
}

/** Защита от выхода за пределы хранилища: пути приходят из renderer. */
function resolveInVault(relPath: string): string {
  const root = vaultRoot()
  const full = join(root, relPath)
  const rel = relative(root, full)
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
    throw new Error('Путь вне хранилища заметок')
  }
  return full
}

const titleOf = (p: string): string => basename(p, MD)

export async function tree(): Promise<VaultNode[]> {
  const root = await ensureVault()

  async function walk(dir: string): Promise<VaultNode[]> {
    const entries = await readdir(dir, { withFileTypes: true })
    const nodes: VaultNode[] = []
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORED.has(e.name)) continue
      const full = join(dir, e.name)
      const rel = relative(root, full)
      if (e.isDirectory()) {
        nodes.push({ name: e.name, path: rel, kind: 'folder', children: await walk(full) })
      } else if (e.name.endsWith(MD)) {
        const s = await stat(full)
        nodes.push({ name: titleOf(e.name), path: rel, kind: 'note', updatedAt: s.mtimeMs })
      }
    }
    // Папки сверху, дальше по алфавиту — предсказуемее, чем порядок файловой системы.
    return nodes.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name, 'ru') : a.kind === 'folder' ? -1 : 1
    )
  }

  return walk(root)
}

async function flatten(): Promise<NoteRef[]> {
  const out: NoteRef[] = []
  const walk = (nodes: VaultNode[]): void => {
    for (const n of nodes) {
      if (n.kind === 'note') out.push({ path: n.path, title: n.name, updatedAt: n.updatedAt ?? 0, size: 0 })
      else if (n.children) walk(n.children)
    }
  }
  walk(await tree())
  return out
}

const WIKILINK = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g

export function parseLinks(content: string): string[] {
  const found = new Set<string>()
  for (const m of content.matchAll(WIKILINK)) found.add(m[1].trim())
  return [...found]
}

export async function readNote(relPath: string): Promise<NoteDoc> {
  const full = resolveInVault(relPath)
  const [content, s] = await Promise.all([readFile(full, 'utf8'), stat(full)])
  return {
    path: relPath,
    title: titleOf(relPath),
    content,
    updatedAt: s.mtimeMs,
    size: s.size,
    links: parseLinks(content)
  }
}

export async function writeNote(relPath: string, content: string): Promise<NoteRef> {
  const full = resolveInVault(relPath)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, content, 'utf8')
  const s = await stat(full)
  return { path: relPath, title: titleOf(relPath), updatedAt: s.mtimeMs, size: s.size }
}

export async function createNote(relPath: string): Promise<NoteRef> {
  const path = relPath.endsWith(MD) ? relPath : relPath + MD
  if (existsSync(resolveInVault(path))) throw new Error('Заметка с таким именем уже есть')
  return writeNote(path, `# ${titleOf(path)}\n\n`)
}

export async function createFolder(relPath: string): Promise<void> {
  await mkdir(resolveInVault(relPath), { recursive: true })
}

export async function renameNote(from: string, to: string): Promise<NoteRef> {
  const target = to.endsWith(MD) ? to : to + MD
  const fullTo = resolveInVault(target)
  await mkdir(dirname(fullTo), { recursive: true })
  await rename(resolveInVault(from), fullTo)
  const s = await stat(fullTo)
  return { path: target, title: titleOf(target), updatedAt: s.mtimeMs, size: s.size }
}

export async function deleteNote(relPath: string): Promise<void> {
  await rm(resolveInVault(relPath), { recursive: true, force: true })
}

/** Кто ссылается на эту заметку. Считается по вики-ссылкам при открытии. */
export async function backlinks(relPath: string): Promise<NoteRef[]> {
  const target = titleOf(relPath).toLowerCase()
  const all = await flatten()
  const hits: NoteRef[] = []
  await Promise.all(
    all
      .filter((n) => n.path !== relPath)
      .map(async (n) => {
        const content = await readFile(resolveInVault(n.path), 'utf8').catch(() => '')
        if (parseLinks(content).some((l) => l.toLowerCase() === target)) hits.push(n)
      })
  )
  return hits.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function searchNotes(query: string, limit = 50): Promise<NoteSearchHit[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const all = await flatten()
  const hits: NoteSearchHit[] = []
  for (const n of all) {
    if (hits.length >= limit) break
    const content = await readFile(resolveInVault(n.path), 'utf8').catch(() => '')
    const idx = content.toLowerCase().indexOf(q)
    const inTitle = n.title.toLowerCase().includes(q)
    if (idx === -1 && !inTitle) continue
    const start = Math.max(0, idx - 40)
    hits.push({
      path: n.path,
      title: n.title,
      excerpt:
        idx === -1
          ? content.slice(0, 120).replace(/\s+/g, ' ')
          : (start > 0 ? '…' : '') + content.slice(start, idx + q.length + 60).replace(/\s+/g, ' ') + '…'
    })
  }
  return hits
}

/** Разрешение вики-ссылки в путь: по заголовку, без учёта регистра. */
export async function resolveLink(title: string): Promise<string | null> {
  const t = title.trim().toLowerCase()
  const all = await flatten()
  return all.find((n) => n.title.toLowerCase() === t)?.path ?? null
}
