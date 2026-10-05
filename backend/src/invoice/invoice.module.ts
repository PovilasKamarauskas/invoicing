import { Module } from '@nestjs/common';
import { InvoiceEmailService } from './invoice-email.service';
import { InvoiceController } from './invoice.controller';
import { InvoiceHistoryService } from './invoice-history.service';
import { InvoiceService } from './invoice.service';

@Module({
  controllers: [InvoiceController],
  providers: [InvoiceService, InvoiceHistoryService, InvoiceEmailService],
})
export class InvoiceModule {}
