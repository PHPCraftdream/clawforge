# Общее ревью ClawForge — раунд 10

Дата: 2026-09-17. Проверенный HEAD: `df76489df1bdfe5becdacfce84e698781df5d6be`.
Предыдущий отчёт: [раунд 9](review-2026-09-17-round-9.md).

## Итог

Идентификатор операции исправлен: внешний operationId теперь подходит для поиска записи журнала, когда команда возвращает journal ID. Маскирование обычной MCP-ошибки также работает. Однако P2 раунда 9 закрыта только частично: **structuredContent ошибочного ответа сохраняет зарегистрированные секреты**. В отчёте одна открытая P2; новых P0/P1 и отдельных P3 в проверенной области не зафиксировано.

P0 — критическая авария; P1 — устранить до релиза; P2 — существенный ограниченный сценарий; P3 — удобство и согласованность. Отсутствие новых P0/P1 не является полной сертификацией релиза. Коммит содержит только отчёт.

Область: текущий MCP fix, обработка CLI/transport errors, structured results и journal lookup, archive/snapshot lifecycle, secret writes, set trial, recipe provisioning, apply/rollback, сохранение evidence, project MCP setup, workflows и живое приложение. Метод: чтение кода, полный штатный набор, отдельные JSON-RPC воспроизведения и новый практический MCP-прогон. Все возможные платформы и ветки не проверены.

## Проверка исправлений раунда 9

Повторён прежний JSON-RPC fixture с настоящими server/context/Journal и application-командами в синтетическом deployment:

- обычная ошибка: `MCP_ERROR_CONTAINS_TOKEN=false`, `MCP_CALL_FAILED=true`;
- `ENVELOPE_ID_EQUALS_JOURNAL_ID=true`;
- lookup по внешнему и внутреннему id: оба успешны.

Это подтверждает исходный простой сценарий redaction и закрывает P3 про journal lookup. Для команд без собственного operationId сохранён документированный transient tool-call id. Настоящие ключи и реальные apply/rollback в этом fixture не использовались.

## P2-01 — Structured failure обходит маскирование зарегистрированного секрета

**Источник:** [mcp-server.ts](../tools/framework/integration/mcp-server.ts), строки 278–295; [mcp-schema.ts](../tools/framework/integration/mcp-schema.ts), structuredResult и поля problems/result.

После captureRun structuredResult строится из исходного machineOutput. В error-response maskSecrets применяется только к текстовому content. Уже созданный structuredContent добавляется без обработки. Его верхний problems и вложенный result сохраняют исходные строки, включая те же секреты, которые текстовая часть успешно скрывает.

**Воспроизведение:** настоящий отдельный stdio serveMcp-процесс и temporary deployment с синтетическим gateway token. Token автоматически зарегистрирован при createContext. Structured application-command fixture сначала emit-ит валидный JSON с blocking problem/detail, содержащим этот token, затем бросает Error с тем же diagnostic text. JSON-RPC результат:

- `IS_ERROR=true`;
- `TEXT_CONTAINS_REGISTERED_TOKEN=false`;
- `STRUCTURED_CONTAINS_REGISTERED_TOKEN=true`;
- `TOP_LEVEL_PROBLEM_CONTAINS_TOKEN=true`;
- `NESTED_RESULT_PROBLEM_CONTAINS_TOKEN=true`.

Выведены только булевы признаки. Команда и credential синтетические; настоящий failing command приложения не вызывался. Файловый fixture удалён.

**Последствие:** MCP-клиент, сохраняющий JSON-результат, получает секрет, даже когда отображаемый текст ошибки выглядит замаскированным. Это не новая независимая проблема, а неполнота исправления P2 раунда 9 для structured commands. Сценарий требует появления credential в исходной диагностике; фактическая утечка настоящих ключей приложения не установлена.

**Исправление:** применять единый error-redaction контракт ко всему возвращаемому error-result, включая вложенные structuredContent и дублирующие problems/warnings/nextActions. Обрабатывать строковые значения после разбора JSON, сохраняя его структуру и типы; не полагаться только на замену в сериализованной строке, где символы могут быть escaped. Намеренный успешный вывод mcp-creds должен оставаться отдельным контрактом. Регрессионная проверка должна искать зарегистрированное значение во всём ответе, а не только в content или тексте исключения.

## Практическая проверка приложения через MCP

После сборки текущего HEAD выполнен новый реальный stdio-прогон по существующему .mcp.json: initialize → initialized → tools/list → последовательные tools/call. ClawForge непосредственно среди connector-инструментов интерфейса этой сессии отсутствует; использован программный клиент по подготовленной конфигурации. Автоматическое подключение серверов интерфейсом не проверялось.

| Сценарий | Результат раунда 10 |
| --- | --- |
| Обнаружение | 33 control tools, 9 channel tools |
| inspect | healthy=true, changed=false, problems=[]; 48,9 с |
| up | Gateway уже Running и healthy; 2,5 с |
| recipe {} и action=list | Оба запроса успешно показывают agent/MCP bundle без confirm |
| lock --check | changed=false, problems=[] |
| pull --share | Stop/archive/start/verify прошли; 177 entries, около 88 KiB; 25,8 с |
| Права нового snapshot | 600, отдельно проверено stat на target |
| Retention | Удалены один старый share-backup и один snapshot сверх лимита 10; восстановимость удалённых файлов отдельно не проверялась |
| status после backup | Runtime healthy; healthz/startupz/readyz = 200 |
| conversations_list / permissions_list_open | Пустые списки, без readiness-ошибок |
| main через control-MCP cli | status=ok, payload и visible text = REVIEW-OK; 18,3 с |

Main получил один диагностический запрос в отдельной новой сессии: вернуть REVIEW-OK без инструментов, изменений файлов или внешних сообщений. Model-use был явным через confirm; usage — 16 865 токенов. Диалог через MCP → CLI → gateway/model работает. Channel conversations по-прежнему отсутствуют; другие агенты не проверялись.

Share-verifier проверил известные provider/gateway и identity-секреты без вывода значений. Внешняя symlink plugin dependency диагностирована как нефатальная. Успешный scan не исключает персональные данные и неизвестные сканеру ключи в workspace. Structured failure с настоящими credentials в приложении не провоцировался.

## Удобно ли пользоваться

Для администрирования — да: описания помогают выбирать tools, inspect/lock возвращают пригодные для автоматизации findings, backup одной командой создаёт согласованный снимок и подтверждает здоровье gateway. Journal lookup стал проще благодаря исправленному operationId.

Сохраняются два практических ограничения: для диалога нужен общий CLI с agent/session-id/timeout/JSON, а backup/status требуют разбирать текст вместо отдельных artifact/profile/verification fields. Отдельный agent-call с явным model-use и коротким ответом был бы удобнее.

Inspect в этом запуске занял около 49 секунд. Это заметная задержка для агента-оператора; причина не установлена, устойчивое ухудшение производительности не утверждается. Времена относятся к одному прогону, helper и сравнительный benchmark в этом раунде не выполнялись.

## Проверки и ограничения

- `npm test` с WSL-проверками: 77 check-файлов прошли; штатных падений не было.
- tsgo, Oxlint, build 80 файлов и actionlint обоих workflows прошли.
- Повторный JSON-RPC fixture подтвердил обычный redaction и journal lookup; новый fixture воспроизвёл structuredContent gap. Synthetic fixtures удалены.
- Реальные изменения: share-backup/snapshot, штатная retention-ротация, краткая остановка/запуск gateway и отдельная сессия main.
- Не выполнялись live restore, SSH, credential rotation, npm publish или новый restore-round-trip.
- Код продукта не менялся. В отчёт не включены реальные ключи или приватные пути компьютера.
