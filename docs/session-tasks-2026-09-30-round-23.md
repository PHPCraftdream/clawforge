# Сессионные задачи: ревью раунда 23

Основание: [статическое ревью XS, раунд 23](review-2026-09-30-xs-round-23.md).

| Задача | Приоритет | Статус |
| --- | --- | --- |
| R23-01: whitespace/normalized userinfo | P1 | закрыта: структурное удаление userinfo, conservative raw authority policy и согласованный diagnostic lexer |
| R23-02: stale upgrade predecessor | P2 | закрыта: identity/settings подтверждаются под instance lock, changed/unknown/stopped state отказывает до backup/recreation |

До fix Node URL witness принимал SPACE userinfo, а public redactor публиковал его raw.
Проверка output агента выявила поглощение следующего URI префиксом error: и обрезание
malformed host. Lexer исправлен; добавлены consumer/edge regressions для diagnostic
prefix, nested literal authorities, malformed config query и игнорируемых controls
в query names. URI без @ не требуют лишнего structural parse; regexes кешируются.

Профильный Windows набор прошёл (3 check-файла). Actual executable inspect/doctor/plan
text/JSON и настоящий subprocess control-MCP JSON-RPC проверены без real network probes:
SPACE, username SPACE, TAB/LF/CR, percent encoding, missing/mixed/backslash slashes,
scheme controls и malformed authorities. Private original probe input сохранён;
полезные host/path/state и ordinary query остаются. Отдельный smoke наблюдал 14
sanitized CLI endpoints и три MCP structured diagnostics без raw/normalized markers.

Upgrade autonomous witness использовал настоящий DockerRuntime/public upgrade,
реальный durable .env и controlled image/data/archive model. До fix B завершал D1,
затем A компенсировал и pins D0; прежний execute no-op также не подтверждал state.
После fix A отказывает без собственного backup/recreation, D1/pin/data сохраняются.
Подтверждены no-op под lock, lock-free dry-run, unknown/stopped/unreadable/settings
refusals и migration backup/image/data compensation. Live upstream images не запускались.

Исправлены model semantics atomic ln/mv, непустой rmdir, stopped container filtering,
recursive removal и du вместо неподдержанных команд и неточных filesystem ответов.
Typecheck/Oxlint, build и pack dry-run прошли; Linux профильный запуск и его
последующие typecheck/Oxlint завершились exit 0. Throwaway witness и его scratch удалены.

Общий набор прошёл: 183 check-файла, 7 capability-пропусков
(GNU userland — 2, Linux host — 4, SSH loopback — 1).
Исправления и passing-after evidence фиксируются перед раундом 24.
