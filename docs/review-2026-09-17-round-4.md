# Общее ревью ClawForge — раунд 4

Дата: 2026-09-17. Проверенный HEAD: `f03b31c69ba968a08410694d310ca62c81658465`.
Предыдущий отчёт: [раунд 3](review-2026-09-17-round-3.md).

## Итог

Находки раунда 3 исправлены и покрыты проходящими проверками. В раунде 4 подтверждены **две P1 и одна P3**: shell-инъекция при вычислении target checksums, ложное разрешение share-архива с явным gateway token и избыточное подтверждение для recipe без action.

P0 — критическая авария; P1 — исправить до релиза; P2 — существенный ограниченный сценарий; P3 — удобство и согласованность. Новых P0/P2 в этом проходе не зафиксировано. Рекомендация: устранить P1 до релиза. Коммит содержит только отчёт.

Область: изменения после раунда 3, credential writes/stores, lifecycle, inspect/plan и сравнение recipe/workspace, backup/archive verification, transport, CLI/MCP, сборка и workflows. Проверены выбранные граничные сценарии и живое WSL/Docker приложение. Отсутствие находок в остальных прочитанных участках не является доказательством отсутствия ошибок во всех ветках.

## Проверка исправлений раунда 3

| Прежняя находка | Текущий результат |
| --- | --- |
| P1-01: target provider environment писался до chmod и обрезался при ошибке | loadSecrets теперь создаёт private staging рядом с final-файлом, задаёт owner до публикации и публикует rename. Set try использует тот же путь. Проверки прав, отказов и сохранности прежних значений проходят. |
| P1-02: Windows local secret-store наследовал широкие ACL | Создание/замена store используют private-file API; каталог stores также защищается. При чтении заполненного store есть диагностика защиты. Проверки ACL проходят. |
| P2-01: после обновления ключей предлагался up вместо restart | Для работающего экземпляра предлагается restart, для остановленного — up; прямо сказано, что запись файла не равна перечитыванию текущим процессом. Проверки обеих веток проходят. |

## P1-01 — Read-only inspect исполняет shell-подстановки из target-пути

**Источник:** [observe.ts](../tools/framework/commands/orchestration/inspect/observe.ts), `targetFileChecksums`, строки 97–107; вызовы для recipe mirror и agent workspace — строки 368 и 378.

Команда формируется как `cd ${JSON.stringify(dir)} && find ...`. JSON-кавычки не являются безопасным quoting для POSIX shell: внутри двойных кавычек продолжают выполняться command substitution и подстановки переменных. Путь содержит target data directory из конфигурации; ограничения имён recipe сами по себе его не защищают.

**Воспроизведение:** во временном каталоге WSL создан настоящий каталог с буквальным компонентом `$(printf REVIEW_CHECKSUM_EXECUTED >&2)` и синтетический content.txt. Создание выполнено через argv, без shell-подстановок. Из текущего исходника извлечена без изменений функция targetFileChecksums, TypeScript-типы удалены штатным Node API; функция вызвана с настоящим WslTransport. Наблюдатель только проверял stderr результата:

- `CHECKSUM_COMMAND_SUBSTITUTION_EXECUTED=true`;
- `EXPECTED_RELATIVE_CONTENT_KEY_PRESENT=false`;
- функция вернула один checksum, но уже с неправильным относительным путём.

Из-за пустого stdout printf команда cd попала в родительский каталог fixture. Выполнялся только безвредный вывод маркера; реальные файлы приложения не использовались. Проверена точная функция checksum, не полный inspect с подменой конфигурации живого приложения.

**Последствие:** контроль над компонентом target-пути позволяет выполнить команду от пользователя transport при операции, объявленной read-only. Дополнительно возможны ложные findings о drift, поскольку checksums вычисляются для другого дерева. Root-права в этом воспроизведении не использовались и не утверждаются; удалённая достижимость через произвольное сообщение агенту не доказана.

**Исправление:** передавать путь позиционным аргументом `sh -c` с обращением через quoted positional parameter либо использовать корректное POSIX quoting. Проверить literal-сохранение пробелов, апострофов, dollar/backtick-подстановок и корректность checksum inventory. Ошибку вычисления желательно отличать от успешного пустого inventory.

## P1-02 — Share-verifier пропускает явный gateway token из самого архива

**Источник:** [verify.ts](../tools/framework/commands/lifecycle/verify.ts), `collectSecrets`, строки 56–108, и разбор archived openclaw.json, строки 221–255.

Gateway token добавляется в search patterns из текущего `ctx.settings.env.OPENCLAW_GATEWAY_TOKEN`. В собственном openclaw.json архива отдельно проверяются только `models.providers.*.apiKey`. Явное `gateway.auth.token` не анализируется как credential по схеме. Поэтому архив другого экземпляра или архив, созданный до смены токена, может пройти share-проверку, хотя содержит явно именованный секрет.

**Воспроизведение:** создан настоящий tar.gz во временном WSL-каталоге с единственным конфигурационным файлом внутри data/config. В JSON записаны `gateway.auth.mode=token` и синтетический plaintext token длиной больше 12 символов. Контекст verifier содержал другой синтетический текущий token. Настоящий verifySnapshot и WslTransport дали:

- `ARCHIVED_PLAINTEXT_GATEWAY_TOKEN_SHARE_PASSED=true`;
- `SUCCESS_MESSAGE_PRESENT=true` для passed share check;
- `TOKEN_VALUE_PRINTED=false`.

Значения не выводились; секреты приложения не использовались. Ошибка воспроизведена без моделирования tar, grep или filesystem.

**Последствие:** результат «прошёл share check» может разрешить распространение архива с явным gateway credential, неизвестным текущему instance. Был ли этот credential уже отозван, verifier не знает. Это конкретный пропуск известного credential-поля, а не требование угадывать любые неизвестные секреты в произвольном тексте workspace.

**Исправление:** анализировать credential-поля самого archived config независимо от текущих значений, начиная с gateway.auth.token. Различать literal credential и поддерживаемые ссылки на секреты. Для share/migrate такой literal должен давать отказ, для full — ожидаемую диагностику. Не включать значения в сообщения. Отдельно покрыть архив другого instance и архив до ротации.

## P3-01 — Recipe без action требует подтверждения для обычного списка

**Источник:** [recipe.ts](../tools/framework/commands/management/recipe.ts), строка 35; [openclawCommands.management.ts](../tools/framework/commands/interface/groups/openclawCommands.management.ts), строка 146.

CLI-dispatcher трактует отсутствие action как list. MCP predicate `readOnlyWhen` проверяет только явно переданные list/status/logs и при отсутствии action возвращает false. Поле action в schema не обязательное.

**Воспроизведение через живой control-MCP:** `recipe` с пустыми arguments возвращает isError=true и просьбу confirm: true; `recipe` с action=list без confirm успешно показывает inventory.

**Последствие:** агент видит предупреждение о замене/удалении состояния для default read-only операции. Это лишний барьер и несогласованность CLI/MCP, а не обход защиты мутаций.

**Исправление:** одинаково трактовать default action в dispatcher и predicate, сохранив подтверждение для install/remove.

## Практическая проверка MCP и приложения

После сборки текущего HEAD запущены реальные stdio MCP-серверы по существующему `.mcp.json`: initialize → initialized → tools/list → последовательные tools/call. ClawForge tools не зарегистрированы непосредственно в интерфейсе текущей сессии, поэтому использован программный клиент с этой конфигурацией. Автоматическое подключение серверов интерфейсом не проверялось.

| Сценарий | Результат раунда 4 |
| --- | --- |
| Обнаружение | 33 control tools и 9 channel tools |
| inspect | healthy=true, changed=false, problems=[]; 32,1 с |
| up | Gateway healthy, существующий контейнер Running; 3,4 с |
| recipe без action / action=list | Первый запрос ошибочно требует confirm; второй успешно показывает agent/MCP bundle |
| lock --check | changed=false, problems=[], без confirm |
| pull --share | Stop/archive/start/verify прошли; 177 entries, около 88 KiB; 32,7 с |
| Snapshot permissions | Mode 600, отдельно проверено stat на target |
| Retention | Штатно удалён один старый snapshot сверх лимита 10 |
| status после snapshot | Runtime healthy; healthz/startupz/readyz = 200 |
| conversations_list / permissions_list_open | Оба списка пусты; readiness-ошибок не было |
| main через control-MCP cli | status=ok; payload и visible text = REVIEW-OK; 21,3 с |

Агент main получил один диагностический запрос в отдельной новой сессии: вернуть REVIEW-OK без инструментов, изменений файлов или внешних сообщений. Model-use был явным; usage — 16 921 токен. Общение через MCP → CLI → gateway/model подтверждено. Channel conversations по-прежнему отсутствуют; другие агенты не проверялись.

Штатный snapshot прошёл scan известных provider/gateway и identity-секретов. Внешняя symlink plugin dependency диагностирована как нефатальная. Этот успех не опровергает P1-02: там проверен отдельный архив с другим literal token. Утечка настоящих ключей приложения не установлена. Личные данные workspace и неизвестные scan значения успешным share-verdict не исключаются.

## Удобство использования

Для администрирования MCP удобен: хороший inventory команд, описания ограничений, структурированные inspect/lock, согласованный snapshot одной операцией и подтверждение здоровья gateway после неё. Recipe default требует исправления P3-01.

Для общения приходится знать OpenClaw CLI и передавать agent/session-id/timeout/JSON вручную, поскольку channel bridge показывает только маршрутизируемые conversations. Отдельный agent-call с явным model-use и коротким ответом был бы удобнее. Backup/status остаются текстовыми: структурированные artifact/profile/verification fields уменьшили бы ручной разбор. Времена в таблице относятся к одному запуску; постоянный CLI helper и сравнительный benchmark не выполнялись.

## Проверки и границы

- `npm test` с WSL-проверками: 76 check-файлов прошли, штатных падений не было.
- tsgo, Oxlint, build 80 файлов и actionlint обоих workflows прошли.
- Воспроизведения новых P1 использовали только синтетические временные данные; fixture-каталоги удалены.
- Реальные изменения: share-backup/snapshot, штатная retention-ротация, краткая остановка/запуск gateway и отдельная сессия main.
- Live restore, SSH target, npm publish, реальные credential rotation и restore-round-trip в этом раунде не выполнялись.
- В отчёте нет значений настоящих секретов или приватных путей компьютера. Исходный код не изменялся.
