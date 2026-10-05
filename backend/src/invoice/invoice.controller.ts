import {
  Controller,
  Post,
  Put,
  Body,
  Res,
  Req,
  BadRequestException,
  Get,
  Param,
  ParseIntPipe,
  Query,
  Header,
  Delete,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import rules from '../../../shared/invoice-rules.cjs';
import { InvoiceEmailService } from './invoice-email.service';
import { InvoiceService } from './invoice.service';
import { GenerateInvoiceDto } from './invoice.dto';
import type { AccountRequest } from '../account/auth.guard';
import { InvoiceHistoryService } from './invoice-history.service';
import {
  record,
  sellerFields,
  buyerFields,
  text,
} from '../account/preferences';

@Controller('invoice')
export class InvoiceController {
  constructor(
    private readonly invoiceService: InvoiceService,
    private readonly history: InvoiceHistoryService,
    private readonly email: InvoiceEmailService,
  ) {}

  @Post('generate')
  async generate(
    @Body() dto: GenerateInvoiceDto,
    @Req() req: AccountRequest,
    @Res() res: Response,
  ) {
    const snapshot = this.validate(dto);
    const header = req.headers['idempotency-key'];
    if (
      header !== undefined &&
      (typeof header !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(header))
    )
      throw new BadRequestException('Invalid request key.');
    const key = typeof header === 'string' ? header : randomUUID();
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(snapshot))
      .digest('hex');
    const request = this.history.begin(req.user.id, key, fingerprint, snapshot);
    if (request.replay) {
      res.setHeader(
        'X-Invoice-Email-Status',
        request.replay.emailStatus || 'not_configured',
      );
      res.setHeader('X-Invoice-Id', String(request.replay.id));
      res.setHeader(
        'X-Invoice-Number',
        encodeURIComponent(request.replay.invoiceNumber),
      );
      this.sendZip(res, request.replay.invoiceNumber, request.replay.zip);
      return;
    }
    try {
      const payload = request.payload;
      const zip = await this.invoiceService.generate(payload);
      const id = this.history.save(req.user.id, payload, zip, key);
      const delivery = await this.history.withOperation(req.user.id, id, () =>
        this.email.send(req.user, id, payload.invoiceNumber, zip),
      );
      res.setHeader('X-Invoice-Email-Status', delivery.status);
      res.setHeader('X-Invoice-Id', String(id));
      res.setHeader(
        'X-Invoice-Number',
        encodeURIComponent(payload.invoiceNumber),
      );
      this.sendZip(res, payload.invoiceNumber, zip);
    } catch (error) {
      this.history.fail(req.user.id, key);
      throw error;
    }
  }

  @Get('next-number')
  @Header('Cache-Control', 'no-store')
  nextNumber(@Req() req: AccountRequest) {
    return { invoiceNumber: this.history.nextNumber(req.user.id) };
  }

  @Get('history')
  @Header('Cache-Control', 'no-store')
  list(@Req() req: AccountRequest, @Query('before') before?: string) {
    if (
      before !== undefined &&
      (!/^\d+$/.test(before) ||
        !Number.isSafeInteger(Number(before)) ||
        Number(before) < 1)
    )
      throw new BadRequestException('Invalid history cursor.');
    return this.history.list(req.user.id, before ? Number(before) : undefined);
  }

  @Get('history/:id')
  @Header('Cache-Control', 'no-store')
  details(@Req() req: AccountRequest, @Param('id', ParseIntPipe) id: number) {
    return this.history.details(req.user.id, id);
  }

  @Get('history/:id/versions')
  @Header('Cache-Control', 'no-store')
  versions(
    @Req() req: AccountRequest,
    @Param('id', ParseIntPipe) id: number,
    @Query('beforeRevision') before?: string,
  ) {
    if (
      before !== undefined &&
      (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)))
    )
      throw new BadRequestException('Invalid version cursor.');
    return this.history.versions(
      req.user.id,
      id,
      before === undefined ? undefined : Number(before),
    );
  }
  @Get('history/:id/versions/:revision')
  @Header('Cache-Control', 'no-store')
  versionDetails(
    @Req() req: AccountRequest,
    @Param('id', ParseIntPipe) id: number,
    @Param('revision', ParseIntPipe) revision: number,
  ) {
    return this.history.versionDetails(
      req.user.id,
      id,
      this.versionRevision(revision),
    );
  }
  @Get('history/:id/versions/:revision/download')
  downloadVersion(
    @Req() req: AccountRequest,
    @Param('id', ParseIntPipe) id: number,
    @Param('revision', ParseIntPipe) revision: number,
    @Res() res: Response,
  ) {
    const saved = this.history.downloadVersion(
      req.user.id,
      id,
      this.versionRevision(revision),
    );
    this.sendZip(res, `${saved.invoiceNumber}-v${revision + 1}`, saved.zip);
  }
  @Get('history/:id/versions/:revision/deliveries/:deliveryId/download')
  downloadDelivery(
    @Req() req: AccountRequest,
    @Param('id', ParseIntPipe) id: number,
    @Param('revision', ParseIntPipe) revision: number,
    @Param('deliveryId', ParseIntPipe) deliveryId: number,
    @Res() res: Response,
  ) {
    const saved = this.history.downloadDelivery(
      req.user.id,
      id,
      this.versionRevision(revision),
      deliveryId,
    );
    this.sendZip(
      res,
      `${saved.invoiceNumber}-v${revision + 1}-delivery-${deliveryId}`,
      saved.zip,
    );
  }
  private versionRevision(revision: number) {
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new BadRequestException('Invalid invoice version.');
    return revision;
  }

  @Delete('history/:id')
  remove(@Req() req: AccountRequest, @Param('id', ParseIntPipe) id: number) {
    return this.history.remove(req.user.id, id);
  }

  @Get('history/:id/download')
  download(
    @Req() req: AccountRequest,
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    const { invoiceNumber, zip } = this.history.download(req.user.id, id);
    this.sendZip(res, invoiceNumber, zip);
  }

  @Post('history/:id/regenerate')
  async regenerate(
    @Req() req: AccountRequest,
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    return this.history.withOperation(req.user.id, id, async () => {
      const saved = this.history.details(req.user.id, id);
      const zip = await this.invoiceService.generate(saved.payload);
      this.history.markRegenerated(req.user.id, id);
      const delivery = await this.email.send(
        req.user,
        id,
        saved.invoiceNumber,
        zip,
      );
      res.setHeader('X-Invoice-Email-Status', delivery.status);
      this.sendZip(res, saved.invoiceNumber, zip);
    });
  }

  @Get('email/config')
  @Header('Cache-Control', 'no-store')
  emailConfig(@Req() req: AccountRequest) {
    return { configured: this.email.configured(), recipient: req.user.email };
  }

  @Post('history/:id/email')
  async emailInvoice(
    @Req() req: AccountRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const saved = this.history.download(req.user.id, id);
    const result = await this.history.withOperation(req.user.id, id, () =>
      this.email.send(req.user, id, saved.invoiceNumber, saved.zip, true),
    );
    if (result.status !== 'sent')
      throw new ServiceUnavailableException(
        result.status === 'not_configured'
          ? 'Email delivery is not configured. Add SMTP settings on the server.'
          : 'Email could not be sent. Your invoice is saved; please try again later.',
      );
    return { ...result, recipient: req.user.email };
  }

  private validate(dto: GenerateInvoiceDto): GenerateInvoiceDto {
    if (!dto || typeof dto !== 'object' || Array.isArray(dto))
      throw new BadRequestException('Invalid invoice.');
    for (const field of [
      'invoiceNumber',
      'invoiceDate',
      'paymentTerm',
      'additionalComment',
    ])
      text(dto[field], field === 'additionalComment' ? 2000 : 100);
    const seller = record(
      dto.seller,
      sellerFields,
    ) as unknown as GenerateInvoiceDto['seller'];
    const buyer = record(
      dto.buyer,
      buyerFields,
    ) as unknown as GenerateInvoiceDto['buyer'];
    if (!Array.isArray(dto.items) || dto.items.length > 200)
      throw new BadRequestException('Invalid line items.');
    for (const item of dto.items) {
      if (!item || typeof item !== 'object')
        throw new BadRequestException('Invalid item.');
      text(item.description);
      text(item.unit, 30);
    }
    if (dto.autoNumber !== undefined && typeof dto.autoNumber !== 'boolean')
      throw new BadRequestException('Invalid numbering option.');
    const snapshot: GenerateInvoiceDto = {
      invoiceNumber: dto.invoiceNumber.trim(),
      invoiceDate: dto.invoiceDate,
      paymentTerm: dto.paymentTerm,
      seller,
      buyer,
      items: dto.items.map(({ description, quantity, unit, price }) => ({
        description,
        quantity,
        unit,
        price,
      })),
      additionalComment: dto.additionalComment,
      autoNumber: dto.autoNumber === true,
      calculationVersion: 1,
    };
    const errors = rules.validateInvoice(snapshot);
    if (Object.keys(errors).length)
      throw new BadRequestException({
        message: Object.values(errors)[0],
        errors,
      });
    return snapshot;
  }

  @Put('history/:id')
  async update(
    @Body() dto: GenerateInvoiceDto & { revision: number },
    @Req() req: AccountRequest,
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    const snapshot = this.validate(dto);
    snapshot.autoNumber = false;
    if (!Number.isSafeInteger(dto.revision) || dto.revision < 0)
      throw new BadRequestException('Invalid invoice revision.');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(key))
      throw new BadRequestException('A valid request key is required.');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ id, revision: dto.revision, snapshot }))
      .digest('hex');
    return this.history.withOperation(req.user.id, id, async () => {
      const replay = this.history.checkEdit(
        req.user.id,
        id,
        dto.revision,
        snapshot.invoiceNumber,
        key,
        fingerprint,
      );
      if (!replay) {
        const zip = await this.invoiceService.generate(snapshot);
        this.history.update(
          req.user.id,
          id,
          dto.revision,
          snapshot,
          zip,
          key,
          fingerprint,
        );
      }
      const saved = this.history.download(req.user.id, id);
      res.setHeader('X-Invoice-Id', String(id));
      res.setHeader(
        'X-Invoice-Number',
        encodeURIComponent(saved.invoiceNumber),
      );
      this.sendZip(res, saved.invoiceNumber, saved.zip);
    });
  }

  private sendZip(res: Response, invoiceNumber: string, zipBuffer: Buffer) {
    res.set({
      'Cache-Control': 'no-store',
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="invoice-${invoiceNumber.replace(/[^a-zA-Z0-9_.-]/g, '-')}.zip"`,
      'Content-Length': zipBuffer.length,
    });
    res.end(zipBuffer);
  }
}
