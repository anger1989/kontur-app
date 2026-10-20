import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { logError, logInfo } from '../log'

/**
 * Скиллы Kontur для локальных агентов.
 *
 * MCP даёт агенту инструменты, но не рассказывает, как ими пользоваться: что
 * такое контуры, откуда берутся id писем, чем Jira отличается от планировщика
 * и что апрув ставят только по просьбе. Это живёт в markdown-скиллах рядом с
 * приложением (`resources/skills`), а отсюда они раскладываются туда, где
 * агент их читает:
 *
 * - Claude Code / Claude Desktop — `~/.claude/skills/<id>/SKILL.md`;
 * - Cursor (и встроенный ассистент, он же cursor-agent с workspace = $HOME) —
 *   `~/.cursor/rules/<id>.mdc`.
 *
 * Файлы перезаписываются целиком: источник правды — то, что приехало с
 * версией Kontur, иначе у пользователя останется скилл от прошлого релиза с
 * инструментами, которых уже нет.
 */

export interface SkillInfo {
  id: string
  /** Имя из frontmatter — его агент видит в списке скиллов. */
  name: string
  description: string
}

export interface SkillsState {
  skills: SkillInfo[]
  /** Куда разложены скиллы сейчас. */
  installed: { claude: boolean; cursor: boolean }
  claudeDir: string
  cursorDir: string
}

const claudeDir = (): string => join(homedir(), '.claude', 'skills')
const cursorDir = (): string => join(homedir(), '.cursor', 'rules')

/** Папка со скиллами внутри сборки (в проде — внутри app.asar, fs её читает). */
function skillsRoot(): string {
  return join(app.getAppPath(), 'resources', 'skills')
}

/** Минимальный парсер frontmatter: нам нужны только name и description. */
function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return {}
  const out: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line)
    if (kv) out[kv[1]!] = kv[2]!.trim()
  }
  return { name: out.name, description: out.description }
}

function readSkillFiles(): { id: string; body: string; info: SkillInfo }[] {
  const root = skillsRoot()
  if (!existsSync(root)) return []
  const out: { id: string; body: string; info: SkillInfo }[] = []
  for (const id of readdirSync(root)) {
    const file = join(root, id, 'SKILL.md')
    if (!existsSync(file)) continue
    const body = readFileSync(file, 'utf8')
    const fm = parseFrontmatter(body)
    out.push({
      id,
      body,
      info: { id, name: fm.name ?? id, description: fm.description ?? '' }
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

export function skillsState(): SkillsState {
  const files = readSkillFiles()
  const ids = files.map((f) => f.id)
  return {
    skills: files.map((f) => f.info),
    installed: {
      claude: ids.length > 0 && ids.every((id) => existsSync(join(claudeDir(), id, 'SKILL.md'))),
      cursor: ids.length > 0 && ids.every((id) => existsSync(join(cursorDir(), `${id}.mdc`)))
    },
    claudeDir: claudeDir(),
    cursorDir: cursorDir()
  }
}

/**
 * Правило Cursor из того же markdown: тело без frontmatter плюс свой
 * заголовок. `alwaysApply: false` — правило подтягивается по описанию, а не
 * висит в каждом запросе.
 */
function toCursorRule(body: string, info: SkillInfo): string {
  const stripped = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  return `---\ndescription: ${info.description}\nglobs:\nalwaysApply: false\n---\n\n${stripped}`
}

export function installSkills(): { ok: boolean; message: string } {
  const files = readSkillFiles()
  if (!files.length) {
    return { ok: false, message: 'Скиллы не найдены в сборке' }
  }
  try {
    for (const f of files) {
      const dir = join(claudeDir(), f.id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), f.body, 'utf8')
    }
    mkdirSync(cursorDir(), { recursive: true })
    for (const f of files) {
      writeFileSync(join(cursorDir(), `${f.id}.mdc`), toCursorRule(f.body, f.info), 'utf8')
    }
    logInfo('mcp', `скиллы разложены: ${files.length} шт.`)
    return {
      ok: true,
      message: `Скиллы (${files.length}) установлены для Claude и Cursor. Перезапустите агента.`
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logError('mcp', `не удалось разложить скиллы: ${msg}`)
    return { ok: false, message: msg }
  }
}
