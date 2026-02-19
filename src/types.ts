export type Channel = 'Sun.store' | 'Solartraders' | 'Direct' | 'Other';
export type PaymentMethod = 'Stripe' | 'Wire' | 'PayPal' | 'Cash';
export type Category = 'Inverters' | 'Solar Panels' | 'Batteries' | 'Accessories';
export type CustomerCountry = string;

export interface Attachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  base64: string;
}

export interface SaleInput {
  date: string;
  client_or_tx: string;
  transaction_ref: string;
  channel: Channel;
  customer_country: CustomerCountry;
  product_ref: string;
  quantity: number;
  sell_price_unit_ht: number;
  sell_price_unit_ttc: number | null;
  shipping_charged: number;
  shipping_charged_ttc: number | null;
  shipping_real: number;
  shipping_real_ttc: number | null;
  payment_method: PaymentMethod;
  category: Category;
  buy_price_unit: number;
  power_wp: number | null;
  attachments: Attachment[];
  tracking_numbers?: string[];
  shipping_provider?: string | null;
  shipping_status?: string | null;
  shipping_cost_source?: 'manual' | 'envia_webhook' | string;
  shipping_event_at?: string | null;
  shipping_tracking_url?: string | null;
  shipping_label_url?: string | null;
  shipping_proof_url?: string | null;
  invoice_url?: string | null;
}

export interface SaleComputed {
  sell_total_ht: number;
  transaction_value: number;
  commission_rate_display: string;
  commission_eur: number;
  payment_fee: number;
  net_received: number;
  total_cost: number;
  gross_margin: number;
  net_margin: number;
  net_margin_pct: number;
}

export interface Sale extends SaleInput, SaleComputed {
  id: string;
  created_at: string;
  updated_at: string;
}

export interface CatalogProduct {
  ref: string;
  buy_price_unit: number;
  category: Category;
  initial_stock: number;
  order: number;
  datasheet_url: string | null;
  source: 'remote';
}

export type StockMap = Record<string, number>;

export interface Filters {
  channel: 'All' | Channel;
  category: 'All' | Category;
  date_from: string;
  date_to: string;
  query: string;
  stock_status: 'all' | 'low' | 'out';
}

export interface BackupPayload {
  generated_at: string;
  sales: Sale[];
  catalog: CatalogProduct[];
  stock: StockMap;
}

export interface ChatMessage {
  id: string;
  store_id: string;
  author: string;
  body: string;
  device_id: string;
  created_at: string;
}
