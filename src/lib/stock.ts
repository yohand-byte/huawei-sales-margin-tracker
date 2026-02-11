import type { CatalogProduct, Sale, StockMap } from '../types';

export const LOW_STOCK_THRESHOLD = 5;

export const computeStockMap = (catalog: CatalogProduct[], sales: Sale[]): StockMap => {
  const stock: StockMap = {};

  for (const item of catalog) {
    stock[item.ref] = item.initial_stock;
  }

  for (const sale of sales) {
    if (stock[sale.product_ref] !== undefined) {
      stock[sale.product_ref] = stock[sale.product_ref] - sale.quantity;
    }
  }

  return stock;
};
