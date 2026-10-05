import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseService } from './database.service';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { AccountController } from './account.controller';

@Global()
@Module({
  controllers: [AccountController],
  providers: [
    DatabaseService,
    AuthService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [DatabaseService],
})
export class AccountModule {}
