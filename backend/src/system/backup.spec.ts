import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  writeFile,
  stat,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import backups from '../../../shared/database-backup.cjs';
import { DatabaseService } from '../account/database.service';
import { BackupService, canViewBackups } from './backup.service';
import { SystemController } from './system.controller';
import type { AccountRequest } from '../account/auth.guard';

describe('Private consistent database backups', () => {
  let directory: string;
  let database: DatabaseService;
  const oldPath = process.env.DATABASE_PATH;
  const oldOwner = process.env.BACKUP_STATUS_OWNER_EMAIL;
  const oldDir = process.env.BACKUP_DIR;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'invoice-backup-test-'));
    process.env.DATABASE_PATH = join(directory, 'source.sqlite');
    database = new DatabaseService();
    database.db
      .prepare('INSERT INTO users VALUES (1,?,?,?,?)')
      .run('test@example.invalid', 'unused', 0, '{}');
    database.db
      .prepare(
        "INSERT INTO invoices(id,user_id,invoice_number,invoice_date,payment_term,buyer_name,total,payload,zip,created_at) VALUES(1,1,'SF 1','2026-01-01','2026-02-01','Buyer',100,'{}',X'010203',0)",
      )
      .run();
  });
  afterEach(async () => {
    database.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries({
      DATABASE_PATH: oldPath,
      BACKUP_STATUS_OWNER_EMAIL: oldOwner,
      BACKUP_DIR: oldDir,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const options = () => ({
    source: process.env.DATABASE_PATH!,
    directory: join(directory, 'backups'),
  });
  it('backs up while writes occur and restores exact records and invoice bytes privately', async () => {
    const task = backups.runBackup(options());
    database.db.prepare("UPDATE users SET preferences='{}' WHERE id=1").run();
    const result = await task;
    const destination = join(directory, 'restored.sqlite');
    const report = await backups.verifyBackup(result.file!, destination);
    expect(report.counts.invoices).toBe(1);
    expect(report.counts.users).toBe(1);
    expect(report.schemaVersion).toBe(5);
    expect((await stat(result.file!)).mode & 0o777).toBe(0o600);
    expect((await stat(options().directory)).mode & 0o777).toBe(0o700);
    const restored = new DatabaseSync(destination, { readOnly: true });
    expect(
      restored.prepare('SELECT hex(zip) AS value FROM invoices').get()?.value,
    ).toBe('010203');
    restored.close();
    await expect(
      backups.verifyBackup(result.file!, destination),
    ).rejects.toThrow();
    await expect(
      backups.verifyBackup(result.file!, process.env.DATABASE_PATH),
    ).rejects.toThrow();
  });
  it('runs once per day, catches up after time passes and serializes competing operators', async () => {
    const first = await backups.runBackup({ ...options(), now: 1000000000000 });
    expect(
      await backups.runBackup({ ...options(), now: 1000000001000 }),
    ).toEqual({ skipped: 'recent' });
    const next = await backups.runBackup({ ...options(), now: 1000086400001 });
    expect(next.file).not.toBe(first.file);
    const concurrent = await Promise.all([
      backups.runBackup({ ...options(), force: true }),
      backups.runBackup({ ...options(), force: true }),
    ]);
    expect(concurrent.filter((r) => r.skipped === 'busy')).toHaveLength(1);
  });
  it('prunes only verified tool snapshots after success and preserves prior success on failure', async () => {
    await mkdir(options().directory);
    await writeFile(join(options().directory, 'unrelated.sqlite'), 'keep');
    const saved = await backups.runBackup({ ...options(), retention: 1 });
    await expect(
      backups.runBackup({
        ...options(),
        source: join(directory, 'missing.sqlite'),
        force: true,
        retention: 1,
      }),
    ).rejects.toThrow();
    expect((await backups.getStatus(options().directory)).lastSuccess).toBe(
      saved.lastSuccess,
    );
    expect((await backups.getStatus(options().directory)).lastError).toContain(
      'Backup failed',
    );
    await backups.verifyBackup(saved.file!);
    await backups.runBackup({ ...options(), force: true, retention: 1 });
    const files = await readdir(options().directory);
    expect(
      files.filter(
        (f) => f.startsWith('invoice-backup-') && f.endsWith('.sqlite'),
      ),
    ).toHaveLength(1);
    expect(
      await readFile(join(options().directory, 'unrelated.sqlite'), 'utf8'),
    ).toBe('keep');
  });
  it('verifies second-destination copies and reports failure without losing the primary backup', async () => {
    const secondary = join(directory, 'secondary');
    await mkdir(secondary);
    const result = await backups.runBackup({
      ...options(),
      secondaryDirectory: secondary,
    });
    expect(result.secondaryLastSuccess).toBe(result.lastSuccess);
    const copies = (await readdir(secondary)).filter((f) =>
      f.endsWith('.sqlite'),
    );
    await backups.verifyBackup(join(secondary, copies[0]));
    const failed = await backups.runBackup({
      ...options(),
      force: true,
      secondaryDirectory: join(directory, 'missing'),
    });
    expect(failed.secondaryError).toContain('Secondary backup failed');
    await backups.verifyBackup(failed.file!);
    expect(
      await backups.runBackup({
        ...options(),
        secondaryDirectory: join(directory, 'missing'),
      }),
    ).toEqual({ skipped: 'recent' });
  });
  it('detects tampering before restoring', async () => {
    const result = await backups.runBackup(options());
    await writeFile(result.file!, 'broken');
    await expect(
      backups.verifyBackup(result.file!, join(directory, 'restore.sqlite')),
    ).rejects.toThrow('BACKUP_CHECKSUM_FAILED');
  });
  it('restricts operational status and never returns paths or private contents', async () => {
    process.env.BACKUP_STATUS_OWNER_EMAIL = 'owner@example.invalid';
    process.env.BACKUP_DIR = options().directory;
    expect(canViewBackups('OWNER@example.invalid')).toBe(true);
    const service = new BackupService();
    const controller = new SystemController(service);
    expect(() =>
      controller.status({
        user: { email: 'other@example.invalid' },
      } as AccountRequest),
    ).toThrow('unavailable');
    service.onModuleInit();
    await service.tick();
    const status = await controller.status({
      user: { email: 'owner@example.invalid' },
    } as AccountRequest);
    expect(status.lastSuccess).toBeDefined();
    expect(JSON.stringify(status)).not.toContain(directory);
    expect(JSON.stringify(status)).not.toContain('test@example');
    await service.onModuleDestroy();
  });
});
