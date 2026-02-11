import type { CatalogProduct, Category } from '../types';
import { getDatasheetUrl } from './datasheets';

export const CATALOG_SOURCE_URL = 'https://yohand-byte.github.io/huawei-pricing-calculator/';
const round2 = (value: number): number => Math.round(value * 100) / 100;

const inferCategory = (ref: string): Category => {
  const value = ref.toLowerCase();
  if (value.includes('luna') || value.includes('battery')) {
    return 'Batteries';
  }
  if (value.includes('panel') || value.includes('pv module')) {
    return 'Solar Panels';
  }
  if (value.includes('sun2000')) {
    return 'Inverters';
  }
  return 'Accessories';
};

const normalizeRef = (value: string): string => value.trim().replace(/\s+/g, ' ');

const parseNumberField = (html: string, field: string, fallback: number): number => {
  const match = html.match(new RegExp(`${field}:\\s*([0-9]+(?:\\.[0-9]+)?)`));
  return match ? Number(match[1]) : fallback;
};

const parseIncludedLocalChargesAed = (html: string): number => {
  const blockMatch = html.match(/const\s+defaultLocalCharges\s*=\s*\[([\s\S]*?)\];/);
  if (!blockMatch) {
    return 0;
  }

  const entryRegex = /\{[\s\S]*?amountAED:\s*([0-9.]+)[\s\S]*?included:\s*(true|false)[\s\S]*?\}/g;
  let total = 0;
  let match = entryRegex.exec(blockMatch[1]);
  while (match) {
    if (match[2] === 'true') {
      total += Number(match[1]);
    }
    match = entryRegex.exec(blockMatch[1]);
  }
  return total;
};

export const parseCatalogFromHtml = (html: string): CatalogProduct[] => {
  const seedBlockMatch = html.match(/const\s+shippingProductsSeed\s*=\s*\[([\s\S]*?)\];/);
  if (!seedBlockMatch) {
    return [];
  }

  const block = seedBlockMatch[1];
  const entryRegex =
    /\{\s*no:\s*(\d+),\s*description:\s*'([^']+)',\s*qty:\s*(\d+),\s*unitPriceUSD:\s*([0-9.]+)/g;
  const products: CatalogProduct[] = [];
  const seen = new Set<string>();
  let totalQty = 0;
  const parsedEntries: Array<{ order: number; ref: string; qty: number; unitPriceUSD: number }> = [];

  let match = entryRegex.exec(block);
  while (match) {
    const order = Number(match[1]);
    const ref = normalizeRef(match[2]);
    const qty = Number(match[3]);
    const unitPriceUSD = Number(match[4]);
    totalQty += qty;
    parsedEntries.push({ order, ref, qty, unitPriceUSD });
    if (!seen.has(ref)) {
      seen.add(ref);
    }
    match = entryRegex.exec(block);
  }

  const exchangeRate = parseNumberField(html, 'exchangeRate', 1);
  const freightQuoteEUR = parseNumberField(html, 'freightQuoteEUR', 0);
  const customsCostsEUR = parseNumberField(html, 'customsCostsEUR', 0);
  const containerCount = parseNumberField(html, 'containerCount', 1);
  const aedToUsdRate = parseNumberField(html, 'aedToUsdRate', 3.6725);
  const localChargesAED = parseIncludedLocalChargesAed(html);
  const localChargesEUR = aedToUsdRate > 0 ? (localChargesAED / aedToUsdRate) * exchangeRate : 0;
  const transportPerContainerEUR = freightQuoteEUR + customsCostsEUR + localChargesEUR;
  const transportTotalEUR = transportPerContainerEUR * containerCount;
  const transportPerUnitEUR = totalQty > 0 ? transportTotalEUR / totalQty : 0;

  for (const entry of parsedEntries) {
    if (!products.find((item) => item.ref === entry.ref)) {
      products.push({
        ref: entry.ref,
        buy_price_unit: round2(entry.unitPriceUSD * exchangeRate + transportPerUnitEUR),
        category: inferCategory(entry.ref),
        initial_stock: entry.qty,
        order: entry.order,
        datasheet_url: getDatasheetUrl(entry.ref, entry.order),
        source: 'remote',
      });
    }
  }

  return products;
};

export const fetchRemoteCatalog = async (): Promise<CatalogProduct[]> => {
  const response = await fetch(CATALOG_SOURCE_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Catalog fetch failed (${response.status})`);
  }
  const html = await response.text();
  return parseCatalogFromHtml(html);
};

export const normalizeCatalog = (catalog: CatalogProduct[]): CatalogProduct[] =>
  catalog.map((item, index) => {
    const order = Number.isFinite(item.order) && item.order > 0 ? item.order : index + 1;
    const mappedDatasheet = getDatasheetUrl(item.ref, order);
    return {
      ...item,
      order,
      datasheet_url: mappedDatasheet ?? item.datasheet_url ?? null,
    };
  });
