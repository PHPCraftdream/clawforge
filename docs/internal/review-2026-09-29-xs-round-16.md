# ClawForge — статическое ревью XS, раунд 16

Дата: 2026-09-29. База: `7c258d4`. Сверены отчёты и закрытые сессионные задачи раундов 10–15. Изучены текущие цепочки CLI/MCP, apply/rollback и set acceptance/evidence, ownership/provisioning, приватных публикаций, архивов/restore, рецептов и их загрузчика, упаковки npm, планировщиков, watch, incident и границ deploy. Связанные проверки и руководства читались как исходники. Приложение, сервисы, тесты, сборки, линтеры, smoke, воспроизведения и бенчмарки не запускались; действующие секреты не читались. Единственное изменение этого раунда — этот отчёт.

Шкала: P0 — безусловный критический ущерб; P1 — утечка секретов или потеря данных в поддерживаемом сценарии; P2 — существенное нарушение поддерживаемого поведения при указанном условии; P3 — меньший эксплуатационный дефект или неверная диагностика. Новые статически подтверждаемые механизмы: **P0 — 0, P1 — 0, P2 — 3, P3 — 1**. Выводы доказывают ветви исходников, а не частоту условий или результат на действующем экземпляре.

## Подтверждённые находки

### P2-01 — npm-пакет из текущего дерева ищет отсутствующий TypeScript loader рецептов

**Код:** `tools/framework/commands/management/recipe/hook-runtime.ts:49-61`, `tools/build-framework-package.ts:43-54`, `tools/build-framework-package.ts:110-122`, `tools/framework/package.json:48-56`; потребители: `tools/framework/commands/management/recipe/actions.ts:34-58`, `tools/framework/commands/management/recipe/lifecycle.ts:62-63`. Поддерживаемый сценарий описан в `docs/guide/deploy-and-mcp.md:90-113` и `docs/guide/recipes.md:47-56`.

При первой загрузке hook `importHookModule()` регистрирует `new URL("./hook-loader.ts", import.meta.url)`. Сборщик создаёт для исходников только соответствующие `.js` и декларации `.d.ts`; исходный `.ts` loader в npm payload не копируется. `rewriteSpecifiers()` меняет расширения исключительно в конструкциях `from`/`import`, поэтому литерал внутри `new URL()` остаётся `./hook-loader.ts`. В скомпилированном `hook-runtime.js` он адресует отсутствующий соседний файл, хотя сборщик формирует рядом `hook-loader.js`.

**Условия и последствия:** framework установлен штатным npm-пакетом; рецепт содержит обычный `prepare.ts`, `verify.ts`, `onboard.ts` или lifecycle hook. Регистрация loader отказывает до исполнения hook. В результате install/verify/onboard и требующий quiesce backup не работают в этом режиме. Запуск исходников из checkout не обнаруживает ошибку, поскольку там `.ts` loader существует. `tools/checks/release/release/installed-consumer.check.ts:158-178` проверяет запуск help, а `tools/checks/foundation/packaging/build-output.check.ts:39-52` ищет оставшиеся `#src/`; ни одна из этих проверок не загружает hook опубликованного пакета.

**Исправление:** выбирать URL loader по расширению исполняемого модуля либо явно преобразовывать эту ссылку на ресурс при сборке, сохранив работу source и dist. Добавить адресную проверку загрузки минимального hook из реально упакованного/установленного пакета, включая относительную зависимость; одного help или поиска import-строк недостаточно. **Граница доказательства:** имя создаваемого файла, правило преобразования и имя загружаемого ресурса однозначны в исходниках. Новый пакет не собирался и не устанавливался; конкретный текст исключения Node не воспроизводился.

### P2-02 — receipt может сертифицировать set после отказа его security gate

**Код:** `tools/framework/commands/orchestration/accept.ts:444-485`, `tools/framework/commands/orchestration/accept.ts:533-552`, `tools/framework/set/artifacts/evidence.ts:47-88`, `tools/framework/set/artifacts/receipt.ts:209-215`, `tools/framework/commands/orchestration/inspect/gather.ts:57-71`, `tools/framework/commands/orchestration/inspect/gather.ts:361-367`. Независимый blocking finding: `tools/framework/security/audit.ts:248-264`, `tools/framework/service/inspection.ts:316-321`. Контракт gate: `docs/guide/monitoring-and-access.md:255-282`; контракт сертификата set: `docs/guide/sets.md:56-77`.

`buildAcceptanceReport()` учитывает blocking security findings в `healthy`; `acceptFromSource()` затем обязан отказать при `securityBlocking > 0`. Однако **до** этого отказа вызывается `attachAcceptanceReceipt()`. В его `saveEvidence()` передаются только результаты recipe checks и совпадение runtime/declaration до и после; результат security gate туда не входит. `gatherInspection()` не запускает gate — его отдельно добавляют doctor и accept. Если все выбранные checks прошли и subject binding подтверждён, `receipt.outcome()` выставляет `verdict: "verified"` независимо от уже установленного blocking security finding.

**Условия и последствия:** полная успешная recipe acceptance и совпадающий artifact/runtime, но дополнительный gate обнаружил blocking проблему. Например, явно объявленный и фактически совпадающий wildcard bind без `acknowledgePublicBind` может пройти обычную convergence inspection и дать `GATEWAY_PUBLICLY_BOUND` только в gate. Один запуск тогда сохраняет неизменяемый receipt `verified`, выводит `healthy: false` и завершается ошибкой. Последующий `set receipts` показывает эту ошибочную сертификацию без security-причины отказа. Это нарушает согласованность durable evidence с итогом acceptance, а не означает, что gate разрешил саму команду.

**Исправление:** переносить outcome security gate в durable evidence и учитывать его при вычислении итогового verdict; blocking gate никогда не должен оставлять сертификат `verified`. Сохранить отдельную правдивую runtime identity и результаты recipe checks, а также безопасную причину отказа. Адресная регрессия: все checks passed, identity/declaration совпадают, gate blocking — CLI отказал и перечитанный receipt не сертифицирует set; отдельно проверить acknowledged/suppressed finding. **Граница доказательства:** потеря gate-result и порядок сохранения/отказа видны в коде. Настоящий публичный bind, audits и запись receipt не запускались.

### P2-03 — параллельная установка расписаний разных deployment теряет cron-задание

**Код:** `tools/framework/commands/lifecycle/backup/install.ts:95-100`, `tools/framework/commands/lifecycle/backup/install.ts:120-129`, `tools/framework/commands/operate/watch/install.ts:136-142`, `tools/framework/commands/operate/watch/install.ts:163-172`, `tools/framework/commands/operate/schedule.ts:120-135`, `tools/framework/runtime/lock/lock-claim.ts:70-75`, `tools/framework/security/instance-mutation-guard.ts:15-16`.

Install/uninstall читают и целиком переписывают пользовательский crontab под **instance** lock. И основной lock, и mutation guard расположены в `locksDir(ctx.settings.dataDir)`; разные deployment с разными data roots получают разные блокировки, хотя работают с одним crontab одного target account. Общая блокировка между чтением и заменой таблицы отсутствует.

**Условия и механизм:** два штатных CLI/MCP-процесса обслуживают разные deployment на одном local/SSH target под одним пользователем. A читает таблицу `T`; B также читает `T`; A пишет `T + backup(A)`; B пишет `T + watch(B)`. Обе команды могут получить exit 0 и сообщить `installed`, но последняя запись удаляет только что установленный backup(A). Аналогично uninstall другого deployment способен вернуть уже удалённое задание из своей устаревшей копии. Корректное сопоставление маркеров не помогает: повреждение происходит при замене всей таблицы из старого чтения.

**Последствие:** теряется автоматическое резервное копирование/мониторинг либо отменяется запрошенное удаление расписания. Это отдельная гонка общего ресурса: закрытые R10-04 и R12-02 устранили ошибочное чтение и чрезмерный matching, но не сериализацию разных instance.

**Исправление:** сериализовать полную read/merge/write-транзакцию общим target-side lock для конкретного scheduler account, одинаковым у backup/watch и всех deployment; удерживать его до подтверждения записи. Instance lock продолжает защищать собственный экземпляр. Добавить детерминированную адресную проверку двух разных data roots с управляемым чередованием операций: оба install должны сохраняться, uninstall не должен воскресать. **Граница доказательства:** допустимое чередование следует из раздельных await и независимых lock paths. Реальные параллельные команды и crontab не запускались; гарантии против стороннего редактора crontab этим пунктом не заявляются.

### P3-01 — restore JSON сообщает о запуске gateway, который оставлен остановленным

**Код:** `tools/framework/commands/lifecycle/restore/index.ts:519-535`, `tools/framework/commands/lifecycle/restore/index.ts:540-552`, `tools/framework/commands/lifecycle/restore/index.ts:610-624`; действующий oracle: `tools/checks/runtime/service/restore.check.ts:82-97`.

После успешной замены данных `reportRestoreOutcome()` проверяет секреты. При `MissingSecretsError` он намеренно оставляет gateway остановленным, печатает причину и возвращает без исключения. Но `restoreArchive()` возвращает только `void`, и вызывающая JSON-ветка вычисляет `started` исключительно как `options.noStart !== true`. Кроме того, эта ветка подавляет промежуточные сообщения через `withOutputSink(() => {}, ...)`, поэтому объяснение пропуска запуска в JSON не попадает.

**Условия и последствия:** `restore --json --force <archive>` без `--no-start`; восстановленная конфигурация ссылается на отсутствующий обязательный секрет. Полезное действие restore действительно завершилось, но ответ утверждает `ok: true, started: true`, хотя `runtime.start()` не вызывался. Машинный клиент получает неверное состояние и не видит инструкцию поставить ключи перед `up`. Существующая проверка подтверждает намеренное поведение «не бросить, не запускать» только через `restoreArchive()` и не проверяет этот JSON-ответ.

**Исправление:** возвращать фактический restore outcome из execute/report-фазы и формировать JSON из него: `started: false` с безопасной причиной и следующим действием при отсутствующих секретах. Сохранить различие между успешно восстановленными данными и возможностью старта. Адресная регрессия должна пройти через публичную JSON-ветку для missing secrets, явного `--no-start` и успешного запуска. **Граница доказательства:** пропуск start и безусловное вычисление поля прямо заданы кодом; восстановление данных и контейнер не запускались.

## Гипотезы и пределы

Новых гипотез, достаточно конкретных для отдельной задачи, не добавлено. Прежняя гипотеза раунда 13 о полноте upstream native backup для ссылок/пустых каталогов и известные capability/Windows → WSL → Docker ограничения не считаются новыми находками. Закрытые механизмы раундов 10–15 не повторены; перечисленные четыре пункта относятся к другим доказуемым путям исполнения.

Объём чтения не является построчным доказательством корректности всей репы и не заменяет динамическую проверку исправлений. Сессионные задачи этого ревью — сверка прежних отчётов и статусов, статический анализ текущего дерева, запись отчёта — выполнены. Исправление находок и прогоны не входят в этот read-only раунд.
