export interface BackupStatus {
  lastSuccess?: number; lastAttempt?: number; lastError?: string | null;
  schemaVersion?: number; destinationAvailable?: boolean;
  secondaryConfigured?: boolean; secondaryLastSuccess?: number | null; secondaryError?: string | null;
}
declare const backups: {
  runBackup(options: {source: string; directory: string; secondaryDirectory?: string; retention?: number; force?: boolean; now?: number}): Promise<BackupStatus & {file?: string; skipped?: string}>;
  getStatus(directory: string): Promise<BackupStatus>;
  verifyBackup(file: string, destination?: string): Promise<{counts: Record<string,number>; invoiceHash: string; schemaVersion: number}>;
};
export default backups;
