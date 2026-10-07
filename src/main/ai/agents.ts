import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mcpInfo } from './mcpServer'
import { logInfo, logError } from '../log'

/**
 * Подключение локальных агентов (Cursor, Codex, Claude) к MCP-серверу Kontur.
 *
 * Вместо того чтобы снабжать агента токенами сервисов, мы прописываем в его
 * конфиг один MCP-сервер Kontur — через него агент получает инструменты и
 * контекст подключённых сервисов, а Kontur отвечает за контуры и доступы.
 *
 * Cursor и Claude Code умеют MCP по HTTP напрямую. Claude Desktop и Codex ходят
 * по stdio, поэтому для них используем мост mcp-remote (npx) к нашему HTTP.
 */

export type AgentId = 'cursor' | 'claude-code' | 'claude-desktop' | 'codex'

export interface AgentState {
  id: AgentId
  name: string
  detected: boolean
  configured: boolean
  configPath: string
}

const paths: Record<AgentId, string> = {
  cursor: join(homedir(), '.cursor', 'mcp.json'),
  'claude-code': join(homedir(), '.claude.json'),
  'claude-desktop': join(
    homedir(),
    'Library',
    'Application Support',
    'Claude',
    'claude_desktop_config.json'
  ),
  codex: join(homedir(), '.codex', 'config.toml')
}

const names: Record<AgentId, string> = {
  cursor: 'Cursor',
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex'
}

function detected(id: AgentId): boolean {
  switch (id) {
    case 'cursor':
      return existsSync('/Applications/Cursor.app') || existsSync(join(homedir(), '.cursor'))
    case 'claude-code':
      return existsSync(paths['claude-code']) || existsSync(join(homedir(), '.claude'))
    case 'claude-desktop':
      return existsSync('/Applications/Claude.app') || existsSync(dirname(paths['claude-desktop']))
    case 'codex':
      return existsSync(join(homedir(), '.codex'))
  }
}

function configured(id: AgentId): boolean {
  const p = paths[id]
  if (!existsSync(p)) return false
  try {
    return readFileSync(p, 'utf8').includes('kontur')
  } catch {
    return false
  }
}

export function agentStates(): AgentState[] {
  return (Object.keys(paths) as AgentId[]).map((id) => ({
    id,
    name: names[id],
    detected: detected(id),
    configured: configured(id),
    configPath: paths[id]
  }))
}

function readJson(p: string): Record<string, unknown> {
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeJson(p: string, data: unknown): void {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(data, null, 2), 'utf8')
}

/** HTTP-запись (Cursor, Claude Code): сервер по url с токеном в заголовке. */
function httpEntry(): Record<string, unknown> {
  const { url, token } = mcpInfo()
  return { url, headers: { Authorization: `Bearer ${token}` } }
}

/** stdio через мост mcp-remote (Claude Desktop, Codex). */
function bridgeCommand(): { command: string; args: string[] } {
  const { url, token } = mcpInfo()
  return {
    command: 'npx',
    args: ['-y', 'mcp-remote', url, '--header', `Authorization: Bearer ${token}`]
  }
}

export function connectAgent(id: AgentId): { ok: boolean; message: string } {
  const info = mcpInfo()
  if (!info.running) return { ok: false, message: 'MCP-сервер не запущен' }
  const p = paths[id]

  try {
    if (id === 'cursor') {
      const cfg = readJson(p)
      const servers = (cfg.mcpServers as Record<string, unknown>) ?? {}
      servers.kontur = httpEntry()
      cfg.mcpServers = servers
      writeJson(p, cfg)
    } else if (id === 'claude-code') {
      const cfg = readJson(p)
      const servers = (cfg.mcpServers as Record<string, unknown>) ?? {}
      servers.kontur = { type: 'http', ...httpEntry() }
      cfg.mcpServers = servers
      writeJson(p, cfg)
    } else if (id === 'claude-desktop') {
      const cfg = readJson(p)
      const servers = (cfg.mcpServers as Record<string, unknown>) ?? {}
      servers.kontur = bridgeCommand()
      cfg.mcpServers = servers
      writeJson(p, cfg)
    } else {
      // Codex — TOML. Аккуратно заменяем/добавляем секцию [mcp_servers.kontur].
      const { command, args } = bridgeCommand()
      const block =
        `[mcp_servers.kontur]\n` +
        `command = ${JSON.stringify(command)}\n` +
        `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]\n`
      let text = existsSync(p) ? readFileSync(p, 'utf8') : ''
      text = text.replace(/\[mcp_servers\.kontur\][\s\S]*?(?=\n\[|\s*$)/, '').trimEnd()
      text = `${text}\n\n${block}`.trimStart()
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, text, 'utf8')
    }
    logInfo('mcp', `агент ${id} подключён (${p})`)
    return {
      ok: true,
      message:
        id === 'cursor' || id === 'claude-code'
          ? `${names[id]}: готово. Перезапустите агента.`
          : `${names[id]}: готово (через мост mcp-remote). Перезапустите агента.`
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logError('mcp', `не удалось подключить ${id}: ${msg}`)
    return { ok: false, message: msg }
  }
}
