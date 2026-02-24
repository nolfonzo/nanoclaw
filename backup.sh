#!/usr/bin/env bash
# Daily backup of nanoclaw runtime state.
# Backs up: database, session auth, group memory, monitor data.
# Keeps the last 7 days. Writes status to weon/ so Weon can report on it.
set -e

BACKUP_DIR="/home/nolfonzo/nanoclaw-backups"
STATUS_FILE="/home/nolfonzo/weon/backup-status.json"
KEEP_DAYS=7

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
ARCHIVE="$BACKUP_DIR/nanoclaw-$TIMESTAMP.tar.gz"

tar -czf "$ARCHIVE" \
  -C /home/nolfonzo/nanoclaw \
  store/ \
  data/sessions/ \
  groups/ \
  -C /home/nolfonzo \
  weon/

SIZE=$(du -sh "$ARCHIVE" | cut -f1)

# Rotate: remove backups older than KEEP_DAYS
find "$BACKUP_DIR" -name "nanoclaw-*.tar.gz" -mtime +$KEEP_DAYS -delete

COUNT=$(find "$BACKUP_DIR" -name "nanoclaw-*.tar.gz" | wc -l | tr -d ' ')

# Write status for Weon to read
cat > "$STATUS_FILE" <<EOF
{
  "lastBackup": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "lastSize": "$SIZE",
  "archivesKept": $COUNT,
  "backupDir": "$BACKUP_DIR"
}
EOF

echo "Backup complete: $ARCHIVE ($SIZE), $COUNT archives kept"
