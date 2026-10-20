---
name: kontur-mail
description: Почта Kontur через MCP — разобрать входящие, прочитать письмо целиком, разложить по папкам и завести серверные inbox-правила (Exchange). Использовать при любой просьбе про письма, почту, рассылки и разбор ящика.
---

# Почта

Два ящика: `bank` и `ecom`. Список писем идёт из локальной базы синхронизации,
тело письма — живым запросом на сервер.

## Прочитать

```
mail_list   { unreadOnly?: true, limit?: 30, env?: 'bank' }
mail_read   { id: 'bank:bank.mail:mail:AAMk...' }
```

`mail_list` отдаёт `id`, `subject`, `from`, `folder`, `unread`, `date` и
`preview` (первые 400 символов). Превью обрезано — если нужно отвечать по
существу или искать детали, бери `mail_read`: там `subject`, `from`, `to`,
`cc`, `date` и полный текст. `mail_read` помечает письмо прочитанным и на
сервере тоже — не вызывай его пачкой «на всякий случай».

Поиск по всем ящикам сразу — `kontur_search { query }`: вернёт письма вместе с
задачами и сообщениями, у писем будет тот же `id` для `mail_read`.

## Разложить по папкам

```
mail_list_folders   { env?: 'bank' }          → id, name, role (inbox|sent|drafts)
mail_create_folder  { name, parentId?, env? }
mail_move           { ids: [...], folderId, env? }
```

`folderId` — либо `id` из `mail_list_folders`, либо роль `inbox` / `sent` /
`drafts`. Перемещать можно пачкой: собери `ids` из `mail_list`.

## Серверные правила (только Exchange/EWS)

```
mail_list_rules        { env? }
mail_upsert_rule       { name, fromContains?, toContains?, subjectContains?,
                         moveToFolder?, markRead?, markImportant?, id?, enabled?, env? }
mail_set_rule_enabled  { ruleId, enabled, env? }
mail_delete_rule       { ruleId, env? }
```

Правило работает на сервере — оно разбирает почту и когда Kontur закрыт.
Без `id` создаётся новое, с `id` — переписывается существующее. У IMAP/JMAP
правил нет: инструмент честно ответит «только через EWS», это не ошибка сети.

`moveToFolder` ждёт тот же `folderId`, что и `mail_move`: сначала
`mail_list_folders`, при необходимости `mail_create_folder`.

## Как действовать

**«Разбери входящие»** — `mail_list { unreadOnly: true }`, сгруппируй по
отправителям и темам, покажи пользователю, что предлагаешь переместить или
пометить, и только после согласия вызывай `mail_move` / правила.

**«Больше не хочу эти рассылки»** — найди характерный признак
(`fromContains` надёжнее, чем тема), заведи папку, создай правило и скажи, что
старые письма правило не тронет: их двигает `mail_move` отдельно.

**Ответ на письмо** агент не отправляет: у MCP нет инструмента отправки почты,
это делает сам пользователь в окне Почты. Подготовь текст — не обещай, что
письмо ушло.
