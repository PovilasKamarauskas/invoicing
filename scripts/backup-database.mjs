import backups from '../shared/database-backup.cjs';
try {
  const result = process.argv.includes('--status') ? await backups.getStatus(process.env.BACKUP_DIR) : await backups.runBackup({ source: process.env.DATABASE_PATH, directory: process.env.BACKUP_DIR,
    secondaryDirectory: process.env.BACKUP_SECONDARY_DIR, retention: Number(process.env.BACKUP_RETENTION || 14), force: process.argv.includes('--force') });
  const { file, ...status } = result;
  console.log(JSON.stringify({ ...status, backupCreated: !!file }));
  if (result.secondaryError) process.exitCode = 1;
} catch { console.error('Backup failed. Check database/destination configuration, permissions and available storage.'); process.exitCode = 1; }
