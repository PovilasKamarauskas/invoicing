import { Module } from '@nestjs/common';
import { AccountModule } from './account/account.module';
import { InvoiceModule } from './invoice/invoice.module';
import { SystemModule } from './system/system.module';
import { TaxModule } from './tax/tax.module';

@Module({
  imports: [AccountModule, InvoiceModule, TaxModule, SystemModule],
})
export class AppModule {}
