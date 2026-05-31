#!/bin/sh
# Daily Postgres backup — see spec 0090 INFRA-1.
# Run via cron or Coolify scheduled task: 0 2 * * * /opt/beam0/backup.sh
# Requires: docker, and optionally rclone for off-server upload.

set -e

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/tmp/beam0-backups"
BACKUP_FILE="${BACKUP_DIR}/beam0_${DATE}.sql.gz"
CONTAINER="x16hptef58ui6huhg5vv7vcr"
RETAIN_DAYS=7

mkdir -p "$BACKUP_DIR"

echo "[backup] Starting Postgres backup at ${DATE}"

# Dump and compress
docker exec "$CONTAINER" pg_dump -U beam0 beam0 | gzip > "$BACKUP_FILE"

echo "[backup] Backup written to ${BACKUP_FILE} ($(du -sh "$BACKUP_FILE" | cut -f1))"

# Optional: upload to off-server storage
# Uncomment and configure one of these:
#
# --- Rclone to Backblaze B2 ---
# if command -v rclone >/dev/null 2>&1; then
#   rclone copy "$BACKUP_FILE" "b2:beam0-backups/postgres/"
#   echo "[backup] Uploaded to Backblaze B2"
# fi
#
# --- AWS S3 / Hetzner Object Storage ---
# if command -v aws >/dev/null 2>&1; then
#   aws s3 cp "$BACKUP_FILE" "s3://beam0-backups/postgres/"
# fi

# Cleanup local backups older than RETAIN_DAYS
find "$BACKUP_DIR" -name "beam0_*.sql.gz" -mtime +${RETAIN_DAYS} -delete
echo "[backup] Cleaned up backups older than ${RETAIN_DAYS} days"

echo "[backup] Done."
