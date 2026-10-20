---
name: kontur-tasks
description: Задачи в Kontur — поиск и заведение issue в Jira (JQL, сабтаски, комментарии) и личный планировщик todos со сроками и напоминаниями. Использовать при просьбах про задачи, тикеты, бэклог, «напомни», «поставь дело».
---

# Задачи

Два разных хранилища, их легко перепутать:

- **Jira** — рабочие задачи команды, `jira_*`. Видны коллегам.
- **Планировщик Kontur** — личные дела, `todos_*`. Живут локально, никто
  другой их не видит, у них есть срок и напоминание.

«Поставь себе напоминание», «не забыть» — это `todos_*`. «Заведи задачу»,
«создай тикет» — Jira (уточни проект, если он неочевиден).

## Jira

```
jira_search       { jql, env? }
jira_create_issue { projectKey, summary, description?, issueType?, parent?, env? }
jira_comment      { issueKey, body, env? }
```

JQL под рукой:

| Что нужно              | JQL                                                      |
| ---------------------- | -------------------------------------------------------- |
| мои открытые           | `assignee = currentUser() AND resolution = Unresolved`    |
| я поставил             | `reporter = currentUser() ORDER BY created DESC`          |
| в проекте за неделю    | `project = PLAT AND created >= -7d`                       |
| ждут меня              | `assignee = currentUser() AND status = "In Review"`       |

Сабтаска: `parent` = ключ родителя плюс `issueType: 'Sub-task'` (в части
проектов — `'Dev Sub-task'`). Если тип не подошёл, Jira вернёт ошибку со
списком допустимых — прочитай её и повтори, а не выдумывай тип.

`projectKey` — префикс ключа задачи (`PLAT-123` → `PLAT`). Не угадывай его:
найди соседнюю задачу через `jira_search` или спроси.

## Планировщик

```
todos_list   { includeDone?, limit? }
todos_create { title, dueAt?, remindAt?, note?, showInCalendar? }
todos_update { todo, title?, done?, dueAt?, remindAt?, note? }
todos_delete { todo }
```

`todo` — id из `todos_list` или точное название. Даты — ISO-8601 с
таймзоной: `2026-10-20T10:00:00+03:00`. «Завтра к 10» считай от текущей даты
и подставляй абсолютное время; `null` в `dueAt`/`remindAt` снимает срок.

Закрыть дело — `todos_update { todo, done: true }`, а не `todos_delete`:
удаление безвозвратно и ломает историю. `showInCalendar: true` кладёт дело со
сроком в календарь Kontur.

## Как действовать

- Перед созданием задачи поищи похожую (`jira_search` по ключевым словам) —
  и скажи пользователю, если нашёл дубль.
- `description` в Jira пиши структурно: что произошло, что ожидалось, как
  воспроизвести, ссылки. Одну строку «починить» никто не починит.
- Разбирая «что у меня на сегодня», совмещай оба источника: `kontur_my_day`
  (задачи, ревью, письма) и `todos_list` (личные дела).
