# Сессионные задачи: ревью раунда 21

Основание: [статическое ревью XS, раунд 21](review-2026-09-30-xs-round-21.md).

| Задача | Приоритет | Статус |
| --- | --- | --- |
| R21-01: recipe Docker namespace | P2 | закрыта: единый builder от gateway namespace, ownership guard и настоящий Docker smoke |
| R21-02: literal option/value binding | P3 | закрыта: CLI сохраняет inline atoms, MCP кодирует literal binding, raw callers мигрированы |
| Smoke: readiness probe у границы grace window | P2 | закрыта: grace end не сокращает доступный общий probe budget |

До исправлений воспроизведены recipe namespace collision при разных gateway namespaces
и CLI/MCP потеря binding --grep=--tail. Первый профильный набор прошёл 11 из 13
check-файлов, один capability-пропуск; две fixture ошибки исправлены: Compose ps
в executable shim и POSIX target paths на Windows. Адресный повтор обеих новых
regressions прошёл. Исправлены Context/host-platform fixture, harness label,
ES2024 Promise declaration для поддерживаемого Node 24, obsolete CLI type import.
Typecheck/Oxlint, build и pack dry-run прошли.

Реальный Windows gate/WslTransport/Docker logs smoke прошёл: CLI --grep=--tail
и --grep=--tail=5 возвращают только matching line; отдельные --grep --tail 5
отказывают. Настоящий control-mcp JSON-RPC tools/call возвращает тот же результат
без tool error. Это controlled HTTP service/log fixture, не upstream OpenClaw.

Реальный recipe Docker smoke выявил преждевременный deadline query на конце
пятисекундного observation window. Исправлен бюджет, а не подавлен отказ;
readiness regression (включая failed service/grace flip/hung probe) прошла.
После fix реальные independent stacks install/reinstall, own backup quiesce/resume,
remove/volumes и legacy refusal/cutover прошли; финальный проход был остановлен
incidental assertion физического Docker Desktop bind path. Этот assertion удалён;
проверяются тип/read-only bind и actual A/B HTTP/volume data. Полный повтор прошёл:
отдельные контейнеры и данные A/B, status/logs, reinstall B сохраняет A,
remove A/--volumes сохраняет B, собственные discovery/quiesce/resume, broken manifest,
legacy refusal/explicit cutover и default workflow. Собственные контейнеры, volumes,
networks и временные roots удалены в finally; image не удалялся.

Общий набор: 181 из 183 выполненных check-файлов прошли, 6 capability-пропусков
(GNU userland — 2, Linux host — 3, SSH loopback — 1). Исправлены два отказа:
MCP dispatch checks сгруппированы по layout limit; incidental argv echo assertion
удалён вместо перепинивания новой token representation. Адресный повтор layout,
MCP safety и обоих dispatch checks прошёл (4 файла); typecheck/Oxlint прошли.
Все временные smoke scripts удалены. Исправления фиксируются перед раундом 22.
