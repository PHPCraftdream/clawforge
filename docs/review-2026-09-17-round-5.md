# Общее ревью ClawForge — раунд 5

Дата: 2026-09-17. Проверенный HEAD: `e6f3594e09af000d7a67be1cd1d40a1f0fd02fde`.
Предыдущий отчёт: [раунд 4](review-2026-09-17-round-4.md).

## Итог

Исправления раунда 4 подтверждены кодом и проходящими регрессионными проверками; default recipe также перепроверен через живой MCP. Новых P0/P1 в проверенной области не обнаружено. Найдены **две P2**: использование digest от другого image reference и обход instance lock независимыми параллельными операциями одного процесса.

P0 — критическая авария; P1 — исправить до релиза; P2 — существенный ограниченный сценарий; P3 — удобство. Отсутствие новых P0/P1 не доказывает отсутствие дефектов вне проверенных сценариев. Две P2 остаются открытыми; этот коммит содержит только отчёт.

Область: изменения после раунда 4, archive verification, inspect checksums, MCP command dispatch, set manifest/image requirements, lock/reentrancy, lifecycle и backup, упаковка/статические проверки, практическая работа WSL/Docker приложения. Метод: чтение исходников, полный штатный набор, отдельные синтетические воспроизведения и новый stdio MCP-прогон.

## Статус раунда 4

| Находка | Текущий результат |
| --- | --- |
| P1-01: shell-подстановки из target-пути в inspect | Путь передаётся отдельным argv, shell обращается к quoted positional parameter. Новый checksums.check.ts и штатные проверки проходят. |
| P1-02: literal gateway token из архива пропускался share-verifier | Разбирается собственное gateway.auth.token архива независимо от live token; literal отвергается вне full. Проверки literal/ref/profile проходят. |
| P3-01: recipe без action требовал confirm | Predicate теперь использует тот же default action, что dispatcher. Оба вызова recipe {} и recipe {action:list} прошли через MCP без confirm. |

## P2-01 — Set может молча закрепить образ от другого image reference

**Источник:** [set-manifest.ts](../tools/framework/commands/sets/set-manifest.ts), `requiredImage`, строки 80–83, и заполнение manifest.requires.image; [lock.ts](../tools/framework/commands/management/lock.ts), `readLock`.

Когда текущий image задан тегом, requiredImage возвращает lock.image.digest, не проверяя соответствие lock.image.reference текущему ctx.settings.image. После изменения OPENCLAW_IMAGE старый lock может относиться к другой repository/tag. Сборка не сообщает о расхождении и приписывает set старый image digest.

**Воспроизведение:** временный deployment с корректным desired-state.json. Lock содержит reference `old.example/old-image:stable` и digest того же old-image; текущий context содержит `new.example/new-image:stable`. Настоящие collectManifest и validateSet дали:

- `NEW_REFERENCE_USED=false`;
- `OLD_LOCK_IMAGE_PINNED=true`;
- `VALIDATION_CODES=[]`.

Сети и живого target в воспроизведении нет; использованы вымышленные image references и синтетический digest. Проверено содержимое manifest, реальная установка этого set не выполнялась.

**Последствие:** artifact может заявлять другой runtime, чем текущая декларация оператора. Set try использует manifest image, поэтому последующая проверка может проверять старый образ. Сохранение digest при движении того же тега полезно; здесь проблема в переносе digest между явно разными references без диагностики.

**Исправление:** проверять соответствие lock текущему image reference до использования digest, при расхождении требовать актуализации lock либо явного pinned image. Не резолвить тег молча через сеть: offline-свойство set build можно сохранить, отказав с понятным действием. Покрыть смену repository/tag, неизменный reference и явный digest.

## P2-02 — Reentrancy instance lock распространяется на весь процесс

**Источник:** [instance-lock.ts](../tools/framework/runtime/instance-lock.ts), `heldHere`/`lockHeldHere`, строки 198–201, и `guarded`, строки 344–345.

Глобальный счётчик отличает только «в этом процессе есть lock» от «lock нет». Он не отличает вложенный вызов текущей операции от независимой asynchronous-цепочки. Пока одна guarded-операция держит lock, другая независимая guarded-операция в том же процессе сразу выполняет body, не пытаясь получить блокировку.

**Воспроизведение:** настоящий guarded и WslTransport, отдельный временный data root. Первая операция получает lock, сигнализирует о входе и ожидает управляемый Promise. После этого верхнеуровневый код, вне её callback, запускает вторую guarded-операцию для того же context. До разрешения Promise первой операции получены:

- `FIRST_LOCK_EXISTS=true`;
- `SECOND_ENTERED_WHILE_FIRST_RUNNING=true`;
- после завершения первой `LOCK_REMOVED_AFTER_FIRST=true`.

Body обеих операций только меняли локальные диагностические флаги. Реальное состояние приложения не менялось; выполнялось создание/удаление lock в fixture. Ожидание кооперативное, без нагрузки и sleep-поллинга.

**Границы воздействия:** стандартный control-MCP последовательно обрабатывает tools/call, поэтому это не доказанный обход через два запроса его обычной последовательной сессии. Сценарий касается concurrent-вызовов framework-команд/guarded из одного процесса, например custom application command. Межпроцессная блокировка этим воспроизведением не опровергается.

**Последствие:** приложение, параллельно запускающее команды через framework API, может одновременно выполнять несовместимые мутации, хотя обе команды используют guarded. Глобальный счётчик также не привязан к ресурсу context.

**Исправление:** ограничить reentrancy текущей asynchronous-цепочкой и идентичностью блокируемого ресурса, например через AsyncLocalStorage с owner token. Независимые операции должны отдельно получать lock или ждать; настоящие вложенные вызовы должны продолжать работать без самоблокировки.

## Новый прогон приложения через MCP

Проверка выполнена после сборки текущего HEAD через настоящий stdio MCP по существующему `.mcp.json`: initialize → initialized → tools/list → последовательные tools/call. Непосредственно зарегистрированных ClawForge-инструментов в интерфейсе этой сессии нет; использован программный клиент по той же конфигурации. Автоматическое обнаружение серверов самим интерфейсом не проверено.

| Операция | Результат раунда 5 |
| --- | --- |
| Обнаружение | 33 control tools, 9 channel tools |
| inspect без helper | healthy=true, changed=false, problems=[]; 21,1 с |
| up | Gateway уже Running и healthy; 1,8 с |
| cli-start | Helper создан и запущен; 2,1 с |
| inspect с helper | healthy=true, changed=false, problems=[]; 18,6 с |
| cli-stop | Helper остановлен и удалён; 0,9 с |
| recipe {} и recipe {action:list} | Оба успешно показывают agent/MCP bundle без confirm |
| lock --check | changed=false, problems=[] |
| pull --share | Stop/archive/start/verify прошли; 177 entries, около 88 KiB; 20,0 с |
| Права snapshot | 600, отдельно проверено stat на target |
| Retention | Штатно удалён один старый snapshot сверх лимита 10 |
| status после backup | Runtime healthy; healthz/startupz/readyz = 200 |
| conversations_list / permissions_list_open | Оба списка пусты, readiness-ошибок нет |
| main через control-MCP cli | status=ok, payload и visible text = REVIEW-OK; 15,2 с |

До теста helper отсутствовал. После cli-stop отдельный docker ps -a с project/service filters подтвердил его отсутствие. Сравнение inspect показало около 2,5 с разницы, но это один последовательный прогон без контроля кешей и нагрузки — не устойчивый benchmark и не обещание ускорения на других машинах.

Main получил одно сообщение в отдельной новой сессии с просьбой вернуть REVIEW-OK без инструментов, изменений файлов и внешних сообщений. Model-use был явным через confirm; usage — 16 945 токенов. Диалог через MCP → CLI → gateway/model подтверждён; channel conversations по-прежнему отсутствуют. Другие агенты не проверялись.

Share-verifier проверил известные provider/gateway и identity-секреты; значения не выводились. Внешняя symlink plugin dependency была диагностирована как нефатальная. Успешный scan не доказывает отсутствие персональных данных и неизвестных сканеру секретов в workspace.

## Удобство

Администрировать через MCP удобно: команды обнаруживаются, ограничения описаны, inspect/lock структурированы, backup выполняет согласованный цикл и возвращает gateway в здоровое состояние. Default recipe больше не требует разбираться в ненужном подтверждении. Helper тоже управляется через MCP и не требует отдельного ручного Docker-сценария.

Для общения остаётся необходимость знать аргументы универсального OpenClaw CLI: agent, session-id, timeout и JSON-режим. Отдельный agent-call с явным model-use и компактным ответом был бы удобнее. Backup/status по-прежнему возвращают текст: структурированные artifact/profile/verification fields упростили бы автоматизацию. Измеренные задержки inspect заметны даже с helper, поэтому частые повторные проверки состояния стоят времени.

## Проверки и ограничения

- `npm test` с WSL-проверками: 77 check-файлов прошли; штатных падений не было.
- tsgo и Oxlint прошли; build выпустил 80 файлов; actionlint обоих workflows прошёл.
- Синтетические fixtures создавались вне приложения и удалены. Исходники продукта не менялись.
- Реальные изменения: краткоживущий helper (удалён), share-backup/snapshot, штатная retention-ротация, краткая остановка/запуск gateway для backup, отдельная сессия main.
- Не выполнялись live restore, реальная смена image, concurrent-мутации живого target, SSH, npm publish или полноценный restore-round-trip.
- Реальные ключи и приватные пути компьютера в отчёт не включены.
