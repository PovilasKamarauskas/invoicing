const { DatabaseSync, backup } = require('node:sqlite');
const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');

const BACKUP_NAME = /^invoice-backup-\d{8}T\d{9}Z-[a-f0-9-]{36}\.sqlite$/;
const DAY = 24 * 60 * 60 * 1000;
function fingerprint(db) {
  const counts = {};
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  for (const { name } of tables) counts[name] = Number(db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get().n);
  const hash = createHash('sha256');
  if (tables.some(t => t.name === 'invoices')) {
    for (const row of db.prepare('SELECT id,user_id,invoice_number,total,payload,zip FROM invoices ORDER BY id').iterate()) {
      const { zip, ...fields } = row;
      hash.update(JSON.stringify(fields));
      hash.update(Buffer.from(zip));
    }
  }
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('BACKUP_INTEGRITY_FAILED');
  return { counts, invoiceHash: hash.digest('hex'), schemaVersion: tables.some(t => t.name === 'schema_migrations') ? Number(db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get().version) : 0 };
}
async function fileHash(file) {
  const { createReadStream } = require('node:fs');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function inspectBackup(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return fingerprint(db); } finally { db.close(); }
}
async function verifyBackup(file, destination) {
  const manifest = JSON.parse(await fs.readFile(file + '.json', 'utf8'));
  if (manifest.fileHash !== await fileHash(file)) throw new Error('BACKUP_CHECKSUM_FAILED');
  const report = await inspectBackup(file);
  if (JSON.stringify(report) !== JSON.stringify(manifest.snapshot)) throw new Error('BACKUP_MANIFEST_FAILED');
  if (destination) {
    // A rehearsal must never overwrite an existing database or restore the live source.
    const handle = await fs.open(destination, 'wx', 0o600);
    await handle.close();
    try {
      await fs.copyFile(file, destination);
      const restored = await inspectBackup(destination);
      if (JSON.stringify(restored) !== JSON.stringify(report)) throw new Error('RESTORE_CHECK_FAILED');
    } catch (error) { await fs.rm(destination, { force: true }); throw error; }
  }
  return report;
}
async function atomicJson(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try { await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
async function getStatus(directory) {
  let state = {};
  try { state = JSON.parse(await fs.readFile(path.join(directory, 'status.json'), 'utf8')); } catch { /* No successful run yet. */ }
  let destinationAvailable = false;
  try { await fs.access(directory, require('node:fs').constants.W_OK); destinationAvailable = true; } catch { /* Unavailable destination. */ }
  return { ...state, destinationAvailable };
}
async function runBackup({ source, directory, secondaryDirectory = '', retention = 14, force = false, now = Date.now() }) {
  if (!source || source === ':memory:' || !directory) throw new Error('BACKUP_CONFIGURATION_INVALID');
  if (!Number.isInteger(retention) || retention < 1 || retention > 365) throw new Error('BACKUP_CONFIGURATION_INVALID');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  // Exclusive advisory lock shared by the application scheduler and operator command.
  // Never steal a lock by age: a slow backup may still be running. Recover a crash lock only with the documented operator procedure.
  const lock = path.join(directory, '.backup-lock');
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') return { skipped: 'busy' }; throw error; }
  let temporary;
  let sourceDb;
  try {
    const previous = await getStatus(directory);
    if (!force && previous.lastSuccess && now - previous.lastSuccess < DAY) return { skipped: 'recent' };
    await atomicJson(path.join(lock, 'owner.json'), { pid: process.pid, startedAt: now });
    sourceDb = new DatabaseSync(source, { readOnly: true });
    const name = `invoice-backup-${new Date(now).toISOString().replaceAll(/[-:.]/g, '')}-${randomUUID()}.sqlite`;
    const output = path.join(directory, name);
    temporary = output + '.tmp';
    // Precreate privately: SQLite's default creation mode must not expose the snapshot.
    const file = await fs.open(temporary, 'wx', 0o600); await file.close();
    await backup(sourceDb, temporary);
    sourceDb.close(); sourceDb = null;
    const snapshot = await inspectBackup(temporary);
    const manifest = { createdAt: now, snapshot, fileHash: await fileHash(temporary) };
    await fs.rename(temporary, output); temporary = null;
    await atomicJson(output + '.json', manifest);
    await verifyBackup(output);
    let secondaryError = null;
    let secondarySuccess = null;
    if (secondaryDirectory) {
      try {
        const secondary = await fs.realpath(secondaryDirectory);
        if (secondary === await fs.realpath(directory)) throw new Error('SECONDARY_SAME_DESTINATION');
        await fs.access(secondary, require('node:fs').constants.W_OK);
        const tempCopy = path.join(secondary, name + '.tmp');
        try {
          const handle = await fs.open(tempCopy, 'wx', 0o600); await handle.close();
          await fs.copyFile(output, tempCopy); await fs.chmod(tempCopy, 0o600);
          await fs.rename(tempCopy, path.join(secondary, name));
          await atomicJson(path.join(secondary, name + '.json'), manifest);
          await verifyBackup(path.join(secondary, name));
          secondarySuccess = now;
        } finally { await fs.rm(tempCopy, { force: true }); }
      } catch { secondaryError = 'Secondary backup failed. Check the configured destination.'; }
    }
    const state = { lastSuccess: now, lastAttempt: now, lastError: null, schemaVersion: snapshot.schemaVersion,
      secondaryConfigured: !!secondaryDirectory, secondaryLastSuccess: secondarySuccess ?? previous.secondaryLastSuccess ?? null, secondaryError };
    await atomicJson(path.join(directory, 'status.json'), state);
    // Only prune complete, verified files belonging to this tool, never arbitrary directory contents.
    async function prune(destination) {
      const names = (await fs.readdir(destination)).filter(n => BACKUP_NAME.test(n)).sort().reverse();
      const valid = [];
      for (const n of names) { try { await verifyBackup(path.join(destination,n)); valid.push(n); } catch { /* Keep incomplete/corrupt files for operator review. */ } }
      for (const n of valid.slice(retention)) { await fs.rm(path.join(destination,n)); await fs.rm(path.join(destination,n + '.json')); }
    }
    await prune(directory);
    if (secondarySuccess) await prune(secondaryDirectory);
    return { file: output, ...state };
  } catch (error) {
    const previous = await getStatus(directory);
    await atomicJson(path.join(directory, 'status.json'), { ...previous, lastAttempt: now, lastError: 'Backup failed. Check storage space and database access.', secondaryConfigured: !!secondaryDirectory }).catch(() => {});
    throw error;
  } finally {
    if (sourceDb) sourceDb.close();
    if (temporary) await fs.rm(temporary, { force: true });
    await fs.rm(lock, { recursive: true, force: true });
  }
}
module.exports = { runBackup, getStatus, verifyBackup };
