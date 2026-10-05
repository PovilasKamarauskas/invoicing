import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import backups from '../../../shared/database-backup.cjs';
import type { BackupStatus } from '../../../shared/database-backup.cjs';

export function canViewBackups(email: string): boolean {
  const owner = process.env.BACKUP_STATUS_OWNER_EMAIL?.trim().toLowerCase();
  return !!owner && email.toLowerCase() === owner;
}
@Injectable()
export class BackupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private lastError: string | null = null;
  onModuleInit() {
    if (!process.env.BACKUP_DIR || process.env.DATABASE_PATH === ':memory:')
      return;
    void this.tick();
    // Hourly check catches a missed daily backup after sleep; runBackup checks the 24-hour interval.
    this.timer = setInterval(() => void this.tick(), 60 * 60 * 1000);
    this.timer.unref();
  }
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = backups
      .runBackup({
        source: process.env.DATABASE_PATH || './data/invoices.sqlite',
        directory: process.env.BACKUP_DIR!,
        secondaryDirectory: process.env.BACKUP_SECONDARY_DIR,
        retention: Number(process.env.BACKUP_RETENTION || 14),
      })
      .then((result) => {
        if (result.skipped !== 'busy') this.lastError = null;
      })
      .catch(() => {
        this.lastError =
          'Backup could not complete. Check storage and the backup configuration.';
        this.logger.warn('Automatic database backup failed.');
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  async status(): Promise<
    BackupStatus & { enabled: boolean; running: boolean }
  > {
    const enabled =
      !!process.env.BACKUP_DIR && process.env.DATABASE_PATH !== ':memory:';
    const status = enabled
      ? await backups.getStatus(process.env.BACKUP_DIR!)
      : {};
    return {
      ...status,
      enabled,
      running: !!this.running,
      secondaryConfigured: !!process.env.BACKUP_SECONDARY_DIR,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
