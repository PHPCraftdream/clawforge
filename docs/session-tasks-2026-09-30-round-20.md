# Сессионные задачи: ревью раунда 20

Основание: [статическое ревью XS, раунд 20](review-2026-09-30-xs-round-20.md).

| Задача | Приоритет | Статус |
| --- | --- | --- |
| R20-01: двусторонний mcp-serve stdio | P2 | закрыта: явный protocol mode, live stdin, точный stdout и отдельный stderr |
| R20-02: scheduler identity одинаковых basename | P2 | закрыта: canonical execution-root digest и безопасная миграция own legacy invocation |

До исправлений воспроизведены потеря pipe stdin и удаление обоих cron entries
с одинаковым basename. После интеграции профильный Windows-набор прошёл:
18 check-файлов, 4 capability-пропуска. Исправлены типы полноценного Context
и label harness в новой process fixture; адресный повтор MCP/schedule прошёл.
Удалена touched incidental Windows argv-copy assertion, не перепинена.
Typecheck/Oxlint, build и pack dry-run прошли.

Linux-проверка штатным check:linux в изолированном node:24 контейнере:
4 check-файла прошли, typecheck/Oxlint прошли. Проверены реальный account flock
с изолированным crontab, одинаковая SSH operator/target-local identity,
coexistence/reinstall/uninstall двух реальных roots с одинаковым basename,
безопасная legacy migration и Windows scheduler runner seam.

Process-регрессии проводят JSON-RPC через настоящий mcpServe/DockerRuntime и
исполняемый Docker shim с реальными pipes: helper/fallback, два ответа до EOF,
точные Unicode/CRLF bytes, separate stderr, client EOF и early child closure.
Отдельный throwaway smoke подтвердил два live protocol обмена при открытом
client stdin и exit 0 после EOF. Scheduler smoke подтвердил byte-identical
сохранность B после uninstall A для backup/watch и разные task names.
Живой upstream MCP через WSL/Docker и настоящий SSH host не проверялись.

Общий набор: 180 из 181 выполненных check-файлов прошли; 6 capability-пропусков
(GNU userland — 2, Linux host — 3, SSH loopback — 1). Единственный отказ —
bootstrap precedence новых scheduler identity queries. Guard перенесён до target
ownership query при --apply, после синтаксической проверки cron. Touched assertions
сообщения заменены consumer проверками refusal/no ownership query/no lock.
Повтор bootstrap/identity/watch-install/backup-install прошёл (4 файла);
повтор typecheck/Oxlint/build прошёл. Исправления фиксируются перед раундом 21.
