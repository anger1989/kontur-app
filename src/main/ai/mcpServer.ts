import { createServer, type Server as HttpServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { logInfo, logError, logWarn } from '../log'
import * as actions from './actions'
import * as automations from '../automations'
import type { AutomationUpsert } from '@shared/automations'

/**
 * MCP-сервер Kontur.
 *
 * Поднимается внутри приложения на 127.0.0.1 и отдаёт локальным агентам
 * (Cursor, Codex, Claude) инструменты подключённых сервисов: найти задачу,
 * завести тикет, прокомментировать ревью, написать страницу в Confluence и т.д.
 * Все вызовы идут через контуры Kontur — агент не видит ни паролей, ни туннелей,
 * только безопасные операции. Доступ только с localhost и по токену.
 *
 * Токен стабилен между перезапусками (лежит в userData) — иначе Cursor
 * получает 401 после каждого старта Kontur, пока снова не нажмёшь «Подключить».
 */

let httpServer: HttpServer | null = null
let token = ''
let port = 0

function tokenFile(): string {
  return join(app.getPath('userData'), 'mcp-token')
}

function loadOrCreateToken(): string {
  const file = tokenFile()
  try {
    if (existsSync(file)) {
      const saved = readFileSync(file, 'utf8').trim()
      if (/^[a-f0-9]{32,}$/i.test(saved)) return saved
    }
  } catch {
    /* создадим новый */
  }
  const next = randomBytes(24).toString('hex')
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, next, { mode: 0o600 })
  } catch (e) {
    logWarn('mcp', `не удалось сохранить токен: ${e instanceof Error ? e.message : String(e)}`)
  }
  return next
}

/** Обновить Bearer в уже прописанных конфигах агентов (без смены url/режима). */
function refreshAgentTokens(url: string, bearer: string): void {
  const auth = `Bearer ${bearer}`
  const patches: { path: string; kind: 'cursor' | 'claude-code' | 'claude-desktop' }[] = [
    { path: join(app.getPath('home'), '.cursor', 'mcp.json'), kind: 'cursor' },
    { path: join(app.getPath('home'), '.claude.json'), kind: 'claude-code' },
    {
      path: join(app.getPath('home'), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      kind: 'claude-desktop'
    }
  ]
  for (const { path: p, kind } of patches) {
    if (!existsSync(p)) continue
    try {
      const raw = readFileSync(p, 'utf8')
      if (!raw.includes('kontur')) continue
      const cfg = JSON.parse(raw) as { mcpServers?: Record<string, Record<string, unknown>> }
      const entry = cfg.mcpServers?.kontur
      if (!entry) continue
      if (kind === 'cursor' || kind === 'claude-code') {
        entry.url = url
        entry.headers = { ...(entry.headers as object), Authorization: auth }
        if (kind === 'claude-code') entry.type = 'http'
      } else {
        // mcp-remote: args содержат url и --header Authorization: Bearer …
        entry.command = 'npx'
        entry.args = ['-y', 'mcp-remote', url, '--header', `Authorization: ${auth}`]
      }
      writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
      logInfo('mcp', `токен обновлён в ${p}`)
    } catch (e) {
      logWarn('mcp', `не обновил ${p}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Codex — TOML
  const codex = join(app.getPath('home'), '.codex', 'config.toml')
  if (existsSync(codex)) {
    try {
      let text = readFileSync(codex, 'utf8')
      if (!text.includes('[mcp_servers.kontur]')) return
      const block =
        `[mcp_servers.kontur]\n` +
        `command = "npx"\n` +
        `args = ["-y", "mcp-remote", ${JSON.stringify(url)}, "--header", ${JSON.stringify(`Authorization: ${auth}`)}]\n`
      text = text.replace(/\[mcp_servers\.kontur\][\s\S]*?(?=\n\[|\s*$)/, '').trimEnd()
      writeFileSync(codex, `${text}\n\n${block}`.trimStart() + '\n', 'utf8')
      logInfo('mcp', `токен обновлён в ${codex}`)
    } catch (e) {
      logWarn('mcp', `не обновил codex: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

const envArg = z.string().optional().describe('Контур: bank или ecom. Если не указан — первый подходящий.')

function build(): McpServer {
  const server = new McpServer({ name: 'kontur', version: app.getVersion() })

  const ok = (data: unknown): { content: { type: 'text'; text: string }[] } => ({
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }]
  })
  const fail = (e: unknown): { content: { type: 'text'; text: string }[]; isError: true } => ({
    content: [{ type: 'text', text: `Ошибка: ${e instanceof Error ? e.message : String(e)}` }],
    isError: true
  })

  server.tool(
    'kontur_list_services',
    'Список подключённых сервисов и контуров (bank, ecom).',
    {},
    async () => ok(actions.listServices())
  )

  server.tool(
    'kontur_my_day',
    'Что требует внимания: задачи, ревью, упоминания, письма из обоих контуров.',
    {},
    async () => ok(actions.myDay())
  )

  server.tool(
    'kontur_search',
    'Сквозной поиск по всему, что синхронизировано (задачи, письма, переписка). У писем есть id и preview — полное тело через mail_read.',
    { query: z.string().describe('Поисковый запрос') },
    async ({ query }) => ok(actions.searchEverything(query))
  )

  server.tool(
    'mail_list',
    'Список писем из синхронизированной почты (тема, от кого, превью). Для полного тела вызови mail_read с id.',
    {
      unreadOnly: z.boolean().optional().describe('Только непрочитанные'),
      limit: z.number().int().min(1).max(100).optional().describe('Сколько писем (по умолчанию 30)'),
      env: envArg
    },
    async ({ unreadOnly, limit, env }) => {
      try {
        return ok(actions.mailList({ unreadOnly, limit, envId: env }))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'mail_read',
    'Прочитать письмо целиком: тема, from/to/cc, текст тела. id — из mail_list / kontur_search / kontur_my_day (вид env:service:mail:…).',
    {
      id: z.string().describe('Id письма, напр. bank.mail:mail:… или из mail_list')
    },
    async ({ id }) => {
      try {
        return ok(await actions.mailRead(id))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'mail_list_folders',
    'Список папок почтового ящика (id, name, role). role = inbox|sent|drafts для системных.',
    { env: envArg },
    async ({ env }) => {
      try {
        return ok(await actions.mailListFolders(env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'mail_create_folder',
    'Создать папку в почтовом ящике.',
    {
      name: z.string().describe('Имя папки'),
      parentId: z.string().optional().describe('Id родительской папки (из mail_list_folders)'),
      env: envArg
    },
    async ({ name, parentId, env }) => {
      try {
        return ok(await actions.mailCreateFolder(name, parentId, env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'mail_move',
    'Переместить письма в папку. ids — из mail_list / mail_read; folderId — из mail_list_folders (или inbox/sent/drafts).',
    {
      ids: z.array(z.string()).min(1).describe('Id писем'),
      folderId: z.string().describe('Id папки назначения'),
      env: envArg
    },
    async ({ ids, folderId, env }) => {
      try {
        return ok(await actions.mailMove(ids, folderId, env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'mail_list_rules',
    'Список серверных inbox-правил (EWS). Для IMAP/JMAP — ошибка «только через EWS».',
    { env: envArg },
    async ({ env }) => {
      try {
        return ok(await actions.mailListRules(env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'mail_upsert_rule',
    'Создать или обновить inbox-правило (EWS). Без id — создать. conditions: from/to/subject contains; actions: moveToFolder / markRead / markImportant.',
    {
      id: z.string().optional().describe('Id правила для обновления'),
      name: z.string().describe('Название'),
      enabled: z.boolean().optional(),
      fromContains: z.string().optional(),
      toContains: z.string().optional(),
      subjectContains: z.string().optional(),
      moveToFolder: z
        .string()
        .optional()
        .describe('EWS FolderId назначения (для exchange — из mail_list_folders; для eas+ews — id из EWS)'),
      markRead: z.boolean().optional(),
      markImportant: z.boolean().optional(),
      env: envArg
    },
    async (args) => {
      try {
        return ok(
          await actions.mailUpsertRule(
            {
              id: args.id,
              name: args.name,
              enabled: args.enabled,
              conditions: {
                fromContains: args.fromContains,
                toContains: args.toContains,
                subjectContains: args.subjectContains
              },
              actions: {
                moveToFolder: args.moveToFolder,
                markRead: args.markRead,
                markImportant: args.markImportant
              }
            },
            args.env
          )
        )
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'mail_delete_rule',
    'Удалить inbox-правило (EWS).',
    { ruleId: z.string().describe('Id правила'), env: envArg },
    async ({ ruleId, env }) => {
      try {
        return ok(await actions.mailDeleteRule(ruleId, env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'mail_set_rule_enabled',
    'Включить или выключить inbox-правило (EWS).',
    {
      ruleId: z.string(),
      enabled: z.boolean(),
      env: envArg
    },
    async ({ ruleId, enabled, env }) => {
      try {
        return ok(await actions.mailSetRuleEnabled(ruleId, enabled, env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'jira_search',
    'Поиск задач в Jira по JQL.',
    { jql: z.string().describe('JQL-запрос'), env: envArg },
    async ({ jql, env }) => {
      try {
        return ok(await actions.jiraSearch(jql, env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'jira_create_issue',
    'Создать задачу в Jira. Сабтаска: parent + issueType «Sub-task» или «Dev Sub-task».',
    {
      projectKey: z.string().describe('Ключ проекта, напр. PLAT'),
      summary: z.string().describe('Заголовок'),
      description: z.string().default('').describe('Описание'),
      issueType: z
        .string()
        .default('Task')
        .describe('Тип: Task, Bug, Story; для сабтасок — Sub-task или Dev Sub-task'),
      parent: z
        .string()
        .optional()
        .describe('Ключ родителя для Sub-task / Dev Sub-task, напр. PLATSLLR-543'),
      env: envArg
    },
    async ({ projectKey, summary, description, issueType, parent, env }) => {
      try {
        return ok(
          await actions.jiraCreateIssue(projectKey, summary, description, issueType, env, parent)
        )
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'jira_comment',
    'Добавить комментарий к задаче Jira.',
    { issueKey: z.string(), body: z.string(), env: envArg },
    async ({ issueKey, body, env }) => {
      try {
        return ok(await actions.jiraComment(issueKey, body, env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'confluence_search',
    'Поиск страниц Confluence по CQL.',
    { cql: z.string().describe('CQL-запрос'), env: envArg },
    async ({ cql, env }) => {
      try {
        return ok(await actions.confluenceSearch(cql, env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'confluence_create_page',
    'Создать страницу в Confluence (тело — HTML storage format).',
    {
      spaceKey: z.string().describe('Ключ пространства'),
      title: z.string(),
      htmlBody: z.string().describe('Содержимое в storage-формате Confluence'),
      env: envArg
    },
    async ({ spaceKey, title, htmlBody, env }) => {
      try {
        return ok(await actions.confluenceCreatePage(spaceKey, title, htmlBody, env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'gitlab_list_reviews',
    'Merge request’ы, ждущие моего ревью.',
    { env: envArg },
    async ({ env }) => {
      try {
        return ok(await actions.gitlabReviews(env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'gitlab_comment_mr',
    'Оставить комментарий к merge request.',
    { projectId: z.number(), mrIid: z.number(), body: z.string(), env: envArg },
    async ({ projectId, mrIid, body, env }) => {
      try {
        return ok(await actions.gitlabCommentMr(projectId, mrIid, body, env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'gitlab_approve_mr',
    'Одобрить merge request.',
    { projectId: z.number(), mrIid: z.number(), env: envArg },
    async ({ projectId, mrIid, env }) => {
      try {
        return ok(await actions.gitlabApproveMr(projectId, mrIid, env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  /* ── Bitbucket ───────────────────────────────────────────────────
     Пул-реквест адресуется тройкой project/repo/prId — ровно тем, что видно
     в ссылке `…/projects/ABC/repos/payments/pull-requests/42`. */

  const prArgs = {
    project: z.string().describe('Ключ проекта, например ABC'),
    repo: z.string().describe('Слаг репозитория, например payments'),
    prId: z.number().describe('Номер пул-реквеста')
  }

  server.tool(
    'bitbucket_list_reviews',
    'Пул-реквесты Bitbucket, ждущие моего ревью (по всем репозиториям).',
    { env: envArg },
    async ({ env }) => {
      try {
        return ok(await actions.bitbucketReviews(env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'bitbucket_list_prs',
    'Пул-реквесты конкретного репозитория Bitbucket.',
    {
      project: prArgs.project,
      repo: prArgs.repo,
      state: z
        .enum(['OPEN', 'MERGED', 'DECLINED', 'ALL'])
        .optional()
        .describe('Состояние, по умолчанию OPEN'),
      env: envArg
    },
    async ({ project, repo, state, env }) => {
      try {
        return ok(await actions.bitbucketListPrs(project, repo, state ?? 'OPEN', env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'bitbucket_get_pr',
    'Карточка пул-реквеста: описание, ветки, ревьюеры и их статусы.',
    { ...prArgs, env: envArg },
    async ({ project, repo, prId, env }) => {
      try {
        return ok(await actions.bitbucketGetPr(project, repo, prId, env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'bitbucket_pr_diff',
    'Diff пул-реквеста в unified-формате (длинный ответ подрезается).',
    {
      ...prArgs,
      contextLines: z.number().optional().describe('Строк контекста вокруг изменений, по умолчанию 3'),
      env: envArg
    },
    async ({ project, repo, prId, contextLines, env }) => {
      try {
        return ok(await actions.bitbucketPrDiff(project, repo, prId, contextLines ?? 3, env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'bitbucket_pr_activity',
    'Лента пул-реквеста: комментарии, апрувы, пуши.',
    { ...prArgs, env: envArg },
    async ({ project, repo, prId, env }) => {
      try {
        return ok(await actions.bitbucketPrActivity(project, repo, prId, env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'bitbucket_comment_pr',
    'Комментарий к пул-реквесту. С path (и line) — привязанный к строке диффа, иначе общий.',
    {
      ...prArgs,
      text: z.string().describe('Текст комментария'),
      path: z.string().optional().describe('Путь к файлу для комментария к строке'),
      line: z.number().optional().describe('Номер строки в файле'),
      lineType: z
        .enum(['ADDED', 'REMOVED', 'CONTEXT'])
        .optional()
        .describe('ADDED — строка новой версии (по умолчанию), REMOVED — старой, CONTEXT — неизменённая'),
      env: envArg
    },
    async ({ project, repo, prId, text, path, line, lineType, env }) => {
      try {
        return ok(
          await actions.bitbucketCommentPr(
            project,
            repo,
            prId,
            text,
            path ? { path, line, lineType } : undefined,
            env
          )
        )
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'bitbucket_review_pr',
    'Поставить статус ревью: APPROVED — одобрить, NEEDS_WORK или UNAPPROVED — снять апрув.',
    {
      ...prArgs,
      status: z.enum(['APPROVED', 'UNAPPROVED', 'NEEDS_WORK']).optional(),
      env: envArg
    },
    async ({ project, repo, prId, status, env }) => {
      try {
        return ok(await actions.bitbucketReviewPr(project, repo, prId, status ?? 'APPROVED', env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'bitbucket_search_code',
    'Поиск по коду в Bitbucket.',
    { query: z.string().describe('Поисковый запрос'), env: envArg },
    async ({ query, env }) => {
      try {
        return ok(await actions.bitbucketSearchCode(query, env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'mattermost_unread',
    'Каналы Mattermost с непрочитанным (живые счётчики с API).',
    { env: envArg },
    async ({ env }) => {
      try {
        return ok(await actions.mattermostUnread(env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'mattermost_read',
    'Прочитать последние сообщения канала Mattermost. channel — id, имя (it-leads) или URL.',
    {
      channel: z.string().describe('Id канала, имя (it-leads) или URL'),
      limit: z.number().int().min(1).max(60).default(30).describe('Сколько сообщений (1–60)'),
      env: envArg
    },
    async ({ channel, limit, env }) => {
      try {
        return ok(await actions.mattermostRead(channel, limit, env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'mattermost_post',
    'Отправить сообщение в канал Mattermost.',
    { channelId: z.string(), message: z.string(), env: envArg },
    async ({ channelId, message, env }) => {
      try {
        return ok(await actions.mattermostPost(channelId, message, env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'mattermost_set_header',
    'Обновить шапку канала Mattermost (header). Markdown ок. channel — id, имя или URL.',
    {
      channel: z.string().describe('Id канала, имя (it-leads) или URL'),
      header: z.string().describe('Текст шапки (markdown, список дежурных и т.п.)'),
      env: envArg
    },
    async ({ channel, header, env }) => {
      try {
        return ok(await actions.mattermostSetHeader(channel, header, env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'mattermost_set_banner',
    'Плашка вверху канала Mattermost (Channel Banner) — её нельзя скрыть, видна всем участникам. ' +
      'Это не шапка канала: для шапки есть mattermost_set_header. Нужны права админа канала и платная лицензия сервера.',
    {
      channel: z.string().describe('Id канала, имя (it-leads) или URL'),
      text: z
        .string()
        .optional()
        .describe('Текст баннера, markdown. До 1024 байт. Обязателен, когда enabled=true'),
      color: z
        .string()
        .optional()
        .describe('Цвет фона в hex: #90c695 или #9c6. Обязателен, когда enabled=true'),
      enabled: z.boolean().default(true).describe('false — снять баннер, текст и цвет сервер запомнит'),
      env: envArg
    },
    async ({ channel, text, color, enabled, env }) => {
      try {
        return ok(await actions.mattermostSetBanner({ channel, text, color, enabled, envId: env }))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'mattermost_license',
    'Лицензия сервера Mattermost и доступны ли на ней баннеры каналов.',
    { env: envArg },
    async ({ env }) => {
      try {
        return ok(await actions.mattermostLicense(env))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'notes_search',
    'Поиск по хранилищу заметок Kontur (markdown vault).',
    {
      query: z.string().describe('Поисковый запрос'),
      limit: z.number().int().min(1).max(50).default(20).optional()
    },
    async ({ query, limit }) => {
      try {
        return ok(await actions.notesSearch(query, limit ?? 20))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'notes_read',
    'Прочитать заметку по пути (`Заметка.md`) или названию (`Заметка`).',
    {
      path: z.string().describe('Путь относительно vault или заголовок заметки')
    },
    async ({ path }) => {
      try {
        return ok(await actions.notesRead(path))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'notes_write',
    'Записать markdown в заметку. mode=replace — целиком, append — дописать в конец. Несуществующую создаёт.',
    {
      path: z.string().describe('Путь (`Заметка.md`) или название (`Заметка`)'),
      content: z.string().describe('Markdown-содержимое'),
      mode: z
        .enum(['replace', 'append'])
        .optional()
        .describe('replace (по умолчанию) или append')
    },
    async ({ path, content, mode }) => {
      try {
        return ok(await actions.notesWrite(path, content, mode ?? 'replace'))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'notes_create',
    'Создать новую заметку. Если content не передан — шаблон с заголовком.',
    {
      path: z.string().describe('Путь или название новой заметки'),
      content: z.string().optional().describe('Начальный markdown')
    },
    async ({ path, content }) => {
      try {
        return ok(await actions.notesCreate(path, content))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'notes_delete',
    'Удалить заметку по пути или названию.',
    {
      path: z.string().describe('Путь или название заметки')
    },
    async ({ path }) => {
      try {
        return ok(await actions.notesDelete(path))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'calendar_create_meeting',
    'Создать встречу в Exchange-календаре (EAS). Время — ISO-8601 с таймзоной.',
    {
      subject: z.string().describe('Тема встречи'),
      startsAt: z
        .string()
        .describe('Начало ISO-8601, напр. 2026-10-05T15:00:00+03:00'),
      endsAt: z
        .string()
        .describe('Конец ISO-8601, напр. 2026-10-05T16:00:00+03:00'),
      location: z.string().optional().describe('Место или ссылка'),
      body: z.string().optional().describe('Описание'),
      attendees: z
        .string()
        .optional()
        .describe('Email участников через запятую, напр. a@bank.ru, b@bank.ru'),
      allDay: z.boolean().optional().describe('Весь день'),
      env: envArg
    },
    async ({ subject, startsAt, endsAt, location, body, attendees, allDay, env }) => {
      try {
        return ok(
          await actions.calendarCreateMeeting({
            subject,
            startsAt,
            endsAt,
            location,
            body,
            attendees,
            allDay,
            envId: env
          })
        )
      } catch (e) {
        return fail(e)
      }
    }
  )

  // Дела — личный планировщик Kontur, не Jira: лежат локально, без контура.
  // Поэтому у них нет env, а удаление и правка принимают ещё и название:
  // ассистент почти никогда не держит id под рукой.
  server.tool(
    'todos_list',
    'Список личных дел планировщика Kontur (не задачи Jira). Отсюда берут id для изменения и удаления.',
    {
      includeDone: z.boolean().default(false).describe('Показать и выполненные'),
      limit: z.number().int().min(1).max(500).default(50).describe('Сколько вернуть')
    },
    async ({ includeDone, limit }) => {
      try {
        return ok(actions.todosList({ includeDone, limit }))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'todos_create',
    'Создать личное дело в планировщике Kontur. Срок и напоминание — ISO-8601 с таймзоной.',
    {
      title: z.string().describe('Что сделать'),
      dueAt: z
        .string()
        .optional()
        .describe('Срок ISO-8601, напр. 2026-10-06T18:00:00+03:00. Без него дело без даты'),
      remindAt: z.string().optional().describe('Когда напомнить, ISO-8601'),
      note: z.string().optional().describe('Заметка к делу'),
      showInCalendar: z
        .boolean()
        .optional()
        .describe('Показывать в календаре (по умолчанию да, если есть срок)')
    },
    async ({ title, dueAt, remindAt, note, showInCalendar }) => {
      try {
        return ok(actions.todosCreate({ title, dueAt, remindAt, note, showInCalendar }))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'todos_delete',
    'Удалить личное дело по id или точному названию. Удаление безвозвратное — закрыть дело можно через todos_update.',
    { todo: z.string().describe('id из todos_list или название дела') },
    async ({ todo }) => {
      try {
        return ok(actions.todosDelete(todo))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'todos_update',
    'Изменить личное дело: закрыть или переоткрыть, переименовать, передвинуть срок и напоминание.',
    {
      todo: z.string().describe('id из todos_list или название дела'),
      title: z.string().optional().describe('Новое название'),
      done: z.boolean().optional().describe('true — выполнено, false — вернуть в работу'),
      dueAt: z.string().nullable().optional().describe('Новый срок ISO-8601; null — снять срок'),
      remindAt: z.string().nullable().optional().describe('Новое напоминание ISO-8601; null — снять'),
      note: z.string().optional().describe('Заметка к делу')
    },
    async ({ todo, title, done, dueAt, remindAt, note }) => {
      try {
        return ok(actions.todosUpdate({ todo, title, done, dueAt, remindAt, note }))
      } catch (e) {
        return fail(e)
      }
    }
  )

  // Локальные сценарии: cron в main-процессе Kontur + типизированные шаги.
  // Агент описывает сценарий целиком через automations_upsert; раннер крутит сам.
  server.tool(
    'automations_list_step_types',
    'Каталог типов шагов для сценариев Kontur (notes.read, duty.resolve, mattermost.set_banner, …).',
    {},
    async () => {
      try {
        return ok(automations.listStepTypes())
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'automations_list',
    'Список локальных автоматизаций Kontur (cron-сценарии) и статус последнего запуска.',
    {},
    async () => {
      try {
        return ok(automations.listAutomationsView())
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'automations_get',
    'Одна автоматизация по id или точному имени.',
    { automation: z.string().describe('id или имя из automations_list') },
    async ({ automation }) => {
      try {
        const a = automations.resolveAutomationRef(automation)
        return ok(automations.automationsGet(a.id))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'automations_upsert',
    'Создать или полностью заменить сценарий: имя, cron, шаги. ' +
      'Сначала смотри automations_list_step_types. Строки в params поддерживают {{vars}} из контекста шагов.',
    {
      id: z.string().optional().describe('id при обновлении существующей'),
      name: z.string().describe('Короткое имя для виджета'),
      enabled: z.boolean().optional().describe('По умолчанию true'),
      cron: z
        .string()
        .describe('5-полевой cron, напр. «0 9 * * 1» — понедельник 09:00'),
      tz: z.string().optional().describe('IANA TZ, по умолчанию Europe/Moscow'),
      steps: z
        .array(
          z.object({
            type: z.string().describe('Тип шага из automations_list_step_types'),
            params: z.record(z.string(), z.unknown()).optional()
          })
        )
        .min(1)
        .describe('Упорядоченные шаги')
    },
    async ({ id, name, enabled, cron, tz, steps }) => {
      try {
        const payload: AutomationUpsert = {
          id,
          name,
          enabled,
          schedule: { cron, tz },
          steps
        }
        return ok(automations.automationsUpsert(payload))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'automations_delete',
    'Удалить автоматизацию по id или имени.',
    { automation: z.string().describe('id или имя') },
    async ({ automation }) => {
      try {
        const a = automations.resolveAutomationRef(automation)
        return ok({ deleted: automations.automationsDelete(a.id), id: a.id })
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'automations_set_enabled',
    'Включить или выключить сценарий без удаления.',
    {
      automation: z.string().describe('id или имя'),
      enabled: z.boolean()
    },
    async ({ automation, enabled }) => {
      try {
        const a = automations.resolveAutomationRef(automation)
        return ok(automations.automationsSetEnabled(a.id, enabled))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.tool(
    'automations_run_now',
    'Прогнать сценарий сразу, не дожидаясь cron. Удобно для проверки после upsert.',
    { automation: z.string().describe('id или имя') },
    async ({ automation }) => {
      try {
        const a = automations.resolveAutomationRef(automation)
        return ok(await automations.automationsRunNow(a.id))
      } catch (e) {
        return fail(e)
      }
    }
  )

  return server
}

export interface McpInfo {
  running: boolean
  port: number
  token: string
  url: string
}

export function mcpInfo(): McpInfo {
  return {
    running: httpServer != null,
    port,
    token,
    url: port ? `http://127.0.0.1:${port}/mcp` : ''
  }
}

/** Поднять локальный MCP-сервер. Слушает только 127.0.0.1, требует токен. */
export async function startMcp(preferredPort = 8765): Promise<McpInfo> {
  if (httpServer) return mcpInfo()
  token = loadOrCreateToken()

  httpServer = createServer(async (req, res) => {
    // Доступ только с localhost и с правильным токеном (Bearer или ?token=).
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    const qToken = url.searchParams.get('token') ?? ''
    if (bearer !== token && qToken !== token) {
      res.writeHead(401).end('unauthorized')
      return
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end('not found')
      return
    }
    try {
      // Без сессий: на каждый запрос — свежий сервер и транспорт (локальный клиент).
      const server = build()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        transport.close().catch(() => {})
        server.close().catch(() => {})
      })
      await server.connect(transport)
      let body = ''
      for await (const chunk of req) body += chunk
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined)
    } catch (err) {
      logError('mcp', err instanceof Error ? err.message : String(err))
      if (!res.headersSent) res.writeHead(500).end('error')
    }
  })

  await new Promise<void>((resolve) => {
    httpServer!.listen(preferredPort, '127.0.0.1', () => {
      port = (httpServer!.address() as { port: number }).port
      resolve()
    })
    httpServer!.on('error', () => {
      // Порт занят — пусть ОС выдаст любой свободный.
      httpServer!.listen(0, '127.0.0.1', () => {
        port = (httpServer!.address() as { port: number }).port
        resolve()
      })
    })
  })

  const info = mcpInfo()
  logInfo('mcp', `MCP-сервер на ${info.url}`)
  // Подтянуть токен в уже подключённые агенты — иначе после рестарта 401.
  refreshAgentTokens(info.url, info.token)
  return info
}

/** Остановить MCP. Рвём keep-alive сразу — иначе `server.close()` ждёт клиентов и выход зависает. */
export async function stopMcp(): Promise<void> {
  const server = httpServer
  if (!server) return
  httpServer = null
  port = 0
  // Node 18.2+: иначе Cursor/агенты с keep-alive держат процесс в CleanupHandles.
  server.closeAllConnections()
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    // На всякий случай не ждём дольше секунды.
    setTimeout(resolve, 1000).unref()
  })
}
