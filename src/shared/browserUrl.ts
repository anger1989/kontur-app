/**
 * Что сделать с тем, что человек набрал в адресной строке браузера.
 *
 * Чистая функция без Electron: её одинаково видят main (навигация вкладки) и
 * рендерер (подсказка в адресной строке), и её поведение можно проверить
 * глазами по таблице ниже, не поднимая приложения.
 *
 * `example.com/path` → `https://example.com/path`
 * `localhost:3000`   → `http://localhost:3000`
 * `jira`             → поиск (внутренние хосты без точки неотличимы от слова,
 *                      а ошибиться в пользу поиска безопаснее)
 * `как сделать X`    → поиск
 */

/** Схемы, которые пишут руками и которые нельзя трогать. */
const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*:/i
/** Хост без схемы: `host.tld`, `host.tld/path`, `host.tld:8080`. */
const BARE_HOST = /^[^\s/?#]+\.[a-zа-я]{2,}(?::\d+)?(?:[/?#]|$)/i
/** localhost и адреса вида 127.0.0.1 — по-умолчанию http, не https. */
const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i

/** Подставить запрос в шаблон поиска (`%s`). */
export function searchUrlFor(template: string, query: string): string {
  const q = encodeURIComponent(query)
  return template.includes('%s') ? template.replace('%s', q) : `${template}${q}`
}

/**
 * Превратить ввод адресной строки в адрес для загрузки.
 * Всё, что не похоже на адрес, уходит в поиск по шаблону `searchUrl`.
 */
export function resolveBrowserInput(input: string, searchUrl: string): string {
  const raw = input.trim()
  if (!raw) return 'about:blank'

  if (LOCAL_HOST.test(raw)) return `http://${raw}`

  if (EXPLICIT_SCHEME.test(raw)) {
    // `https://…`, `about:blank`, `file:///…` — как написано. Адрес с пробелом
    // внутри схемы бывает только у случайно вставленного текста — в поиск.
    return /\s/.test(raw) ? searchUrlFor(searchUrl, raw) : raw
  }

  if (BARE_HOST.test(raw)) return `https://${raw}`

  return searchUrlFor(searchUrl, raw)
}

/** Хост адреса — подпись вкладки, пока страница не сообщила заголовок. */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
