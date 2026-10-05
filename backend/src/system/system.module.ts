import { Module } from '@nestjs/common';
import { BackupService } from './backup.service';
import { SystemController } from './system.controller';
@Module({ controllers: [SystemController], providers: [BackupService] })
export class SystemModule {}
