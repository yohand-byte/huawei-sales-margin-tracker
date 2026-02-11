import type { BackupPayload, CatalogProduct, Sale, StockMap } from '../types';

export const STORAGE_KEYS = {
  sales: 'sales_margin_tracker_sales_v1',
  catalog: 'sales_margin_tracker_catalog_v2',
  stock: 'sales_margin_tracker_stock_v2',
  backup: 'sales_margin_tracker_backup_v2',
} as const;

const isBrowser = (): boolean => typeof window !== 'undefined' && typeof localStorage !== 'undefined';

export const readLocalStorage = <T>(key: string, fallback: T): T => {
  if (!isBrowser()) {
    return fallback;
  }
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

export const writeLocalStorage = (key: string, value: unknown): void => {
  if (!isBrowser()) {
    return;
  }
  localStorage.setItem(key, JSON.stringify(value));
};

export const buildBackup = (
  sales: Sale[],
  catalog: CatalogProduct[],
  stock: StockMap,
): BackupPayload => ({
  generated_at: new Date().toISOString(),
  sales,
  catalog,
  stock,
});
