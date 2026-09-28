# Общее ревью ClawForge — серия 2, раунд 1

Дата: 2026-09-18. Проверенный HEAD: `8bb4bf674deadccdc5d2d82aa7c8008f6ad09355`.
Предыдущая серия закончилась [раундом 12](review-2026-09-18-round-12.md); этот отчёт открывает
новую нумерацию и другой набор глаз, поэтому пересматривает и то, что прежние раунды считали
закрытым.

## Итог

**Одна P1, две P2, три P3.** Главная находка получена не чтением, а живым прогоном: после
установки app-owned sidecar-рецепта его приватные файлы лежат внутри data-каталога, и
snapshot-механизм о них не знает — `pull --share` теперь отклоняется всегда, а обычный
`pull` уносит plaintext-учётные данные sidecar внутрь архива и рапортует «no provider keys
inside». Две P2 — о том, что контракт «read-only» и «changed: false» для hook-команд
рецептов держится на ярлыке, который фреймворк проверить не может, и о том, что первый же
настоящий hook положил учётные данные в argv процесса на target, потому что фреймворк не дал
ему другого канала.

P0 — критическая авария; P1 — устранить до релиза; P2 — существенный ограниченный сценарий;
P3 — удобство и согласованность. Новых P0 в проверенной области не найдено. Зелёные проверки
и здоровый deployment не доказывают отсутствие дефектов вне проверенных сценариев.

## Область и метод

Прочитаны изменения после `fd54744` (восемь коммитов: доставка секретов из локального store в
обе runtime-локации, generic-хуки рецептов `prepare/verify/onboard`, `recipe import`,
условный structured-вывод, маскирование MCP-ошибок, изоляция lock-лизов, приватный `.env`
пробного set), а также заново — archive/verify, instance lock, private-file/private-config,
MCP dispatch и gate. Полный штатный набор и статические проверки прогнаны на HEAD.

Приложение проверено через настоящие stdio MCP-серверы по существующей `.mcp.json`
(`initialize → notifications/initialized → tools/list → tools/call`) отдельным JSON-RPC
клиентом; в интерфейсе этой сессии ClawForge-инструменты не зарегистрированы. Приложение
резолвит `@clawforge/framework` в checkout репозитория, сборка выполнена до прогона — то есть
проверялся именно рецензируемый код. Все значения учётных данных в этом отчёте скрыты; там,
где нужно было доказать идентичность содержимого, сравнивались только контрольные суммы.

## P1-01 — Приватные файлы рецепта попадают в snapshot, а share-backup становится невозможным

**Источники:** [private-config.ts](../tools/framework/security/private-config.ts),
`ensurePrivateTargetDirectory`/`replacePrivateTargetFile` — принимают любой абсолютный путь,
а [field-feedback](field-feedback-sidecar-round-13.md) и README направляют рецепт в
`<data>/<recipe>/`; [archive.ts](../tools/framework/service/archive.ts), `excludesFor` и
`SHARE_ALLOWED`; [verify.ts](../tools/framework/commands/lifecycle/verify.ts),
`collectSecrets` — знает только provider-ключи, gateway token и identity-токены.

Ни одна из трёх сторон не знает о приватных файлах, которые app-owned hook пишет через
собственный helper фреймворка. Для `migrate`/`full` они не исключаются; для `share` не
разрешены; verifier не ищет их значения, потому что `registerPrivateSecret` живёт в процессе
`prepare`, а `verify` запускается в другом.

**Воспроизведение на живом приложении:**

- `pull --share` (confirm) — архив создан, затем **отклонён и удалён вместе с backup**:
  `archive contains paths the 'share' profile does not allow: tor-socks5,
  tor-socks5/proxy-credentials.env, tor-socks5/tor-socks5.users.ktav, tor-socks5/arti-data, …`.
  Пока sidecar установлен, share-профиль для этого deployment недоступен вовсе.
- `pull` (migrate, confirm) — **успех**: «pulled 323 entries (29M) … no provider keys inside».
  В архиве присутствуют `data/tor-socks5/proxy-credentials.env` и
  `data/tor-socks5/tor-socks5.users.ktav`; sha256 извлечённого из архива файла учётных данных
  совпадает с живым файлом (`164366db…` = `164366db…`), users-файла — тоже (`062ff577…`).
- `verify <этот архив> --profile migrate` через MCP — **passed the 'migrate' check**.
- Внутри архива также `arti-data/` (кэш и состояние Tor-клиента) и `*.lock`/`*.templock`
  sidecar-а — host-локальное состояние, которому в переносимом архиве не место.

**Последствие:** профиль `migrate` по документации «всё, кроме provider-ключей; ключи едут
рядом в `<archive>.secrets.env`» — а на деле уносит внутри SOCKS5-логин/пароль и users-файл
прокси в открытом виде, и verifier это благословляет. Share-backup — ровно та операция,
которую предыдущие двенадцать раундов проверяли каждый раз, — сломан для любого deployment с
sidecar, который следует рекомендованной раскладке.

**Исправление:** место приватных файлов рецепта должен определять фреймворк, а не hook.
Либо выделенный корень вне data-каталога (`<data>-private/<recipe>/`, по аналогии с
`<data>-locks`), либо объявление приватных путей в `recipe.json`, из которого одновременно
выводятся исключения `excludesFor` для всех профилей, отрицательный список `verify` и
допустимый список `SHARE_ALLOWED`. `replacePrivateTargetFile` должен отказывать пути, который
не попадает под это объявление. Регрессия: реальный `pull` на fixture с рецептом, у которого
есть приватный файл, и проверка, что ни в одном профиле его байты не оказываются внутри
архива, а share-профиль не отклоняется из-за него.

## P2-01 — `recipe verify` выполняет app-owned код без подтверждения и утверждает `changed: false`

**Источники:** [recipe.ts](../tools/framework/commands/management/recipe.ts),
`RECIPE_READ_ONLY_ACTIONS` включает `"verify"`, `runRecipeHook` делает динамический `import()`
файла рецепта и вызывает его с полным `Context`; [mcp-server.ts](../tools/framework/integration/mcp-server.ts),
строки 262–279: `readOnly` снимает требование `confirm` и через `effectiveCommand` даёт
[mcp-schema.ts](../tools/framework/integration/mcp-schema.ts):93 `changed: false` «по
декларации, как факт».

**Воспроизведение:** `recipe {action: "verify", name: "tor-socks5"}` через MCP без `confirm`
выполнился (811 мс), запустил `curl` через прокси на target и вернул
`structuredContent.changed = false`. `recipe onboard` тот же hook-механизм — правильно
потребовал `confirm: true`.

**Последствие:** для `verify.ts` фреймворк не знает ничего: файл принадлежит приложению,
может писать на target и перезапускать сервисы через тот же `ctx.runtime`, что и `prepare`.
Гейт MCP («destructive требует confirm») и заявленный факт `changed: false` — единственное,
на что агент опирается между шагами, — здесь выводятся из имени действия, а не из поведения.
Это не обход защиты мутаций само по себе, но обещание, которое код не в состоянии сдержать.

**Исправление:** hook-команды не считать read-only по имени. Либо рецепт объявляет это в
`recipe.json` (`hooks.verify.readOnly: true`), и тогда фреймворк по-прежнему не утверждает
`changed: false`, а опускает поле (в `StructuredResult` `healthy` уже устроен так: «gap can be
seen»); либо `verify` требует `confirm` наравне с `onboard`. Регрессия через
`mcp-server.check.ts`: hook-действие без объявления не проходит без `confirm`, и `changed`
для него не равен `false`.

## P2-02 — Фреймворк не даёт hook-у безопасного канала для секретных аргументов

**Источники:** [private-config.ts](../tools/framework/security/private-config.ts) — API
ограничен генерацией, регистрацией для маскирования и атомарной записью файла;
`RecipeContext` отдаёт сырой `transport.exec`. Собственный прецедент фреймворка для той же
задачи — `withEnvPrefix`, `input:` (stdin) и `--env-file` в
[transport.ts](../tools/framework/runtime/transport.ts) и
[runtime-docker.ts](../tools/framework/runtime/runtime-docker.ts): токен gateway был убран с
командной строки target именно этими средствами.

**Наблюдение:** первый настоящий рецепт (`tor-socks5/verify.ts`, `onboard.ts`) передаёт
`--proxy-user <логин>:<пароль>` в argv `curl`, а при настроенном боте — и его токен в URL.
`registerPrivateSecret` маскирует вывод, но не `/proc/<pid>/cmdline` на target, где строка
видна каждому пользователю системы на время запроса. Дефект — в коде рецепта; пробел — в
контракте фреймворка, который эту дорогу не закрыл и другой не открыл.

**Исправление:** helper вида `execWithSecrets(ctx, command, args, { env })`, передающий
секреты через окружение (`withEnvPrefix`) или stdin, плюс явное правило в README для
рецептов: секрет никогда не аргумент. Для `curl` конкретно — `--netrc-file`/`--config` из
приватного файла или `CURLOPT`-переменные. Регрессия: check, который на записывающем
транспорте убеждается, что зарегистрированный секрет не появляется ни в одном элементе argv.

## P3-01 — Store после `8bb4bf6` требует gateway token, но не говорит, откуда его взять

**Источники:** [secrets.ts](../tools/framework/commands/management/secrets.ts), `applyStore`
— `needed` больше не фильтруется по `target-env`, а `absent` отвергает любой обязательный
пропуск; [service/secrets.ts](../tools/framework/service/secrets.ts), `requirementsFromConfig`
— `OPENCLAW_GATEWAY_TOKEN` объявлен `required: true` в `repo-env`; `template` не поясняет
источник значения.

Store, созданный до этого коммита, или свежий шаблон с заполненными только provider-ключами
теперь получает `1 value(s) missing` — оператор должен вручную скопировать токен из `.env`
в store, чего ни шаблон, ни сообщение не подсказывают. Опечатка при копировании доставляется
в `.env` и до перезапуска оставляет инструмент без доступа к работающему gateway. Явный
отказ с именем переменной — поэтому P3, а не выше; но контракт «store — источник истины»
стоит дописать словами в шаблоне: «значение уже есть в `.env`, скопируйте его».

## P3-02 — Два разных «следующих действия» для одного и того же LOCK_DRIFT

Живой `lock --check`: `nextActions: ["./clawforge lock"]`, при этом каждая из двух проблем
внутри того же ответа несёт `nextAction: "./clawforge plan"`. `inspect` для тех же проблем
даёт `./clawforge plan`. Агент, действующий по `nextActions`, получит разные указания в
зависимости от того, какой инструмент он вызвал. Один источник для «что делать с дрейфом
lock», и `lock --check` должен ему следовать.

## P3-03 — `secrets` называет необязательный секрет MISSING под заголовком «required»

Живой вывод: `==> required secrets … MISSING TELEGRAM_BOT_TOKEN target-env onboarding recipe`
и тут же `==> all required secrets are present`. Оба утверждения верны по отдельности и
противоречат друг другу вместе. Необязательные записи стоит либо выделить в свою группу, либо
подписать `optional`.

## Практическая работа с приложением через MCP

| Сценарий | Результат |
| --- | --- |
| Обнаружение | control: 33 инструмента (12 со structured-схемой); channel: 9 |
| status | healthy, healthz/startupz/readyz = 200; 2,0 с |
| secrets | 2 required present, 1 optional missing; значения не выводятся; 0,5 с |
| lock --check | 2 × LOCK_DRIFT warning (рецепт tor-socks5 и TELEGRAM_BOT_TOKEN не в lock); 0,4 с |
| recipe {} | tor-socks5 (disabled, но установлен и healthy) и confluence-mock как agent/MCP bundle; без confirm |
| recipe status tor-socks5 | контейнер Up, healthy; 0,8 с |
| inspect | healthy=true, те же 2 warning; 20,1 с |
| pull --share (confirm) | **отклонён и удалён** — P1-01; gateway остановлен и вернулся healthy; 19,8 с |
| pull (migrate, confirm) | успех, 323 entries, 29M; sidecar-учётные данные внутри — P1-01; 21,2 с |
| verify … --profile migrate | passed — P1-01 |
| verify … --profile share | failed, 6 findings, включая `tor-socks5/…` |
| recipe verify tor-socks5 | выполнен **без confirm**, `changed: false` — P2-01; 0,8 с |
| recipe onboard tor-socks5 | отказ без confirm — корректно |
| Права артефактов | backup и snapshot 600; `.secrets.env` 600; `.template.env` 644 (только имена) |
| Retention | штатно удалены один share-backup и один snapshot сверх лимита 10 |
| conversations_list / permissions_list_open | 0 и 0, без ошибок; initialize channel-сервера 6,0 с |
| main через control `cli` (confirm) | ответ `REVIEW-R1-OK`; 16,0 с |

Диалог с агентом: одно сообщение в `main` через `cli agent --agent main -m …` с явным
`confirm: true` — той же формой, что использует `smoke`. Model-use подтверждён. Channel
conversations по-прежнему пусты.

Реальные изменения приложения за прогон: один отклонённый share-backup (удалён фреймворком),
один migrate-backup и один snapshot оставлены, штатная ротация retention, две короткие
остановки gateway, один probe `curl` через прокси (hook рецепта), одна сессия `main`.
`recipe onboard` не выполнялся.

## Удобно ли пользоваться агенту

**Для администрирования — да.** Инструменты обнаруживаются с полными описаниями и схемами;
`inspect`/`lock` возвращают `healthy/problems/nextActions`, по которым можно действовать без
разбора текста; гейт `confirm` предсказуем — read-only команды идут без него, мутации
останавливаются с понятной фразой; backup выполняет цикл stop → archive → start → verify и
сам удаляет то, что не прошло проверку. Ошибки, когда они есть, объяснены словами.

**Что мешало.**

- `pull`, `status`, `verify` — только текст. Отказ share-backup пришёл как `isError: true` с
  прозой; чтобы понять причину и путь артефакта, приходится читать. Поля
  `artifact`/`profile`/`verdict`/`findings` в `structuredContent` сделали бы цепочку
  «backup → verify → restore» машинной.
- Обращение к агенту требует знать OpenClaw CLI (`agent --agent main -m`). Отдельный
  `agent-call` с явным model-use и коротким структурированным ответом был бы удобнее и
  безопаснее, чем универсальный `cli`.
- Два разных `nextActions` для одного дрейфа (P3-02) — именно то, что сбивает агента,
  который следует подсказкам буквально.
- `inspect` 20 с — терпимо для точечной проверки, ощутимо в цикле «изменил → проверил».
- Хорошо: `verify` доступен отдельно и честно рассказывает, что он не сканирует (личное
  содержимое transcripts/workspace) — это правильная граница, названная вслух.

## Проверки и границы

- Node v24.12.0. `npm test`: **78 check-файлов прошли**; `tsgo --noEmit`, `oxlint
  --deny-warnings`, сборка 80 файлов, `npm run pack:check` — exit 0 (коды сняты без пайпа).
- `actionlint` по обоим workflow — без замечаний.
- Приложение резолвит фреймворк в checkout репозитория (symlink); сборка выполнена до
  MCP-прогона.
- Не выполнялись: live restore/push, rollback, ротация ключей, SSH-таргет, публикация пакета,
  restore round-trip, `recipe onboard`, `recipe import`.
- В каталоге `recipes/confluence-mock/` приложения лежат пустые каталоги с именами файлов без
  последнего символа (`README.m/`, `acceptance.jso/`, …), датированные созданием deployment.
  Фреймворк их не создаёт (`init` делает только `config/secrets/recipes`) и молча
  игнорирует; происхождение вне кода репозитория, на поведение не влияет — отмечено, чтобы
  не удивляло следующего читателя.
- В отчёте нет значений секретов и частных путей машины; исходный код и тесты в этом раунде
  не менялись. Коммит содержит только этот документ.
