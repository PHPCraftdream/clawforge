# Общее ревью ClawForge — раунд 11

Дата: 2026-09-17. База: `2b68844` (отчёт раунда 10 поверх реализации `df76489`). Проверено **рабочее дерево**, включая незакоммиченные изменения в `tools/framework/integration/mcp-schema.ts`, `mcp-server.ts` и `tools/checks/integration/mcp/mcp-apply-report.check.ts` — 27 добавлений и 3 удаления на момент проверки. Эти три файла не входят в коммит настоящего отчёта.

Предыдущий отчёт: [раунд 10](review-2026-09-17-round-10.md).

## Итог

Рекурсивное маскирование закрывает обычные строковые значения structured error, но весь error-response ещё не очищается: JSON-экранирование в текстовой копии и ключи объектов обходят защиту. Дополнительно выявлен сценарий apply, который устанавливает недостающий provider key без перезапуска работающего gateway.

Итого **две P2**, новых P0/P1 и отдельных P3 в проверенной области не обнаружено. P0 — критическая авария; P1 — устранить до релиза; P2 — существенный ограниченный сценарий; P3 — удобство. Это не исчерпывающее доказательство отсутствия других дефектов. Коммит содержит только отчёт.

Область: текущее исправление MCP, error serialization и redaction, планирование apply и установка секретов, output sinks, recipe lifecycle, backup verification и новый живой MCP-прогон. Метод: чтение исходников, полный штатный набор, изолированные воспроизведения и работа существующего приложения. Реальные ключи не ротировались.

## P2-01 — Секрет остаётся в escaped JSON текста ошибки и в ключах structured-объектов

**Источник:** [mcp-server.ts](../tools/framework/integration/mcp-server.ts), ветка error-response; [mcp-schema.ts](../tools/framework/integration/mcp-schema.ts), maskStructuredValue; [output.ts](../tools/framework/core/output.ts), emit.

Emit передаёт JSON одновременно в machine sink и обычный capture sink. Structured-ветка теперь маскирует разобранные строковые значения, однако текстовая копия остаётся сериализованной: maskSecrets ищет исходное значение и не находит его вариант с escaped кавычками/backslash. В Object.fromEntries сохраняются исходные ключи, которые тоже могут содержать credential.

**Воспроизведение:** настоящий отдельный serveMcp/context и synthetic application-command. Gateway credential содержит внутреннюю кавычку и обратную косую черту, не содержит перевода строки и корректно читается из fixture .env. Команда emit-ит JSON с credential в problem.detail и ключе diagnostics, затем бросает обычное исключение. После получения JSON-RPC текстовая JSON-часть снова разобрана:

- `ESCAPED_SECRET_RECOVERED_FROM_TEXT=true`;
- `STRUCTURED_VALUE_REDACTED=true`;
- `SECRET_PRESERVED_AS_OBJECT_KEY=true`.

Значения не выводились; реальный token приложения не использовался. Это подтверждает частичное исправление P2 раунда 10 и два оставшихся канала. Утечка настоящих ключей не установлена. Сценарий требует credential в исходной диагностике; текущий hex gateway token обычно не содержит таких спецсимволов, но registered-secret API ими не ограничен.

**Исправление:** текстовую копию machine JSON формировать из очищенного parsed payload, не теряя отдельные progress/error-сообщения. Продумать маскирование строковых ключей с безопасной обработкой коллизий: простая замена нескольких ключей на один маркер не должна молча терять диагностику. Проверять отсутствие восстанавливаемого registered secret во всём error-response, включая повторное JSON-декодирование. Успешный намеренный mcp-creds остаётся отдельным контрактом.

## P2-02 — Apply без config drift не перезапускает gateway после установки ключей

**Источник:** [plan.ts](../tools/framework/commands/orchestration/plan.ts), planActions: SECRET_MISSING добавляет secrets, а restart зависит только от RESTART_REQUIRED/CONFIG_DRIFT; [apply.ts](../tools/framework/commands/orchestration/apply.ts), RUNNERS/confirm; [secrets.ts](../tools/framework/commands/management/secrets.ts), инструкция после applyStore.

Если gateway работает, конфигурация совпадает, но target-env key отсутствует, план содержит secrets без restart. Apply записывает файл и повторно проверяет наличие значений на диске, после чего может сообщить healthy. При этом сам secrets --apply правильно предупреждает, что работающий instance ещё не прочитал файл и требуется restart. Автоматический план эту зависимость не учитывает.

**Воспроизведение:** настоящий apply с существующим lifecycle fixture. В live config модели задан provider apiKey через env SecretRef; target .env пуст, local store содержит синтетическое значение, runtime обозначен работающим, desired-state пуст и не требует правки config. Результат:

- `SECRET_ONLY_APPLY_HEALTHY=true`;
- steps: secrets/done, lock/skipped (advisory);
- `SECRET_FILE_POPULATED=true`;
- `RESTART_CALLS=0`.

Планирование, orchestration и установка ключей выполнялись настоящим кодом, target/runtime моделировались. Реальный gateway с отсутствующим ключом не поднимался; проверка использования старого/нового значения моделью не выполнялась. Подтверждено отсутствие restart, а не конкретный provider authentication failure.

**Последствие:** apply не гарантирует перечитывание startup environment после своего secrets-step и может преждевременно назвать состояние согласованным. Это относится к работающему instance без других причин для restart; для остановленного gateway следующий up уже читает файл.

**Исправление:** учитывать успешную установку target secrets как причину restart работающего instance либо выполнять reload, если он поддерживается и подтверждён runtime. Не перезапускать при dry-run/отказе записи и не добавлять лишний restart после up. Проверять порядок secret write → restart → final inspection.

## Практическая работа через MCP

После сборки проверенного рабочего дерева выполнен новый реальный stdio MCP-прогон по существующему .mcp.json: initialize → initialized → tools/list → tools/call. В интерфейсе помощника ClawForge не подключён как непосредственный connector; используется программный клиент по той же конфигурации. Автоматическое подключение серверов самим интерфейсом не проверялось.

| Сценарий | Результат раунда 11 |
| --- | --- |
| Обнаружение | 33 control tools, 9 channel tools |
| inspect | healthy=true, changed=false, problems=[]; 20,0 с |
| up | Существующий gateway Running и healthy; 1,6 с |
| recipe {} и action=list | Оба запроса показывают agent/MCP bundle без confirm |
| lock --check | changed=false, problems=[] |
| pull --share | Stop/archive/start/verify прошли; 177 entries, около 88 KiB; 21,3 с |
| Snapshot permissions | 600, отдельно проверено stat на target |
| Retention | Удалены один старый share-backup и один snapshot сверх лимита 10; восстановимость удалённых файлов отдельно не проверялась |
| status после backup | Runtime healthy; healthz/startupz/readyz = 200 |
| conversations_list / permissions_list_open | Пустые списки, без readiness-ошибок |
| main через control-MCP cli | status=ok, payload и visible text = REVIEW-OK; 12,2 с |

Main получил один запрос в отдельной новой сессии: вернуть REVIEW-OK без инструментов, изменений файлов или внешних сообщений. Model-use был явным через confirm; usage — 16 803 токена. Диалог работает через MCP → CLI → gateway/model. Channel conversations отсутствуют; другие агенты не перепроверялись.

Share-verifier проверил известные provider/gateway и identity-секреты без вывода значений. Внешняя symlink plugin dependency диагностирована как нефатальная. Успешный scan не исключает персональные данные или неизвестные сканеру ключи в workspace.

## Удобство и проверка

Администрирование через MCP удобно: есть описания tools, structured findings и согласованный backup с подтверждением здоровья gateway. Диалог требует знания общего CLI и agent/session-id/timeout/JSON; отдельный agent-call с явным model-use был бы проще. Backup/status также удобнее получать как структурированные artifact/profile/verification fields. Времена таблицы — один прогон, не benchmark; helper не запускался.

- `npm test` с WSL-проверками: 77 check-файлов прошли; штатных падений не было.
- tsgo, Oxlint, build 80 файлов и actionlint обоих workflows прошли.
- Synthetic fixtures удалены; реальные сбои с ключами не провоцировались.
- Реальные изменения приложения: share-backup/snapshot, штатная retention-ротация, краткая остановка/запуск gateway и одна сессия main.
- Live restore, SSH, provider key rotation и npm publish не выполнялись.
- Код продукта в этом раунде не менялся. Три ранее изменённых файла оставлены незакоммиченными; в отчёте нет настоящих ключей и приватных путей компьютера.
