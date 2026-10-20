---
name: kontur-reviews
description: Код-ревью через Kontur — пул-реквесты Bitbucket (bank) и merge request'ы GitLab (ecom): найти ждущие меня, прочитать diff и ленту, оставить комментарий к строке, поставить апрув. Использовать при просьбах про ревью, PR, MR, диффы.
---

# Ревью

Bitbucket живёт в контуре `bank`, GitLab — в `ecom`. Инструменты разные, но
сценарий один: найти → прочитать → прокомментировать → поставить статус.

## Что ждёт меня

```
bitbucket_list_reviews { env? }   → PR по всем репозиториям, где я ревьюер
gitlab_list_reviews    { env? }   → MR, ждущие моего ревью
```

## Bitbucket

PR адресуется тройкой из ссылки
`…/projects/ABC/repos/payments/pull-requests/42` → `project: 'ABC'`,
`repo: 'payments'`, `prId: 42`.

```
bitbucket_get_pr      { project, repo, prId }              описание, ветки, ревьюеры
bitbucket_pr_diff     { project, repo, prId, contextLines? } unified diff (длинный режется)
bitbucket_pr_activity { project, repo, prId }              комментарии, апрувы, пуши
bitbucket_comment_pr  { project, repo, prId, text, path?, line?, lineType? }
bitbucket_review_pr   { project, repo, prId, status? }     APPROVED | NEEDS_WORK | UNAPPROVED
bitbucket_search_code { query, env? }
```

Комментарий без `path` — общий к PR. С `path` (и `line`) он привязывается к
строке диффа: путь бери ровно таким, как он в диффе, а номер строки — из
того же диффа, иначе Bitbucket привяжет комментарий не туда.

`bitbucket_review_pr` без `status` ставит `APPROVED`. `NEEDS_WORK` и
`UNAPPROVED` снимают апрув.

## GitLab

```
gitlab_comment_mr { projectId: number, mrIid: number, body }
gitlab_approve_mr { projectId: number, mrIid: number }
```

`projectId` и `mrIid` — числа; оба есть в ответе `gitlab_list_reviews`.
`mrIid` — это номер MR внутри проекта (из URL), а не глобальный id.

## Как действовать

1. Прочитай diff целиком, прежде чем писать хоть один комментарий. Если diff
   обрезан, сузь обзор: ревьюй по файлам и скажи пользователю, что смотрел не
   всё.
2. Посмотри `bitbucket_pr_activity` — возможно, про это уже написали, и твой
   комментарий будет третьим подряд.
3. Комментарии пишутся от имени пользователя и видны команде. Формулируй по
   делу, с конкретной строкой и предложением, как исправить. Черновик покажи
   пользователю, если он не просил «просто оставь комментарии».
4. **Апрув — только по явной просьбе.** «Посмотри PR» означает прочитать и
   пересказать, а не одобрить.
