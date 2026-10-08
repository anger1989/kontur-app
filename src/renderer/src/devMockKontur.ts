/* ВРЕМЕННЫЙ ФАЙЛ ДЛЯ ВИЗУАЛЬНОЙ ПРОВЕРКИ РЕНДЕРЕРА В БРАУЗЕРЕ. УДАЛИТЬ. */
import { defaultConfig } from '@shared/defaults'
import type { AppConfig, BrowserState, Item } from '@shared/types'

const MIN = 60_000
const d0 = new Date(); d0.setHours(0, 0, 0, 0)
const day0 = d0.getTime()
const at = (h: number, m = 0, off = 0): number => day0 + off * 86_400_000 + h * 3_600_000 + m * MIN

const base = defaultConfig()
let config: AppConfig = {
  ...base,
  onboardingCompleted: true,
  // Сразу живые обои — проверяем именно их.
  wallpaper: { kind: 'animated', value: 'aurora' },
  services: base.services.map((s) =>
    s.kind === 'mail' ? { ...s, enabled: true, baseUrl: 'https://mail.example' } : s
  )
}

const ev = (id: string, title: string, start: number, mins: number, envId = 'bank'): Item => ({
  id, envId, serviceId: `${envId}.mail`, kind: 'event', title, body: '',
  author: null, state: 'принята', url: '', updatedAt: start, unread: false, mentioned: false,
  startsAt: start, endsAt: start + mins * MIN
})

const events: Item[] = [
  ev('a1', 'Daily SLLR', at(10, 15), 15),
  ev('a3', '3 Амиго SLLR', at(13), 60),
  ev('a8', 'Добавление API-ключа', at(15, 30), 60, 'ecom'),
  ev('h1', 'Daily SLLR', at(10, 15, 1), 15),
  ev('h4', 'SLLR PBR', at(13, 0, 1), 60),
  ev('f1', 'Daily SLLR', at(10, 15, 2), 15)
]

const todos: Item[] = [
  { ...ev('td1', 'Ответить Кате про доступы', at(12), 0), kind: 'todo', state: null }
]

const off = (): void => {}
function group(impl: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(impl, {
    get: (t, p: string) => (p in t ? t[p] : () => (p.startsWith('on') ? off : Promise.resolve(undefined)))
  })
}

const api = {
  config: group({
    get: () => Promise.resolve(config),
    // Клик по плитке обоев должен менять фон вживую.
    patch: (patch: Partial<AppConfig>) => {
      config = { ...config, ...patch }
      return Promise.resolve(config)
    },
    onChange: () => off
  }),
  env: group({
    status: () => Promise.resolve(config.envs.map((e) => ({ envId: e.id, tunnel: 'up' as const, vpn: 'off' as const, lastSyncAt: Date.now(), lastError: null, pendingOutbox: 0 }))),
    onChange: () => off,
    onTrayAction: () => off,
    probe: () => Promise.resolve([])
  }),
  theme: group({ onChange: () => off, set: () => Promise.resolve('dark') }),
  nav: group({ onOpenRoute: () => off, onJoinMeeting: () => off }),
  items: group({
    query: (q?: { kinds?: string[] }) => {
      if (q?.kinds?.includes('task')) return Promise.resolve([])
      return Promise.resolve(events)
    },
    onChange: () => off, markRead: () => Promise.resolve(0)
  }),
  todos: group({ list: () => Promise.resolve(todos) }),
  automations: group({ list: () => Promise.resolve([]), onChange: () => off }),
  bookmarks: group({ list: () => Promise.resolve([]), onChange: () => off }),
  browser: group({ state: () => Promise.resolve({ activeId: null, tabs: [] } as BrowserState), onChange: () => off }),
  view: group({}),
  app: group({
    getVersion: () => Promise.resolve('0.0.0-dev'),
    checkUpdate: () =>
      Promise.resolve({
        currentVersion: '0.0.0-dev',
        latestVersion: '0.0.0-dev',
        available: false,
        releaseUrl: '',
        downloadUrl: '',
        body: ''
      }),
    openUpdate: () => Promise.resolve(),
    onUpdateAvailable: () => off,
    onMaximizedChange: () => off
  }),
  secrets: group({ available: () => Promise.resolve(false), list: () => Promise.resolve([]) }),
  keyboard: group({ layout: () => Promise.resolve('ru'), onLayoutChange: () => off }),
  mcp: group({ info: () => Promise.resolve(null), agents: () => Promise.resolve([]) }),
  notes: group({ tree: () => Promise.resolve([]), search: () => Promise.resolve([]) }),
  fs: group({ favorites: () => Promise.resolve([]), list: () => Promise.resolve([]) }),
  terminal: group({ onData: () => off, onExit: () => off }),
  mail: group({}), calendar: group({ suggestPeople: () => Promise.resolve([]) }),
  contacts: group({}),
  tasks: group({
    board: () =>
      Promise.resolve({
        serviceId: null,
        projectKey: null,
        columns: [
          { id: 'cat:new', title: 'К выполнению', category: 'new', statusIds: [], statusName: '' },
          {
            id: 'cat:indeterminate',
            title: 'В работе',
            category: 'indeterminate',
            statusIds: [],
            statusName: ''
          },
          { id: 'cat:done', title: 'Готово', category: 'done', statusIds: [], statusName: '' }
        ]
      })
  }),
  vpn: group({}),
  logs: group({ read: () => Promise.resolve('') }), icons: group({})
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(window as any).kontur = new Proxy(api, {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get: (t, p: string) => (p in t ? (t as any)[p] : group({}))
})
