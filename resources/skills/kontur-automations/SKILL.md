---
name: kontur-automations
description: Сценарии Kontur — автоматизации по расписанию (cron) и по событию (письмо, сообщение, ревью, задача, встреча) с шагами notify, todos.create, mattermost.post, notes.read. Использовать при просьбах «делай это каждый день», «когда придёт X — сделай Y», настроить напоминания и дежурства.
---

# Автоматизации

Локальные сценарии Kontur: триггер плюс упорядоченные шаги. Работают, пока
запущен Kontur, и видны пользователю в виджете «Автоматизации».

```
automations_list             список и статус последнего запуска
automations_get              { automation }  id или точное имя
automations_upsert           создать или заменить
automations_set_enabled      { automation, enabled }
automations_run_now          { automation }  прогнать сразу
automations_delete           { automation }
automations_list_step_types  каталог шагов с параметрами
automations_list_event_types каталог событий
```

## Триггер: ровно одно из двух

**По расписанию** — `cron` (5 полей) и `tz` (по умолчанию `Europe/Moscow`):
`'0 9 * * 1'` — понедельник, 9 утра.
Если к `cron` добавить `filter` — это **poll непрочитанной почты**: на тике
берутся unread-письма по фильтру, шаги гоняются на каждое, после успеха письмо
помечается прочитанным (курсор = unread, без дублей).

**По событию** — `event` плюс необязательный `filter`:

| Событие            | Когда                                       |
| ------------------ | ------------------------------------------- |
| `mail.received`    | новое письмо во входящих                    |
| `message.received` | сообщение/упоминание в Mattermost           |
| `review.new`       | новый MR/PR на мне                          |
| `task.new`         | новая задача                                |
| `calendar.soon`    | до встречи осталось `minutesBefore` минут   |

`filter`: `envId`, `authorContains`, `titleContains`, `bodyContains`,
`mentioned` (только упоминания), `folder`, `minutesBefore`.

Указать и `cron`, и `event` нельзя — инструмент вернёт ошибку.

## Шаги

`steps: [{ type, params }]`, по порядку. Типы (актуальный список —
`automations_list_step_types`):

- `notify` — баннер macOS: `title`, `body`.
- `todos.create` — дело в планировщике: `title`, `note?`, `dueAt?`, `remindAt?`.
- `mattermost.post` — сообщение: `channel`, `message`, `env?`.
- `mattermost.set_header` — шапка канала: `channel`, `header`.
- `mattermost.set_banner` — плашка: `channel`, `text`, `color`, `enabled?`.
- `mattermost.mark_alert_resolved` — закрыть FIRING-алерт в канале.
- `notes.read` — прочитать заметку в контекст: `path`, результат в
  `noteContent`.
- `duty.resolve` — разобрать график дежурств из прочитанной заметки.
- `mail.mark_read` — пометить письмо прочитанным (`id` или `{{item.id}}`).
  Для `cron+filter` отметка делается и без шага после успешного прогона.

Список шагов закрытый: тип, которого нет в каталоге, при сохранении
отклоняется с перечнем доступных. Если нужного шага не существует — так и
скажи пользователю, не подбирай похожее имя наугад.

В строковых параметрах работают подстановки из события/письма: `{{title}}`,
`{{author}}`, `{{url}}`, `{{body}}`, `{{item.*}}`, а также значения, которые
положили предыдущие шаги (например `{{noteContent}}`).

Poll алертов в канал (каждые 5 минут):

```json
{
  "name": "NOTIFICATIONS → MM",
  "cron": "*/5 * * * *",
  "filter": { "authorContains": "NOTIFICATIONS", "folder": "inbox" },
  "steps": [
    { "type": "mattermost.mark_alert_resolved",
      "params": { "channel": "alerts", "title": "{{title}}", "env": "shared" } },
    { "type": "mattermost.post",
      "params": { "channel": "alerts", "env": "shared",
        "message": "**{{title}}**\nот {{author}}\n\n{{body}}" } }
  ]
}
```

## Примеры

Упоминание в Mattermost → дело в планировщике:

```json
{
  "name": "Упоминания в дела",
  "event": "message.received",
  "filter": { "mentioned": true },
  "steps": [
    { "type": "todos.create",
      "params": { "title": "Ответить: {{title}}", "note": "{{url}}" } }
  ]
}
```

Понедельник, 9:00 — дежурный в шапку канала:

```json
{
  "name": "Дежурный недели",
  "cron": "0 9 * * 1",
  "steps": [
    { "type": "notes.read", "params": { "path": "Дежурства" } },
    { "type": "duty.resolve", "params": {} },
    { "type": "mattermost.set_header",
      "params": { "channel": "it-leads", "header": "Дежурный: {{duty}}" } }
  ]
}
```

## Как действовать

1. Сначала `automations_list` — возможно, похожий сценарий уже есть, и его
   надо обновить (`automations_upsert` с тем же `id`), а не плодить второй.
2. Проверяй шаги через `automations_run_now`: у event-сценария контекст
   `item.*` при этом пустой, зато видно, что шаги вообще отрабатывают.
3. Сценарии, которые пишут другим людям (`mattermost.post`, баннеры),
   показывай пользователю текстом до создания и включай только с его
   согласия — можно создать с `enabled: false` и включить потом.
4. Ненужный сценарий лучше выключить (`automations_set_enabled`), чем
   удалять: удаление безвозвратно.
