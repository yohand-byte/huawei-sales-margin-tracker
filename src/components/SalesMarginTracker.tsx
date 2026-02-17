import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { CATALOG_SOURCE_URL, fetchRemoteCatalog, normalizeCatalog } from '../lib/catalog';
import { computeSale, isPowerWpRequired, round2 } from '../lib/calculations';
import { catalogToCsv, downloadBackupJson, downloadCsv, salesToCsv } from '../lib/exports';
import { createSeedSales } from '../lib/seed';
import { LOW_STOCK_THRESHOLD, computeStockMap } from '../lib/stock';
import { STORAGE_KEYS, buildBackup, readLocalStorage, writeLocalStorage } from '../lib/storage';
import { isSupabaseConfigured, pullCloudBackup, pushCloudBackup } from '../lib/supabase';
import type {
  Attachment,
  BackupPayload,
  CatalogProduct,
  Category,
  Channel,
  Filters,
  PaymentMethod,
  Sale,
  SaleInput,
  StockMap,
} from '../types';

const CHANNELS: Channel[] = ['Sun.store', 'Solartraders', 'Direct', 'Other'];
const CATEGORIES: Category[] = ['Inverters', 'Solar Panels', 'Batteries', 'Accessories'];
const PAYMENT_METHODS: PaymentMethod[] = ['Stripe', 'Wire', 'PayPal', 'Cash'];
const EUROPEAN_COUNTRIES = [
  'Albanie',
  'Allemagne',
  'Andorre',
  'Armenie',
  'Autriche',
  'Azerbaidjan',
  'Belgique',
  'Bielorussie',
  'Bosnie-Herzegovine',
  'Bulgarie',
  'Chypre',
  'Croatie',
  'Danemark',
  'Espagne',
  'Estonie',
  'Finlande',
  'France',
  'Georgie',
  'Grece',
  'Hongrie',
  'Irlande',
  'Islande',
  'Italie',
  'Kosovo',
  'Lettonie',
  'Liechtenstein',
  'Lituanie',
  'Luxembourg',
  'Macedoine du Nord',
  'Malte',
  'Moldavie',
  'Monaco',
  'Montenegro',
  'Norvege',
  'Pays-Bas',
  'Pologne',
  'Portugal',
  'Republique tcheque',
  'Roumanie',
  'Royaume-Uni',
  'Russie',
  'Saint-Marin',
  'Serbie',
  'Slovaquie',
  'Slovenie',
  'Suede',
  'Suisse',
  'Turquie',
  'Ukraine',
  'Vatican',
] as const;
const THEME_STORAGE_KEY = 'sales_margin_tracker_theme_v1';
const FRANCE_COUNTRY = 'France';
const FRANCE_VAT_RATE = 0.2;
const COUNTRY_PLACEHOLDER = '';
const AUTO_HARD_REFRESH_MS = 5 * 60 * 1000;
const HARD_REFRESH_QUERY_KEY = '__hr';
const COUNTRY_ISO_CODES: Record<string, string> = {
  Albanie: 'AL',
  Allemagne: 'DE',
  Andorre: 'AD',
  Armenie: 'AM',
  Autriche: 'AT',
  Azerbaidjan: 'AZ',
  Belgique: 'BE',
  Bielorussie: 'BY',
  'Bosnie-Herzegovine': 'BA',
  Bulgarie: 'BG',
  Chypre: 'CY',
  Croatie: 'HR',
  Danemark: 'DK',
  Espagne: 'ES',
  Estonie: 'EE',
  Finlande: 'FI',
  France: 'FR',
  Georgie: 'GE',
  Grece: 'GR',
  Hongrie: 'HU',
  Irlande: 'IE',
  Islande: 'IS',
  Italie: 'IT',
  Kosovo: 'XK',
  Lettonie: 'LV',
  Liechtenstein: 'LI',
  Lituanie: 'LT',
  Luxembourg: 'LU',
  'Macedoine du Nord': 'MK',
  Malte: 'MT',
  Moldavie: 'MD',
  Monaco: 'MC',
  Montenegro: 'ME',
  Norvege: 'NO',
  'Pays-Bas': 'NL',
  Pologne: 'PL',
  Portugal: 'PT',
  'Republique tcheque': 'CZ',
  Roumanie: 'RO',
  'Royaume-Uni': 'GB',
  Russie: 'RU',
  'Saint-Marin': 'SM',
  Serbie: 'RS',
  Slovaquie: 'SK',
  Slovenie: 'SI',
  Suede: 'SE',
  Suisse: 'CH',
  Turquie: 'TR',
  Ukraine: 'UA',
  Vatican: 'VA',
};

const DEFAULT_FILTERS: Filters = {
  channel: 'All',
  category: 'All',
  date_from: '',
  date_to: '',
  query: '',
  stock_status: 'all',
};

const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

const createEmptySaleInput = (): SaleInput => ({
  date: toIsoDate(new Date()),
  client_or_tx: '',
  channel: 'Sun.store',
  customer_country: COUNTRY_PLACEHOLDER,
  product_ref: '',
  quantity: 1,
  sell_price_unit_ht: 0,
  sell_price_unit_ttc: null,
  shipping_charged: 0,
  shipping_charged_ttc: null,
  shipping_real: 0,
  shipping_real_ttc: null,
  payment_method: 'Wire',
  category: 'Inverters',
  buy_price_unit: 0,
  power_wp: null,
  attachments: [],
});

const formatMoney = (value: number): string =>
  new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);

const formatPercent = (value: number): string => `${round2(value)}%`;
const formatDateTime = (value: string): string => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(d);
};
const toTimestamp = (value: string | null | undefined): number => {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const makeId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sale-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const saleToInput = (sale: Sale): SaleInput => ({
  date: sale.date,
  client_or_tx: sale.client_or_tx,
  channel: sale.channel,
  customer_country: sale.customer_country || COUNTRY_PLACEHOLDER,
  product_ref: sale.product_ref,
  quantity: sale.quantity,
  sell_price_unit_ht: sale.sell_price_unit_ht,
  sell_price_unit_ttc: sale.sell_price_unit_ttc ?? null,
  shipping_charged: sale.shipping_charged,
  shipping_charged_ttc: sale.shipping_charged_ttc ?? null,
  shipping_real: sale.shipping_real,
  shipping_real_ttc: sale.shipping_real_ttc ?? null,
  payment_method: sale.payment_method,
  category: sale.category,
  buy_price_unit: sale.buy_price_unit,
  power_wp: sale.power_wp,
  attachments: sale.attachments,
});

const saleToLinkedInput = (sale: Sale): SaleInput => ({
  date: sale.date,
  client_or_tx: sale.client_or_tx,
  channel: sale.channel,
  customer_country: sale.customer_country || COUNTRY_PLACEHOLDER,
  product_ref: '',
  quantity: 1,
  sell_price_unit_ht: 0,
  sell_price_unit_ttc: null,
  shipping_charged: 0,
  shipping_charged_ttc: null,
  shipping_real: 0,
  shipping_real_ttc: null,
  payment_method: sale.payment_method,
  category: sale.category,
  buy_price_unit: 0,
  power_wp: null,
  attachments: [],
});

const inputToSale = (id: string, input: SaleInput, createdAt?: string): Sale => {
  const now = new Date().toISOString();
  return {
    id,
    ...input,
    ...computeSale(input),
    created_at: createdAt ?? now,
    updated_at: now,
  };
};

const fileToAttachment = (file: File): Promise<Attachment> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = typeof reader.result === 'string' ? reader.result : '';
      const base64 = raw.includes(',') ? raw.split(',')[1] : raw;
      resolve({
        id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        base64,
      });
    };
    reader.onerror = () => reject(new Error('Lecture de fichier impossible.'));
    reader.readAsDataURL(file);
  });

const downloadAttachment = (attachment: Attachment): void => {
  const link = document.createElement('a');
  link.href = `data:${attachment.mime};base64,${attachment.base64}`;
  link.download = attachment.name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

const toNumber = (value: string): number => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const toNullableNumber = (value: string): number | null => {
  if (value.trim() === '') {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const normalizeNullableNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const isFranceCustomer = (country: string): boolean => country === FRANCE_COUNTRY;
const applyFranceVat = (htAmount: number): number => round2(htAmount * (1 + FRANCE_VAT_RATE));

const isoCodeToFlag = (isoCode: string): string => {
  const code = isoCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    return '🏳️';
  }
  return String.fromCodePoint(...Array.from(code).map((char) => 127397 + char.charCodeAt(0)));
};

const countryToFlag = (country: string): string => {
  const isoCode = COUNTRY_ISO_CODES[country];
  return isoCode ? isoCodeToFlag(isoCode) : '🏳️';
};

const normalizeSaleFiscalFields = (sale: Sale): SaleInput => ({
  ...sale,
  customer_country:
    typeof sale.customer_country === 'string' && sale.customer_country.length > 0
      ? sale.customer_country
      : COUNTRY_PLACEHOLDER,
  sell_price_unit_ttc: isFranceCustomer(sale.customer_country)
    ? applyFranceVat(sale.sell_price_unit_ht)
    : normalizeNullableNumber(sale.sell_price_unit_ttc),
  shipping_charged_ttc: isFranceCustomer(sale.customer_country)
    ? applyFranceVat(sale.shipping_charged)
    : normalizeNullableNumber(sale.shipping_charged_ttc),
  shipping_real_ttc: isFranceCustomer(sale.customer_country)
    ? applyFranceVat(sale.shipping_real)
    : normalizeNullableNumber(sale.shipping_real_ttc),
});

const parseStoredSales = (): Sale[] => {
  const stored = readLocalStorage<Sale[]>(STORAGE_KEYS.sales, []);
  if (stored.length > 0) {
    return stored.map((sale) => {
      const normalized = normalizeSaleFiscalFields(sale);
      return {
        ...sale,
        ...normalized,
        ...computeSale(normalized),
      };
    });
  }

  const backup = readLocalStorage<BackupPayload | null>(STORAGE_KEYS.backup, null);
  if (backup && Array.isArray(backup.sales) && backup.sales.length > 0) {
    return backup.sales.map((sale) => {
      const normalized = normalizeSaleFiscalFields(sale);
      return {
        ...sale,
        ...normalized,
        ...computeSale(normalized),
      };
    });
  }

  return createSeedSales();
};

const parseStoredCatalog = (): CatalogProduct[] => {
  const stored = normalizeCatalog(readLocalStorage<CatalogProduct[]>(STORAGE_KEYS.catalog, []));
  if (stored.length > 0) {
    return stored;
  }
  const backup = readLocalStorage<BackupPayload | null>(STORAGE_KEYS.backup, null);
  if (backup && Array.isArray(backup.catalog) && backup.catalog.length > 0) {
    return normalizeCatalog(backup.catalog);
  }
  return [];
};

const parseStoredStock = (): StockMap => {
  const stored = readLocalStorage<StockMap>(STORAGE_KEYS.stock, {});
  if (Object.keys(stored).length > 0) {
    return stored;
  }
  const backup = readLocalStorage<BackupPayload | null>(STORAGE_KEYS.backup, null);
  if (backup && backup.stock && typeof backup.stock === 'object') {
    return backup.stock;
  }
  return {};
};

const parseLastBackupTimestamp = (): string | null => {
  const backup = readLocalStorage<BackupPayload | null>(STORAGE_KEYS.backup, null);
  if (backup && typeof backup.generated_at === 'string' && backup.generated_at.length > 0) {
    return backup.generated_at;
  }
  return null;
};

const parseTheme = (): 'dark' | 'light' => {
  const stored = readLocalStorage<'dark' | 'light' | null>(THEME_STORAGE_KEY, null);
  return stored === 'light' ? 'light' : 'dark';
};

interface GroupedOrderRow {
  key: string;
  date: string;
  client_or_tx: string;
  customer_country: string;
  channel: Channel;
  refs_count: number;
  product_display: string;
  quantity: number;
  sell_price_unit_ht: number;
  sell_total_ht: number;
  commission_eur: number;
  payment_fee: number;
  net_received: number;
  net_margin: number;
  net_margin_pct: number;
  attachments_count: number;
  first_sale: Sale;
}

export function SalesMarginTracker() {
  const cloudEnabled = isSupabaseConfigured;

  const [activeTab, setActiveTab] = useState<'sales' | 'dashboard' | 'stock'>('sales');
  const [theme, setTheme] = useState<'dark' | 'light'>(() => parseTheme());
  const [catalog, setCatalog] = useState<CatalogProduct[]>(() => parseStoredCatalog());
  const [sales, setSales] = useState<Sale[]>(() => parseStoredSales());
  const [stock, setStock] = useState<StockMap>(() => parseStoredStock());
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(() => parseLastBackupTimestamp());
  const [cloudReady, setCloudReady] = useState<boolean>(() => !cloudEnabled);
  const [cloudStatus, setCloudStatus] = useState<string>(() =>
    cloudEnabled ? 'Supabase: initialisation...' : 'Supabase: non configure (mode local)',
  );
  const [groupByOrder, setGroupByOrder] = useState<boolean>(true);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [stockQuery, setStockQuery] = useState<string>('');
  const [stockOnlyLow, setStockOnlyLow] = useState<boolean>(false);
  const [stockCategoryFilter, setStockCategoryFilter] = useState<'All' | Category>('All');

  const [form, setForm] = useState<SaleInput>(() => createEmptySaleInput());
  const [editingSaleId, setEditingSaleId] = useState<string | null>(null);
  const [saleModalOpen, setSaleModalOpen] = useState<boolean>(false);
  const [catalogStatus, setCatalogStatus] = useState<string>('Sync catalogue en attente...');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [successMessage, setSuccessMessage] = useState<string>('');

  const importInputRef = useRef<HTMLInputElement | null>(null);

  const catalogMap = useMemo(() => {
    const map = new Map<string, CatalogProduct>();
    for (const item of catalog) {
      map.set(item.ref, item);
    }
    return map;
  }, [catalog]);

  const sortedCatalog = useMemo(() => [...catalog].sort((a, b) => a.ref.localeCompare(b.ref)), [catalog]);
  const catalogByOrder = useMemo(
    () => [...catalog].sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999)),
    [catalog],
  );

  useEffect(() => {
    let canceled = false;

    const syncCatalog = async (): Promise<void> => {
      setCatalogStatus('Sync catalogue distant...');
      try {
        const remote = await fetchRemoteCatalog();
        if (canceled) {
          return;
        }

        if (remote.length === 0) {
          setCatalogStatus('Catalogue distant vide. Catalogue local conserve.');
          return;
        }

        setCatalog(normalizeCatalog(remote));
        setCatalogStatus(`Catalogue sync OK: ${remote.length} references.`);
      } catch (error) {
        if (!canceled) {
          setCatalogStatus(`Echec import distant: ${String((error as Error).message)}`);
        }
      }
    };

    void syncCatalog();

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!cloudEnabled) {
      return;
    }

    let canceled = false;

    const initCloudSync = async (): Promise<void> => {
      setCloudStatus('Supabase: lecture du backup cloud...');
      try {
        const localBackup = readLocalStorage<BackupPayload | null>(STORAGE_KEYS.backup, null);
        const cloudBackup = await pullCloudBackup();
        if (canceled) {
          return;
        }

        if (cloudBackup) {
          const cloudTs = toTimestamp(cloudBackup.generated_at);
          const localTs = toTimestamp(localBackup?.generated_at);
          const shouldRestoreCloud = !localBackup || cloudTs > localTs;

          if (shouldRestoreCloud) {
            const restoredSales = cloudBackup.sales.map((sale) => {
              const normalized = normalizeSaleFiscalFields(sale);
              return {
                ...sale,
                ...normalized,
                ...computeSale(normalized),
              };
            });
            const restoredCatalog = normalizeCatalog(cloudBackup.catalog);
            const restoredStock =
              cloudBackup.stock && typeof cloudBackup.stock === 'object'
                ? cloudBackup.stock
                : computeStockMap(restoredCatalog, restoredSales);

            setSales(restoredSales);
            setCatalog(restoredCatalog);
            setStock(restoredStock);
            writeLocalStorage(STORAGE_KEYS.sales, restoredSales);
            writeLocalStorage(STORAGE_KEYS.catalog, restoredCatalog);
            writeLocalStorage(STORAGE_KEYS.stock, restoredStock);
            writeLocalStorage(STORAGE_KEYS.backup, cloudBackup);
            setLastBackupAt(cloudBackup.generated_at);
            setSuccessMessage('Donnees Supabase restaurees.');
            setCloudStatus(`Supabase: backup cloud charge (${formatDateTime(cloudBackup.generated_at)})`);
          } else {
            const pushedAt = await pushCloudBackup(localBackup);
            if (!canceled) {
              setCloudStatus(`Supabase: cloud aligne (${formatDateTime(pushedAt)})`);
            }
          }
        } else if (localBackup) {
          const pushedAt = await pushCloudBackup(localBackup);
          if (!canceled) {
            setCloudStatus(`Supabase: backup local publie (${formatDateTime(pushedAt)})`);
          }
        } else {
          setCloudStatus('Supabase: aucun backup detecte.');
        }
      } catch (error) {
        if (!canceled) {
          setCloudStatus(`Supabase: erreur (${String((error as Error).message)})`);
        }
      } finally {
        if (!canceled) {
          setCloudReady(true);
        }
      }
    };

    void initCloudSync();

    return () => {
      canceled = true;
    };
  }, [cloudEnabled]);

  useEffect(() => {
    setStock(computeStockMap(catalog, sales));
  }, [catalog, sales]);

  useEffect(() => {
    writeLocalStorage(STORAGE_KEYS.sales, sales);
  }, [sales]);

  useEffect(() => {
    writeLocalStorage(STORAGE_KEYS.catalog, catalog);
  }, [catalog]);

  useEffect(() => {
    writeLocalStorage(STORAGE_KEYS.stock, stock);
  }, [stock]);

  useEffect(() => {
    writeLocalStorage(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (!successMessage) return;
    const timer = window.setTimeout(() => setSuccessMessage(''), 4000);
    return () => window.clearTimeout(timer);
  }, [successMessage]);

  useEffect(() => {
    if (!errorMessage) return;
    const timer = window.setTimeout(() => setErrorMessage(''), 6000);
    return () => window.clearTimeout(timer);
  }, [errorMessage]);

  useEffect(() => {
    const payload = buildBackup(sales, catalog, stock);
    writeLocalStorage(STORAGE_KEYS.backup, payload);
    setLastBackupAt(payload.generated_at);
  }, [sales, catalog, stock]);

  useEffect(() => {
    if (!cloudEnabled || !cloudReady) {
      return;
    }

    const payload = buildBackup(sales, catalog, stock);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const pushedAt = await pushCloudBackup(payload);
          setCloudStatus(`Supabase: sync auto OK (${formatDateTime(pushedAt)})`);
        } catch (error) {
          setCloudStatus(`Supabase: sync auto KO (${String((error as Error).message)})`);
        }
      })();
    }, 1200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [cloudEnabled, cloudReady, sales, catalog, stock]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      // Avoid force-reload while a form is being edited.
      if (saleModalOpen) {
        return;
      }
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set(HARD_REFRESH_QUERY_KEY, `${Date.now()}`);
      window.location.replace(nextUrl.toString());
    }, AUTO_HARD_REFRESH_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [saleModalOpen]);

  const editingSale = useMemo(() => {
    if (!editingSaleId) {
      return null;
    }
    return sales.find((sale) => sale.id === editingSaleId) ?? null;
  }, [editingSaleId, sales]);

  const filteredSales = useMemo(() => {
    const query = filters.query.trim().toLowerCase();

    return sales.filter((sale) => {
      if (filters.channel !== 'All' && sale.channel !== filters.channel) {
        return false;
      }

      if (filters.category !== 'All' && sale.category !== filters.category) {
        return false;
      }

      if (filters.date_from && sale.date < filters.date_from) {
        return false;
      }

      if (filters.date_to && sale.date > filters.date_to) {
        return false;
      }

      if (
        query &&
        !sale.client_or_tx.toLowerCase().includes(query) &&
        !sale.product_ref.toLowerCase().includes(query)
      ) {
        return false;
      }

      if (filters.stock_status !== 'all') {
        const currentStock = stock[sale.product_ref];
        if (currentStock === undefined) {
          return false;
        }

        if (filters.stock_status === 'low') {
          return currentStock > 0 && currentStock <= LOW_STOCK_THRESHOLD;
        }

        return currentStock <= 0;
      }

      return true;
    });
  }, [filters, sales, stock]);

  const kpis = useMemo(() => {
    const totalRevenue = filteredSales.reduce((sum, sale) => sum + sale.transaction_value, 0);
    const totalNetMargin = filteredSales.reduce((sum, sale) => sum + sale.net_margin, 0);
    const totalCommissions = filteredSales.reduce((sum, sale) => sum + sale.commission_eur, 0);
    const totalPlatformFees = filteredSales.reduce((sum, sale) => sum + sale.payment_fee, 0);

    const breakdown = CHANNELS.map((channel) => {
      const channelSales = filteredSales.filter((sale) => sale.channel === channel);
      return {
        channel,
        count: channelSales.length,
        revenue: channelSales.reduce((sum, sale) => sum + sale.transaction_value, 0),
        netMargin: channelSales.reduce((sum, sale) => sum + sale.net_margin, 0),
        commissions: channelSales.reduce((sum, sale) => sum + sale.commission_eur, 0),
      };
    });

    return {
      totalRevenue: round2(totalRevenue),
      totalNetMargin: round2(totalNetMargin),
      avgNetMarginPct: totalRevenue > 0 ? round2((totalNetMargin / totalRevenue) * 100) : 0,
      salesCount: filteredSales.length,
      totalCommissions: round2(totalCommissions),
      totalPlatformFees: round2(totalPlatformFees),
      breakdown,
    };
  }, [filteredSales]);

  const groupedOrders = useMemo<GroupedOrderRow[]>(() => {
    const buckets = new Map<
      string,
      {
        date: string;
        client_or_tx: string;
        customer_country: string;
        channel: Channel;
        refs: Set<string>;
        quantity: number;
        weighted_sell_unit_total: number;
        sell_total_ht: number;
        transaction_value: number;
        commission_eur: number;
        payment_fee: number;
        net_received: number;
        net_margin: number;
        attachments_count: number;
        first_sale: Sale;
      }
    >();

    for (const sale of filteredSales) {
      const key = `${sale.date}::${sale.client_or_tx}::${sale.channel}`;
      const existing = buckets.get(key);
      if (!existing) {
        buckets.set(key, {
          date: sale.date,
          client_or_tx: sale.client_or_tx,
          customer_country: sale.customer_country,
          channel: sale.channel,
          refs: new Set([sale.product_ref]),
          quantity: sale.quantity,
          weighted_sell_unit_total: sale.sell_price_unit_ht * sale.quantity,
          sell_total_ht: sale.sell_total_ht,
          transaction_value: sale.transaction_value,
          commission_eur: sale.commission_eur,
          payment_fee: sale.payment_fee,
          net_received: sale.net_received,
          net_margin: sale.net_margin,
          attachments_count: sale.attachments.length,
          first_sale: sale,
        });
        continue;
      }

      existing.refs.add(sale.product_ref);
      existing.quantity += sale.quantity;
      existing.weighted_sell_unit_total += sale.sell_price_unit_ht * sale.quantity;
      existing.sell_total_ht += sale.sell_total_ht;
      existing.transaction_value += sale.transaction_value;
      existing.commission_eur += sale.commission_eur;
      existing.payment_fee += sale.payment_fee;
      existing.net_received += sale.net_received;
      existing.net_margin += sale.net_margin;
      existing.attachments_count += sale.attachments.length;
    }

    return Array.from(buckets.entries())
      .map(([key, value]) => {
        const refs = Array.from(value.refs);
        const refsCount = refs.length;
        const productDisplay = refsCount === 1 ? refs[0] : `${refsCount} references`;
        const avgSellUnit = value.quantity > 0 ? round2(value.weighted_sell_unit_total / value.quantity) : 0;
        const netMarginPct = value.transaction_value > 0 ? round2((value.net_margin / value.transaction_value) * 100) : 0;

        return {
          key,
          date: value.date,
          client_or_tx: value.client_or_tx,
          customer_country: value.customer_country,
          channel: value.channel,
          refs_count: refsCount,
          product_display: productDisplay,
          quantity: value.quantity,
          sell_price_unit_ht: avgSellUnit,
          sell_total_ht: round2(value.sell_total_ht),
          commission_eur: round2(value.commission_eur),
          payment_fee: round2(value.payment_fee),
          net_received: round2(value.net_received),
          net_margin: round2(value.net_margin),
          net_margin_pct: netMarginPct,
          attachments_count: value.attachments_count,
          first_sale: value.first_sale,
        };
      })
      .sort((a, b) => {
        if (a.date !== b.date) {
          return b.date.localeCompare(a.date);
        }
        return a.client_or_tx.localeCompare(b.client_or_tx);
      });
  }, [filteredSales]);

  const topProducts = useMemo(() => {
    const map = new Map<string, { revenue: number; qty: number }>();
    for (const sale of filteredSales) {
      const existing = map.get(sale.product_ref) ?? { revenue: 0, qty: 0 };
      map.set(sale.product_ref, {
        revenue: existing.revenue + sale.transaction_value,
        qty: existing.qty + sale.quantity,
      });
    }
    return Array.from(map.entries())
      .map(([product, values]) => ({ product, ...values }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);
  }, [filteredSales]);

  const stockRows = useMemo(() => {
    const query = stockQuery.trim().toLowerCase();
    return catalogByOrder
      .map((item) => {
        const currentStock = stock[item.ref] ?? item.initial_stock;
        const status = currentStock <= 0 ? 'RUPTURE' : currentStock <= LOW_STOCK_THRESHOLD ? 'FAIBLE' : 'OK';
        return {
          ...item,
          currentStock,
          status,
        };
      })
      .filter((row) => {
        if (stockCategoryFilter !== 'All' && row.category !== stockCategoryFilter) {
          return false;
        }
        if (stockOnlyLow && row.currentStock > LOW_STOCK_THRESHOLD) {
          return false;
        }
        if (!query) {
          return true;
        }
        return row.ref.toLowerCase().includes(query) || row.category.toLowerCase().includes(query);
      });
  }, [catalogByOrder, stock, stockQuery, stockOnlyLow, stockCategoryFilter]);

  const stockAlerts = useMemo(
    () => stockRows.filter((item) => item.currentStock <= LOW_STOCK_THRESHOLD).slice(0, 6),
    [stockRows],
  );

  const selectedCatalogProduct = useMemo(
    () => catalogMap.get(form.product_ref.trim()) ?? null,
    [catalogMap, form.product_ref],
  );
  const isFranceSale = useMemo(() => isFranceCustomer(form.customer_country), [form.customer_country]);
  const franceSellPriceTtc = useMemo(
    () => (isFranceSale ? applyFranceVat(form.sell_price_unit_ht) : null),
    [isFranceSale, form.sell_price_unit_ht],
  );
  const franceShippingChargedTtc = useMemo(
    () => (isFranceSale ? applyFranceVat(form.shipping_charged) : null),
    [isFranceSale, form.shipping_charged],
  );
  const franceShippingRealTtc = useMemo(
    () => (isFranceSale ? applyFranceVat(form.shipping_real) : null),
    [isFranceSale, form.shipping_real],
  );

  const previewComputed = useMemo(() => computeSale(form), [form]);

  const updateForm = <K extends keyof SaleInput>(field: K, value: SaleInput[K]) => {
    setForm((previous) => ({ ...previous, [field]: value }));
  };

  const applyCatalogProduct = (value: string) => {
    const trimmed = value.trim();
    const match = catalogMap.get(trimmed);

    setForm((previous) => {
      const next: SaleInput = { ...previous, product_ref: value };
      if (match) {
        next.buy_price_unit = match.buy_price_unit;
        next.category = match.category;
      }
      return next;
    });
  };

  const openCreateModal = () => {
    setEditingSaleId(null);
    setForm(createEmptySaleInput());
    setErrorMessage('');
    setSuccessMessage('');
    setSaleModalOpen(true);
  };

  const openEditModal = (sale: Sale) => {
    setEditingSaleId(sale.id);
    setForm(saleToInput(sale));
    setErrorMessage('');
    setSuccessMessage('');
    setSaleModalOpen(true);
  };

  const openCreateLinkedModal = (sale: Sale) => {
    setEditingSaleId(null);
    setForm(saleToLinkedInput(sale));
    setErrorMessage('');
    setSuccessMessage('');
    setSaleModalOpen(true);
  };

  const showOrderLines = (order: GroupedOrderRow) => {
    setGroupByOrder(false);
    setFilters((previous) => ({
      ...previous,
      query: order.client_or_tx,
      channel: order.channel,
      date_from: order.date,
      date_to: order.date,
    }));
    setErrorMessage('');
    setSuccessMessage(`Affichage detail pour ${order.client_or_tx}.`);
  };

  const closeSaleModal = () => {
    setSaleModalOpen(false);
    setEditingSaleId(null);
    setForm(createEmptySaleInput());
  };

  const goHome = () => {
    setActiveTab('sales');
    setGroupByOrder(true);
    setFilters(DEFAULT_FILTERS);
    setErrorMessage('');
    setSuccessMessage('');
  };

  const validateSale = (saleInput: SaleInput): string | null => {
    if (!saleInput.date) {
      return 'Date obligatoire.';
    }
    if (!saleInput.client_or_tx.trim()) {
      return 'Client/TX obligatoire.';
    }
    if (!saleInput.product_ref.trim()) {
      return 'Produit obligatoire.';
    }
    if (!saleInput.customer_country.trim()) {
      return 'Pays client obligatoire.';
    }
    if (saleInput.quantity <= 0) {
      return 'Quantite > 0 requise.';
    }
    if (isFranceCustomer(saleInput.customer_country)) {
      if (saleInput.sell_price_unit_ht < 0) {
        return 'Prix vente unit. HT invalide.';
      }
      if (saleInput.shipping_charged < 0) {
        return 'Prix frais de port HT invalide.';
      }
      if (saleInput.shipping_real < 0) {
        return 'Cout frais de port HT invalide.';
      }
    }

    if (isPowerWpRequired(saleInput.channel, saleInput.category)) {
      if (saleInput.power_wp === null || saleInput.power_wp <= 0) {
        return 'power_wp est obligatoire pour Solartraders + Solar Panels.';
      }
    }

    const referencedProduct = catalogMap.get(saleInput.product_ref.trim());
    if (referencedProduct) {
      let available = stock[referencedProduct.ref] ?? 0;
      if (editingSale && editingSale.product_ref === referencedProduct.ref) {
        available += editingSale.quantity;
      }
      if (saleInput.quantity > available) {
        return `Stock insuffisant pour ${referencedProduct.ref} (disponible: ${available}).`;
      }
    }

    return null;
  };

  const handleSubmitSale = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage('');
    setSuccessMessage('');

    const normalizedInput: SaleInput = {
      ...form,
      client_or_tx: form.client_or_tx.trim(),
      product_ref: form.product_ref.trim(),
      customer_country: form.customer_country,
      quantity: Math.max(0, Number(form.quantity)),
      sell_price_unit_ht: Number(form.sell_price_unit_ht),
      sell_price_unit_ttc: isFranceCustomer(form.customer_country)
        ? applyFranceVat(Number(form.sell_price_unit_ht))
        : normalizeNullableNumber(form.sell_price_unit_ttc),
      shipping_charged: Number(form.shipping_charged),
      shipping_charged_ttc: isFranceCustomer(form.customer_country)
        ? applyFranceVat(Number(form.shipping_charged))
        : null,
      shipping_real: Number(form.shipping_real),
      shipping_real_ttc: isFranceCustomer(form.customer_country)
        ? applyFranceVat(Number(form.shipping_real))
        : null,
      buy_price_unit: Number(form.buy_price_unit),
      power_wp: isPowerWpRequired(form.channel, form.category) ? Number(form.power_wp) : null,
    };

    const validationError = validateSale(normalizedInput);
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    if (editingSale) {
      const updatedSale = inputToSale(editingSale.id, normalizedInput, editingSale.created_at);
      setSales((previous) => previous.map((sale) => (sale.id === editingSale.id ? updatedSale : sale)));
      setSuccessMessage('Vente modifiee.');
    } else {
      const newSale = inputToSale(makeId(), normalizedInput);
      setSales((previous) => [newSale, ...previous]);
      setSuccessMessage('Vente ajoutee.');
    }

    setSaleModalOpen(false);
    setEditingSaleId(null);
    setForm(createEmptySaleInput());
  };

  const handleDeleteSale = (saleId: string) => {
    const sale = sales.find((item) => item.id === saleId);
    if (!sale) {
      return;
    }

    if (!window.confirm(`Supprimer la vente ${sale.client_or_tx} ?`)) {
      return;
    }

    setSales((previous) => previous.filter((item) => item.id !== saleId));
  };

  const handleFormAttachmentFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }

    try {
      const newAttachments = await Promise.all(Array.from(files).map((file) => fileToAttachment(file)));
      setForm((previous) => ({
        ...previous,
        attachments: [...previous.attachments, ...newAttachments],
      }));
    } catch {
      setErrorMessage('Impossible de joindre au moins un fichier.');
    }
  };

  const removeFormAttachment = (attachmentId: string) => {
    setForm((previous) => ({
      ...previous,
      attachments: previous.attachments.filter((item) => item.id !== attachmentId),
    }));
  };

  const exportSalesCsv = () => {
    const content = salesToCsv(sales);
    downloadCsv(`sales-margin-tracker-${toIsoDate(new Date())}.csv`, content);
  };

  const exportCatalogCsv = () => {
    const content = catalogToCsv(catalogByOrder, stock);
    downloadCsv(`catalog-stock-${toIsoDate(new Date())}.csv`, content);
  };

  const exportBackup = () => {
    const payload: BackupPayload = buildBackup(sales, catalog, stock);
    writeLocalStorage(STORAGE_KEYS.backup, payload);
    downloadBackupJson(`sales-margin-backup-${toIsoDate(new Date())}.json`, payload);
  };

  const syncCloudNow = async () => {
    if (!cloudEnabled) {
      setErrorMessage('Supabase non configure. Ajoute les variables VITE_SUPABASE_*.');
      return;
    }
    try {
      const payload = buildBackup(sales, catalog, stock);
      const pushedAt = await pushCloudBackup(payload);
      setCloudStatus(`Supabase: sync manuelle OK (${formatDateTime(pushedAt)})`);
      setSuccessMessage('Cloud Supabase synchronise.');
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(`Sync cloud impossible: ${String((error as Error).message)}`);
    }
  };

  const restoreFromCloud = async () => {
    if (!cloudEnabled) {
      setErrorMessage('Supabase non configure. Ajoute les variables VITE_SUPABASE_*.');
      return;
    }
    try {
      const cloudBackup = await pullCloudBackup();
      if (!cloudBackup) {
        setErrorMessage('Aucun backup cloud trouve.');
        return;
      }

      const restoredSales = cloudBackup.sales.map((sale) => {
        const normalized = normalizeSaleFiscalFields(sale);
        return {
          ...sale,
          ...normalized,
          ...computeSale(normalized),
        };
      });
      const restoredCatalog = normalizeCatalog(cloudBackup.catalog);
      const restoredStock =
        cloudBackup.stock && typeof cloudBackup.stock === 'object'
          ? cloudBackup.stock
          : computeStockMap(restoredCatalog, restoredSales);

      setSales(restoredSales);
      setCatalog(restoredCatalog);
      setStock(restoredStock);
      writeLocalStorage(STORAGE_KEYS.sales, restoredSales);
      writeLocalStorage(STORAGE_KEYS.catalog, restoredCatalog);
      writeLocalStorage(STORAGE_KEYS.stock, restoredStock);
      writeLocalStorage(STORAGE_KEYS.backup, cloudBackup);
      setLastBackupAt(cloudBackup.generated_at);
      setCloudStatus(`Supabase: backup cloud restaure (${formatDateTime(cloudBackup.generated_at)})`);
      setSuccessMessage('Backup cloud restaure.');
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(`Restauration cloud impossible: ${String((error as Error).message)}`);
    }
  };

  const handleImportBackup = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }

    const file = files[0];
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Partial<BackupPayload>;

      if (!Array.isArray(parsed.sales)) {
        setErrorMessage('Backup invalide: champ sales manquant.');
        return;
      }

      const importedSales: Sale[] = parsed.sales.map((raw, index) => {
        const fallbackId = `import-${index + 1}-${Date.now()}`;
        const input: SaleInput = {
          date: typeof raw.date === 'string' ? raw.date : toIsoDate(new Date()),
          client_or_tx: typeof raw.client_or_tx === 'string' ? raw.client_or_tx : `Imported-${index + 1}`,
          channel: CHANNELS.includes(raw.channel as Channel) ? (raw.channel as Channel) : 'Other',
          customer_country:
            typeof (raw as Partial<SaleInput>).customer_country === 'string' &&
            (raw as Partial<SaleInput>).customer_country!.length > 0
              ? ((raw as Partial<SaleInput>).customer_country as string)
              : COUNTRY_PLACEHOLDER,
          product_ref: typeof raw.product_ref === 'string' ? raw.product_ref : '',
          quantity: Number(raw.quantity ?? 0),
          sell_price_unit_ht: Number(raw.sell_price_unit_ht ?? 0),
          sell_price_unit_ttc: normalizeNullableNumber((raw as Partial<SaleInput>).sell_price_unit_ttc),
          shipping_charged: Number(raw.shipping_charged ?? 0),
          shipping_charged_ttc: normalizeNullableNumber((raw as Partial<SaleInput>).shipping_charged_ttc),
          shipping_real: Number(raw.shipping_real ?? 0),
          shipping_real_ttc: normalizeNullableNumber((raw as Partial<SaleInput>).shipping_real_ttc),
          payment_method: PAYMENT_METHODS.includes(raw.payment_method as PaymentMethod)
            ? (raw.payment_method as PaymentMethod)
            : 'Wire',
          category: CATEGORIES.includes(raw.category as Category) ? (raw.category as Category) : 'Accessories',
          buy_price_unit: Number(raw.buy_price_unit ?? 0),
          power_wp: raw.power_wp === null || raw.power_wp === undefined ? null : Number(raw.power_wp),
          attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
        };

        return inputToSale(typeof raw.id === 'string' ? raw.id : fallbackId, input, raw.created_at);
      });

      setSales(importedSales);

      if (Array.isArray(parsed.catalog) && parsed.catalog.length > 0) {
        const nextCatalog = parsed.catalog
          .filter((item) => {
            return (
              typeof (item as Partial<CatalogProduct>).ref === 'string' &&
              typeof (item as Partial<CatalogProduct>).buy_price_unit === 'number' &&
              typeof (item as Partial<CatalogProduct>).initial_stock === 'number' &&
              CATEGORIES.includes((item as Partial<CatalogProduct>).category as Category)
            );
          })
          .map((item, index): CatalogProduct => ({
            ref: (item as Partial<CatalogProduct>).ref as string,
            buy_price_unit: (item as Partial<CatalogProduct>).buy_price_unit as number,
            category: (item as Partial<CatalogProduct>).category as Category,
            initial_stock: (item as Partial<CatalogProduct>).initial_stock as number,
            order:
              typeof (item as Partial<CatalogProduct>).order === 'number'
                ? ((item as Partial<CatalogProduct>).order as number)
                : index + 1,
            datasheet_url:
              typeof (item as Partial<CatalogProduct>).datasheet_url === 'string' ||
              (item as Partial<CatalogProduct>).datasheet_url === null
                ? ((item as Partial<CatalogProduct>).datasheet_url as string | null)
                : null,
            source: 'remote',
          }));
        if (nextCatalog.length > 0) {
          setCatalog(normalizeCatalog(nextCatalog));
        }
      }

      setSuccessMessage('Backup JSON importe avec succes.');
      setErrorMessage('');
    } catch {
      setErrorMessage('Import JSON impossible. Verifie le format du fichier.');
    }
  };

  const totalAlertCount = stockRows.filter((row) => row.currentStock <= LOW_STOCK_THRESHOLD).length;

  return (
    <div className={`sm-app theme-${theme}`}>
      <header className="sm-topbar">
        <div className="sm-brand">
          <div className="sm-logo">SM</div>
          <div>
            <p className="sm-title">Huawei Sales Manager</p>
            <p className="sm-subtitle">{catalogStatus}</p>
            <p className="sm-subtitle">
              {lastBackupAt
                ? `Sauvegarde auto locale: ${formatDateTime(lastBackupAt)} (PJ incluses)`
                : 'Sauvegarde auto locale en attente...'}
            </p>
            <p className="sm-subtitle">{cloudStatus}</p>
          </div>
        </div>

        <div className="sm-top-actions">
          <button
            type="button"
            className="sm-icon-btn"
            onClick={() => setTheme((previous) => (previous === 'dark' ? 'light' : 'dark'))}
            title="Toggle theme"
          >
            {theme === 'dark' ? '☀' : '🌙'}
          </button>

          <nav className="sm-tabs">
            <button type="button" className="sm-tab" onClick={goHome}>
              Home
            </button>
            <button
              type="button"
              className={`sm-tab ${activeTab === 'sales' ? 'active' : ''}`}
              onClick={() => setActiveTab('sales')}
            >
              Ventes
            </button>
            <button
              type="button"
              className={`sm-tab ${activeTab === 'dashboard' ? 'active' : ''}`}
              onClick={() => setActiveTab('dashboard')}
            >
              Dashboard
            </button>
            <button
              type="button"
              className={`sm-tab ${activeTab === 'stock' ? 'active' : ''}`}
              onClick={() => setActiveTab('stock')}
            >
              Stock
            </button>
          </nav>
        </div>
      </header>

      {successMessage && <p className="sm-feedback success">{successMessage}</p>}
      {errorMessage && <p className="sm-feedback error">{errorMessage}</p>}

      {activeTab === 'sales' && (
        <section className="sm-panel">
          <div className="sm-toolbar">
            <button type="button" className="sm-primary-btn" onClick={openCreateModal}>
              + Nouvelle vente
            </button>
            <button type="button" className="sm-btn" onClick={exportSalesCsv}>
              CSV ventes
            </button>
            <button type="button" className="sm-btn" onClick={exportCatalogCsv}>
              CSV stock
            </button>
            <button type="button" className="sm-btn" onClick={exportBackup}>
              Backup JSON
            </button>
            <button type="button" className="sm-btn" onClick={() => void syncCloudNow()}>
              Sync Cloud
            </button>
            <button type="button" className="sm-btn" onClick={() => void restoreFromCloud()}>
              Restaurer Cloud
            </button>
            <button
              type="button"
              className="sm-btn"
              onClick={() => importInputRef.current?.click()}
            >
              Importer JSON
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json"
              className="sm-hidden"
              onChange={(event) => {
                void handleImportBackup(event.target.files);
                event.currentTarget.value = '';
              }}
            />
          </div>

          <div className="sm-filters">
            <select
              value={filters.channel}
              onChange={(event) =>
                setFilters((previous) => ({
                  ...previous,
                  channel: event.target.value as Filters['channel'],
                }))
              }
            >
              <option value="All">Tous canaux</option>
              {CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {channel}
                </option>
              ))}
            </select>

            <select
              value={filters.category}
              onChange={(event) =>
                setFilters((previous) => ({
                  ...previous,
                  category: event.target.value as Filters['category'],
                }))
              }
            >
              <option value="All">Toutes categories</option>
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>

            <input
              type="text"
              value={filters.query}
              onChange={(event) =>
                setFilters((previous) => ({
                  ...previous,
                  query: event.target.value,
                }))
              }
              placeholder="Client / TX / produit"
            />

            <input
              type="date"
              value={filters.date_from}
              onChange={(event) =>
                setFilters((previous) => ({
                  ...previous,
                  date_from: event.target.value,
                }))
              }
            />

            <input
              type="date"
              value={filters.date_to}
              onChange={(event) =>
                setFilters((previous) => ({
                  ...previous,
                  date_to: event.target.value,
                }))
              }
            />

            <select
              value={filters.stock_status}
              onChange={(event) =>
                setFilters((previous) => ({
                  ...previous,
                  stock_status: event.target.value as Filters['stock_status'],
                }))
              }
            >
              <option value="all">Tout stock</option>
              <option value="low">Stock faible</option>
              <option value="out">Rupture</option>
            </select>

            <label className="sm-checkbox">
              <input type="checkbox" checked={groupByOrder} onChange={(event) => setGroupByOrder(event.target.checked)} />
              Vue commande
            </label>
          </div>

          <div className="sm-alert-line">
            ⚠ {totalAlertCount} alerte(s) stock
          </div>

          <div className="sm-table-wrap">
            <table className="sm-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Client/TX</th>
                  <th>Canal</th>
                  <th>Produit</th>
                  <th>Qte</th>
                  <th>PV unit HT</th>
                  <th>Total HT</th>
                  <th>Fees Platform / Fees Stripe</th>
                  <th>Net recu</th>
                  <th>Marge nette</th>
                  <th>Marge %</th>
                  <th>PJ</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {groupByOrder
                  ? groupedOrders.map((order) => (
                      <tr key={order.key}>
                        <td>{order.date}</td>
                        <td>
                          {order.customer_country ? `${countryToFlag(order.customer_country)} ` : ''}
                          {order.client_or_tx}
                        </td>
                        <td>
                          <span className="sm-chip">{order.channel}</span>
                        </td>
                        <td>{order.product_display}</td>
                        <td>{order.quantity}</td>
                        <td>{formatMoney(order.sell_price_unit_ht)}</td>
                        <td>{formatMoney(order.sell_total_ht)}</td>
                        <td>
                          {formatMoney(order.commission_eur)} / {formatMoney(order.payment_fee)}
                        </td>
                        <td>{formatMoney(order.net_received)}</td>
                        <td className={order.net_margin >= 0 ? 'ok' : 'ko'}>{formatMoney(order.net_margin)}</td>
                        <td className={order.net_margin_pct >= 0 ? 'ok' : 'ko'}>{formatPercent(order.net_margin_pct)}</td>
                        <td>{order.attachments_count}</td>
                        <td className="sm-row-actions">
                          <button
                            type="button"
                            onClick={() => openCreateLinkedModal(order.first_sale)}
                            title="Ajouter une nouvelle ligne produit sur cette commande"
                          >
                            Ajouter article
                          </button>
                          <button type="button" onClick={() => showOrderLines(order)} title="Voir le detail des lignes">
                            Details
                          </button>
                        </td>
                      </tr>
                    ))
                  : filteredSales.map((sale) => (
                      <tr key={sale.id}>
                        <td>{sale.date}</td>
                        <td>
                          {sale.customer_country ? `${countryToFlag(sale.customer_country)} ` : ''}
                          {sale.client_or_tx}
                        </td>
                        <td>
                          <span className="sm-chip">{sale.channel}</span>
                        </td>
                        <td>{sale.product_ref}</td>
                        <td>{sale.quantity}</td>
                        <td>{formatMoney(sale.sell_price_unit_ht)}</td>
                        <td>{formatMoney(sale.sell_total_ht)}</td>
                        <td>
                          {formatMoney(sale.commission_eur)} / {formatMoney(sale.payment_fee)}
                          <small> ({sale.commission_rate_display})</small>
                        </td>
                        <td>{formatMoney(sale.net_received)}</td>
                        <td className={sale.net_margin >= 0 ? 'ok' : 'ko'}>{formatMoney(sale.net_margin)}</td>
                        <td className={sale.net_margin_pct >= 0 ? 'ok' : 'ko'}>{formatPercent(sale.net_margin_pct)}</td>
                        <td>{sale.attachments.length}</td>
                        <td className="sm-row-actions">
                          <button
                            type="button"
                            onClick={() => openCreateLinkedModal(sale)}
                            title="Ajouter une nouvelle ligne produit pour ce client"
                          >
                            Ajouter article
                          </button>
                          <button type="button" onClick={() => openEditModal(sale)}>
                            Edit
                          </button>
                          <button type="button" onClick={() => handleDeleteSale(sale.id)}>
                            Del
                          </button>
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>

          <div className="sm-kpi-strip">
            <div>
              <p>Ventes affichees</p>
              <strong>{groupByOrder ? groupedOrders.length : kpis.salesCount}</strong>
            </div>
            <div>
              <p>CA total</p>
              <strong>{formatMoney(kpis.totalRevenue)}</strong>
            </div>
            <div>
              <p>Marge nette</p>
              <strong className="ok">
                {formatMoney(kpis.totalNetMargin)} ({formatPercent(kpis.avgNetMarginPct)})
              </strong>
            </div>
            <div>
              <p>Fees Platform / Fees Stripe</p>
              <strong className="warn">
                {formatMoney(kpis.totalCommissions)} / {formatMoney(kpis.totalPlatformFees)}
              </strong>
            </div>
          </div>
        </section>
      )}

      {activeTab === 'dashboard' && (
        <section className="sm-panel">
          <h2 className="sm-section-title">Dashboard KPI</h2>

          <div className="sm-kpi-grid">
            <article className="sm-kpi-card blue">
              <p>Chiffre d affaires</p>
              <strong>{formatMoney(kpis.totalRevenue)}</strong>
            </article>
            <article className="sm-kpi-card green">
              <p>Marge nette totale</p>
              <strong>{formatMoney(kpis.totalNetMargin)}</strong>
            </article>
            <article className="sm-kpi-card yellow">
              <p>Commissions totales</p>
              <strong>{formatMoney(kpis.totalCommissions)}</strong>
            </article>
            <article className="sm-kpi-card purple">
              <p>Taux marge moyen</p>
              <strong>{formatPercent(kpis.avgNetMarginPct)}</strong>
            </article>
            <article className="sm-kpi-card">
              <p>Nombre de ventes</p>
              <strong>{kpis.salesCount}</strong>
            </article>
          </div>

          <div className="sm-table-wrap">
            <table className="sm-table">
              <thead>
                <tr>
                  <th>Canal</th>
                  <th>Ventes</th>
                  <th>CA</th>
                  <th>Commissions</th>
                  <th>Marge nette</th>
                </tr>
              </thead>
              <tbody>
                {kpis.breakdown.map((row) => (
                  <tr key={row.channel}>
                    <td>{row.channel}</td>
                    <td>{row.count}</td>
                    <td>{formatMoney(row.revenue)}</td>
                    <td>{formatMoney(row.commissions)}</td>
                    <td className={row.netMargin >= 0 ? 'ok' : 'ko'}>{formatMoney(row.netMargin)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="sm-dashboard-two-col">
            <article className="sm-card">
              <h3>Top 5 produits (par CA)</h3>
              {topProducts.length === 0 ? (
                <p>Aucun produit.</p>
              ) : (
                <ul className="sm-list">
                  {topProducts.map((item) => (
                    <li key={item.product}>
                      <span>{item.product}</span>
                      <strong>{formatMoney(item.revenue)}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </article>

            <article className="sm-card">
              <h3>Alertes stock</h3>
              {stockAlerts.length === 0 ? (
                <p>Aucune alerte stock.</p>
              ) : (
                <ul className="sm-list">
                  {stockAlerts.map((item) => (
                    <li key={item.ref}>
                      <span>{item.ref}</span>
                      <strong className={item.currentStock <= 0 ? 'ko' : 'warn'}>
                        {item.currentStock} restant(s)
                      </strong>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          </div>

          <article className="sm-card">
            <h3>Marge nette par canal</h3>
            <div className="sm-bars">
              {(() => {
                const maxValue = Math.max(
                  ...kpis.breakdown.map((item) => Math.abs(item.netMargin)),
                  1,
                );
                return kpis.breakdown.map((item) => {
                  const height = Math.max(8, (Math.abs(item.netMargin) / maxValue) * 160);
                  return (
                    <div key={item.channel} className="sm-bar-col">
                      <div
                        className={`sm-bar ${item.netMargin >= 0 ? 'pos' : 'neg'}`}
                        style={{ height: `${height}px` }}
                        title={`${item.channel} ${formatMoney(item.netMargin)}`}
                      />
                      <span>{item.channel}</span>
                      <small>{formatMoney(item.netMargin)}</small>
                    </div>
                  );
                });
              })()}
            </div>
          </article>
        </section>
      )}

      {activeTab === 'stock' && (
        <section className="sm-panel">
          <div className="sm-stock-head">
            <h2 className="sm-section-title">Catalogue & Stock ({stockRows.length})</h2>
            <div className="sm-stock-controls">
              <input
                type="text"
                value={stockQuery}
                onChange={(event) => setStockQuery(event.target.value)}
                placeholder="Recherche reference ou categorie"
              />
              <select
                value={stockCategoryFilter}
                onChange={(event) => setStockCategoryFilter(event.target.value as 'All' | Category)}
              >
                <option value="All">Toutes categories</option>
                {CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
              <label className="sm-checkbox">
                <input
                  type="checkbox"
                  checked={stockOnlyLow}
                  onChange={(event) => setStockOnlyLow(event.target.checked)}
                />
                Stock faible seulement
              </label>
              <button type="button" className="sm-btn" onClick={exportCatalogCsv}>
                Export CSV stock
              </button>
            </div>
          </div>

          <div className="sm-table-wrap">
            <table className="sm-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Reference</th>
                  <th>Categorie</th>
                  <th>PA (EUR)</th>
                  <th>Stock</th>
                  <th>Statut</th>
                  <th>Datasheet</th>
                </tr>
              </thead>
              <tbody>
                {stockRows.map((item, index) => (
                  <tr key={item.ref}>
                    <td>{item.order ?? index + 1}</td>
                    <td>{item.ref}</td>
                    <td>
                      <span className="sm-chip">{item.category}</span>
                    </td>
                    <td>{formatMoney(item.buy_price_unit)}</td>
                    <td>{item.currentStock}</td>
                    <td>
                      <span
                        className={`sm-status ${
                          item.status === 'OK' ? 'ok' : item.status === 'FAIBLE' ? 'warn' : 'ko'
                        }`}
                      >
                        {item.status}
                      </span>
                    </td>
                    <td>
                      {item.datasheet_url ? (
                        <a className="sm-link-btn" href={item.datasheet_url} target="_blank" rel="noopener noreferrer">
                          PDF
                        </a>
                      ) : (
                        <span className="sm-muted">N/A</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="sm-footnote">
            Source catalogue: <a href={CATALOG_SOURCE_URL}>{CATALOG_SOURCE_URL}</a>
          </p>
        </section>
      )}

      {saleModalOpen && (
        <div className="sm-modal-overlay" role="dialog" aria-modal="true">
          <form className="sm-modal" onSubmit={handleSubmitSale}>
            <div className="sm-modal-head">
              <h3>{editingSale ? 'Modifier vente' : 'Nouvelle vente'}</h3>
              <button type="button" className="sm-close" onClick={closeSaleModal}>
                ×
              </button>
            </div>

            <div className="sm-form-grid">
              <label>
                Date
                <input
                  type="date"
                  value={form.date}
                  onChange={(event) => updateForm('date', event.target.value)}
                  required
                />
              </label>

              <label>
                Client / TX
                <input
                  type="text"
                  value={form.client_or_tx}
                  onChange={(event) => updateForm('client_or_tx', event.target.value)}
                  required
                />
              </label>

              <label>
                Pays client
                <select
                  value={form.customer_country}
                  onChange={(event) => {
                    const country = event.target.value;
                    setForm((previous) => ({
                      ...previous,
                      customer_country: country,
                      sell_price_unit_ttc: isFranceCustomer(country)
                        ? applyFranceVat(previous.sell_price_unit_ht)
                        : null,
                      shipping_charged_ttc: isFranceCustomer(country)
                        ? applyFranceVat(previous.shipping_charged)
                        : null,
                      shipping_real_ttc: isFranceCustomer(country) ? applyFranceVat(previous.shipping_real) : null,
                    }));
                  }}
                  required
                >
                  <option value={COUNTRY_PLACEHOLDER} disabled>
                    Selectionner un pays
                  </option>
                  {EUROPEAN_COUNTRIES.map((country) => (
                    <option key={country} value={country}>
                      {countryToFlag(country)} {country}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Canal
                <select
                  value={form.channel}
                  onChange={(event) => {
                    const channel = event.target.value as Channel;
                    setForm((previous) => ({
                      ...previous,
                      channel,
                      power_wp: isPowerWpRequired(channel, previous.category) ? previous.power_wp : null,
                    }));
                  }}
                >
                  {CHANNELS.map((channel) => (
                    <option key={channel} value={channel}>
                      {channel}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Paiement
                <select
                  value={form.payment_method}
                  onChange={(event) => updateForm('payment_method', event.target.value as PaymentMethod)}
                >
                  {PAYMENT_METHODS.map((method) => (
                    <option key={method} value={method}>
                      {method}
                    </option>
                  ))}
                </select>
              </label>

              <label className="full">
                Produit
                <input
                  type="text"
                  value={form.product_ref}
                  onChange={(event) => applyCatalogProduct(event.target.value)}
                  list="catalog-products"
                  placeholder="Rechercher un produit"
                  required
                />
                <datalist id="catalog-products">
                  {sortedCatalog.map((item) => (
                    <option key={item.ref} value={item.ref} />
                  ))}
                </datalist>
                {selectedCatalogProduct && (
                  <small>
                    Auto: {selectedCatalogProduct.category} | PA {formatMoney(selectedCatalogProduct.buy_price_unit)} |
                    Stock {stock[selectedCatalogProduct.ref] ?? selectedCatalogProduct.initial_stock}
                  </small>
                )}
              </label>

              <label>
                Categorie
                <select
                  value={form.category}
                  onChange={(event) => {
                    const category = event.target.value as Category;
                    setForm((previous) => ({
                      ...previous,
                      category,
                      power_wp: isPowerWpRequired(previous.channel, category) ? previous.power_wp : null,
                    }));
                  }}
                >
                  {CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Quantite
                <input
                  type="number"
                  min="1"
                  value={form.quantity}
                  onChange={(event) => updateForm('quantity', Math.max(0, toNumber(event.target.value)))}
                  required
                />
              </label>

              <label>
                Prix achat unit. (EUR)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.buy_price_unit}
                  onChange={(event) => updateForm('buy_price_unit', toNumber(event.target.value))}
                  required
                />
              </label>

              <label>
                Prix vente unit. HT (EUR)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.sell_price_unit_ht}
                  onChange={(event) => {
                    const nextValue = toNumber(event.target.value);
                    setForm((previous) => ({
                      ...previous,
                      sell_price_unit_ht: nextValue,
                      sell_price_unit_ttc: isFranceCustomer(previous.customer_country)
                        ? applyFranceVat(nextValue)
                        : previous.sell_price_unit_ttc,
                    }));
                  }}
                  required
                />
              </label>

              <label>
                Prix vente unit. TTC (EUR)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={isFranceSale ? (franceSellPriceTtc ?? '') : (form.sell_price_unit_ttc ?? '')}
                  onChange={(event) => {
                    if (isFranceSale) {
                      return;
                    }
                    updateForm('sell_price_unit_ttc', toNullableNumber(event.target.value));
                  }}
                  disabled={!isFranceSale}
                  readOnly={isFranceSale}
                  required={false}
                />
                {isFranceSale && <small>Auto TVA France (20%).</small>}
              </label>

              <label>
                Prix frais de port HT (EUR)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.shipping_charged}
                  onChange={(event) => {
                    const nextValue = toNumber(event.target.value);
                    setForm((previous) => ({
                      ...previous,
                      shipping_charged: nextValue,
                      shipping_charged_ttc: isFranceCustomer(previous.customer_country)
                        ? applyFranceVat(nextValue)
                        : previous.shipping_charged_ttc,
                    }));
                  }}
                  required
                />
              </label>

              <label>
                Prix frais de port TTC (EUR)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={isFranceSale ? (franceShippingChargedTtc ?? '') : (form.shipping_charged_ttc ?? '')}
                  onChange={(event) => {
                    if (isFranceSale) {
                      return;
                    }
                    updateForm('shipping_charged_ttc', toNullableNumber(event.target.value));
                  }}
                  disabled={!isFranceSale}
                  readOnly={isFranceSale}
                  required={false}
                />
                {isFranceSale && <small>Auto TVA France (20%).</small>}
              </label>

              <label>
                Cout frais de port HT (EUR)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.shipping_real}
                  onChange={(event) => {
                    const nextValue = toNumber(event.target.value);
                    setForm((previous) => ({
                      ...previous,
                      shipping_real: nextValue,
                      shipping_real_ttc: isFranceCustomer(previous.customer_country)
                        ? applyFranceVat(nextValue)
                        : previous.shipping_real_ttc,
                    }));
                  }}
                  required
                />
              </label>

              <label>
                Cout frais de port TTC (EUR)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={isFranceSale ? (franceShippingRealTtc ?? '') : (form.shipping_real_ttc ?? '')}
                  onChange={(event) => {
                    if (isFranceSale) {
                      return;
                    }
                    updateForm('shipping_real_ttc', toNullableNumber(event.target.value));
                  }}
                  disabled={!isFranceSale}
                  readOnly={isFranceSale}
                  required={false}
                />
                {isFranceSale && <small>Auto TVA France (20%).</small>}
              </label>

              {isPowerWpRequired(form.channel, form.category) && (
                <label>
                  power_wp (obligatoire)
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={form.power_wp ?? ''}
                    onChange={(event) => updateForm('power_wp', toNumber(event.target.value))}
                    required
                  />
                </label>
              )}
            </div>

            <div className="sm-metric-grid">
              <p>
                <span>Total HT</span>
                <strong>{formatMoney(previewComputed.sell_total_ht)}</strong>
              </p>
              <p>
                <span>Valeur TX</span>
                <strong>{formatMoney(previewComputed.transaction_value)}</strong>
              </p>
              <p>
                <span>Commission</span>
                <strong>
                  {formatMoney(previewComputed.commission_eur)} ({previewComputed.commission_rate_display})
                </strong>
              </p>
              <p>
                <span>Frais paiement</span>
                <strong>{formatMoney(previewComputed.payment_fee)}</strong>
              </p>
              <p>
                <span>Net recu</span>
                <strong>{formatMoney(previewComputed.net_received)}</strong>
              </p>
              <p>
                <span>Cout total</span>
                <strong>{formatMoney(previewComputed.total_cost)}</strong>
              </p>
              <p>
                <span>Marge brute</span>
                <strong>{formatMoney(previewComputed.gross_margin)}</strong>
              </p>
              <p>
                <span>Marge nette</span>
                <strong className={previewComputed.net_margin >= 0 ? 'ok' : 'ko'}>
                  {formatMoney(previewComputed.net_margin)} ({formatPercent(previewComputed.net_margin_pct)})
                </strong>
              </p>
            </div>

            <div className="sm-attachments">
              <div className="sm-attach-head">
                <span>Pieces jointes</span>
                <input
                  type="file"
                  multiple
                  onChange={(event) => {
                    void handleFormAttachmentFiles(event.target.files);
                    event.currentTarget.value = '';
                  }}
                />
              </div>
              {form.attachments.length === 0 ? (
                <p className="sm-muted">Aucune PJ.</p>
              ) : (
                form.attachments.map((attachment) => (
                  <div key={attachment.id} className="sm-attach-row">
                    <span>
                      {attachment.name} ({Math.round(attachment.size / 1024)} KB)
                    </span>
                    <div>
                      <button type="button" onClick={() => downloadAttachment(attachment)}>
                        Download
                      </button>
                      <button type="button" onClick={() => removeFormAttachment(attachment.id)}>
                        Supprimer
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="sm-modal-actions">
              <button type="button" className="sm-btn" onClick={closeSaleModal}>
                Annuler
              </button>
              <button type="submit" className="sm-primary-btn">
                {editingSale ? 'Enregistrer' : 'Ajouter'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
