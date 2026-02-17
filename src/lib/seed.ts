import { computeSale } from './calculations';
import type { Attachment, Sale, SaleInput } from '../types';

const makeDate = (daysOffset: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + daysOffset);
  return date.toISOString().slice(0, 10);
};

const emptyAttachments = (): Attachment[] => [];

const seedInputs: SaleInput[] = [
  {
    date: makeDate(-2),
    client_or_tx: 'Client Demo A',
    transaction_ref: 'TX-1001',
    channel: 'Sun.store',
    customer_country: 'France',
    product_ref: 'SUN2000-12K-MB0',
    quantity: 2,
    sell_price_unit_ht: 1490,
    sell_price_unit_ttc: 1788,
    shipping_charged: 120,
    shipping_charged_ttc: 144,
    shipping_real: 80,
    shipping_real_ttc: 96,
    payment_method: 'Wire',
    category: 'Inverters',
    buy_price_unit: 1317,
    power_wp: null,
    attachments: emptyAttachments(),
  },
  {
    date: makeDate(-1),
    client_or_tx: 'Client Demo B',
    transaction_ref: 'ST-2001',
    channel: 'Solartraders',
    customer_country: 'Belgique',
    product_ref: 'HUAWEI-PANEL-550WP',
    quantity: 100,
    sell_price_unit_ht: 58,
    sell_price_unit_ttc: null,
    shipping_charged: 300,
    shipping_charged_ttc: null,
    shipping_real: 220,
    shipping_real_ttc: null,
    payment_method: 'Wire',
    category: 'Solar Panels',
    buy_price_unit: 45,
    power_wp: 550000,
    attachments: emptyAttachments(),
  },
  {
    date: makeDate(0),
    client_or_tx: 'Client Demo C',
    transaction_ref: 'DIR-3001',
    channel: 'Direct',
    customer_country: 'France',
    product_ref: 'Smart dongle SDongleA-05',
    quantity: 5,
    sell_price_unit_ht: 70,
    sell_price_unit_ttc: 84,
    shipping_charged: 25,
    shipping_charged_ttc: 30,
    shipping_real: 20,
    shipping_real_ttc: 24,
    payment_method: 'Cash',
    category: 'Accessories',
    buy_price_unit: 41,
    power_wp: null,
    attachments: emptyAttachments(),
  },
];

export const createSeedSales = (): Sale[] =>
  seedInputs.map((input, index) => {
    const now = new Date().toISOString();
    return {
      id: `seed-${index + 1}`,
      ...input,
      ...computeSale(input),
      created_at: now,
      updated_at: now,
    };
  });
