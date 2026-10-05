import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AccountRequest } from '../account/auth.guard';
import { TaxService, taxYear } from './tax.service';

@Controller('api/taxes')
export class TaxController {
  constructor(private readonly taxes: TaxService) {}
  @Get('years')
  years(@Req() req: AccountRequest) {
    return this.taxes.years(req.user.id);
  }
  @Get(':year')
  summary(
    @Req() req: AccountRequest,
    @Param('year') year: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.taxes.summary(req.user.id, taxYear(year));
  }
  @Get(':year/export')
  export(
    @Req() req: AccountRequest,
    @Param('year') year: string,
    @Res() res: Response,
  ) {
    const y = taxYear(year);
    res.setHeader('Cache-Control', 'no-store');
    res
      .type('text/csv')
      .attachment(`yearly-taxes-${y}.csv`)
      .send(this.taxes.csv(req.user.id, y));
  }
  @Put(':year/settings')
  settings(
    @Req() req: AccountRequest,
    @Param('year') year: string,
    @Body() body: unknown,
  ) {
    return this.taxes.saveSettings(req.user.id, taxYear(year), body);
  }
  @Put('invoices/:id/earned-date')
  earned(
    @Req() req: AccountRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.taxes.earnedDate(req.user.id, id, body);
  }
  @Post(':year/review-dates')
  review(@Req() req: AccountRequest, @Param('year') year: string) {
    return this.taxes.reviewDates(req.user.id, taxYear(year));
  }
  @Post(':year/entries')
  entry(
    @Req() req: AccountRequest,
    @Param('year') year: string,
    @Body() body: unknown,
  ) {
    return this.taxes.saveEntry(req.user.id, taxYear(year), body);
  }
  @Put(':year/entries/:id')
  update(
    @Req() req: AccountRequest,
    @Param('year') year: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.taxes.saveEntry(req.user.id, taxYear(year), body, id);
  }
  @Delete(':year/entries/:id')
  remove(
    @Req() req: AccountRequest,
    @Param('year') year: string,
    @Param('id') id: string,
  ) {
    return this.taxes.deleteEntry(req.user.id, taxYear(year), id);
  }
}
