import type { BackupPayload, CatalogProduct, StockMap, Sale } from '../types';

const escapeCell = (value: string): string => {
  if (/[";\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
};

const toValue = (value: number | string | null | undefined): string => {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
};

export const salesToCsv = (sales: Sale[]): string => {
  const header = [
    'id',
    'date',
    'client_or_tx',
    'channel',
    'product_ref',
    'quantity',
    'sell_price_unit_ht',
    'sell_total_ht',
    'shipping_charged',
    'shipping_real',
    'transaction_value',
    'payment_method',
    'category',
    'buy_price_unit',
    'power_wp',
    'commission_rate_display',
    'commission_eur',
    'payment_fee',
    'net_received',
    'total_cost',
    'gross_margin',
    'net_margin',
    'net_margin_pct',
    'attachments_count',
    'created_at',
    'updated_at',
  ];

  const rows = sales.map((sale) => [
    sale.id,
    sale.date,
    sale.client_or_tx,
    sale.channel,
    sale.product_ref,
    toValue(sale.quantity),
    toValue(sale.sell_price_unit_ht),
    toValue(sale.sell_total_ht),
    toValue(sale.shipping_charged),
    toValue(sale.shipping_real),
    toValue(sale.transaction_value),
    sale.payment_method,
    sale.category,
    toValue(sale.buy_price_unit),
    toValue(sale.power_wp),
    sale.commission_rate_display,
    toValue(sale.commission_eur),
    toValue(sale.payment_fee),
    toValue(sale.net_received),
    toValue(sale.total_cost),
    toValue(sale.gross_margin),
    toValue(sale.net_margin),
    toValue(sale.net_margin_pct),
    toValue(sale.attachments.length),
    sale.created_at,
    sale.updated_at,
  ]);

  return [header, ...rows]
    .map((row) => row.map((cell) => escapeCell(String(cell))).join(';'))
    .join('\n');
};

export const catalogToCsv = (catalog: CatalogProduct[], stock: StockMap): string => {
  const header = [
    'order',
    'reference',
    'category',
    'buy_price_unit_eur',
    'stock_initial',
    'stock_current',
    'status',
    'datasheet_url',
  ];

  const rows = catalog.map((item) => {
    const currentStock = stock[item.ref] ?? item.initial_stock;
    const status = currentStock <= 0 ? 'Rupture' : currentStock <= 5 ? 'Stock faible' : 'OK';
    return [
      toValue(item.order),
      item.ref,
      item.category,
      toValue(item.buy_price_unit),
      toValue(item.initial_stock),
      toValue(currentStock),
      status,
      toValue(item.datasheet_url),
    ];
  });

  return [header, ...rows]
    .map((row) => row.map((cell) => escapeCell(String(cell))).join(';'))
    .join('\n');
};

const downloadBlob = (filename: string, mime: string, content: string): void => {
  const blob = new Blob([content], { type: mime });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
};

export const downloadCsv = (filename: string, csv: string): void => {
  downloadBlob(filename, 'text/csv;charset=utf-8', csv);
};

export const downloadBackupJson = (filename: string, payload: BackupPayload): void => {
  downloadBlob(filename, 'application/json;charset=utf-8', JSON.stringify(payload, null, 2));
};
