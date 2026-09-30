# Сессионные задачи: ревью раунда 19

Основание: [статическое ревью XS, раунд 19](review-2026-09-30-xs-round-19.md).

| Задача | Приоритет | Статус |
| --- | --- | --- |
| R19-01: новый image для upgrade validation | P2 | закрыта: transient settings и проверка running digest до pin |
| R19-02: rollback при исключениях после recreation | P2 | закрыта: единый compensation path, обе причины при failed rollback |
| R19-03: неизвестная plugins/skills inventory | P2 | закрыта: отказ writer без изменения bytes, явный unknown в check |
| R19-04: SSH scheduled watch history | P2 | закрыта: target metadata/history, remote status, отдельные operator cycles |
| R19-05: бинарно-безопасный offsite пример | P2 | закрыта: base64 transfer и SHA-256 записанной копии |
| R19-06: concurrent watch alerts | P3 | закрыта: файловая исключительность на весь delivery/persistence cycle |

Первый профильный набор: 15 из 18 файлов прошли. Исправлены три fixture
несогласованности: backup start предыдущего image больше не считается upgrade
recreation; mkdirp модели не отказывает на существующем каталоге; channel fixture
имеет обязательный transport description и использует правильный watch state scope.
Повтор upgrade/install и channels прошёл. Typecheck/Oxlint, build и pack dry-run прошли.

Smoke: реальный DockerRuntime/Compose с управляемым transport выбирает CLI image B
после recreation и A после rollback, не меняя исходные settings. Реальный lock command
с partial inventory failure сохраняет прежние байты файла. Настоящий localhost HTTP
webhook получил один outage POST и один recovery POST; конкурирующий cycle отказан,
state согласован. Настоящий tar.gz с бинарным payload 0–255 перенесён через base64:
source/offsite SHA-256 совпадают, распаковка восстанавливает исходные байты.
Проверены direct exec и SSH command serialization через настоящий локальный sh.
Живой Docker/SSH target не запускался; авторизованный SSH host в среде отсутствует.

Общий набор: 178 из 179 выполненных check-файлов прошли; 6 capability-пропусков
(GNU userland — 2, Linux host — 3, SSH loopback — 1). Единственный отказ —
incidental assertion длины строки help. Эта проверка удалена, новый watch paragraph
разбит по смыслу; адресный arguments check и повтор typecheck/Oxlint прошли.
Настоящий help renderer показал корректные отдельные абзацы cycle/alert.
Все шесть исправлений и результаты проверки фиксируются локально перед раундом 20.
