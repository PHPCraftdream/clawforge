# Общее ревью ClawForge — раунд 9

Дата: 2026-09-17. Проверенный HEAD: `63a5c7c4afa8f9634426885fa59cc1abf68e0194`.
Предыдущий отчёт: [раунд 8](review-2026-09-17-round-8.md).

## Итог

P1 раунда 8 подтверждённо исправлена на настоящих Windows ACL. В новом проходе найдены **одна P2 и одна P3**: зарегистрированный секрет не маскируется в MCP failure, а одинаковое имя operationId используется для двух разных идентификаторов с разным назначением. Новых P0/P1 в проверенной области не обнаружено.

P0 — критическая авария; P1 — исправить до релиза; P2 — существенный ограниченный сценарий; P3 — удобство и согласованность. Это не утверждение об отсутствии остальных дефектов и не полная сертификация готовности к релизу. Коммит содержит только отчёт.

Область: текущий set-try fix и его реальные ACL, CLI/MCP ошибки и structured results, журнал операций, set/evidence/receipt flow, ownership/provisioning, backup/lifecycle/transport, CI и сборка, живое WSL/Docker приложение. Метод: чтение кода, полный штатный набор, отдельные синтетические воспроизведения и новый MCP-прогон. Все возможные платформы и ветки не покрыты.

## Проверка P1 раунда 8

Повторено прежнее воспроизведение: настоящий buildSet → setTry --keep на временном Windows deployment с наследуемым Guests ACE у родителя. Использован моделируемый runtime lifecycle fixture; Docker и живые credentials в trial не участвовали. В отличие от штатного hook-теста защита каталога/файла не подменялась: применялся настоящий private-file API и настоящий icacls.

- `KEPT_TRIAL_HAS_GATEWAY_TOKEN=true`;
- `KEPT_TRIAL_ENV_GRANTS_GUESTS=false`;
- `PRIVATE_FILE_CHECK_REPORTS_EXPOSURE=false`.

Реальный .env retained trial защищён; значение сгенерированного fixture-token не выводилось. Fixture вместе с сохранённым trial удалён. Это проверка конкретного Windows ACL-сценария, а не заявление об изоляции между Linux UID на DrvFs: она остаётся отдельной диагностируемой границей.

## P2-01 — MCP возвращает незамаскированный зарегистрированный секрет из исключения

**Источник:** [mcp-server.ts](../tools/framework/integration/mcp-server.ts), captureRun/captureGateRun и формирование failure-response; для сравнения [log.ts](../tools/framework/core/log.ts), registerSecret/reportError, и [cli.ts](../tools/framework/entry/cli.ts), main.

CLI entry обрабатывает исключения через reportError, который применяет maskSecrets. MCP captureRun получает error.message и включает его в content ответа без той же обработки. Gateway token автоматически регистрируется при createContext, но эта регистрация не влияет на MCP failure serialization. Аналогичный путь есть в captureGateRun и внешнем catch MCP-dispatcher.

**Воспроизведение:** временный deployment с синтетическим gateway token, настоящий отдельный stdio serveMcp-процесс и application-command fixture, бросающий Error с этим token в message. Значение специально известно системе маскирования. Для сравнения тот же текст передан настоящему reportError. Результаты:

- `CLI_ERROR_CONTAINS_TOKEN=false`;
- `MCP_ERROR_CONTAINS_TOKEN=true`;
- `MCP_CALL_FAILED=true`.

Проверка вывела только булевы результаты. Настоящие ключи не использовались, живой failing command не вызывался. Ошибка моделировалась в теле application-команды, а context creation, регистрация gateway token и MCP-dispatch были настоящими.

**Последствие:** ошибка application-command или дочерней системы, содержащая уже зарегистрированный credential, попадает в MCP transcript/сохранённый результат целиком, хотя эквивалентная CLI-диагностика его маскирует. Факт раскрытия синтетического значения доказан; утечка ключей существующего приложения не установлена. P2 отражает необходимость ошибки, которая содержит credential, а не наличие ключа в каждом штатном ответе.

**Исправление:** применять общее маскирование к error/failure diagnostics при выходе из MCP, включая gate и внешнюю ветку catch. Не смешивать этот контракт с намеренным успешным выводом credentials через mcp-creds. Проверять parity CLI/MCP и отсутствие зарегистрированного значения во всех failure content blocks.

## P3-01 — Верхний operationId нельзя использовать для поиска journal operation

**Источник:** [mcp-server.ts](../tools/framework/integration/mcp-server.ts), вызов structuredResult с новым id; [mcp-schema.ts](../tools/framework/integration/mcp-schema.ts), operationId конверта; [operations.ts](../tools/framework/service/operations.ts), Journal; [apply.ts](../tools/framework/commands/orchestration/apply.ts), ApplyOutcome.operationId.

Structured-result содержит внешний operationId, сгенерированный по имени инструмента и времени. Команда apply одновременно возвращает другой operationId внутри result — ID настоящего журнала. Schema-комментарий называет внешний id идентификатором вызова, а комментарии Journal/ApplyOutcome обещают общий ID журнала, snapshot и MCP-результата. Данные не теряются, но два значения с одинаковым именем требуют знания внутренней структуры.

**Воспроизведение через отдельный настоящий MCP server:** application fixture использовал реальный Journal для записи операции apply и вернул его id. Затем настоящая команда operations вызвана по обоим идентификаторам:

- `ENVELOPE_ID_EQUALS_JOURNAL_ID=false`;
- `LOOKUP_ENVELOPE_ID_FAILED=true`;
- `LOOKUP_PAYLOAD_ID_FAILED=false`.

Контекст, журнал и его файловая запись реальные, но в синтетическом deployment; настоящие apply/rollback или конфигурация приложения не изменялись. Этот тест устанавливает несогласованность контракта, не потерю журнала.

**Улучшение:** явно разделить callId и journal operationId либо использовать ID команды во внешнем поле, когда команда его возвращает. Для read-only запросов без журнала дать однозначное описание. В примерах MCP lookup/rollback указать точное поле, которое принимает operations.

## Практическая проверка приложения через MCP

После сборки текущего HEAD выполнен новый реальный stdio MCP-прогон по существующему .mcp.json: initialize → initialized → tools/list → последовательные tools/call. ClawForge connector непосредственно в инструментах интерфейса этой сессии отсутствует; использован программный клиент по подготовленной конфигурации. Автоматическое подключение серверов интерфейсом не проверялось.

| Действие | Результат раунда 9 |
| --- | --- |
| Обнаружение | 33 control tools, 9 channel tools |
| inspect | healthy=true, changed=false, problems=[]; 23,2 с |
| up | Gateway Running и healthy; 1,8 с |
| recipe {} и action=list | Оба запроса показывают agent/MCP bundle без confirm |
| lock --check | changed=false, problems=[] |
| pull --share | Stop/archive/start/verify прошли; 177 entries, около 88 KiB; 20,7 с |
| Snapshot permissions | 600, отдельно проверено stat на target |
| Retention | Удалён один старый snapshot сверх лимита 10; восстановимость удалённого файла отдельно не проверялась |
| status после backup | Runtime healthy; healthz/startupz/readyz = 200 |
| conversations_list / permissions_list_open | Пустые списки, без readiness-ошибок |
| main через control-MCP cli | status=ok; payload и visible text = REVIEW-OK; 14,6 с |

Main получил один запрос в отдельной новой сессии: вернуть REVIEW-OK, не применять инструменты, не менять файлы, не отправлять внешние сообщения. Model-use был явным через confirm; usage — 16 851 токен. Диалог через MCP → CLI → gateway/model работает. Channel conversations по-прежнему отсутствуют; другие агенты не проверялись.

Share-verifier проверил известные provider/gateway и identity-секреты без вывода значений. Внешняя symlink plugin dependency диагностирована как нефатальная. Успешная проверка не исключает персональные данные и неизвестные сканеру ключи в workspace. В штатном прогоне ошибка с настоящими credentials намеренно не провоцировалась.

## Удобство

Для администрирования framework удобен: обнаружение команд, описания, structured findings, корректный read-only lock и полный цикл согласованного backup одной операцией. Следующий практический недостаток — прослеживание операции: нужно знать, что journal ID лежит в result, а внешний operationId имеет другой смысл.

Для диалога по-прежнему требуется общий CLI и аргументы agent/session-id/timeout/JSON. Отдельный agent-call с явным model-use и компактным ответом упростил бы общение. Backup/status возвращают текст: структурированные artifact/profile/verification fields сократили бы разбор логов. Времена в таблице — один прогон, не benchmark; helper в этом раунде не запускался.

## Проверки и границы

- `npm test` с WSL-проверками: 77 check-файлов прошли; штатных падений не было.
- tsgo, Oxlint, build 80 файлов и actionlint обоих workflows прошли.
- ACL-проверка использовала настоящий private-file API; JSON-RPC проверки — настоящий server/context/Journal с synthetic command bodies. Временные fixtures удалены.
- Реальные изменения приложения: share-backup/snapshot, штатная retention-ротация, краткая остановка/запуск gateway и отдельная сессия main.
- Live restore, SSH, credential rotation, npm publish и новый restore-round-trip в этом раунде не выполнялись.
- Исходный код не изменялся. В отчёт не включены реальные ключи и приватные пути компьютера.
