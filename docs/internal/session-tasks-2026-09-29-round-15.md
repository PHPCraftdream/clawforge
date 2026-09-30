# Сессионные задачи: ревью раунда 15

Основание: [статическое ревью XS, раунд 15](review-2026-09-29-xs-round-15.md).

| Задача | Приоритет | Статус |
| --- | --- | --- |
| R15-01: приватная публикация config при rollback | P1 | закрыта: exclusive private staging и owner до rename |
| R15-02: продолжать incident при отказе evidence writer | P2 | закрыта: ошибки preserve/collect сохраняются, остальные фазы выполняются |
| R15-03: сохранять unknown telemetry каналов в watch | P2 | закрыта: `CHANNEL_UNKNOWN` даёт degraded без healthy recovery |
| R15-04: учитывать грамматику `%` в cron | P3 | закрыта: неподдерживаемый `%` отвергается до scheduler-команд |

После интеграции прошли 175 check-файлов; четыре пропущены по возможностям среды
(`gnu-userland`, два `linux-host`, `ssh-loopback`). Typecheck, Oxlint, build,
pack dry-run и actionlint прошли. Linux-only регрессия прав staging/final inode
включена в общий набор и ожидает оснащённый Linux runner. Исправления фиксируются
локальным коммитом перед новым статическим ревью.
