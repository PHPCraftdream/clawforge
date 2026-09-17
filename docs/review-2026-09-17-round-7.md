# Общее ревью ClawForge — раунд 7

Дата: 2026-09-17. Проверенный HEAD: `fd54744090ee53834db865a7b1a6c0ef057ca68f`.
Последний завершённый предыдущий отчёт: [раунд 5](review-2026-09-17-round-5.md). Отчёт раунда 6 в проверенном checkout отсутствует.

## Итог

Смена image reference теперь проверяется до pinning; независимые параллельные цепочки одного процесса больше не используют общий счётчик lock. Регрессионные проверки проходят. Новый проход выявил **одну P1 и две P2**: credential-staging попадает в migrate-архив, reentrancy не различает targets с одинаковым lock path, а завершившаяся owning scope остаётся действующей для отложенных descendants.

P0 — критическая авария; P1 — устранить до релиза; P2 — существенный ограниченный сценарий; P3 — удобство. Новых P0 и отдельных P3 не зафиксировано. До устранения P1 рекомендацию к релизу не даю. Этот коммит содержит только отчёт.

Область: изменения текущего commit, image requirements, lock/ownership scope и её вызовы из apply/rollback/provisioning, запись секретов и её связь с archive profiles, backup/verify, CLI/MCP, сборка и статические проверки, живой WSL/Docker deployment. Метод: чтение кода, полный штатный набор, изолированные воспроизведения и новый MCP-прогон. Это не исчерпывающая проверка всех платформ и веток.

## Проверка последних исправлений

| Прежний дефект | Текущий результат |
| --- | --- |
| Digest из lock другого image reference | requiredImage проверяет точное совпадение reference, сообщает обе стороны и варианты исправления. Явный digest сохраняет отдельную ветку. Проверки проходят. |
| Независимая операция обходила глобальный heldHere | Вместо process-global counter введён AsyncLocalStorage; обычная независимая цепочка получает lock отдельно. Вызовы apply/rollback переведены в owning scope. Проверки проходят. Ограничения идентичности и lifetime перечислены ниже. |

## P1-01 — Migrate-архив включает оставшийся credential-staging

**Источник:** [state.ts](../tools/framework/commands/lifecycle/state.ts), `loadSecrets` и `pullLocked`; [archive.ts](../tools/framework/service/archive.ts), `excludesFor`, migrate branch; [backup.ts](../tools/framework/commands/lifecycle/backup.ts), создание backup.

Атомарная установка ключей создаёт соседний файл с именем `.env.clawforge-<random>`. После аварийного завершения процесса до rename/cleanup такой файл может остаться. Migrate исключает только точный `config/.env`, но не временные credential-файлы рядом с ним. Provider-ключи из staging попадают в архив, про который pull сообщает, что provider keys внутри отсутствуют.

Обычная активная операция защищена instance lock; воспроизведение относится к оставшемуся файлу после аварии и последующему восстановлению возможности выполнять операции, а не к race с нормально работающей записью.

**Воспроизведение:** временный data root внутри WSL с синтетическими текущим config/.env и оставшимся `.env.clawforge-0123456789abcdef`, оба private. Настоящие createArchive с profile=migrate и tar listing дали:

- `CURRENT_ENV_EXCLUDED=true`;
- `INTERRUPTED_SECRET_STAGING_INCLUDED=true`;
- отдельный настоящий verifySnapshot с profile=migrate вернул false.

Состояние после аварии подготовлено файлом-fixture; процессы ради теста не убивались. Архив и ключи синтетические. Значения не выводились, fixture удалён.

**Последствие:** migrate-backup может содержать provider credentials вопреки заявленному составу. Явная verification защищает от этого, но ни обычное создание migrate-backup, ни migrate-ветка pull не запускают эту проверку автоматически; автоматическая проверка pull сейчас относится к share. Migrate остаётся приватным профилем из-за identity/transcripts, однако перенос provider keys внутрь архива нарушает его отдельную границу безопасности.

**Исправление:** исключать все framework-owned credential temporaries, включая вложенные временные имена private writer, из соответствующих профилей либо хранить staging вне архивируемого дерева. Не удалять чужой активный staging ради backup. Добавить проверку состава migrate до объявления успеха и покрыть оставшиеся после аварии файлы. Share-verifier в этом сценарии уже должен отказать; успешное создание migrate нельзя приравнивать к shareability.

## P2-01 — Один lock path ошибочно означает один target

**Источник:** [instance-lock.ts](../tools/framework/runtime/instance-lock.ts), `chainLocks`, `lockHeldHere`, `HeldLock.path` и `runOwning`.

Owning scope хранит Set строк lockPath. Идентичность transport/host/WSL-дистрибуции не включена. Два разных target могут иметь одинаковый абсолютный путь, особенно при стандартном layout. Вложенная операция над target B тогда считается reentrant относительно lock на target A и не обращается к B за блокировкой.

**Воспроизведение:** внешний guarded получил настоящий lock во временном WSL-каталоге. Внутри него вызван guarded для второго context с тем же settings.dataDir, но другим transport (`ssh:second-target.invalid`). Этот transport был записывающей вызовы заглушкой, которая при обращении завершилась бы отказом. Callback второго guarded вошёл без единого обращения к transport:

- `DIFFERENT_TARGET_ENTERED_WITHOUT_OWN_LOCK=true`.

Реальное SSH-подключение не выполнялось. Подтверждён именно пропуск acquisition для другого target; состояние этого target не менялось.

**Границы:** стандартный MCP обслуживает один deployment и этот multi-target сценарий не запускался через него. Он относится к композиции framework-команд/custom application code, работающей с несколькими contexts. Исправленная сериализация независимых цепочек одного target этим не опровергается.

**Исправление:** включить устойчивую идентичность endpoint transport вместе с нормализованным lock path в ресурс owning scope. Вложенный вызов для другого host/distro должен получить собственный lock, даже если абсолютные пути совпадают.

## P2-02 — Отложенная callback наследует владение после release

**Источник:** [instance-lock.ts](../tools/framework/runtime/instance-lock.ts), `runOwning`, `lockHeldHere` и `HeldLock.release`.

AsyncLocalStorage сохраняет store в asynchronous descendants, созданных внутри scope. Возврат из runOwning не отзывает уже унаследованный Set; release меняет локальный флаг handle, но membership строки в scope не связано с этим флагом. Поэтому отложенная callback может решить, что владеет lock, который уже освобождён и захвачен другой операцией.

**Воспроизведение на настоящем WSL fixture:** внутри первой guarded-операции создана callback, ожидающая управляемый Promise. Первая операция завершилась и освободила lock. Из независимого кода takeLock захватил тот же ресурс для competing-operation. После этого Promise разрешён, и callback вызвала guarded для старого context:

- `PARENT_LOCK_RELEASED=true`;
- `EXPIRED_SCOPE_STILL_REPORTS_OWNERSHIP=true`;
- `LATE_CHILD_ENTERED_WITH_COMPETING_LOCK=true`.

Обе операции выполняли только диагностические callbacks; настоящая мутация была ограничена fixture-lock. Все promises дождались завершения, competing lock освобождён, fixture удалён. Искусственной нагрузки или sleep-поллинга не было.

**Границы:** сценарий требует descendant, пережившего родительскую операцию, например отложенного callback в application hook. Стандартные полностью awaited последовательные команды этим воспроизведением не признаны сломанными.

**Исправление:** хранить в scope живую запись владения/lease с resource identity и состоянием released, а не только строку. После release или завершения соответствующей owning operation отложенные descendants должны получать lock заново. Покрыть случай, когда к этому моменту ресурс уже принадлежит другой операции.

## Практическая проверка через MCP

После сборки текущего HEAD выполнен новый прогон реального stdio MCP по `.mcp.json`: initialize, initialized, tools/list, последовательные tools/call. В интерфейсе помощника ClawForge не подключён непосредственно как connector; клиент запускался программно по подготовленной конфигурации. Автоматическое подключение серверов интерфейсом не проверялось.

| Сценарий | Результат раунда 7 |
| --- | --- |
| Обнаружение | 33 control tools, 9 channel tools |
| inspect | healthy=true, changed=false, problems=[]; 23,2 с |
| up | Gateway уже Running и healthy; 1,9 с |
| recipe {} и action=list | Оба запроса успешно показывают agent/MCP bundle без confirm |
| lock --check | changed=false, problems=[] |
| pull --share | Stop/archive/start/verify прошли; 177 entries, около 88 KiB; 22,0 с |
| Snapshot permissions | 600, отдельно проверено stat на target |
| Retention | Штатно удалён один старый snapshot сверх лимита 10 |
| status после backup | Runtime healthy; healthz/startupz/readyz = 200 |
| conversations_list / permissions_list_open | Пустые списки, без readiness-ошибок |
| main через control-MCP cli | status=ok; payload и visible text = REVIEW-OK; 21,3 с |

Main получил один запрос в отдельной новой сессии: вернуть REVIEW-OK без инструментов, изменений файлов и внешних сообщений. Model-use был явным через confirm; usage — 17 033 токена. Диалог через MCP → CLI → gateway/model работает. Channel conversations отсутствуют; другие агенты не перепроверялись.

Штатный share-verifier проверил известные provider/gateway и identity-секреты. Значения не выводились. Внешняя symlink plugin dependency диагностирована как нефатальная. Этот прогон не использовал synthetic credential-staging: P1-01 проверялся отдельно. Утечка настоящих ключей приложения не установлена. Успешный share-scan не исключает персональные данные или неизвестные сканеру секреты в workspace.

## Удобно ли пользоваться

Для администрирования — да: инструменты обнаруживаются, имеют полезные описания, inspect/lock структурированы, share-backup сам выполняет согласованный цикл и подтверждает здоровье gateway. Default recipe теперь соответствует CLI. Для управления несколькими target через библиотечную композицию нельзя пока полагаться на reentrancy без учёта новых P2.

Для диалога нужен универсальный CLI и знание agent/session-id/timeout/JSON-аргументов. Отдельный agent-call с явным model-use и компактным ответом упростил бы задачу. Backup/status остаются текстовыми: artifact, profile и verification status удобнее получать структурированно. Текущие задержки — наблюдения одного запуска, не benchmark; helper в этом раунде не запускался.

## Проверки и ограничения

- `npm test` с WSL-проверками: 77 check-файлов прошли; штатных падений не было.
- tsgo, Oxlint, build 80 файлов и actionlint обоих workflows прошли.
- Воспроизведения выполнялись на синтетических данных; второй target моделировался, реальный SSH отсутствовал. Временные fixture-каталоги удалены.
- Реальные изменения приложения: share-backup/snapshot, штатная retention-ротация, краткая остановка/запуск gateway и одна отдельная сессия main.
- Live restore, реальная авария writer, concurrent-мутации живого приложения, смена image и npm publish не выполнялись.
- Исходники продукта не менялись. В отчёт не включены значения реальных ключей и приватные пути компьютера.
