export class LineItemDto {
  description: string;
  quantity: number;
  unit: string; // 'd', 'h', 'pcs', 'month'
  price: number;
}

export class BuyerDto {
  name: string;
  vatCode: string;
  address: string;
}

export class SellerDto {
  name: string;
  individualActivity: string;
  taxNumber: string;
  address: string;
  bankName: string;
  swift: string;
  iban: string;
}

export class GenerateInvoiceDto {
  calculationVersion?: number;
  autoNumber?: boolean;
  invoiceNumber: string;
  invoiceDate: string;
  paymentTerm: string;
  seller: SellerDto;
  buyer: BuyerDto;
  items: LineItemDto[];
  additionalComment: string;
}
