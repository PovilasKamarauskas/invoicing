import fs from 'node:fs/promises';
import path from 'node:path';
import backups from '../shared/database-backup.cjs';

const [source, destination] = process.argv.slice(2);
let scratch;
try {
  if (!source || !destination || source === destination)
    throw new Error('Usage: node scripts/restore-database.mjs VERIFIED_BACKUP NEW_DATABASE_PATH');
  for (const file of [destination, destination + '-wal', destination + '-shm']) {
    try { await fs.lstat(file); throw new Error('Destination or its SQLite sidecars already exist. Nothing was replaced.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await fs.mkdir(path.dirname(destination), {recursive:true,mode:0o700});
  scratch = await fs.mkdtemp(path.join(path.dirname(destination), '.invoice-restore-'));
  await fs.chmod(scratch,0o700);
  const verified = path.join(scratch, 'verified.sqlite');
  const report = await backups.verifyBackup(source,verified);
  await fs.chmod(verified,0o600);
  const file = await fs.open(verified,'r');
  try { await file.sync(); } finally { await file.close(); }
  // Atomic exclusive installation: a database created in the meantime is never overwritten.
  await fs.link(verified,destination);
  console.log(JSON.stringify({restored:true,...report}));
} catch (error) {
  console.error(error.message?.startsWith('Destination') || error.message?.startsWith('Usage:')
    ? error.message : 'Restore failed. Verify the snapshot/manifest, permissions, and that the destination is empty and the backend stopped.');
  process.exitCode=1;
} finally { if (scratch) await fs.rm(scratch,{recursive:true,force:true}); }
