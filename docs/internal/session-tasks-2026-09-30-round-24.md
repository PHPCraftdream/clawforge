# Сессионные задачи: ревью раунда 24

Основание: [статическое ревью XS, раунд 24](review-2026-09-30-xs-round-24.md).

| Задача | Приоритет | Статус |
| --- | --- | --- |
| R24-01: private operator-side offsite copy | P1 | закрыта: public helpers, verified sealed directory и exclusive binary creation до credential bytes |
| Smoke: inherited Windows owner access | P2 | закрыта: directory grants наследуют только trusted SID set, owner read/write сохранены |

Использованы существующие protectPrivateDirectory/createPrivateBinaryFile, явно
экспортированные через installed @clawforge/framework/private-config. Guide и package
README различают operator files и target privatePaths ledger. Destination абсолютен
для честного boundary reporting; existing file не перезаписывается. Директория Windows
даёт trusted SIDs (OI)(CI) inheritance, а не снимает owner access с существующих files.
Детерминированный real filesystem owner read/update regression добавлен в audit check.

До fix POSIX subprocess с private source archive 0600 и public parents создавал copies:
umask 022 → directory 0755/file 0644; umask 000 → 0777/0666. Другой UID реально извлекал
фиктивный credential из gzip. После fix исполнен актуальный guide hook из настоящего
npm-packed installed consumer, не из source import: Linux umask 022/000, fresh и existing
output directory → 0700/0600, UID 65534 не читает архив. Source/destination SHA-256 и
распаковка совпадают. FileHandle observer проверял file/directory privacy при size 0,
до первого binary write; credential staging отсутствует.

Windows actual installed consumer подтвердил protected DACL и отсутствие foreign
trustees до bytes, existing directory/file refusal, byte/hash/tar round-trip и сохранение
source при transfer/write/hash/protection failure. Internal purpose не читает/пишет.
Owner access regression, typecheck/Oxlint, build и actual npm pack прошли.

Граница: Windows DACL защищает Windows identities, не других Linux users на shared
DrvFs mount. Реальный boundary probe показал Linux OPEN; это не скрыто и не заявлено
изоляцией. Guide прямо запрещает plaintext flow в такой storage configuration:
protected Linux operator storage либо encryption на target ДО transfer обязательны.
Post-copy encryption comment удалён; explicit permissions старых copies требуют аудита.

Свои containers, source/scratch trees, packed consumer и throwaway scripts удалены.
Финальный общий набор прошёл: 183 check-файла, 7 capability-пропусков
(GNU userland — 2, Linux host — 4, SSH loopback — 1).
Результаты фиксируются перед ревью раунда 25.
