import {
  Controller,
  Get,
  Req,
  Header,
  ForbiddenException,
} from '@nestjs/common';
import type { AccountRequest } from '../account/auth.guard';
import { BackupService, canViewBackups } from './backup.service';
@Controller('api/system')
export class SystemController {
  constructor(private readonly backups: BackupService) {}
  @Get('backup-status')
  @Header('Cache-Control', 'no-store')
  status(@Req() req: AccountRequest) {
    if (!canViewBackups(req.user.email))
      throw new ForbiddenException(
        'Backup status is unavailable for this account.',
      );
    return this.backups.status();
  }
}
