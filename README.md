# Kontur

Единое рабочее место для двух изолированных сетевых контуров: задачи, вики, git,
чат, почта и календарь в одном окне — плюс сквозной поиск, заметки, терминал и
автоматизации.

Репозиторий (HTTPS): https://github.com/anger1989/kontur-app.git

```bash
git clone https://github.com/anger1989/kontur-app.git
```

## Зачем нативное приложение

Браузер не умеет держать два VPN-туннеля, ходить во внутренние сети контуров и
открывать веб-клиенты с `X-Frame-Options`. Electron может: у каждого контура
своя партиция cookies и свой транспорт, сервисы живут в `WebContentsView`, а не
в iframe.

## Возможности

- Два контура + «Общие» сервисы (вне VPN)
- Подъём VPN: Check Point (`trac` / snx-rs), OpenVPN/Tunnelblick, scutil, своя команда
- Почта: EAS / EWS / IMAP / JMAP — папки, перемещение, inbox rules (EWS)
- Jira, Confluence, GitLab, Bitbucket, Mattermost
- Рабочий стол, виджеты, блокировка, скринсейвер
- Встроенный терминал (несколько вкладок), браузер, файлы, заметки
- MCP-сервер для AI-агентов (localhost)

## Секреты

Пароли и токены шифруются `safeStorage` (на macOS — Keychain) и не попадают в
git. В renderer значения не уходят, пока явно не нажмёте «показать».

Дефолтные URL сервисов в репозитории **пустые** — каждый задаёт свои адреса в
настройках / онбординге.

## Запуск

```bash
npm install
npm run fetch:snx   # опционально: бинари snx-rs (AGPL) для dist
npm run dev
```

```bash
npm run typecheck
npm run dist:mac    # → dist/Kontur-<version>-arm64.dmg
```

## Обновления (без Apple Developer ID)

Приложение при старте и по кнопке «Проверить обновления» смотрит
[GitHub Releases](https://github.com/anger1989/kontur-app/releases). Если есть
версия новее — предлагает скачать DMG; пользователь сам ставит в Applications.

Публикация релиза (нужен `GH_TOKEN` с правом `contents:write`):

```bash
# поднимите version в package.json, затем:
npm run dist:mac -- --publish always
```

## Стек

Electron · React · TypeScript · Tailwind · better-sqlite3 · undici · zustand ·
xterm / node-pty · MCP SDK.

## Лицензия

MIT — см. [LICENSE](LICENSE).  
Встроенный snx-rs — AGPL; см. `vendor/snx-rs/NOTICE`.
