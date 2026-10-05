import backups from '../shared/database-backup.cjs';
const [file, destination] = process.argv.slice(2);
if (!file) { console.error('Usage: node scripts/verify-backup.mjs BACKUP_FILE [NEW_REHEARSAL_DATABASE]'); process.exitCode = 1; }
else try { console.log(JSON.stringify({verified:true, restored:!!destination, ...await backups.verifyBackup(file,destination)})); }
catch { console.error('Verification failed. Check the snapshot, its manifest and that the rehearsal destination does not exist.'); process.exitCode = 1; }
