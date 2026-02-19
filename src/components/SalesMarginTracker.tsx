import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CATALOG_SOURCE_URL, fetchRemoteCatalog, normalizeCatalog } from '../lib/catalog';
import { computeSale, isPowerWpRequired, round2 } from '../lib/calculations';
import { catalogToCsv, downloadBackupJson, downloadCsv, salesToCsv } from '../lib/exports';
import { createSeedSales } from '../lib/seed';
import { LOW_STOCK_THRESHOLD, computeStockMap } from '../lib/stock';
import { STORAGE_KEYS, buildBackup, readLocalStorage, writeLocalStorage } from '../lib/storage';
import {
  deletePushSubscription,
  isSupabaseConfigured,
  isWebPushClientConfigured,
  pullChatMessages,
  pullCloudBackupWithMeta,
  pullCloudUpdatedAt,
  pushChatMessage,
  pushCloudBackup,
  savePushSubscription,
  sendPushNotificationForChat,
  clearSupabaseStoreId,
  getSupabaseStoreId,
  hasSupabaseStoreId,
  setSupabaseStoreId,
  supabaseAnonKey,
  supabaseMessagesTable,
  supabaseUrl,
  webPushPublicKey,
} from '../lib/supabase';
import type {
  Attachment,
  BackupPayload,
  CatalogProduct,
  ChatMessage,
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
const SHIPPING_STATUS_OPTIONS = [
  'label_created',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'exception',
  'cancelled',
];
const EUROPEAN_COUNTRY_OPTIONS = [
  { iso: 'AL', name: 'Albanie' },
  { iso: 'DE', name: 'Allemagne' },
  { iso: 'AD', name: 'Andorre' },
  { iso: 'AM', name: 'Armenie' },
  { iso: 'AT', name: 'Autriche' },
  { iso: 'AZ', name: 'Azerbaidjan' },
  { iso: 'BE', name: 'Belgique' },
  { iso: 'BY', name: 'Bielorussie' },
  { iso: 'BA', name: 'Bosnie-Herzegovine' },
  { iso: 'BG', name: 'Bulgarie' },
  { iso: 'CY', name: 'Chypre' },
  { iso: 'HR', name: 'Croatie' },
  { iso: 'DK', name: 'Danemark' },
  { iso: 'ES', name: 'Espagne' },
  { iso: 'EE', name: 'Estonie' },
  { iso: 'FI', name: 'Finlande' },
  { iso: 'FR', name: 'France' },
  { iso: 'GE', name: 'Georgie' },
  { iso: 'GR', name: 'Grece' },
  { iso: 'HU', name: 'Hongrie' },
  { iso: 'IE', name: 'Irlande' },
  { iso: 'IS', name: 'Islande' },
  { iso: 'IT', name: 'Italie' },
  { iso: 'XK', name: 'Kosovo' },
  { iso: 'LV', name: 'Lettonie' },
  { iso: 'LI', name: 'Liechtenstein' },
  { iso: 'LT', name: 'Lituanie' },
  { iso: 'LU', name: 'Luxembourg' },
  { iso: 'MK', name: 'Macedoine du Nord' },
  { iso: 'MT', name: 'Malte' },
  { iso: 'MD', name: 'Moldavie' },
  { iso: 'MC', name: 'Monaco' },
  { iso: 'ME', name: 'Montenegro' },
  { iso: 'NO', name: 'Norvege' },
  { iso: 'NL', name: 'Pays-Bas' },
  { iso: 'PL', name: 'Pologne' },
  { iso: 'PT', name: 'Portugal' },
  { iso: 'CZ', name: 'Republique tcheque' },
  { iso: 'RO', name: 'Roumanie' },
  { iso: 'GB', name: 'Royaume-Uni' },
  { iso: 'RU', name: 'Russie' },
  { iso: 'SM', name: 'Saint-Marin' },
  { iso: 'RS', name: 'Serbie' },
  { iso: 'SK', name: 'Slovaquie' },
  { iso: 'SI', name: 'Slovenie' },
  { iso: 'SE', name: 'Suede' },
  { iso: 'CH', name: 'Suisse' },
  { iso: 'TR', name: 'Turquie' },
  { iso: 'UA', name: 'Ukraine' },
  { iso: 'VA', name: 'Vatican' },
] as const;
const THEME_STORAGE_KEY = 'sales_margin_tracker_theme_v1';
const FRANCE_ISO = 'FR';
const FRANCE_VAT_RATE = 0.2;
const SUN_STORE_STRIPE_ORDER_FEE = 5;
const COUNTRY_PLACEHOLDER = '';
const HARD_REFRESH_QUERY_KEY = '__hr';
const CHAT_AUTHOR_STORAGE_KEY = 'sales_margin_tracker_chat_author_v1';
const CHAT_DEVICE_STORAGE_KEY = 'sales_margin_tracker_chat_device_id_v1';
const CHAT_LAST_SEEN_STORAGE_KEY = 'sales_margin_tracker_chat_last_seen_v1';
const DESKTOP_NOTIFS_STORAGE_KEY = 'sales_margin_tracker_desktop_notifs_enabled_v1';
const CLOUD_AUTO_SYNC_STORAGE_KEY = 'sales_margin_tracker_cloud_auto_sync_v1';
const CHAT_POLL_INTERVAL_MS = 5000;
const CHAT_ACTIVE_MENTION_REGEX = /(?:^|\s)@([A-Za-z0-9._/-]*)$/;
const CHAT_MESSAGE_MENTION_REGEX = /(@[A-Za-z0-9][A-Za-z0-9._/-]*)/g;
const POWER_WP_FROM_REF_REGEX = /(\d{2,5})(?:\s*)W(?:P)?\b/i;
const COUNTRY_NAME_BY_ISO: Record<string, string> = Object.fromEntries(
  EUROPEAN_COUNTRY_OPTIONS.map((option) => [option.iso, option.name])
);
const COUNTRY_ALIAS_TO_ISO: Record<string, string> = (() => {
  const aliases: Record<string, string> = {};
  for (const option of EUROPEAN_COUNTRY_OPTIONS) {
    aliases[option.iso.toLowerCase()] = option.iso;
    aliases[option.name.toLowerCase()] = option.iso;
  }
  // Common aliases observed from scrapers / PDFs (English).
  aliases['germany'] = 'DE';
  aliases['italy'] = 'IT';
  aliases['france'] = 'FR';
  aliases['netherlands'] = 'NL';
  aliases['spain'] = 'ES';
  aliases['belgium'] = 'BE';
  aliases['switzerland'] = 'CH';
  aliases['austria'] = 'AT';
  aliases['portugal'] = 'PT';
  aliases['poland'] = 'PL';
  aliases['romania'] = 'RO';
  aliases['czech republic'] = 'CZ';
  aliases['united kingdom'] = 'GB';
  aliases['uk'] = 'GB';
  return aliases;
})();

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
  transaction_ref: '',
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
  tracking_numbers: [],
  shipping_provider: null,
  shipping_status: null,
  shipping_cost_source: 'manual',
  shipping_event_at: null,
  shipping_tracking_url: null,
  shipping_label_url: null,
  shipping_proof_url: null,
  invoice_url: null,
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

const inferPowerWpFromRef = (productRef: string, quantity: number): number | null => {
  const safeRef = productRef.trim();
  if (!safeRef) {
    return null;
  }
  const match = safeRef.match(POWER_WP_FROM_REF_REGEX);
  if (!match) {
    return null;
  }
  const unitWp = Number(match[1]);
  const qty = Math.max(0, Number(quantity));
  if (!Number.isFinite(unitWp) || unitWp <= 0 || !Number.isFinite(qty) || qty <= 0) {
    return null;
  }
  return round2(unitWp * qty);
};

const allocateAmountByWeight = (total: number, weights: number[]): number[] => {
  if (weights.length === 0) {
    return [];
  }
  const safeTotal = round2(Number.isFinite(total) ? total : 0);
  const totalCents = Math.round(safeTotal * 100);
  if (totalCents === 0) {
    return weights.map(() => 0);
  }

  const positiveWeights = weights.map((weight) => (weight > 0 ? weight : 0));
  const sumWeights = positiveWeights.reduce((sum, weight) => sum + weight, 0);
  const normalizedWeights = sumWeights > 0 ? positiveWeights : weights.map(() => 1);
  const normalizedWeightSum = normalizedWeights.reduce((sum, weight) => sum + weight, 0);

  const rawAllocations = normalizedWeights.map((weight) => (totalCents * weight) / normalizedWeightSum);
  const baseAllocations = rawAllocations.map((raw) => Math.floor(raw));
  let remaining = totalCents - baseAllocations.reduce((sum, value) => sum + value, 0);

  const byRemainder = rawAllocations
    .map((raw, index) => ({ index, remainder: raw - baseAllocations[index] }))
    .sort((a, b) => b.remainder - a.remainder);

  for (let i = 0; i < byRemainder.length && remaining > 0; i += 1) {
    baseAllocations[byRemainder[i].index] += 1;
    remaining -= 1;
  }

  return baseAllocations.map((cents) => round2(cents / 100));
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
  transaction_ref: sale.transaction_ref ?? '',
  channel: sale.channel,
  customer_country: normalizeCountryIso(sale.customer_country) || COUNTRY_PLACEHOLDER,
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
  tracking_numbers: Array.isArray(sale.tracking_numbers) ? sale.tracking_numbers : [],
  shipping_provider: sale.shipping_provider ?? null,
  shipping_status: sale.shipping_status ?? null,
  shipping_cost_source: sale.shipping_cost_source ?? 'manual',
  shipping_event_at: sale.shipping_event_at ?? null,
  shipping_tracking_url: sale.shipping_tracking_url ?? null,
  shipping_label_url: sale.shipping_label_url ?? null,
  shipping_proof_url: sale.shipping_proof_url ?? null,
  invoice_url: sale.invoice_url ?? null,
});

const saleToLinkedInput = (sale: Sale): SaleInput => ({
  date: sale.date,
  client_or_tx: sale.client_or_tx,
  transaction_ref: sale.transaction_ref ?? '',
  channel: sale.channel,
  customer_country: normalizeCountryIso(sale.customer_country) || COUNTRY_PLACEHOLDER,
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
  tracking_numbers: [],
  shipping_provider: null,
  shipping_status: null,
  shipping_cost_source: 'manual',
  shipping_event_at: null,
  shipping_tracking_url: null,
  shipping_label_url: null,
  shipping_proof_url: null,
  invoice_url: null,
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

const base64ToBlob = (base64: string, mime: string): Blob => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
};

const base64UrlToArrayBuffer = (value: string): ArrayBuffer => {
  const normalized = `${value}`.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const base64 = normalized + padding;
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output.buffer as ArrayBuffer;
};

const isPdfAttachment = (attachment: Attachment): boolean =>
  attachment.mime === 'application/pdf' || attachment.name.toLowerCase().endsWith('.pdf');
const isImageAttachment = (attachment: Attachment): boolean => attachment.mime.startsWith('image/');

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

const normalizeOptionalText = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const sanitizeTrackingNumber = (value: string): string => {
  const cleaned = value.trim().replace(/\s+/g, '').toUpperCase();
  if (!cleaned) {
    return '';
  }
  // Ignore placeholders from manual tests / invalid stubs.
  if (cleaned.includes('TEST')) {
    return '';
  }
  if (/^X{6,}$/.test(cleaned)) {
    return '';
  }
  if (/^1ZX{6,}$/.test(cleaned)) {
    return '';
  }
  if (cleaned.length < 8) {
    return '';
  }
  if (!/[0-9]/.test(cleaned) || !/[A-Z]/.test(cleaned)) {
    return '';
  }
  return cleaned;
};

const normalizeCatalogRefInput = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  // Accept accidental pasted labels like "SUN2000-10K-LC0 | Inverters | PA 610,15".
  const [head] = trimmed.split('|');
  return (head ?? '').trim();
};

const normalizeTrackingNumbers = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const numbers = value
    .map((item) => (typeof item === 'string' ? sanitizeTrackingNumber(item) : ''))
    .filter((item) => item.length > 0);
  return Array.from(new Set(numbers));
};

const parseTrackingNumbersFromInput = (value: string): string[] =>
  Array.from(
    new Set(
      value
        .split(/[,\n;]+/)
        .map((item) => sanitizeTrackingNumber(item))
        .filter((item) => item.length > 0),
    ),
  );

const buildTrackingUrl = (provider: string | null | undefined, trackingNumber: string): string => {
  const normalized = trackingNumber.trim();
  if (!normalized) {
    return '#';
  }
  const encoded = encodeURIComponent(normalized);
  const providerKey = (provider ?? '').toLowerCase();

  if (providerKey.includes('ups')) {
    return `https://www.ups.com/track?loc=fr_FR&tracknum=${encoded}`;
  }
  if (providerKey.includes('dhl')) {
    return `https://www.dhl.com/fr-fr/home/tracking/tracking-express.html?tracking-id=${encoded}`;
  }
  if (providerKey.includes('fedex')) {
    return `https://www.fedex.com/fedextrack/?trknbr=${encoded}`;
  }
  return `https://www.17track.net/fr/track#nums=${encoded}`;
};

const normalizeShippingStatus = (value: string | null | undefined): string | null => {
  const raw = (value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw.includes('livr')) return 'delivered';
  if (raw.includes('in_transit') || raw.includes('transit') || raw.includes('route')) return 'in_transit';
  if (raw.includes('delivery') || raw.includes('livraison')) return 'out_for_delivery';
  if (raw.includes('label') || raw.includes('etiquette')) return 'label_created';
  if (raw.includes('cancel')) return 'cancelled';
  if (raw.includes('exception') || raw.includes('failed') || raw.includes('retour')) return 'exception';
  return raw;
};

const formatShippingStatus = (value: string | null | undefined): string => {
  const status = normalizeShippingStatus(value);
  if (!status) return '-';
  switch (status) {
    case 'label_created':
      return 'Etiquette creee';
    case 'in_transit':
      return 'En transit';
    case 'out_for_delivery':
      return 'En livraison';
    case 'delivered':
      return 'Livre';
    case 'exception':
      return 'Exception';
    case 'cancelled':
      return 'Annule';
    default:
      return status.replace(/_/g, ' ');
  }
};

const buildTransactionDisplay = (transactionRef: string, orderNumber: string | null | undefined): string => {
  const tx = transactionRef.trim();
  const cc = (orderNumber ?? '').trim();
  if (tx && cc && tx.toLowerCase() !== cc.toLowerCase()) {
    return `${tx} / ${cc}`;
  }
  return tx || cc || '-';
};

const renderTrackingLinks = (
  trackingNumbers: unknown,
  provider: string | null | undefined,
): ReactNode => {
  const normalized = normalizeTrackingNumbers(trackingNumbers);
  if (normalized.length === 0) {
    return '-';
  }
  const visible = normalized.slice(0, 2);
  return (
    <span className="sm-track-links">
      {visible.map((tracking, index) => (
        <span key={tracking}>
          {index > 0 ? ', ' : ''}
          <a
            className="sm-track-link"
            href={buildTrackingUrl(provider, tracking)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            {tracking}
          </a>
        </span>
      ))}
      {normalized.length > 2 ? ` +${normalized.length - 2}` : ''}
    </span>
  );
};

const renderTrackingMeta = (
  provider: string | null | undefined,
  status: string | null | undefined,
  eventAt: string | null | undefined,
  proofUrl?: string | null | undefined,
  trackingNumbers?: unknown,
  trackingUrl?: string | null | undefined,
  showTime = true,
): ReactNode => {
  const hasTrackingContext =
    normalizeTrackingNumbers(trackingNumbers).length > 0 ||
    Boolean(toSafeUrl(trackingUrl)) ||
    Boolean(toSafeUrl(proofUrl));
  if (!hasTrackingContext) {
    return null;
  }

  const parts: string[] = [];
  const providerText = normalizeOptionalText(provider);
  if (providerText) {
    parts.push(providerText);
  }
  const effectiveStatus = toSafeUrl(proofUrl) ? 'delivered' : status;
  const statusText = formatShippingStatus(effectiveStatus);
  if (statusText !== '-') {
    parts.push(statusText);
  }
  if (parts.length === 0 && !eventAt) {
    return null;
  }
  return (
    <div className="sm-track-meta">
      {parts.join(' / ')}
      {showTime && eventAt ? <span className="sm-track-time">{formatDateTime(eventAt)}</span> : null}
    </div>
  );
};

const renderShippingDocLinks = (
  trackingUrl: string | null | undefined,
  labelUrl: string | null | undefined,
  proofUrl: string | null | undefined,
  invoiceUrl?: string | null | undefined,
  trackingNumbers?: unknown,
  provider?: string | null | undefined,
): ReactNode => {
  const normalizedTrackingUrl = toSafeUrl(trackingUrl);
  const normalizedTrackingNumbers = normalizeTrackingNumbers(trackingNumbers);
  const fallbackTrackingUrl =
    normalizedTrackingUrl ??
    (normalizedTrackingNumbers.length > 0 ? buildTrackingUrl(provider, normalizedTrackingNumbers[0]) : null);

  const links = [
    { label: 'Suivi', href: fallbackTrackingUrl },
    { label: 'Etiquette', href: toSafeUrl(labelUrl) },
    { label: 'Preuve', href: toSafeUrl(proofUrl) },
    { label: 'Facture', href: toSafeUrl(invoiceUrl) },
  ].filter((item) => Boolean(item.href)) as { label: string; href: string }[];

  if (links.length === 0) {
    return null;
  }

  return (
    <div className="sm-track-doc-links">
      {links.map((item) => (
        <a
          key={item.label}
          href={item.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
        >
          {item.label}
        </a>
      ))}
    </div>
  );
};

const normalizeCountryIso = (raw: unknown): string => {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    return '';
  }

  const upper = value.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper) && COUNTRY_NAME_BY_ISO[upper]) {
    return upper;
  }

  const mapped = COUNTRY_ALIAS_TO_ISO[value.toLowerCase()];
  return mapped ?? '';
};

const isFranceCustomer = (countryIso: string): boolean => normalizeCountryIso(countryIso) === FRANCE_ISO;
const applyFranceVat = (htAmount: number): number => round2(htAmount * (1 + FRANCE_VAT_RATE));

const isoCodeToFlag = (isoCode: string): string => {
  const code = isoCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    return '🏳️';
  }
  return String.fromCodePoint(...Array.from(code).map((char) => 127397 + char.charCodeAt(0)));
};

const countryToFlag = (country: string): string => {
  const iso = normalizeCountryIso(country);
  return iso ? isoCodeToFlag(iso) : '🏳️';
};

const extractZohoOrderNumber = (saleId: string): string | null => {
  const match = saleId.match(/^zoho-([a-z]{2}-\d+)-/i);
  return match?.[1] ? match[1].toUpperCase() : null;
};

const toSafeUrl = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
};

const fileNameFromUrl = (url: string, fallback: string): string => {
  try {
    const parsed = new URL(url);
    const raw = decodeURIComponent(parsed.pathname.split('/').pop() ?? '');
    if (raw.trim()) {
      return raw.trim();
    }
  } catch {
    // Ignore invalid URL parse; fallback below.
  }
  return fallback;
};

const inferCustomerCountry = (sale: Sale): string => {
  if (typeof sale.customer_country === 'string' && sale.customer_country.length > 0) {
    const normalized = normalizeCountryIso(sale.customer_country);
    if (normalized) {
      return normalized;
    }
  }
  // Backward compatibility: historical rows with TTC values are considered France orders.
  if (
    normalizeNullableNumber(sale.sell_price_unit_ttc) !== null ||
    normalizeNullableNumber(sale.shipping_charged_ttc) !== null ||
    normalizeNullableNumber(sale.shipping_real_ttc) !== null
  ) {
    return FRANCE_ISO;
  }
  return COUNTRY_PLACEHOLDER;
};

const buildOrderProductDisplay = (refs: string[]): string => {
  const uniqueRefs = refs.filter((ref, index) => refs.indexOf(ref) === index);
  if (uniqueRefs.length === 0) {
    return '-';
  }
  if (uniqueRefs.length === 1) {
    return `1 ref: ${uniqueRefs[0]}`;
  }
  const preview = uniqueRefs.slice(0, 2).join(' + ');
  const remaining = uniqueRefs.length - 2;
  return remaining > 0
    ? `${uniqueRefs.length} refs: ${preview} +${remaining}`
    : `${uniqueRefs.length} refs: ${preview}`;
};

const TX_REF_REGEX = /(?:^|\\b)transaction\\s*#\\s*([A-Za-z0-9_-]{4,})\\b/i;
const HASH_TAG_REF_REGEX = /#([A-Za-z0-9_-]{4,})\\b/;
const ORDER_CODE_REGEX = /\\b([A-Z]{2,5}-\\d{3,10})\\b/;

const simpleHash32 = (input: string): number => {
  // Deterministic, fast (not crypto). Used only to create stable AUTO transaction ids.
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const AUTO_TX_REF_REGEX = /^AUTO-(\d{4}-\d{2}-\d{2})-([A-Z]{3})-([a-z0-9]{3,})(?:-(\d+))?$/i;

const inferTransactionRefFromAttachments = (attachments: Attachment[]): string => {
  for (const attachment of attachments) {
    const match = attachment.name.match(ORDER_CODE_REGEX);
    if (match?.[1]) {
      return match[1];
    }
  }
  return '';
};

const normalizeTransactionRef = (raw: unknown, channel: Channel): string => {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    return '';
  }
  const autoMatch = value.match(AUTO_TX_REF_REGEX);
  if (!autoMatch) {
    return value;
  }

  const [, date, tagRaw, hashRaw] = autoMatch;
  const tag = tagRaw.toUpperCase();
  const hash = hashRaw.toLowerCase();
  // For Direct/Other we never want multiple clusters: it creates confusing "split orders".
  if (channel === 'Direct' || channel === 'Other') {
    return `AUTO-${date}-${tag}-${hash}`;
  }
  return value;
};

const extractTransactionRef = (clientOrTx: string): string => {
  const raw = clientOrTx.trim();
  if (!raw) {
    return '';
  }
  const txMatch = raw.match(TX_REF_REGEX);
  if (txMatch?.[1]) {
    return `#${txMatch[1]}`;
  }
  const hashMatch = raw.match(HASH_TAG_REF_REGEX);
  if (hashMatch?.[1]) {
    return `#${hashMatch[1]}`;
  }
  const orderMatch = raw.match(ORDER_CODE_REGEX);
  if (orderMatch?.[1]) {
    return orderMatch[1];
  }
  return '';
};

const normalizeChannelTag = (channel: Channel): string => {
  switch (channel) {
    case 'Sun.store':
      return 'SUN';
    case 'Solartraders':
      return 'SOL';
    case 'Direct':
      return 'DIR';
    default:
      return 'OTH';
  }
};

const migrateMissingTransactionRefs = (sales: Sale[]): Sale[] => {
  const cloned = sales.map((sale) => ({ ...sale }));
  const pendingIndexes: number[] = [];

  for (let i = 0; i < cloned.length; i += 1) {
    const sale = cloned[i];
    sale.transaction_ref = normalizeTransactionRef(sale.transaction_ref, sale.channel);
    const existingTx = typeof sale.transaction_ref === 'string' ? sale.transaction_ref.trim() : '';
    if (existingTx) {
      // If we have a Direct/Other AUTO tx id but a clear order code in attachments, prefer the order code.
      if ((sale.channel === 'Direct' || sale.channel === 'Other') && existingTx.startsWith('AUTO-')) {
        const attachmentTx = inferTransactionRefFromAttachments(sale.attachments ?? []);
        if (attachmentTx) {
          sale.transaction_ref = attachmentTx;
        }
      }
      continue;
    }
    const extracted = extractTransactionRef(String(sale.client_or_tx ?? ''));
    if (extracted) {
      sale.transaction_ref = extracted;
      continue;
    }
    const attachmentTx = inferTransactionRefFromAttachments(sale.attachments ?? []);
    if (attachmentTx) {
      sale.transaction_ref = attachmentTx;
      continue;
    }
    pendingIndexes.push(i);
  }

  if (pendingIndexes.length === 0) {
    return cloned;
  }

  // Fill missing tx refs by (date + client + channel). We intentionally avoid "time clustering":
  // it creates multiple orders for the same customer on the same day (confusing for Direct).
  const groups = new Map<string, number[]>();
  for (const idx of pendingIndexes) {
    const sale = cloned[idx];
    const date = typeof sale.date === 'string' ? sale.date : '';
    const client = String(sale.client_or_tx ?? '').trim();
    const key = `${date}::${client}::${sale.channel}`;
    const list = groups.get(key) ?? [];
    list.push(idx);
    groups.set(key, list);
  }

  for (const [key, indexes] of groups.entries()) {
    const [date, client, channelRaw] = key.split('::');
    const channel = (CHANNELS.includes(channelRaw as Channel) ? (channelRaw as Channel) : 'Other') as Channel;
    const tag = normalizeChannelTag(channel);
    const clientHash = simpleHash32(client).toString(36).slice(0, 6);
    const txRef = `AUTO-${date}-${tag}-${clientHash}`;
    for (const idx of indexes) {
      cloned[idx].transaction_ref = txRef;
    }
  }

  return cloned;
};

const normalizeSaleFiscalFields = (sale: Sale): SaleInput => ({
  ...sale,
  transaction_ref: typeof sale.transaction_ref === 'string' ? sale.transaction_ref : '',
  customer_country: inferCustomerCountry(sale),
  sell_price_unit_ttc: isFranceCustomer(inferCustomerCountry(sale))
    ? applyFranceVat(sale.sell_price_unit_ht)
    : normalizeNullableNumber(sale.sell_price_unit_ttc),
  shipping_charged_ttc: isFranceCustomer(inferCustomerCountry(sale))
    ? applyFranceVat(sale.shipping_charged)
    : normalizeNullableNumber(sale.shipping_charged_ttc),
  shipping_real_ttc: isFranceCustomer(inferCustomerCountry(sale))
    ? applyFranceVat(sale.shipping_real)
    : normalizeNullableNumber(sale.shipping_real_ttc),
  tracking_numbers: normalizeTrackingNumbers(sale.tracking_numbers),
  shipping_provider: normalizeOptionalText(sale.shipping_provider),
  shipping_status: normalizeShippingStatus(normalizeOptionalText(sale.shipping_status)),
  shipping_cost_source: normalizeOptionalText(sale.shipping_cost_source) ?? 'manual',
  shipping_event_at: normalizeOptionalText(sale.shipping_event_at),
  shipping_tracking_url: toSafeUrl(sale.shipping_tracking_url),
  shipping_label_url: toSafeUrl(sale.shipping_label_url),
  shipping_proof_url: toSafeUrl(sale.shipping_proof_url),
  invoice_url: toSafeUrl(sale.invoice_url),
});

const parseStoredSales = (): Sale[] => {
  const stored = readLocalStorage<Sale[]>(STORAGE_KEYS.sales, []);
  if (stored.length > 0) {
    const migrated = migrateMissingTransactionRefs(stored);
    return migrated.map((sale) => {
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
    const migrated = migrateMissingTransactionRefs(backup.sales as Sale[]);
    return migrated.map((sale) => {
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
  transaction_ref: string;
  order_number: string;
  customer_country: string;
  channel: Channel;
  tracking_numbers: string[];
  shipping_provider: string | null;
  shipping_status: string | null;
  shipping_event_at: string | null;
  shipping_tracking_url: string | null;
  shipping_label_url: string | null;
  shipping_proof_url: string | null;
  invoice_url: string | null;
  refs_count: number;
  product_display: string;
  low_stock_refs: string[];
  out_stock_refs: string[];
  quantity: number;
  sell_price_unit_ht: number;
  sell_total_ht: number;
  transaction_value: number;
  commission_eur: number;
  payment_fee: number;
  net_received: number;
  net_margin: number;
  net_margin_pct: number;
  attachments_count: number;
  first_sale: Sale;
}

interface OrderEditLine {
  id: string;
  product_ref: string;
  category: Category;
  quantity: number;
  buy_price_unit: number;
  sell_price_unit_ht: number;
  shipping_charged: number;
  shipping_real: number;
  power_wp: number | null;
}

interface OrderEditForm {
  date: string;
  client_or_tx: string;
  transaction_ref: string;
  order_number: string;
  channel: Channel;
  customer_country: string;
  payment_method: PaymentMethod;
  tracking_numbers: string[];
  shipping_provider: string | null;
  shipping_status: string | null;
  shipping_event_at: string | null;
  shipping_tracking_url: string | null;
  shipping_label_url: string | null;
  shipping_proof_url: string | null;
  invoice_url: string | null;
  shipping_charged_order: number;
  shipping_real_order: number;
  attachments: Attachment[];
  source_sale_ids: string[];
  lines: OrderEditLine[];
}

type ConfirmTone = 'danger' | 'warn';

interface ConfirmDialogState {
  title: string;
  message: string;
  confirmLabel: string;
  tone: ConfirmTone;
  onConfirm: () => void;
}

interface BackupSummary {
  generated_at: string;
  sales_lines: number;
  orders: number;
  revenue: number;
  net_margin: number;
}

interface CloudConflictState {
  local: BackupPayload;
  cloud: BackupPayload;
  cloud_updated_at: string;
  local_summary: BackupSummary;
  cloud_summary: BackupSummary;
}

const CONFIRM_TONE_META: Record<ConfirmTone, { icon: string; subtitle: string }> = {
  danger: {
    icon: '!',
    subtitle: 'Action irreversible. Verifiez avant de continuer.',
  },
  warn: {
    icon: '!',
    subtitle: 'Veuillez confirmer cette operation.',
  },
};

const summarizeBackupPayload = (backup: BackupPayload): BackupSummary => {
  const migratedSales = migrateMissingTransactionRefs((backup.sales ?? []) as Sale[]);
  const orderKeys = new Set<string>();
  let revenue = 0;
  let netMargin = 0;
  for (const sale of migratedSales) {
    const date = typeof sale.date === 'string' ? sale.date : '';
    const client = String(sale.client_or_tx ?? '').trim();
    const tx = String(sale.transaction_ref ?? '').trim();
    const channel = CHANNELS.includes(sale.channel as Channel) ? (sale.channel as Channel) : 'Other';
    orderKeys.add(`${date}::${client}::${tx}::${channel}`);
    const txValue = Number(sale.transaction_value ?? 0);
    if (Number.isFinite(txValue)) {
      revenue += txValue;
    }
    const nm = Number(sale.net_margin ?? 0);
    if (Number.isFinite(nm)) {
      netMargin += nm;
    }
  }
  return {
    generated_at: typeof backup.generated_at === 'string' ? backup.generated_at : '',
    sales_lines: migratedSales.length,
    orders: orderKeys.size,
    revenue: round2(revenue),
    net_margin: round2(netMargin),
  };
};

export function SalesMarginTracker() {
  const cloudBackendAvailable = isSupabaseConfigured;
  const [cloudStoreId, setCloudStoreId] = useState<string>(() => getSupabaseStoreId());
  const cloudEnabled = cloudBackendAvailable && cloudStoreId.length > 0;
  const [cloudKeyModalOpen, setCloudKeyModalOpen] = useState<boolean>(false);
  const [cloudKeyDraft, setCloudKeyDraft] = useState<string>(() => cloudStoreId);
  const [cloudAutoSyncEnabled, setCloudAutoSyncEnabled] = useState<boolean>(() =>
    readLocalStorage<boolean>(CLOUD_AUTO_SYNC_STORAGE_KEY, false),
  );

  const [activeTab, setActiveTab] = useState<'sales' | 'dashboard' | 'stock'>('dashboard');
  const [theme, setTheme] = useState<'dark' | 'light'>(() => parseTheme());
  const [catalog, setCatalog] = useState<CatalogProduct[]>(() => parseStoredCatalog());
  const [sales, setSales] = useState<Sale[]>(() => parseStoredSales());
  const [stock, setStock] = useState<StockMap>(() => parseStoredStock());
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(() => parseLastBackupTimestamp());
  const [cloudReady, setCloudReady] = useState<boolean>(() => !cloudEnabled);
  const [cloudStatus, setCloudStatus] = useState<string>(() =>
    !cloudBackendAvailable
      ? 'Supabase: non configure (mode local)'
      : cloudEnabled
        ? 'Supabase: initialisation...'
        : 'Supabase: cle cloud manquante (mode local)',
  );
  const [cloudBaselineUpdatedAt, setCloudBaselineUpdatedAt] = useState<string | null>(null);
  const [cloudConflict, setCloudConflict] = useState<CloudConflictState | null>(null);
  const groupByOrder = true;
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [stockQuery, setStockQuery] = useState<string>('');
  const [stockOnlyLow, setStockOnlyLow] = useState<boolean>(false);
  const [stockCategoryFilter, setStockCategoryFilter] = useState<'All' | Category>('All');

  const [form, setForm] = useState<SaleInput>(() => createEmptySaleInput());
  const [editingSaleId, setEditingSaleId] = useState<string | null>(null);
  const [saleModalOpen, setSaleModalOpen] = useState<boolean>(false);
  const [orderModalOpen, setOrderModalOpen] = useState<boolean>(false);
  const [orderForm, setOrderForm] = useState<OrderEditForm | null>(null);
  const [previewAttachmentItem, setPreviewAttachmentItem] = useState<Attachment | null>(null);
  const [previewAttachmentUrl, setPreviewAttachmentUrl] = useState<string>('');
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [chatAuthor, setChatAuthor] = useState<string>(() => readLocalStorage<string>(CHAT_AUTHOR_STORAGE_KEY, ''));
  const [chatAuthorDraft, setChatAuthorDraft] = useState<string>(() =>
    readLocalStorage<string>(CHAT_AUTHOR_STORAGE_KEY, ''),
  );
  const [chatAuthorEditing, setChatAuthorEditing] = useState<boolean>(
    () => readLocalStorage<string>(CHAT_AUTHOR_STORAGE_KEY, '').trim().length < 2,
  );
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState<string>('');
  const [chatOpen, setChatOpen] = useState<boolean>(false);
  const [chatUnreadCount, setChatUnreadCount] = useState<number>(0);
  const [chatLastSeenAt, setChatLastSeenAt] = useState<string>(() =>
    readLocalStorage<string>(CHAT_LAST_SEEN_STORAGE_KEY, ''),
  );
  const [chatLoading, setChatLoading] = useState<boolean>(false);
  const [chatSending, setChatSending] = useState<boolean>(false);
  const [chatPushEnabled, setChatPushEnabled] = useState<boolean>(false);
  const [chatPushBusy, setChatPushBusy] = useState<boolean>(false);
  const [desktopNotifsEnabled, setDesktopNotifsEnabled] = useState<boolean>(() =>
    readLocalStorage<boolean>(DESKTOP_NOTIFS_STORAGE_KEY, false),
  );
  const [chatDeviceId] = useState<string>(() => {
    const existing = readLocalStorage<string>(CHAT_DEVICE_STORAGE_KEY, '');
    if (existing) {
      return existing;
    }
    const generated = makeId();
    writeLocalStorage(CHAT_DEVICE_STORAGE_KEY, generated);
    return generated;
  });
  const [catalogStatus, setCatalogStatus] = useState<string>('Sync catalogue en attente...');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [successMessage, setSuccessMessage] = useState<string>('');
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const chatDraftInputRef = useRef<HTMLInputElement | null>(null);
  const chatAudioContextRef = useRef<AudioContext | null>(null);
  const chatIncomingBootstrappedRef = useRef<boolean>(false);
  const chatSeenIncomingIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setCloudKeyDraft(cloudStoreId);
  }, [cloudStoreId]);

  useEffect(() => {
    if (!cloudBackendAvailable) {
      setCloudReady(true);
      setCloudConflict(null);
      setCloudBaselineUpdatedAt(null);
      setCloudStatus('Supabase: non configure (mode local)');
      return;
    }
    if (!cloudEnabled) {
      setCloudReady(true);
      setCloudConflict(null);
      setCloudBaselineUpdatedAt(null);
      setCloudStatus('Supabase: cle cloud manquante (mode local)');
      return;
    }
    setCloudReady(false);
    setCloudConflict(null);
    setCloudBaselineUpdatedAt(null);
    setCloudStatus('Supabase: initialisation...');
  }, [cloudBackendAvailable, cloudEnabled]);

  const catalogMap = useMemo(() => {
    const map = new Map<string, CatalogProduct>();
    for (const item of catalog) {
      map.set(item.ref, item);
    }
    return map;
  }, [catalog]);

  const catalogRefByUpper = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of catalog) {
      map.set(item.ref.toUpperCase(), item.ref);
    }
    return map;
  }, [catalog]);

  const sortedCatalog = useMemo(() => [...catalog].sort((a, b) => a.ref.localeCompare(b.ref)), [catalog]);
  const catalogByOrder = useMemo(
    () => [...catalog].sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999)),
    [catalog],
  );

  const activeChatMentionQuery = useMemo(() => {
    const match = chatDraft.match(CHAT_ACTIVE_MENTION_REGEX);
    if (!match) {
      return null;
    }
    return match[1] ?? '';
  }, [chatDraft]);

  const chatMentionSuggestions = useMemo(() => {
    if (activeChatMentionQuery === null) {
      return [];
    }
    const queryUpper = activeChatMentionQuery.toUpperCase();
    const refs = catalogByOrder.map((item) => item.ref);
    if (!queryUpper) {
      return refs;
    }
    const startsWith = refs.filter((ref) => ref.toUpperCase().startsWith(queryUpper));
    const contains = refs.filter(
      (ref) => !ref.toUpperCase().startsWith(queryUpper) && ref.toUpperCase().includes(queryUpper),
    );
    return [...startsWith, ...contains];
  }, [activeChatMentionQuery, catalogByOrder]);

  const chatPushSupported =
    cloudEnabled &&
    isWebPushClientConfigured &&
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

  const desktopBridge =
    typeof window !== 'undefined' ? ((window as unknown as { smDesktop?: unknown }).smDesktop as
      | {
          isElectron?: boolean;
          setConfig?: (config: unknown) => Promise<unknown>;
          setNotificationsEnabled?: (enabled: boolean) => Promise<unknown>;
        }
      | undefined) : undefined;

  const isDesktopApp = Boolean(desktopBridge?.isElectron);
  const desktopNotifsSupported = Boolean(desktopBridge?.setNotificationsEnabled);
  const webPushSupported = chatPushSupported && !isDesktopApp;
  useEffect(() => {
    if (!desktopNotifsSupported) {
      return;
    }
    // Pass runtime config to the desktop wrapper so it can poll Supabase for notifications.
    if (!cloudEnabled) {
      void desktopBridge?.setNotificationsEnabled?.(false);
      return;
    }
    void desktopBridge?.setConfig?.({
      supabaseUrl,
      supabaseAnonKey,
      storeId: cloudStoreId,
      deviceId: chatDeviceId,
      messagesTable: supabaseMessagesTable,
    });
    void desktopBridge?.setNotificationsEnabled?.(desktopNotifsEnabled);
  }, [cloudEnabled, cloudStoreId, desktopNotifsSupported, desktopNotifsEnabled, chatDeviceId, desktopBridge]);

  const ensureServiceWorkerRegistration = useCallback(async (): Promise<ServiceWorkerRegistration> => {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Service worker indisponible.');
    }

    const swUrl = `${import.meta.env.BASE_URL}sw.js`;
    let registration = await navigator.serviceWorker.getRegistration();
    if (!registration) {
      // main.tsx registers on window load, but users can click before that or
      // the tab can be restored from BFCache. This keeps notifications reliable.
      registration = await navigator.serviceWorker.register(swUrl);
    }

    if (registration.active) {
      return registration;
    }

    const timeoutMs = 4000;
    const timeout = new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error('Service worker pas pret. Recharge la page.')), timeoutMs);
    });

    return (await Promise.race([navigator.serviceWorker.ready, timeout])) as ServiceWorkerRegistration;
  }, []);

  const refreshPushSubscriptionState = useCallback(async () => {
    if (!chatPushSupported) {
      setChatPushEnabled(false);
      return;
    }
    try {
      const registration = await ensureServiceWorkerRegistration();
      const subscription = await registration.pushManager.getSubscription();
      setChatPushEnabled(Boolean(subscription));
    } catch {
      setChatPushEnabled(false);
    }
  }, [chatPushSupported, ensureServiceWorkerRegistration]);

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

  const applyBackupToLocalState = useCallback((backup: BackupPayload, successNote: string) => {
    const migratedSales = migrateMissingTransactionRefs(backup.sales as Sale[]);
    const restoredSales = migratedSales.map((sale) => {
      const normalized = normalizeSaleFiscalFields(sale);
      return {
        ...sale,
        ...normalized,
        ...computeSale(normalized),
      };
    });
    const restoredCatalog = normalizeCatalog(backup.catalog);
    const restoredStock =
      backup.stock && typeof backup.stock === 'object' ? backup.stock : computeStockMap(restoredCatalog, restoredSales);

    setSales(restoredSales);
    setCatalog(restoredCatalog);
    setStock(restoredStock);
    writeLocalStorage(STORAGE_KEYS.sales, restoredSales);
    writeLocalStorage(STORAGE_KEYS.catalog, restoredCatalog);
    writeLocalStorage(STORAGE_KEYS.stock, restoredStock);
    writeLocalStorage(STORAGE_KEYS.backup, backup);
    setLastBackupAt(backup.generated_at);
    setSuccessMessage(successNote);
  }, []);

  useEffect(() => {
    if (!cloudEnabled) {
      return;
    }
    if (!cloudAutoSyncEnabled) {
      // Manual mode: do not pull/push automatically. This avoids surprise merges and "broken" UI states.
      setCloudReady(true);
      setCloudConflict(null);
      setCloudStatus('Supabase: mode manuel (auto-sync OFF)');
      return;
    }

    let canceled = false;
    let initOk = false;

    const initCloudSync = async (): Promise<void> => {
      setCloudStatus('Supabase: lecture du backup cloud...');
      try {
        const localBackup = readLocalStorage<BackupPayload | null>(STORAGE_KEYS.backup, null);
        const cloudRow = await pullCloudBackupWithMeta();
        const cloudBackup = cloudRow?.payload ?? null;
        if (cloudRow?.updated_at) {
          setCloudBaselineUpdatedAt(cloudRow.updated_at);
        }
        if (canceled) {
          return;
        }

        if (cloudBackup) {
          const cloudTs = toTimestamp(cloudBackup.generated_at);
          const localTs = toTimestamp(localBackup?.generated_at);
          const shouldRestoreCloud = !localBackup || (cloudTs > 0 && localTs > 0 && cloudTs > localTs);

          if (shouldRestoreCloud) {
            applyBackupToLocalState(cloudBackup, 'Donnees Supabase restaurees.');
            setCloudStatus(`Supabase: backup cloud charge (${formatDateTime(cloudBackup.generated_at)})`);
            setCloudConflict(null);
            initOk = true;
          } else if (localBackup) {
            // Safety: do not overwrite cloud automatically. Ask the user to choose.
            const localSummary = summarizeBackupPayload(localBackup);
            const cloudSummary = summarizeBackupPayload(cloudBackup);
            setCloudConflict({
              local: localBackup,
              cloud: cloudBackup,
              cloud_updated_at: cloudRow?.updated_at ?? '',
              local_summary: localSummary,
              cloud_summary: cloudSummary,
            });
            setCloudAutoSyncEnabled(false);
            setCloudStatus('Supabase: conflit detecte (local vs cloud). Choisis une action.');
            initOk = false;
          } else {
            initOk = true;
          }
        } else if (localBackup) {
          const pushedAt = await pushCloudBackup(localBackup);
          if (!canceled) {
            setCloudStatus(`Supabase: backup local publie (${formatDateTime(pushedAt)})`);
            setCloudBaselineUpdatedAt(pushedAt);
            setCloudConflict(null);
          }
          initOk = true;
        } else {
          setCloudStatus('Supabase: aucun backup detecte.');
          initOk = true;
        }
      } catch (error) {
        if (!canceled) {
          setCloudStatus(`Supabase: erreur (${String((error as Error).message)})`);
        }
      } finally {
        if (!canceled) {
          // Safety: do NOT enable auto-sync if we couldn't read cloud state.
          setCloudReady(initOk);
        }
      }
    };

    void initCloudSync();

    return () => {
      canceled = true;
    };
  }, [applyBackupToLocalState, cloudAutoSyncEnabled, cloudEnabled]);

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
    writeLocalStorage(CLOUD_AUTO_SYNC_STORAGE_KEY, cloudAutoSyncEnabled);
  }, [cloudAutoSyncEnabled]);

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
    if (!previewAttachmentItem) {
      setPreviewAttachmentUrl('');
      return;
    }
    const blob = base64ToBlob(previewAttachmentItem.base64, previewAttachmentItem.mime);
    const blobUrl = URL.createObjectURL(blob);
    setPreviewAttachmentUrl(blobUrl);
    return () => {
      URL.revokeObjectURL(blobUrl);
    };
  }, [previewAttachmentItem]);

  useEffect(() => {
    writeLocalStorage(CHAT_AUTHOR_STORAGE_KEY, chatAuthor.trim());
  }, [chatAuthor]);

  useEffect(() => {
    if (!cloudEnabled) {
      return;
    }

    let canceled = false;

    const refreshMessages = async (silent = true) => {
      if (!silent) {
        setChatLoading(true);
      }
      try {
        const rows = await pullChatMessages();
        if (!canceled) {
          setChatMessages(rows);
        }
      } catch (error) {
        if (!canceled) {
          setErrorMessage(`Messagerie indisponible: ${String((error as Error).message)}`);
        }
      } finally {
        if (!canceled && !silent) {
          setChatLoading(false);
        }
      }
    };

    void refreshMessages(false);
    const intervalId = window.setInterval(() => {
      void refreshMessages(true);
    }, CHAT_POLL_INTERVAL_MS);

    return () => {
      canceled = true;
      window.clearInterval(intervalId);
    };
  }, [cloudEnabled]);

  useEffect(() => {
    if (!chatOpen) {
      return;
    }
    const container = chatListRef.current;
    if (!container) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [chatOpen, chatMessages]);

  useEffect(() => {
    if (!chatOpen) {
      return;
    }
    void refreshPushSubscriptionState();
  }, [chatOpen, refreshPushSubscriptionState]);

  useEffect(() => {
    writeLocalStorage(CHAT_LAST_SEEN_STORAGE_KEY, chatLastSeenAt);
  }, [chatLastSeenAt]);

  useEffect(() => {
    if (chatOpen) {
      const lastCreatedAt = chatMessages.at(-1)?.created_at ?? '';
      if (lastCreatedAt && lastCreatedAt !== chatLastSeenAt) {
        setChatLastSeenAt(lastCreatedAt);
      }
      setChatUnreadCount(0);
      return;
    }
    const unread = chatMessages.filter((message) => {
      if (message.device_id === chatDeviceId) {
        return false;
      }
      if (!chatLastSeenAt) {
        return true;
      }
      return message.created_at > chatLastSeenAt;
    }).length;
    setChatUnreadCount(unread);
  }, [chatMessages, chatOpen, chatDeviceId, chatLastSeenAt]);

  const ensureChatAudioContext = useCallback(async (): Promise<AudioContext | null> => {
    if (typeof window === 'undefined') {
      return null;
    }
    const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      return null;
    }
    if (!chatAudioContextRef.current) {
      chatAudioContextRef.current = new AudioContextCtor();
    }
    if (chatAudioContextRef.current.state === 'suspended') {
      try {
        await chatAudioContextRef.current.resume();
      } catch {
        return null;
      }
    }
    return chatAudioContextRef.current;
  }, []);

  const playIncomingChatTone = useCallback(async () => {
    const context = await ensureChatAudioContext();
    if (!context) {
      return;
    }
    const now = context.currentTime;
    const buzzPattern = [0, 0.14];
    for (const offset of buzzPattern) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(880, now + offset);
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.12, now + offset + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.11);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + 0.12);
    }
  }, [ensureChatAudioContext]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    const handler = (event: MessageEvent) => {
      const data = event.data as { type?: string; title?: string } | null;
      if (!data || data.type !== 'SM_PUSH_DEBUG') {
        return;
      }
      setSuccessMessage(data.title ? `Push recu: ${data.title}` : 'Push recu.');
      void playIncomingChatTone();
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => {
      navigator.serviceWorker.removeEventListener('message', handler);
    };
  }, [playIncomingChatTone]);

  useEffect(() => {
    const incomingMessages = chatMessages.filter((message) => message.device_id !== chatDeviceId);
    if (!chatIncomingBootstrappedRef.current) {
      chatSeenIncomingIdsRef.current = new Set(incomingMessages.map((message) => message.id));
      chatIncomingBootstrappedRef.current = true;
      return;
    }

    const newlyReceived = incomingMessages.filter((message) => !chatSeenIncomingIdsRef.current.has(message.id));
    if (newlyReceived.length === 0) {
      return;
    }

    for (const message of newlyReceived) {
      chatSeenIncomingIdsRef.current.add(message.id);
    }

    if (chatSeenIncomingIdsRef.current.size > 500) {
      const trimmed = incomingMessages.slice(-300).map((message) => message.id);
      chatSeenIncomingIdsRef.current = new Set(trimmed);
    }

    void playIncomingChatTone();
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate([120, 80, 120]);
    }
  }, [chatMessages, chatDeviceId, playIncomingChatTone]);

  useEffect(() => {
    const payload = buildBackup(sales, catalog, stock);
    writeLocalStorage(STORAGE_KEYS.backup, payload);
    setLastBackupAt(payload.generated_at);
  }, [sales, catalog, stock]);

  useEffect(() => {
    if (!cloudEnabled || !cloudReady || cloudConflict || !cloudAutoSyncEnabled) {
      return;
    }

    const payload = buildBackup(sales, catalog, stock);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          // Concurrency safety: if the cloud row changed since last init/push, stop auto-sync and ask user.
          const remoteUpdatedAt = await pullCloudUpdatedAt().catch(() => null);
          if (
            remoteUpdatedAt &&
            cloudBaselineUpdatedAt &&
            remoteUpdatedAt !== cloudBaselineUpdatedAt &&
            !cloudConflict
          ) {
            const cloudRow = await pullCloudBackupWithMeta().catch(() => null);
            if (cloudRow) {
              setCloudConflict({
                local: payload,
                cloud: cloudRow.payload,
                cloud_updated_at: cloudRow.updated_at,
                local_summary: summarizeBackupPayload(payload),
                cloud_summary: summarizeBackupPayload(cloudRow.payload),
              });
              setCloudAutoSyncEnabled(false);
              setCloudReady(false);
              setCloudStatus('Supabase: conflit detecte (un autre appareil a modifie le cloud).');
              return;
            }
          }
          const pushedAt = await pushCloudBackup(payload);
          setCloudBaselineUpdatedAt(pushedAt);
          setCloudStatus(`Supabase: sync auto OK (${formatDateTime(pushedAt)})`);
        } catch (error) {
          setCloudStatus(`Supabase: sync auto KO (${String((error as Error).message)})`);
        }
      })();
    }, 1200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [catalog, cloudAutoSyncEnabled, cloudBaselineUpdatedAt, cloudConflict, cloudEnabled, cloudReady, sales, stock]);

  const [cloudPulling, setCloudPulling] = useState(false);

  const handleManualCloudPull = useCallback(async () => {
    if (!cloudEnabled || cloudPulling) return;

    // Confirmation avant d'écraser les données locales
    const localCount = sales.length;
    const confirmed = window.confirm(
      `⚠️ Charger depuis Supabase va remplacer tes ${localCount} vente(s) locale(s) par les données cloud.\n\nContinuer ?`
    );
    if (!confirmed) return;

    setCloudPulling(true);
    setCloudStatus('Supabase: pull en cours...');
    try {
      const cloudRow = await pullCloudBackupWithMeta();
      if (!cloudRow) {
        setCloudStatus('Supabase: aucune donnee cloud trouvee.');
        return;
      }
      applyBackupToLocalState(cloudRow.payload, 'Donnees cloud chargees.');
      setCloudBaselineUpdatedAt(cloudRow.updated_at);
      setCloudConflict(null);
      setCloudStatus(`Supabase: pull OK (${formatDateTime(cloudRow.payload.generated_at)})`);
    } catch (error) {
      setCloudStatus(`Supabase: erreur pull (${String((error as Error).message)})`);
    } finally {
      setCloudPulling(false);
    }
  }, [applyBackupToLocalState, cloudEnabled, cloudPulling, sales.length]);

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
        !sale.transaction_ref.toLowerCase().includes(query) &&
        !sale.product_ref.toLowerCase().includes(query) &&
        !(extractZohoOrderNumber(sale.id)?.toLowerCase().includes(query) ?? false)
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

  const groupedOrders = useMemo<GroupedOrderRow[]>(() => {
    const buckets = new Map<
      string,
      {
        date: string;
        client_or_tx: string;
        transaction_ref: string;
        order_number: string;
        customer_country: string;
        channel: Channel;
        tracking_numbers: Set<string>;
        shipping_provider: string | null;
        shipping_status: string | null;
        shipping_event_at: string | null;
        shipping_tracking_url: string | null;
        shipping_label_url: string | null;
        shipping_proof_url: string | null;
        invoice_url: string | null;
        refs: Set<string>;
        low_stock_refs: Set<string>;
        out_stock_refs: Set<string>;
        quantity: number;
        weighted_sell_unit_total: number;
        sell_total_ht: number;
        transaction_value: number;
        commission_eur: number;
        payment_fee_sum: number;
        net_received: number;
        net_margin: number;
        attachments_count: number;
        first_sale: Sale;
      }
    >();

    for (const sale of filteredSales) {
      const key = `${sale.date}::${sale.client_or_tx}::${sale.transaction_ref}::${sale.channel}`;
      const existing = buckets.get(key);
      if (!existing) {
        const currentStock = stock[sale.product_ref];
        const lowStockRefs = new Set<string>();
        const outStockRefs = new Set<string>();
        if (currentStock !== undefined) {
          if (currentStock <= 0) {
            outStockRefs.add(sale.product_ref);
          } else if (currentStock <= LOW_STOCK_THRESHOLD) {
            lowStockRefs.add(sale.product_ref);
          }
        }
        buckets.set(key, {
          date: sale.date,
          client_or_tx: sale.client_or_tx,
          transaction_ref: sale.transaction_ref,
          order_number: extractZohoOrderNumber(sale.id) ?? '',
          customer_country: sale.customer_country,
          channel: sale.channel,
          tracking_numbers: new Set(normalizeTrackingNumbers(sale.tracking_numbers)),
          shipping_provider: normalizeOptionalText(sale.shipping_provider),
          shipping_status: normalizeShippingStatus(normalizeOptionalText(sale.shipping_status)),
          shipping_event_at: normalizeOptionalText(sale.shipping_event_at),
          shipping_tracking_url: toSafeUrl(sale.shipping_tracking_url),
          shipping_label_url: toSafeUrl(sale.shipping_label_url),
          shipping_proof_url: toSafeUrl(sale.shipping_proof_url),
          invoice_url: toSafeUrl(sale.invoice_url),
          refs: new Set([sale.product_ref]),
          low_stock_refs: lowStockRefs,
          out_stock_refs: outStockRefs,
          quantity: sale.quantity,
          weighted_sell_unit_total: sale.sell_price_unit_ht * sale.quantity,
          sell_total_ht: sale.sell_total_ht,
          transaction_value: sale.transaction_value,
          commission_eur: sale.commission_eur,
          payment_fee_sum: sale.payment_fee,
          net_received: sale.net_received,
          net_margin: sale.net_margin,
          attachments_count: sale.attachments.length,
          first_sale: sale,
        });
        continue;
      }

      existing.refs.add(sale.product_ref);
      for (const tracking of normalizeTrackingNumbers(sale.tracking_numbers)) {
        existing.tracking_numbers.add(tracking);
      }
      const saleProvider = normalizeOptionalText(sale.shipping_provider);
      const saleStatus = normalizeShippingStatus(normalizeOptionalText(sale.shipping_status));
      const saleEventAt = normalizeOptionalText(sale.shipping_event_at);
      const saleTrackingUrl = toSafeUrl(sale.shipping_tracking_url);
      const saleLabelUrl = toSafeUrl(sale.shipping_label_url);
      const saleProofUrl = toSafeUrl(sale.shipping_proof_url);
      const saleInvoiceUrl = toSafeUrl(sale.invoice_url);
      const hasNewerEvent = toTimestamp(saleEventAt) >= toTimestamp(existing.shipping_event_at);

      if (saleProvider && (!existing.shipping_provider || hasNewerEvent)) {
        existing.shipping_provider = saleProvider;
      }
      if (saleStatus && (!existing.shipping_status || hasNewerEvent)) {
        existing.shipping_status = saleStatus;
      }
      if (saleEventAt && hasNewerEvent) {
        existing.shipping_event_at = saleEventAt;
      }
      if (saleTrackingUrl && (!existing.shipping_tracking_url || hasNewerEvent)) {
        existing.shipping_tracking_url = saleTrackingUrl;
      }
      if (saleLabelUrl && (!existing.shipping_label_url || hasNewerEvent)) {
        existing.shipping_label_url = saleLabelUrl;
      }
      if (saleProofUrl && (!existing.shipping_proof_url || hasNewerEvent)) {
        existing.shipping_proof_url = saleProofUrl;
      }
      if (saleInvoiceUrl && !existing.invoice_url) {
        existing.invoice_url = saleInvoiceUrl;
      }
      if (!existing.order_number) {
        existing.order_number = extractZohoOrderNumber(sale.id) ?? '';
      }
      const currentStock = stock[sale.product_ref];
      if (currentStock !== undefined) {
        if (currentStock <= 0) {
          existing.out_stock_refs.add(sale.product_ref);
        } else if (currentStock <= LOW_STOCK_THRESHOLD) {
          existing.low_stock_refs.add(sale.product_ref);
        }
      }
      existing.quantity += sale.quantity;
      existing.weighted_sell_unit_total += sale.sell_price_unit_ht * sale.quantity;
      existing.sell_total_ht += sale.sell_total_ht;
      existing.transaction_value += sale.transaction_value;
      existing.commission_eur += sale.commission_eur;
      existing.payment_fee_sum += sale.payment_fee;
      existing.net_received += sale.net_received;
      existing.net_margin += sale.net_margin;
      existing.attachments_count += sale.attachments.length;
    }

    return Array.from(buckets.entries())
      .map(([key, value]) => {
        const refs = Array.from(value.refs);
        const refsCount = refs.length;
        const productDisplay = buildOrderProductDisplay(refs);
        const avgSellUnit = value.quantity > 0 ? round2(value.weighted_sell_unit_total / value.quantity) : 0;
        const normalizedPaymentFee =
          value.payment_fee_sum > 0 && value.channel === 'Sun.store' ? SUN_STORE_STRIPE_ORDER_FEE : 0;
        const feeDelta = value.payment_fee_sum - normalizedPaymentFee;
        const normalizedNetReceived = round2(value.net_received + feeDelta);
        const normalizedNetMargin = round2(value.net_margin + feeDelta);
        const netMarginPct =
          value.transaction_value > 0 ? round2((normalizedNetMargin / value.transaction_value) * 100) : 0;

        return {
          key,
          date: value.date,
          client_or_tx: value.client_or_tx,
          transaction_ref: value.transaction_ref,
          order_number: value.order_number,
          customer_country: value.customer_country,
          channel: value.channel,
          tracking_numbers: Array.from(value.tracking_numbers),
          shipping_provider: value.shipping_provider,
          shipping_status: value.shipping_status,
          shipping_event_at: value.shipping_event_at,
          shipping_tracking_url: value.shipping_tracking_url,
          shipping_label_url: value.shipping_label_url,
          shipping_proof_url: value.shipping_proof_url,
          invoice_url: value.invoice_url,
          refs_count: refsCount,
          product_display: productDisplay,
          low_stock_refs: Array.from(value.low_stock_refs).sort((a, b) => a.localeCompare(b)),
          out_stock_refs: Array.from(value.out_stock_refs).sort((a, b) => a.localeCompare(b)),
          quantity: value.quantity,
          sell_price_unit_ht: avgSellUnit,
          sell_total_ht: round2(value.sell_total_ht),
          transaction_value: round2(value.transaction_value),
          commission_eur: round2(value.commission_eur),
          payment_fee: round2(normalizedPaymentFee),
          net_received: normalizedNetReceived,
          net_margin: normalizedNetMargin,
          net_margin_pct: netMarginPct,
          attachments_count: value.attachments_count,
          first_sale: value.first_sale,
        };
      })
      .sort((a, b) => {
        if (a.date !== b.date) {
          return b.date.localeCompare(a.date);
        }
        const byClient = a.client_or_tx.localeCompare(b.client_or_tx);
        if (byClient !== 0) {
          return byClient;
        }
        return a.transaction_ref.localeCompare(b.transaction_ref);
      });
  }, [filteredSales, stock]);

  const kpis = useMemo(() => {
    const totalRevenue = groupedOrders.reduce((sum, order) => sum + order.transaction_value, 0);
    const totalNetMargin = groupedOrders.reduce((sum, order) => sum + order.net_margin, 0);
    const totalCommissions = groupedOrders.reduce((sum, order) => sum + order.commission_eur, 0);
    const totalPlatformFees = groupedOrders.reduce((sum, order) => sum + order.payment_fee, 0);
    const totalMaterialsSold = groupedOrders.reduce((sum, order) => sum + order.quantity, 0);

    const breakdown = CHANNELS.map((channel) => {
      const channelOrders = groupedOrders.filter((order) => order.channel === channel);
      return {
        channel,
        count: channelOrders.length,
        revenue: channelOrders.reduce((sum, order) => sum + order.transaction_value, 0),
        netMargin: channelOrders.reduce((sum, order) => sum + order.net_margin, 0),
        commissions: channelOrders.reduce((sum, order) => sum + order.commission_eur, 0),
      };
    });

    return {
      totalRevenue: round2(totalRevenue),
      totalNetMargin: round2(totalNetMargin),
      avgNetMarginPct: totalRevenue > 0 ? round2((totalNetMargin / totalRevenue) * 100) : 0,
      salesCount: groupedOrders.length,
      totalMaterialsSold,
      totalCommissions: round2(totalCommissions),
      totalPlatformFees: round2(totalPlatformFees),
      breakdown,
    };
  }, [groupedOrders]);

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
  const orderPreviewComputed = useMemo(() => {
    if (!orderForm) {
      return null;
    }

    const lineWeights = orderForm.lines.map((line) => {
      const base = round2(line.quantity * line.sell_price_unit_ht);
      return base > 0 ? base : Math.max(1, line.quantity);
    });
    const allocatedShippingCharged = allocateAmountByWeight(orderForm.shipping_charged_order, lineWeights);
    const allocatedShippingReal = allocateAmountByWeight(orderForm.shipping_real_order, lineWeights);

    return orderForm.lines.reduce(
      (accumulator, line, index) => {
        const normalizedInput: SaleInput = {
          date: orderForm.date,
          client_or_tx: orderForm.client_or_tx,
          transaction_ref: orderForm.transaction_ref,
          channel: orderForm.channel,
          customer_country: orderForm.customer_country,
          product_ref: line.product_ref.trim(),
          quantity: line.quantity,
          sell_price_unit_ht: line.sell_price_unit_ht,
          sell_price_unit_ttc: isFranceCustomer(orderForm.customer_country) ? applyFranceVat(line.sell_price_unit_ht) : null,
          shipping_charged: allocatedShippingCharged[index] ?? 0,
          shipping_charged_ttc: isFranceCustomer(orderForm.customer_country)
            ? applyFranceVat(allocatedShippingCharged[index] ?? 0)
            : null,
          shipping_real: allocatedShippingReal[index] ?? 0,
          shipping_real_ttc: isFranceCustomer(orderForm.customer_country)
            ? applyFranceVat(allocatedShippingReal[index] ?? 0)
            : null,
          payment_method: orderForm.payment_method,
          category: line.category,
          buy_price_unit: line.buy_price_unit,
          power_wp: isPowerWpRequired(orderForm.channel, line.category)
            ? inferPowerWpFromRef(line.product_ref.trim(), line.quantity) ?? line.power_wp
            : null,
          attachments: [],
        };
        const computed = computeSale(normalizedInput);

        accumulator.quantity += line.quantity;
        accumulator.sell_total_ht += computed.sell_total_ht;
        accumulator.transaction_value += computed.transaction_value;
        accumulator.commission_eur += computed.commission_eur;
        accumulator.payment_fee += computed.payment_fee;
        accumulator.net_received += computed.net_received;
        accumulator.total_cost += computed.total_cost;
        accumulator.net_margin += computed.net_margin;
        return accumulator;
      },
      {
        quantity: 0,
        sell_total_ht: 0,
        transaction_value: 0,
        commission_eur: 0,
        payment_fee: 0,
        net_received: 0,
        total_cost: 0,
        net_margin: 0,
      },
    );
  }, [orderForm]);

  const updateForm = <K extends keyof SaleInput>(field: K, value: SaleInput[K]) => {
    setForm((previous) => ({ ...previous, [field]: value }));
  };

  const applyCatalogProduct = (value: string) => {
    const trimmed = normalizeCatalogRefInput(value);
    const match = catalogMap.get(trimmed);

    setForm((previous) => {
      const next: SaleInput = { ...previous, product_ref: trimmed };
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

  const getOrderSales = (order: GroupedOrderRow): Sale[] =>
    sales.filter(
      (sale) =>
        sale.date === order.date &&
        sale.client_or_tx === order.client_or_tx &&
        sale.transaction_ref === order.transaction_ref &&
        sale.channel === order.channel,
    );

  const openEditOrderModal = (order: GroupedOrderRow) => {
    const orderSales = getOrderSales(order);
    if (orderSales.length === 0) {
      setErrorMessage('Commande introuvable.');
      return;
    }

    const firstSale = orderSales[0];
    const orderShippingCharged = round2(orderSales.reduce((sum, sale) => sum + sale.shipping_charged, 0));
    const orderShippingReal = round2(orderSales.reduce((sum, sale) => sum + sale.shipping_real, 0));
    const orderAttachmentsMap = new Map<string, Attachment>();
    for (const sale of orderSales) {
      for (const attachment of sale.attachments) {
        if (!orderAttachmentsMap.has(attachment.id)) {
          orderAttachmentsMap.set(attachment.id, attachment);
        }
      }
    }
    setOrderForm({
      date: firstSale.date,
      client_or_tx: firstSale.client_or_tx,
      transaction_ref: firstSale.transaction_ref ?? '',
      order_number: order.order_number || extractZohoOrderNumber(firstSale.id) || '',
      channel: firstSale.channel,
      customer_country: normalizeCountryIso(firstSale.customer_country) || COUNTRY_PLACEHOLDER,
      payment_method: firstSale.payment_method,
      tracking_numbers: order.tracking_numbers,
      shipping_provider: normalizeOptionalText(order.shipping_provider ?? firstSale.shipping_provider),
      shipping_status: normalizeShippingStatus(order.shipping_status ?? firstSale.shipping_status),
      shipping_event_at: normalizeOptionalText(order.shipping_event_at ?? firstSale.shipping_event_at),
      shipping_tracking_url: toSafeUrl(order.shipping_tracking_url ?? firstSale.shipping_tracking_url),
      shipping_label_url: toSafeUrl(order.shipping_label_url ?? firstSale.shipping_label_url),
      shipping_proof_url: toSafeUrl(order.shipping_proof_url ?? firstSale.shipping_proof_url),
      invoice_url: toSafeUrl(order.invoice_url ?? firstSale.invoice_url),
      shipping_charged_order: orderShippingCharged,
      shipping_real_order: orderShippingReal,
      attachments: Array.from(orderAttachmentsMap.values()),
      source_sale_ids: orderSales.map((sale) => sale.id),
      lines: orderSales.map((sale) => ({
        id: sale.id,
        product_ref: sale.product_ref,
        category: sale.category,
        quantity: sale.quantity,
        buy_price_unit: sale.buy_price_unit,
        sell_price_unit_ht: sale.sell_price_unit_ht,
        shipping_charged: sale.shipping_charged,
        shipping_real: sale.shipping_real,
        power_wp: sale.power_wp,
      })),
    });
    setOrderModalOpen(true);
    setErrorMessage('');
    setSuccessMessage('');
  };

  const closeOrderModal = () => {
    setOrderModalOpen(false);
    setOrderForm(null);
  };

  const updateOrderHeader = <K extends keyof Omit<OrderEditForm, 'lines' | 'source_sale_ids'>>(
    field: K,
    value: OrderEditForm[K],
  ) => {
    setOrderForm((previous) => {
      if (!previous) {
        return previous;
      }
      return {
        ...previous,
        [field]: value,
      };
    });
  };

  const updateOrderLine = <K extends keyof OrderEditLine>(lineId: string, field: K, value: OrderEditLine[K]) => {
    setOrderForm((previous) => {
      if (!previous) {
        return previous;
      }
      return {
        ...previous,
        lines: previous.lines.map((line) => (line.id === lineId ? { ...line, [field]: value } : line)),
      };
    });
  };

  const openConfirmDialog = ({
    title,
    message,
    confirmLabel,
    tone = 'danger',
    onConfirm,
  }: Omit<ConfirmDialogState, 'tone'> & { tone?: ConfirmDialogState['tone'] }) => {
    setConfirmDialog({
      title,
      message,
      confirmLabel,
      tone,
      onConfirm,
    });
  };

  const closeConfirmDialog = () => {
    setConfirmDialog(null);
  };

  const submitConfirmDialog = () => {
    if (!confirmDialog) {
      return;
    }
    const action = confirmDialog.onConfirm;
    setConfirmDialog(null);
    action();
  };

  const updateOrderLineProduct = (lineId: string, value: string) => {
    const trimmed = normalizeCatalogRefInput(value);
    const catalogProduct = catalogMap.get(trimmed);
    setOrderForm((previous) => {
      if (!previous) {
        return previous;
      }
      return {
        ...previous,
        lines: previous.lines.map((line) => {
          if (line.id !== lineId) {
            return line;
          }
          if (!catalogProduct) {
            return { ...line, product_ref: trimmed };
          }
          return {
            ...line,
            product_ref: trimmed,
            category: catalogProduct.category,
            buy_price_unit: catalogProduct.buy_price_unit,
          };
        }),
      };
    });
  };

  const addOrderLine = () => {
    setOrderForm((previous) => {
      if (!previous) {
        return previous;
      }
      return {
        ...previous,
        lines: [
          ...previous.lines,
          {
            id: `order-line-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            product_ref: '',
            category: 'Inverters',
            quantity: 1,
            buy_price_unit: 0,
            sell_price_unit_ht: 0,
            shipping_charged: 0,
            shipping_real: 0,
            power_wp: null,
          },
        ],
      };
    });
  };

  const removeOrderLine = (lineId: string) => {
    if (!orderForm) {
      return;
    }
    const lineToDelete = orderForm.lines.find((line) => line.id === lineId);
    const lineLabel = lineToDelete?.product_ref?.trim() || 'cette reference';
    openConfirmDialog({
      title: 'Supprimer une reference',
      message: `Confirmer la suppression de ${lineLabel} ?`,
      confirmLabel: 'Supprimer',
      tone: 'danger',
      onConfirm: () => {
        setOrderForm((previous) => {
          if (!previous) {
            return previous;
          }
          if (previous.lines.length <= 1) {
            // Keep one editable line so the order form remains valid and usable.
            return {
              ...previous,
              lines: previous.lines.map((line) =>
                line.id === lineId
                  ? {
                      ...line,
                      product_ref: '',
                      category: 'Inverters',
                      quantity: 1,
                      buy_price_unit: 0,
                      sell_price_unit_ht: 0,
                      shipping_charged: 0,
                      shipping_real: 0,
                      power_wp: null,
                    }
                  : line,
              ),
            };
          }
          return {
            ...previous,
            lines: previous.lines.filter((line) => line.id !== lineId),
          };
        });
      },
    });
  };

  const closeSaleModal = () => {
    setSaleModalOpen(false);
    setEditingSaleId(null);
    setForm(createEmptySaleInput());
    triggerHardRefreshAfterMutation();
  };

  const forceHardRefresh = () => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set(HARD_REFRESH_QUERY_KEY, `${Date.now()}`);
    window.location.replace(nextUrl.toString());
  };

  const triggerHardRefreshAfterMutation = () => {
    window.setTimeout(() => {
      forceHardRefresh();
    }, 350);
  };

  const validateSale = (saleInput: SaleInput): string | null => {
    if (!saleInput.date) {
      return 'Date obligatoire.';
    }
    if (!saleInput.client_or_tx.trim()) {
      return 'Client obligatoire.';
    }
    if (!saleInput.transaction_ref.trim()) {
      return 'Transaction # obligatoire.';
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
      const inferredPowerWp = inferPowerWpFromRef(saleInput.product_ref, saleInput.quantity);
      const effectivePowerWp = inferredPowerWp ?? saleInput.power_wp;
      if (effectivePowerWp === null || effectivePowerWp <= 0) {
        return 'Puissance Wp introuvable: ajoute la valeur dans la reference produit (ex: 550WP).';
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
      transaction_ref: form.transaction_ref.trim(),
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
      power_wp: isPowerWpRequired(form.channel, form.category)
        ? inferPowerWpFromRef(form.product_ref, Number(form.quantity)) ?? normalizeNullableNumber(form.power_wp)
        : null,
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

  const handleSubmitOrder = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!orderForm) {
      return;
    }

    const normalizedHeader = {
      date: orderForm.date,
      client_or_tx: orderForm.client_or_tx.trim(),
      transaction_ref: orderForm.transaction_ref.trim(),
      channel: orderForm.channel,
      customer_country: orderForm.customer_country,
      payment_method: orderForm.payment_method,
    };

    if (!normalizedHeader.date) {
      setErrorMessage('Date obligatoire.');
      return;
    }
    if (!normalizedHeader.client_or_tx) {
      setErrorMessage('Client obligatoire.');
      return;
    }
    if (!normalizedHeader.transaction_ref) {
      setErrorMessage('Transaction # obligatoire.');
      return;
    }
    if (!normalizedHeader.customer_country) {
      setErrorMessage('Pays client obligatoire.');
      return;
    }
    if (orderForm.shipping_charged_order < 0 || orderForm.shipping_real_order < 0) {
      setErrorMessage('Les montants de transport commande doivent etre >= 0.');
      return;
    }
    if (orderForm.lines.length === 0) {
      setErrorMessage('La commande doit contenir au moins un produit.');
      return;
    }

    const normalizedTrackingNumbers = normalizeTrackingNumbers(orderForm.tracking_numbers);
    const normalizedShippingProvider = normalizeOptionalText(orderForm.shipping_provider);
    const normalizedShippingStatus = normalizeShippingStatus(orderForm.shipping_status);
    const normalizedShippingEventAt = normalizeOptionalText(orderForm.shipping_event_at);
    const normalizedTrackingUrl = toSafeUrl(orderForm.shipping_tracking_url);
    const normalizedLabelUrl = toSafeUrl(orderForm.shipping_label_url);
    const normalizedProofUrl = toSafeUrl(orderForm.shipping_proof_url);
    const normalizedInvoiceUrl = toSafeUrl(orderForm.invoice_url);

    const existingOrderSales = sales.filter((sale) => orderForm.source_sale_ids.includes(sale.id));
    const existingById = new Map(existingOrderSales.map((sale) => [sale.id, sale]));
    if (existingById.size !== orderForm.source_sale_ids.length) {
      setErrorMessage('Incoherence detectee sur la commande. Reouvre la commande puis reessaie.');
      return;
    }

    const oldQtyByRef = new Map<string, number>();
    for (const sale of existingOrderSales) {
      const ref = sale.product_ref.trim();
      oldQtyByRef.set(ref, (oldQtyByRef.get(ref) ?? 0) + sale.quantity);
    }

    const newQtyByRef = new Map<string, number>();
    for (const line of orderForm.lines) {
      const lineRef = line.product_ref.trim();
      if (!lineRef) {
        setErrorMessage('Chaque ligne doit avoir une reference produit.');
        return;
      }
      if (line.quantity <= 0) {
        setErrorMessage(`Quantite invalide pour ${lineRef}.`);
        return;
      }
      if (line.buy_price_unit < 0 || line.sell_price_unit_ht < 0) {
        setErrorMessage(`Montant negatif non autorise pour ${lineRef}.`);
        return;
      }
      if (isPowerWpRequired(normalizedHeader.channel, line.category)) {
        const inferredLinePowerWp = inferPowerWpFromRef(lineRef, line.quantity);
        const effectiveLinePowerWp = inferredLinePowerWp ?? line.power_wp;
        if (effectiveLinePowerWp === null || effectiveLinePowerWp <= 0) {
          setErrorMessage(`Puissance Wp introuvable pour ${lineRef} (ex: 550WP).`);
          return;
        }
      }
      newQtyByRef.set(lineRef, (newQtyByRef.get(lineRef) ?? 0) + line.quantity);
    }

    const lineWeights = orderForm.lines.map((line) => {
      const base = round2(line.quantity * line.sell_price_unit_ht);
      return base > 0 ? base : Math.max(1, line.quantity);
    });
    const allocatedShippingCharged = allocateAmountByWeight(orderForm.shipping_charged_order, lineWeights);
    const allocatedShippingReal = allocateAmountByWeight(orderForm.shipping_real_order, lineWeights);

    for (const [ref, newQty] of newQtyByRef.entries()) {
      const referencedProduct = catalogMap.get(ref);
      if (!referencedProduct) {
        continue;
      }
      const availableExcludingOrder = (stock[ref] ?? 0) + (oldQtyByRef.get(ref) ?? 0);
      if (newQty > availableExcludingOrder) {
        setErrorMessage(`Stock insuffisant pour ${ref} (disponible: ${availableExcludingOrder}).`);
        return;
      }
    }

    const isFranceOrder = isFranceCustomer(normalizedHeader.customer_country);
    const updates = new Map<string, Sale>();
    const newSales: Sale[] = [];
    const keptIds = new Set<string>();
    for (const [index, line] of orderForm.lines.entries()) {
      const original = existingById.get(line.id) ?? null;
      const lineId = original ? original.id : makeId();
      keptIds.add(lineId);
      const linePowerWp = isPowerWpRequired(normalizedHeader.channel, line.category)
        ? inferPowerWpFromRef(line.product_ref.trim(), line.quantity) ?? line.power_wp
        : null;
      const normalizedInput: SaleInput = {
        date: normalizedHeader.date,
        client_or_tx: normalizedHeader.client_or_tx,
        transaction_ref: normalizedHeader.transaction_ref,
        channel: normalizedHeader.channel,
        customer_country: normalizedHeader.customer_country,
        product_ref: line.product_ref.trim(),
        quantity: line.quantity,
        sell_price_unit_ht: line.sell_price_unit_ht,
        sell_price_unit_ttc: isFranceOrder ? applyFranceVat(line.sell_price_unit_ht) : null,
        shipping_charged: allocatedShippingCharged[index] ?? 0,
        shipping_charged_ttc: isFranceOrder ? applyFranceVat(allocatedShippingCharged[index] ?? 0) : null,
        shipping_real: allocatedShippingReal[index] ?? 0,
        shipping_real_ttc: isFranceOrder ? applyFranceVat(allocatedShippingReal[index] ?? 0) : null,
        payment_method: normalizedHeader.payment_method,
        category: line.category,
        buy_price_unit: line.buy_price_unit,
        power_wp: linePowerWp,
        attachments: index === 0 ? orderForm.attachments : [],
        tracking_numbers: normalizedTrackingNumbers,
        shipping_provider: normalizedShippingProvider,
        shipping_status: normalizedShippingStatus,
        shipping_cost_source: original?.shipping_cost_source ?? 'manual',
        shipping_event_at: normalizedShippingEventAt ?? original?.shipping_event_at ?? null,
        shipping_tracking_url: normalizedTrackingUrl,
        shipping_label_url: normalizedLabelUrl,
        shipping_proof_url: normalizedProofUrl,
        invoice_url: normalizedInvoiceUrl ?? original?.invoice_url ?? null,
      };
      const normalizedSale = inputToSale(lineId, normalizedInput, original?.created_at);
      if (original) {
        updates.set(lineId, normalizedSale);
      } else {
        newSales.push(normalizedSale);
      }
    }

    setSales((previous) => {
      const next = previous
        .filter((sale) => !orderForm.source_sale_ids.includes(sale.id) || keptIds.has(sale.id))
        .map((sale) => updates.get(sale.id) ?? sale);
      return [...newSales, ...next];
    });
    closeOrderModal();
    setErrorMessage('');
    setSuccessMessage(`Commande modifiee (${orderForm.lines.length} ligne(s)).`);
    triggerHardRefreshAfterMutation();
  };

  const handleDeleteSale = (saleId: string) => {
    const sale = sales.find((item) => item.id === saleId);
    if (!sale) {
      return;
    }

    openConfirmDialog({
      title: 'Supprimer une vente',
      message: `Supprimer la vente ${sale.client_or_tx} (${sale.transaction_ref || '-'}) ?`,
      confirmLabel: 'Supprimer',
      tone: 'danger',
      onConfirm: () => {
        setSales((previous) => previous.filter((item) => item.id !== saleId));
        triggerHardRefreshAfterMutation();
      },
    });
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
    const attachment = form.attachments.find((item) => item.id === attachmentId);
    const attachmentLabel = attachment?.name || 'cette piece jointe';
    openConfirmDialog({
      title: 'Supprimer une piece jointe',
      message: `Supprimer ${attachmentLabel} ?`,
      confirmLabel: 'Supprimer',
      tone: 'danger',
      onConfirm: () => {
        setForm((previous) => ({
          ...previous,
          attachments: previous.attachments.filter((item) => item.id !== attachmentId),
        }));
      },
    });
  };

  const handleOrderAttachmentFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }

    try {
      const newAttachments = await Promise.all(Array.from(files).map((file) => fileToAttachment(file)));
      setOrderForm((previous) => {
        if (!previous) {
          return previous;
        }
        return {
          ...previous,
          attachments: [...previous.attachments, ...newAttachments],
        };
      });
    } catch {
      setErrorMessage('Impossible de joindre au moins un fichier.');
    }
  };

  const importOrderAttachmentFromUrl = async (
    sourceUrl: string | null | undefined,
    fallbackName: string,
  ) => {
    const safeUrl = toSafeUrl(sourceUrl);
    if (!safeUrl) {
      setErrorMessage('URL document invalide ou manquante.');
      return;
    }

    try {
      const response = await fetch(safeUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const fileName = fileNameFromUrl(safeUrl, fallbackName);
      const file = new File([blob], fileName, {
        type: blob.type || 'application/pdf',
      });
      const attachment = await fileToAttachment(file);
      setOrderForm((previous) => {
        if (!previous) {
          return previous;
        }
        const alreadyExists = previous.attachments.some(
          (item) => item.name === attachment.name && item.size === attachment.size,
        );
        return alreadyExists
          ? previous
          : {
              ...previous,
              attachments: [...previous.attachments, attachment],
            };
      });
      setSuccessMessage(`PJ importee: ${fileName}`);
    } catch {
      setErrorMessage(
        "Impossible d'importer la PJ depuis Envia (URL inaccessible/CORS). Ouvre le lien puis ajoute le fichier manuellement.",
      );
    }
  };

  const removeOrderAttachment = (attachmentId: string) => {
    if (!orderForm) {
      return;
    }
    const attachment = orderForm.attachments.find((item) => item.id === attachmentId);
    const attachmentLabel = attachment?.name || 'cette piece jointe';
    openConfirmDialog({
      title: 'Supprimer une piece jointe',
      message: `Supprimer ${attachmentLabel} ?`,
      confirmLabel: 'Supprimer',
      tone: 'danger',
      onConfirm: () => {
        setOrderForm((previous) => {
          if (!previous) {
            return previous;
          }
          return {
            ...previous,
            attachments: previous.attachments.filter((item) => item.id !== attachmentId),
          };
        });
      },
    });
  };

  const openAttachmentPreview = (attachment: Attachment) => {
    setPreviewAttachmentItem(attachment);
  };

  const closeAttachmentPreview = () => {
    setPreviewAttachmentItem(null);
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

  const enablePushNotifications = async () => {
    if (!webPushSupported) {
      if (isDesktopApp) {
        setErrorMessage("L'app macOS (Electron) ne supporte pas Web Push. Utilise Notifs ON (desktop).");
        return;
      }
      setErrorMessage('Push non supporte sur ce navigateur/appareil.');
      return;
    }
    if (!chatPushSupported) {
      setErrorMessage('Push non supporte sur ce navigateur/appareil.');
      return;
    }
    setChatPushBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setErrorMessage('Autorisation notifications refusee.');
        return;
      }
      const registration = await ensureServiceWorkerRegistration();
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToArrayBuffer(webPushPublicKey),
        }));
      const json = subscription.toJSON();
      const endpoint = json.endpoint ?? '';
      const p256dh = json.keys?.p256dh ?? '';
      const auth = json.keys?.auth ?? '';
      if (!endpoint || !p256dh || !auth) {
        throw new Error('Subscription push incomplete.');
      }
      await savePushSubscription({
        device_id: chatDeviceId,
        endpoint,
        p256dh,
        auth,
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      });
      setChatPushEnabled(true);
      setSuccessMessage('Notifications push activees.');
    } catch (error) {
      const message = String((error as Error).message);
      if (message.toLowerCase().includes('push service not available')) {
        setErrorMessage("Web Push indisponible ici. Sur Mac app (Electron): active Notifs ON (desktop).");
      } else {
        setErrorMessage(`Activation push impossible: ${message}`);
      }
    } finally {
      setChatPushBusy(false);
    }
  };

  const disablePushNotifications = async () => {
    if (!webPushSupported) {
      setChatPushEnabled(false);
      return;
    }
    setChatPushBusy(true);
    try {
      const registration = await ensureServiceWorkerRegistration();
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        await deletePushSubscription(endpoint);
      }
      setChatPushEnabled(false);
      setSuccessMessage('Notifications push desactivees.');
    } catch (error) {
      setErrorMessage(`Desactivation push impossible: ${String((error as Error).message)}`);
    } finally {
      setChatPushBusy(false);
    }
  };

  const toggleDesktopNotifications = async () => {
    if (!desktopNotifsSupported) {
      setErrorMessage('Notifications desktop indisponibles.');
      return;
    }
    const next = !desktopNotifsEnabled;
    setDesktopNotifsEnabled(next);
    writeLocalStorage(DESKTOP_NOTIFS_STORAGE_KEY, next);
    try {
      await desktopBridge?.setNotificationsEnabled?.(next);
      setSuccessMessage(next ? 'Notifs desktop activees.' : 'Notifs desktop desactivees.');
    } catch (error) {
      setErrorMessage(`Notif desktop impossible: ${String((error as Error).message)}`);
    }
  };

  const sendLocalNotificationTest = async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setErrorMessage('Notifications non supportees sur ce navigateur/appareil.');
      return;
    }
    if (!('serviceWorker' in navigator)) {
      setErrorMessage('Service worker indisponible sur ce navigateur/appareil.');
      return;
    }

    setChatPushBusy(true);
    try {
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (permission !== 'granted') {
        setErrorMessage('Autorisation notifications refusee (Chrome/macOS).');
        return;
      }

      const registration = await ensureServiceWorkerRegistration();

      const title = 'Test • Huawei Sales Manager';
      const body = "Si tu vois ceci, Chrome/macOS autorise bien les notifications pour l'app.";
      const icon = `${import.meta.env.BASE_URL}favicon-192.png`;

      // Try page-level notification first and confirm via events.
      // If macOS/Chrome blocks displaying, onshow/onerror helps diagnose.
      let confirmed = false;
      try {
        const notification = new Notification(title, { body, icon });
        notification.onshow = () => {
          confirmed = true;
          setSuccessMessage('Notification affichee (OK).');
        };
        notification.onerror = () => {
          confirmed = true;
          setErrorMessage(
            'Notification bloquee par macOS/Chrome. Verifie Reglages Systeme > Notifications > Chrome et les permissions du site.',
          );
        };
      } catch {
        // Ignore and fallback to SW path below.
      }

      // Always fire a SW notification too (useful when page notifications are restricted).
      await registration.showNotification(title, {
        body,
        icon,
        badge: icon,
        tag: 'local-test',
      });

      window.setTimeout(async () => {
        if (confirmed) {
          return;
        }
        try {
          const visible = (await registration.getNotifications({ tag: 'local-test' })).length > 0;
          if (visible) {
            setSuccessMessage('Notification envoyee (visible dans le centre de notifications).');
          } else {
            setErrorMessage(
              'Notification envoyee mais non affichee. Verifie macOS: Notifications Chrome autorisees + Focus/Ne pas deranger.',
            );
          }
        } catch {
          setErrorMessage(
            'Notification envoyee mais non confirmee. Verifie macOS: Notifications Chrome autorisees + Focus/Ne pas deranger.',
          );
        }
      }, 900);
    } catch (error) {
      const diag = (() => {
        try {
          return [
            `permission=${typeof Notification !== 'undefined' ? Notification.permission : 'n/a'}`,
            `secure=${typeof window !== 'undefined' ? String(window.isSecureContext) : 'n/a'}`,
            `sw_controller=${navigator.serviceWorker?.controller?.scriptURL ?? 'none'}`,
          ].join(' | ');
        } catch {
          return '';
        }
      })();
      setErrorMessage(`Test notification impossible: ${String((error as Error).message)} ${diag}`.trim());
    } finally {
      setChatPushBusy(false);
    }
  };

  const sendServerPushTest = async () => {
    if (!cloudEnabled) {
      setErrorMessage('Push cloud indisponible: configure Supabase.');
      return;
    }
    if (!chatPushEnabled) {
      setErrorMessage('Active d abord Push ON sur cet appareil.');
      return;
    }
    setChatPushBusy(true);
    try {
      await sendPushNotificationForChat({
        author: 'System',
        body: `Ping push (${formatDateTime(new Date().toISOString())})`,
        sender_device_id: '',
        url: window.location.href,
      });
      setSuccessMessage('Ping push envoye (serveur).');
    } catch (error) {
      setErrorMessage(`Ping push impossible: ${String((error as Error).message)}`);
    } finally {
      setChatPushBusy(false);
    }
  };

  const handleSendChatMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!cloudEnabled) {
      setErrorMessage('Messagerie cloud indisponible: configure Supabase.');
      return;
    }
    const author = chatAuthor.trim();
    const messageBody = chatDraft.trim();
    if (author.length < 2) {
      setErrorMessage('Renseigne ton prenom (2 caracteres minimum).');
      return;
    }
    if (messageBody.length === 0) {
      return;
    }

    setChatSending(true);
    try {
      await pushChatMessage({
        author,
        body: messageBody,
        device_id: chatDeviceId,
      });
      try {
        const appUrl =
          typeof window !== 'undefined' ? `${window.location.origin}${import.meta.env.BASE_URL}` : undefined;
        await sendPushNotificationForChat({
          author,
          body: messageBody,
          sender_device_id: chatDeviceId,
          url: appUrl,
        });
      } catch (error) {
        setErrorMessage(`Push non envoye: ${String((error as Error).message)}`);
      }
      setChatDraft('');
      const refreshed = await pullChatMessages();
      setChatMessages(refreshed);
    } catch (error) {
      setErrorMessage(`Envoi message impossible: ${String((error as Error).message)}`);
    } finally {
      setChatSending(false);
    }
  };

  const saveChatAuthor = () => {
    const normalized = chatAuthorDraft.trim();
    if (normalized.length < 2) {
      setErrorMessage('Pseudo trop court (minimum 2 caracteres).');
      return;
    }
    setChatAuthor(normalized);
    setChatAuthorDraft(normalized);
    setChatAuthorEditing(false);
  };

  const applyChatMention = (ref: string) => {
    setChatDraft((previous) =>
      previous.replace(CHAT_ACTIVE_MENTION_REGEX, (fullMatch) => {
        const hasLeadingSpace = fullMatch.startsWith(' ');
        return `${hasLeadingSpace ? ' ' : ''}@${ref} `;
      }),
    );
    window.requestAnimationFrame(() => {
      chatDraftInputRef.current?.focus();
    });
  };

  const openMentionReference = (ref: string) => {
    setStockQuery(ref);
    setStockCategoryFilter('All');
    setStockOnlyLow(false);
    setActiveTab('stock');
    setChatOpen(false);
  };

  const renderChatMessageBody = (body: string): ReactNode[] =>
    body.split(CHAT_MESSAGE_MENTION_REGEX).map((part, index) => {
      if (!part.startsWith('@')) {
        return <span key={`txt-${index}`}>{part}</span>;
      }
      const rawRef = part.slice(1);
      const normalizedRef = catalogRefByUpper.get(rawRef.toUpperCase());
      if (!normalizedRef) {
        return <span key={`txt-${index}`}>{part}</span>;
      }
      return (
        <button
          key={`mention-${normalizedRef}-${index}`}
          type="button"
          className="sm-chat-mention"
          onClick={() => openMentionReference(normalizedRef)}
          title={`Ouvrir le stock pour ${normalizedRef}`}
        >
          @{normalizedRef}
        </button>
      );
    });

  const toggleChatOpen = () => {
    if (!cloudEnabled) {
      setErrorMessage('Messagerie cloud indisponible: configure Supabase + cle cloud.');
      return;
    }
    void ensureChatAudioContext();
    setChatOpen((previous) => !previous);
  };

  const resolveCloudConflictUseLocal = useCallback(async () => {
    if (!cloudConflict) {
      return;
    }
    try {
      const pushedAt = await pushCloudBackup(cloudConflict.local);
      setCloudBaselineUpdatedAt(pushedAt);
      setCloudConflict(null);
      setCloudReady(true);
      setCloudStatus(`Supabase: local publie (${formatDateTime(pushedAt)})`);
      setSuccessMessage('Cloud mis a jour depuis le local.');
    } catch (error) {
      setErrorMessage(`Sync cloud impossible: ${String((error as Error).message)}`);
    }
  }, [cloudConflict]);

  const resolveCloudConflictUseCloud = useCallback(async () => {
    if (!cloudConflict) {
      return;
    }
    try {
      applyBackupToLocalState(cloudConflict.cloud, 'Backup cloud restaure.');
      const updatedAt = cloudConflict.cloud_updated_at || (await pullCloudUpdatedAt().catch(() => null)) || null;
      setCloudBaselineUpdatedAt(updatedAt);
      setCloudConflict(null);
      setCloudReady(true);
      setCloudStatus(`Supabase: cloud conserve (${formatDateTime(cloudConflict.cloud.generated_at)})`);
    } catch (error) {
      setErrorMessage(`Restauration cloud impossible: ${String((error as Error).message)}`);
    }
  }, [applyBackupToLocalState, cloudConflict]);

  const dismissCloudConflict = useCallback(() => {
    setCloudConflict(null);
    setCloudAutoSyncEnabled(false);
    setCloudReady(true);
    setCloudStatus('Supabase: mode manuel (auto-sync OFF)');
  }, []);

  const generateCloudStoreKey = () => {
    if (typeof crypto === 'undefined' || !('getRandomValues' in crypto)) {
      setCloudKeyDraft(`sm-${Date.now()}-${makeId()}`);
      return;
    }
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    setCloudKeyDraft(`sm-${hex}`);
  };

  const saveCloudStoreKey = () => {
    try {
      setSupabaseStoreId(cloudKeyDraft);
      setCloudStoreId(getSupabaseStoreId());
      setCloudKeyModalOpen(false);
      setSuccessMessage('Cle cloud enregistree.');
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(`Cle cloud invalide: ${String((error as Error).message)}`);
    }
  };

  const repairLocalData = () => {
    try {
      setSales((previous) => {
        const migrated = migrateMissingTransactionRefs(previous);
        return migrated.map((sale) => {
          const normalized = normalizeSaleFiscalFields(sale);
          return {
            ...sale,
            ...normalized,
            ...computeSale(normalized),
          };
        });
      });
      setSuccessMessage('Reparation locale OK (pays/drapeaux/transactions).');
    } catch (error) {
      setErrorMessage(`Reparation impossible: ${String((error as Error).message)}`);
    }
  };

  const clearCloudStoreKey = () => {
    clearSupabaseStoreId();
    setCloudStoreId('');
    setCloudKeyModalOpen(false);
    setSuccessMessage('Cle cloud effacee (mode local).');
    setErrorMessage('');
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

          {cloudBackendAvailable && (
            <button
              type="button"
              className="sm-icon-btn"
              onClick={() => setCloudKeyModalOpen(true)}
              title={cloudEnabled ? 'Cle cloud configuree' : 'Configurer la cle cloud'}
            >
              {cloudEnabled ? '🔑' : '⚠'}
            </button>
          )}

          <nav className="sm-tabs">
            <button
              type="button"
              className={`sm-tab ${activeTab === 'dashboard' ? 'active' : ''}`}
              onClick={() => setActiveTab('dashboard')}
            >
              Dashboard
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

      {cloudConflict && (
        <div className="sm-modal-overlay" role="dialog" aria-modal="true">
          <div className="sm-modal sm-cloud-conflict-modal">
            <div className="sm-modal-head">
              <h3>Conflit Supabase</h3>
              <button type="button" className="sm-close" onClick={dismissCloudConflict} aria-label="Fermer">
                ×
              </button>
            </div>

            <p className="sm-muted">
              Deux etats differents existent entre ce navigateur (local) et Supabase (cloud). Pour eviter toute perte de
              donnees, l'auto-sync est suspendu tant que tu ne choisis pas.
            </p>

            <div className="sm-cloud-conflict-grid">
              <article className="sm-cloud-conflict-card">
                <h4>Local</h4>
                <p>
                  <strong>{formatDateTime(cloudConflict.local_summary.generated_at)}</strong>
                </p>
                <p className="sm-muted">
                  {cloudConflict.local_summary.orders} commande(s) | {cloudConflict.local_summary.sales_lines} ligne(s)
                </p>
                <p className="sm-muted">
                  CA {formatMoney(cloudConflict.local_summary.revenue)} | Marge {formatMoney(cloudConflict.local_summary.net_margin)}
                </p>
              </article>

              <article className="sm-cloud-conflict-card">
                <h4>Cloud</h4>
                <p>
                  <strong>{formatDateTime(cloudConflict.cloud_summary.generated_at)}</strong>
                </p>
                <p className="sm-muted">
                  {cloudConflict.cloud_summary.orders} commande(s) | {cloudConflict.cloud_summary.sales_lines} ligne(s)
                </p>
                <p className="sm-muted">
                  CA {formatMoney(cloudConflict.cloud_summary.revenue)} | Marge {formatMoney(cloudConflict.cloud_summary.net_margin)}
                </p>
              </article>
            </div>

            <div className="sm-modal-actions">
              <button type="button" className="sm-primary-btn" onClick={() => void resolveCloudConflictUseCloud()}>
                Restaurer cloud
              </button>
              <button type="button" className="sm-danger-btn" onClick={() => void resolveCloudConflictUseLocal()}>
                Publier local (ecrase cloud)
              </button>
              <button type="button" className="sm-btn" onClick={dismissCloudConflict}>
                Plus tard
              </button>
            </div>
          </div>
        </div>
      )}

      {cloudKeyModalOpen && (
        <div
          className="sm-modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => setCloudKeyModalOpen(false)}
        >
          <div className="sm-modal sm-cloud-key-modal" onClick={(event) => event.stopPropagation()}>
            <div className="sm-modal-head">
              <h3>Cle cloud (Supabase)</h3>
              <button type="button" className="sm-close" onClick={() => setCloudKeyModalOpen(false)} aria-label="Fermer">
                ×
              </button>
            </div>

            <p className="sm-muted">
              Cette cle est un secret partage: elle controle l'acces aux donnees cloud via RLS. Ne la mets jamais dans le
              code, et partage-la uniquement a ton equipe.
            </p>

            <div className="sm-form-grid sm-cloud-key-grid">
              <label className="full">
                <span>Store key</span>
                <input
                  type="password"
                  value={cloudKeyDraft}
                  onChange={(event) => setCloudKeyDraft(event.target.value)}
                  placeholder="Ex: sm-... (long/aleatoire)"
                  autoComplete="off"
                />
                <small className="sm-muted">
                  Statut: {cloudEnabled ? 'activee' : hasSupabaseStoreId() ? 'enregistree (recharge si besoin)' : 'non configuree'}.
                </small>
              </label>

              <label className="full sm-checkbox">
                <input
                  type="checkbox"
                  checked={cloudAutoSyncEnabled}
                  onChange={(event) => setCloudAutoSyncEnabled(event.target.checked)}
                />
                Auto-sync cloud (deconseille). Laisse OFF si tu veux zero surprise.
              </label>
            </div>

            <div className="sm-modal-actions">
              <button type="button" className="sm-btn" onClick={generateCloudStoreKey}>
                Generer
              </button>
              <button
                type="button"
                className="sm-btn"
                onClick={() => {
                  void navigator.clipboard?.writeText(cloudKeyDraft);
                  setSuccessMessage('Cle copiee.');
                }}
                disabled={!cloudKeyDraft.trim()}
              >
                Copier
              </button>
              <button type="button" className="sm-primary-btn" onClick={saveCloudStoreKey} disabled={!cloudKeyDraft.trim()}>
                Enregistrer
              </button>
              <button type="button" className="sm-danger-btn" onClick={clearCloudStoreKey} disabled={!hasSupabaseStoreId()}>
                Effacer
              </button>
              <button type="button" className="sm-btn" onClick={repairLocalData}>
                Reparer local
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'sales' && (
        <section className="sm-panel">
          <div className="sm-toolbar">
            <button type="button" className="sm-primary-btn" onClick={openCreateModal}>
              + Nouvelle vente
            </button>
            {cloudEnabled && (
              <button
                type="button"
                className="sm-btn"
                onClick={() => void handleManualCloudPull()}
                disabled={cloudPulling}
                title="Charger les dernières données depuis Supabase"
              >
                {cloudPulling ? '...' : '↓ Cloud'}
              </button>
            )}
            <button type="button" className="sm-btn" onClick={exportSalesCsv}>
              CSV ventes
            </button>
            <button type="button" className="sm-btn" onClick={exportCatalogCsv}>
              CSV stock
            </button>
            <details className="sm-advanced-menu">
              <summary className="sm-btn">Avance</summary>
              <div className="sm-advanced-menu-content">
                <button type="button" className="sm-btn" onClick={exportBackup}>
                  Backup JSON
                </button>
              </div>
            </details>
          </div>

          <div className="sm-filters">
            <label className="sm-filter-item">
              <span className="sm-filter-label">Canal</span>
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
            </label>

            <label className="sm-filter-item">
              <span className="sm-filter-label">Categorie</span>
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
            </label>

            <label className="sm-filter-item">
              <span className="sm-filter-label">Recherche</span>
              <input
                type="text"
                value={filters.query}
                onChange={(event) =>
                  setFilters((previous) => ({
                    ...previous,
                    query: event.target.value,
                  }))
                }
                placeholder="Client / Transaction # / produit"
              />
            </label>

            <label className="sm-filter-item">
              <span className="sm-filter-label">Date debut</span>
              <div className="sm-filter-date-row">
                <input
                  type="date"
                  value={filters.date_from}
                  onChange={(event) =>
                    setFilters((previous) => ({
                      ...previous,
                      date_from: event.target.value,
                    }))
                  }
                  aria-label="Date debut"
                />
                <button
                  type="button"
                  className="sm-filter-reset-btn"
                  onClick={() =>
                    setFilters((previous) => ({
                      ...previous,
                      date_from: '',
                    }))
                  }
                  disabled={!filters.date_from}
                  title="Effacer date debut"
                  aria-label="Effacer date debut"
                >
                  ×
                </button>
              </div>
            </label>

            <label className="sm-filter-item">
              <span className="sm-filter-label">Date fin</span>
              <div className="sm-filter-date-row">
                <input
                  type="date"
                  value={filters.date_to}
                  onChange={(event) =>
                    setFilters((previous) => ({
                      ...previous,
                      date_to: event.target.value,
                    }))
                  }
                  aria-label="Date fin"
                />
                <button
                  type="button"
                  className="sm-filter-reset-btn"
                  onClick={() =>
                    setFilters((previous) => ({
                      ...previous,
                      date_to: '',
                    }))
                  }
                  disabled={!filters.date_to}
                  title="Effacer date fin"
                  aria-label="Effacer date fin"
                >
                  ×
                </button>
              </div>
            </label>

            <label className="sm-filter-item">
              <span className="sm-filter-label">Stock</span>
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
                  <th>Client</th>
                  <th>Transaction / CC</th>
                  <th>Tracking</th>
                  <th>Canal</th>
                  <th>Produits</th>
                  <th className="sm-num">Qte</th>
                  <th className="sm-num">PV unit HT</th>
                  <th className="sm-num">Total HT</th>
                  <th className="sm-num">Valeur TX</th>
                  <th className="sm-num">Fees Platform</th>
                  <th className="sm-num">Fees Stripe</th>
                  <th className="sm-num">Net recu</th>
                  <th className="sm-num">Marge nette</th>
                  <th className="sm-num">Marge %</th>
                  <th>PJ</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {groupByOrder
                  ? groupedOrders.map((order) => (
                      <tr key={order.key} className="sm-click-row" onClick={() => openEditOrderModal(order)}>
                        <td>{order.date}</td>
                        <td>
                          {order.customer_country ? `${countryToFlag(order.customer_country)} ` : ''}
                          {order.client_or_tx}
                        </td>
                        <td>
                          <div className="sm-tx-cell">
                            <span className="sm-cell-main">
                              {buildTransactionDisplay(order.transaction_ref, order.order_number)}
                            </span>
                          </div>
                        </td>
                        <td className="sm-tracking-cell">
                          {renderTrackingLinks(order.tracking_numbers, order.shipping_provider)}
                          {renderTrackingMeta(
                            order.shipping_provider,
                            order.shipping_status,
                            order.shipping_event_at,
                            order.shipping_proof_url,
                            order.tracking_numbers,
                            order.shipping_tracking_url,
                            false,
                          )}
                          {renderShippingDocLinks(
                            order.shipping_tracking_url,
                            order.shipping_label_url,
                            order.shipping_proof_url,
                            order.invoice_url,
                            order.tracking_numbers,
                            order.shipping_provider,
                          )}
                        </td>
                        <td>
                          <span className="sm-chip">{order.channel}</span>
                        </td>
                        <td>
                          {order.product_display}
                          {order.out_stock_refs.length > 0 && (
                            <small className="sm-stock-ref-hint ko">
                              Rupture: {order.out_stock_refs.join(', ')}
                            </small>
                          )}
                          {order.out_stock_refs.length === 0 && order.low_stock_refs.length > 0 && (
                            <small className="sm-stock-ref-hint warn">
                              Stock faible: {order.low_stock_refs.join(', ')}
                            </small>
                          )}
                        </td>
                        <td className="sm-num">{order.quantity}</td>
                        <td className="sm-num">{formatMoney(order.sell_price_unit_ht)}</td>
                        <td className="sm-num">{formatMoney(order.sell_total_ht)}</td>
                        <td className="sm-num">{formatMoney(order.transaction_value)}</td>
                        <td className="sm-num">{formatMoney(order.commission_eur)}</td>
                        <td className="sm-num">{formatMoney(order.payment_fee)}</td>
                        <td className="sm-num">{formatMoney(order.net_received)}</td>
                        <td className={`sm-num ${order.net_margin >= 0 ? 'ok' : 'ko'}`}>{formatMoney(order.net_margin)}</td>
                        <td className={`sm-num ${order.net_margin_pct >= 0 ? 'ok' : 'ko'}`}>{formatPercent(order.net_margin_pct)}</td>
                        <td>{order.attachments_count}</td>
                        <td className="sm-row-actions">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              openEditOrderModal(order);
                            }}
                            title="Modifier la commande complete et tous ses produits"
                          >
                            Editer commande
                          </button>
                        </td>
                      </tr>
                    ))
                  : filteredSales.map((sale) => (
                      <tr key={sale.id} className="sm-click-row" onClick={() => openEditModal(sale)}>
                        <td>{sale.date}</td>
                        <td>
                          {sale.customer_country ? `${countryToFlag(sale.customer_country)} ` : ''}
                          {sale.client_or_tx}
                        </td>
                        <td>
                          <div className="sm-tx-cell">
                            <span className="sm-cell-main">
                              {buildTransactionDisplay(sale.transaction_ref || '', extractZohoOrderNumber(sale.id))}
                            </span>
                          </div>
                        </td>
                        <td className="sm-tracking-cell">
                          {renderTrackingLinks(sale.tracking_numbers, sale.shipping_provider)}
                          {renderTrackingMeta(
                            sale.shipping_provider,
                            sale.shipping_status,
                            sale.shipping_event_at,
                            sale.shipping_proof_url,
                            sale.tracking_numbers,
                            sale.shipping_tracking_url,
                            false,
                          )}
                          {renderShippingDocLinks(
                            sale.shipping_tracking_url,
                            sale.shipping_label_url,
                            sale.shipping_proof_url,
                            sale.invoice_url,
                            sale.tracking_numbers,
                            sale.shipping_provider,
                          )}
                        </td>
                        <td>
                          <span className="sm-chip">{sale.channel}</span>
                        </td>
                        <td>{sale.product_ref}</td>
                        <td className="sm-num">{sale.quantity}</td>
                        <td className="sm-num">{formatMoney(sale.sell_price_unit_ht)}</td>
                        <td className="sm-num">{formatMoney(sale.sell_total_ht)}</td>
                        <td className="sm-num">{formatMoney(sale.transaction_value)}</td>
                        <td className="sm-num">
                          {formatMoney(sale.commission_eur)}
                          <small> ({sale.commission_rate_display})</small>
                        </td>
                        <td className="sm-num">{formatMoney(sale.payment_fee)}</td>
                        <td className="sm-num">{formatMoney(sale.net_received)}</td>
                        <td className={`sm-num ${sale.net_margin >= 0 ? 'ok' : 'ko'}`}>{formatMoney(sale.net_margin)}</td>
                        <td className={`sm-num ${sale.net_margin_pct >= 0 ? 'ok' : 'ko'}`}>{formatPercent(sale.net_margin_pct)}</td>
                        <td>{sale.attachments.length}</td>
                        <td className="sm-row-actions">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              openCreateLinkedModal(sale);
                            }}
                            title="Ajouter une nouvelle ligne produit pour ce client"
                          >
                            Ajouter produit
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              openEditModal(sale);
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleDeleteSale(sale.id);
                            }}
                          >
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
              <p>Commandes affichees</p>
              <strong>{groupedOrders.length}</strong>
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
              <p>Articles vendus</p>
              <strong>{kpis.totalMaterialsSold}</strong>
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

      <div className="sm-chat-fab-wrap">
        {!chatOpen && (
          <button type="button" className="sm-chat-fab" onClick={toggleChatOpen} title="Messagerie interne">
            💬 Chat
            {chatUnreadCount > 0 && <span className="sm-chat-badge">{chatUnreadCount}</span>}
          </button>
        )}

        {chatOpen && (
          <section className="sm-chat-dock">
            <div className="sm-chat-dock-head">
              <div>
                <h3>Messagerie equipe</h3>
                <p>Interne a votre Store ID</p>
              </div>
              <div className="sm-chat-dock-head-actions">
                {desktopNotifsSupported ? (
                  <button
                    type="button"
                    className="sm-btn"
                    onClick={() => void toggleDesktopNotifications()}
                    disabled={chatPushBusy}
                    title="Notifications desktop (app macOS): polling + notification native."
                  >
                    {desktopNotifsEnabled ? 'Notifs ON' : 'Notifs OFF'}
                  </button>
                ) : webPushSupported ? (
                  <button
                    type="button"
                    className="sm-btn"
                    onClick={() => void (chatPushEnabled ? disablePushNotifications() : enablePushNotifications())}
                    disabled={chatPushBusy}
                    title="Notifications push iPhone/macOS (PWA installee)"
                  >
                    {chatPushBusy ? '...' : chatPushEnabled ? 'Push ON' : 'Push OFF'}
                  </button>
                ) : (
                  <span className="sm-muted">Push non supporte ici</span>
                )}
                {webPushSupported && (
                  <button
                    type="button"
                    className="sm-btn"
                    onClick={() => void sendServerPushTest()}
                    disabled={chatPushBusy || !chatPushEnabled}
                    title="Envoie un push depuis le serveur (test)."
                  >
                    Ping
                  </button>
                )}
                <button
                  type="button"
                  className="sm-btn"
                  onClick={() => void sendLocalNotificationTest()}
                  disabled={chatPushBusy}
                  title="Test rapide: verifie que Chrome/macOS affiche bien les notifications."
                >
                  Test
                </button>
                <button type="button" className="sm-close" onClick={() => setChatOpen(false)}>
                  ×
                </button>
              </div>
            </div>
            <p className="sm-chat-push-note">
              iPhone: push disponible uniquement si l'app est ajoutee a l'ecran d'accueil.
            </p>

            <div className="sm-chat-list" ref={chatListRef}>
              {chatLoading && chatMessages.length === 0 ? (
                <p className="sm-muted">Chargement des messages...</p>
              ) : chatMessages.length === 0 ? (
                <p className="sm-muted">Aucun message. Lance la conversation.</p>
              ) : (
                chatMessages.map((message) => {
                  const isMine = message.device_id === chatDeviceId;
                  return (
                    <article key={message.id} className={`sm-chat-item ${isMine ? 'mine' : 'other'}`}>
                      <p className="sm-chat-author">{message.author}</p>
                      <p className="sm-chat-body">{renderChatMessageBody(message.body)}</p>
                      <time className="sm-chat-time">{formatDateTime(message.created_at)}</time>
                    </article>
                  );
                })
              )}
            </div>

            {chatAuthorEditing ? (
              <div className="sm-chat-identity-edit">
                <input
                  type="text"
                  value={chatAuthorDraft}
                  onChange={(event) => setChatAuthorDraft(event.target.value)}
                  placeholder="Choisir un prenom ou pseudo"
                  maxLength={60}
                />
                <button type="button" className="sm-primary-btn" onClick={saveChatAuthor}>
                  Valider
                </button>
              </div>
            ) : (
              <div className="sm-chat-identity">
                <span>Vous: {chatAuthor}</span>
                <button
                  type="button"
                  className="sm-btn"
                  onClick={() => {
                    setChatAuthorDraft(chatAuthor);
                    setChatAuthorEditing(true);
                  }}
                >
                  Modifier pseudo
                </button>
              </div>
            )}

            <form className="sm-chat-form" onSubmit={handleSendChatMessage}>
              <div className="sm-chat-compose">
                <input
                  ref={chatDraftInputRef}
                  type="text"
                  value={chatDraft}
                  onChange={(event) => setChatDraft(event.target.value)}
                  placeholder="Ecrire un message... (utilise @REF)"
                  maxLength={4000}
                  required
                  disabled={chatAuthorEditing}
                />
                {!chatAuthorEditing && chatMentionSuggestions.length > 0 && (
                  <div className="sm-chat-mention-list">
                    {chatMentionSuggestions.map((ref) => (
                      <button
                        key={ref}
                        type="button"
                        className="sm-chat-mention-option"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => applyChatMention(ref)}
                      >
                        @{ref}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button type="submit" className="sm-primary-btn" disabled={chatSending || chatAuthorEditing}>
                {chatSending ? 'Envoi...' : 'Envoyer'}
              </button>
            </form>
          </section>
        )}
      </div>

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
                Client
                <input
                  type="text"
                  value={form.client_or_tx}
                  onChange={(event) => updateForm('client_or_tx', event.target.value)}
                  required
                />
              </label>

              <label>
                Transaction #
                <input
                  type="text"
                  value={form.transaction_ref}
                  onChange={(event) => updateForm('transaction_ref', event.target.value)}
                  placeholder="Ex: #A12345"
                  required
                />
              </label>

              <label>
                Pays client
                <select
                  value={form.customer_country}
                  onChange={(event) => {
                    const country = normalizeCountryIso(event.target.value);
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
                  <option value={COUNTRY_PLACEHOLDER}>Selectionner un pays</option>
                  {EUROPEAN_COUNTRY_OPTIONS.map((option) => (
                    <option key={option.iso} value={option.iso}>
                      {isoCodeToFlag(option.iso)} {option.name}
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
                <select
                  className="sm-catalog-select"
                  value={catalogMap.has(form.product_ref.trim()) ? form.product_ref.trim() : '__manual__'}
                  onChange={(event) => {
                    if (event.target.value !== '__manual__') {
                      applyCatalogProduct(event.target.value);
                    }
                  }}
                >
                  <option value="__manual__">Catalogue: reference libre</option>
                  {catalogByOrder.map((item) => (
                    <option key={item.ref} value={item.ref}>
                      {item.ref}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={form.product_ref}
                  onChange={(event) => applyCatalogProduct(event.target.value)}
                  list="catalog-products"
                  placeholder="Reference produit"
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
                      <button type="button" onClick={() => openAttachmentPreview(attachment)}>
                        Voir
                      </button>
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

      {orderModalOpen && orderForm && (
        <div className="sm-modal-overlay" role="dialog" aria-modal="true">
          <form className="sm-modal" onSubmit={handleSubmitOrder}>
            <div className="sm-modal-head">
              <h3>Editer commande</h3>
              <button type="button" className="sm-close" onClick={closeOrderModal}>
                ×
              </button>
            </div>

            <div className="sm-form-grid">
              <label>
                Date
                <input
                  type="date"
                  value={orderForm.date}
                  onChange={(event) => updateOrderHeader('date', event.target.value)}
                  required
                />
              </label>
              <label>
                Client
                <input
                  type="text"
                  value={orderForm.client_or_tx}
                  onChange={(event) => updateOrderHeader('client_or_tx', event.target.value)}
                  required
                />
              </label>
              <label>
                Transaction #
                <input
                  type="text"
                  value={orderForm.transaction_ref}
                  onChange={(event) => updateOrderHeader('transaction_ref', event.target.value)}
                  required
                />
              </label>
              <label>
                Commande (CC)
                <input type="text" value={orderForm.order_number || '-'} readOnly />
              </label>
              <label>
                Pays client
                <select
                  value={orderForm.customer_country}
                  onChange={(event) => updateOrderHeader('customer_country', normalizeCountryIso(event.target.value))}
                  required
                >
                  <option value={COUNTRY_PLACEHOLDER}>Selectionner un pays</option>
                  {EUROPEAN_COUNTRY_OPTIONS.map((option) => (
                    <option key={option.iso} value={option.iso}>
                      {isoCodeToFlag(option.iso)} {option.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Canal
                <select
                  value={orderForm.channel}
                  onChange={(event) => {
                    const channel = event.target.value as Channel;
                    setOrderForm((previous) => {
                      if (!previous) {
                        return previous;
                      }
                      return {
                        ...previous,
                        channel,
                        lines: previous.lines.map((line) => ({
                          ...line,
                          power_wp: isPowerWpRequired(channel, line.category) ? line.power_wp : null,
                        })),
                      };
                    });
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
                  value={orderForm.payment_method}
                  onChange={(event) => updateOrderHeader('payment_method', event.target.value as PaymentMethod)}
                >
                  {PAYMENT_METHODS.map((method) => (
                    <option key={method} value={method}>
                      {method}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Tracking(s)
                <input
                  type="text"
                  value={orderForm.tracking_numbers.join(', ')}
                  onChange={(event) =>
                    updateOrderHeader('tracking_numbers', parseTrackingNumbersFromInput(event.target.value))
                  }
                  placeholder="1Z... , 1Z..."
                />
              </label>
              <label>
                Transporteur
                <input
                  type="text"
                  value={orderForm.shipping_provider ?? ''}
                  onChange={(event) => updateOrderHeader('shipping_provider', normalizeOptionalText(event.target.value))}
                  placeholder="UPS / DHL / FedEx"
                />
              </label>
              <label>
                Statut livraison
                <select
                  value={orderForm.shipping_status ?? ''}
                  onChange={(event) =>
                    updateOrderHeader('shipping_status', normalizeShippingStatus(event.target.value) ?? null)
                  }
                >
                  <option value="">Aucun</option>
                  {SHIPPING_STATUS_OPTIONS.map((status) => (
                    <option key={status} value={status}>
                      {formatShippingStatus(status)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Derniere MAJ transport
                <input type="text" value={orderForm.shipping_event_at ? formatDateTime(orderForm.shipping_event_at) : '-'} readOnly />
              </label>
              <label>
                Lien suivi
                <input
                  type="url"
                  value={orderForm.shipping_tracking_url ?? ''}
                  onChange={(event) =>
                    updateOrderHeader('shipping_tracking_url', normalizeOptionalText(event.target.value))
                  }
                  placeholder="https://..."
                />
              </label>
              <label>
                Lien etiquette
                <input
                  type="url"
                  value={orderForm.shipping_label_url ?? ''}
                  onChange={(event) =>
                    updateOrderHeader('shipping_label_url', normalizeOptionalText(event.target.value))
                  }
                  placeholder="https://..."
                />
              </label>
              <label>
                Preuve de livraison (URL)
                <input
                  type="url"
                  value={orderForm.shipping_proof_url ?? ''}
                  onChange={(event) =>
                    updateOrderHeader('shipping_proof_url', normalizeOptionalText(event.target.value))
                  }
                  placeholder="https://..."
                />
              </label>
              <label>
                Facture (URL)
                <input
                  type="url"
                  value={orderForm.invoice_url ?? ''}
                  onChange={(event) => updateOrderHeader('invoice_url', normalizeOptionalText(event.target.value))}
                  placeholder="https://..."
                />
              </label>
              <label className="full">
                Liens logistiques
                <div className="sm-inline-links">
                  {renderShippingDocLinks(
                    orderForm.shipping_tracking_url,
                    orderForm.shipping_label_url,
                    orderForm.shipping_proof_url,
                    orderForm.invoice_url,
                    orderForm.tracking_numbers,
                    orderForm.shipping_provider,
                  ) ?? <span className="sm-muted">Aucun lien disponible.</span>}
                </div>
                <div className="sm-inline-actions">
                  <button
                    type="button"
                    className="sm-btn"
                    onClick={() => void importOrderAttachmentFromUrl(orderForm.shipping_label_url, 'etiquette-envia.pdf')}
                  >
                    Importer etiquette en PJ
                  </button>
                  <button
                    type="button"
                    className="sm-btn"
                    onClick={() => void importOrderAttachmentFromUrl(orderForm.shipping_proof_url, 'preuve-livraison-envia.pdf')}
                  >
                    Importer preuve en PJ
                  </button>
                  <button
                    type="button"
                    className="sm-btn"
                    onClick={() => void importOrderAttachmentFromUrl(orderForm.invoice_url, 'facture-commande.pdf')}
                  >
                    Importer facture en PJ
                  </button>
                </div>
              </label>
              <label>
                Prix transport commande HT (EUR)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={orderForm.shipping_charged_order}
                  onChange={(event) => updateOrderHeader('shipping_charged_order', toNumber(event.target.value))}
                  required
                />
              </label>
              <label>
                Cout transport commande HT (EUR)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={orderForm.shipping_real_order}
                  onChange={(event) => updateOrderHeader('shipping_real_order', toNumber(event.target.value))}
                  required
                />
              </label>
            </div>

            <p className="sm-footnote">
              France: TTC applique automatiquement (TVA 20%) a partir des montants HT.
            </p>
            <p className="sm-footnote">
              PA unit = prix achat unitaire EUR (auto catalogue si la reference est reconnue).
            </p>
            <p className="sm-footnote">
              Les transports sont saisis au niveau commande puis repartis automatiquement sur les lignes pour le calcul.
            </p>
            <div className="sm-toolbar">
              <button type="button" className="sm-btn" onClick={addOrderLine}>
                + Ajouter produit
              </button>
            </div>

            {orderPreviewComputed && (
              <div className="sm-order-summary">
                <div>
                  <p>Total HT lignes</p>
                  <strong>{formatMoney(round2(orderPreviewComputed.sell_total_ht))}</strong>
                </div>
                <div>
                  <p>Valeur TX (HT + port)</p>
                  <strong>{formatMoney(round2(orderPreviewComputed.transaction_value))}</strong>
                </div>
                <div>
                  <p>Fees Platform / Stripe</p>
                  <strong>
                    {formatMoney(round2(orderPreviewComputed.commission_eur))} / {formatMoney(round2(orderPreviewComputed.payment_fee))}
                  </strong>
                </div>
                <div>
                  <p>Net recu / Marge nette</p>
                  <strong className={orderPreviewComputed.net_margin >= 0 ? 'ok' : 'ko'}>
                    {formatMoney(round2(orderPreviewComputed.net_received))} / {formatMoney(round2(orderPreviewComputed.net_margin))}
                  </strong>
                </div>
              </div>
            )}

            <div className="sm-table-wrap sm-order-lines-wrap">
              <table className="sm-table sm-order-lines-table">
                <colgroup>
                  <col className="sm-col-product" />
                  <col className="sm-col-category" />
                  <col className="sm-col-qty" />
                  <col className="sm-col-pa" />
                  <col className="sm-col-pv-ht" />
                  <col className="sm-col-pv-ttc" />
                  <col className="sm-col-action" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Produit</th>
                    <th>Categorie</th>
                    <th className="sm-num">Qte</th>
                    <th className="sm-num">PA unit (achat)</th>
                    <th className="sm-num">PV unit HT (vente)</th>
                    <th className="sm-num">PV unit TTC</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {orderForm.lines.map((line) => {
                    const lineRef = line.product_ref.trim();
                    const lineCatalogProduct = catalogMap.get(lineRef) ?? null;
                    const lineStock = lineCatalogProduct ? (stock[lineCatalogProduct.ref] ?? lineCatalogProduct.initial_stock) : null;
                    const autoHint = lineCatalogProduct
                      ? `Auto: ${lineCatalogProduct.category} | PA ${formatMoney(lineCatalogProduct.buy_price_unit)} | Stock ${lineStock ?? '-'}`
                      : 'Saisir une reference catalogue pour auto-remplir categorie, PA et stock.';

                    return (
                      <tr key={line.id}>
                        <td data-label="Produit">
                          <select
                            className="sm-catalog-select"
                            value={lineCatalogProduct ? lineCatalogProduct.ref : '__manual__'}
                            onChange={(event) => {
                              if (event.target.value !== '__manual__') {
                                updateOrderLineProduct(line.id, event.target.value);
                              }
                            }}
                          >
                            <option value="__manual__">Catalogue: reference libre</option>
                            {catalogByOrder.map((item) => (
                              <option key={item.ref} value={item.ref}>
                                {item.ref}
                              </option>
                            ))}
                          </select>
                          <input
                            className="sm-order-product-input"
                            type="text"
                            value={line.product_ref}
                            list="catalog-products-order"
                            onChange={(event) => updateOrderLineProduct(line.id, event.target.value)}
                            placeholder="Reference produit"
                            title={autoHint}
                            required
                          />
                        </td>
                        <td data-label="Categorie">
                          <select
                            value={line.category}
                            onChange={(event) => {
                              const category = event.target.value as Category;
                              updateOrderLine(line.id, 'category', category);
                              if (!isPowerWpRequired(orderForm.channel, category)) {
                                updateOrderLine(line.id, 'power_wp', null);
                              }
                            }}
                          >
                            {CATEGORIES.map((category) => (
                              <option key={category} value={category}>
                                {category}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="sm-num" data-label="Qte">
                          <input
                            type="number"
                            min="1"
                            value={line.quantity}
                            onChange={(event) => updateOrderLine(line.id, 'quantity', Math.max(1, toNumber(event.target.value)))}
                            required
                          />
                        </td>
                        <td className="sm-num" data-label="PA unit (achat)">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={line.buy_price_unit}
                            onChange={(event) => updateOrderLine(line.id, 'buy_price_unit', toNumber(event.target.value))}
                            title="PA unit = prix d achat unitaire EUR."
                            required
                          />
                        </td>
                        <td className="sm-num" data-label="PV unit HT (vente)">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={line.sell_price_unit_ht}
                            onChange={(event) => updateOrderLine(line.id, 'sell_price_unit_ht', toNumber(event.target.value))}
                            required
                          />
                        </td>
                        <td className="sm-num" data-label="PV unit TTC">
                          <span className="sm-readonly-cell">
                            {isFranceCustomer(orderForm.customer_country) ? formatMoney(applyFranceVat(line.sell_price_unit_ht)) : '-'}
                          </span>
                        </td>
                        <td data-label="Action">
                          <button
                            type="button"
                            className="sm-btn"
                            onClick={() => removeOrderLine(line.id)}
                          >
                            Supprimer
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <datalist id="catalog-products-order">
                {sortedCatalog.map((item) => (
                  <option key={item.ref} value={item.ref} />
                ))}
              </datalist>
            </div>

            <div className="sm-attachments">
              <div className="sm-attach-head">
                <span>Pieces jointes commande</span>
                <label className="sm-btn">
                  + Ajouter
                  <input
                    type="file"
                    multiple
                    className="sm-hidden"
                    onChange={(event) => {
                      void handleOrderAttachmentFiles(event.target.files);
                      event.currentTarget.value = '';
                    }}
                  />
                </label>
              </div>
              {orderForm.attachments.length === 0 ? (
                <p className="sm-muted">Aucune PJ.</p>
              ) : (
                orderForm.attachments.map((attachment) => (
                  <div key={attachment.id} className="sm-attach-row">
                    <span>
                      {attachment.name} ({Math.round(attachment.size / 1024)} KB)
                    </span>
                    <div>
                      <button type="button" onClick={() => openAttachmentPreview(attachment)}>
                        Voir
                      </button>
                      <button type="button" onClick={() => downloadAttachment(attachment)}>
                        Download
                      </button>
                      <button type="button" onClick={() => removeOrderAttachment(attachment.id)}>
                        Supprimer
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="sm-modal-actions">
              <button type="button" className="sm-btn" onClick={closeOrderModal}>
                Annuler
              </button>
              <button type="submit" className="sm-primary-btn">
                Enregistrer commande
              </button>
            </div>
          </form>
        </div>
      )}

      {previewAttachmentItem && previewAttachmentUrl && (
        <div className="sm-modal-overlay sm-preview-overlay" role="dialog" aria-modal="true">
          <div className="sm-modal sm-preview-modal">
            <div className="sm-modal-head">
              <h3>{previewAttachmentItem.name}</h3>
              <button type="button" className="sm-close" onClick={closeAttachmentPreview}>
                ×
              </button>
            </div>
            <div className="sm-preview-content">
              {isImageAttachment(previewAttachmentItem) && (
                <img src={previewAttachmentUrl} alt={previewAttachmentItem.name} className="sm-preview-media" />
              )}
              {isPdfAttachment(previewAttachmentItem) && (
                <object data={previewAttachmentUrl} type="application/pdf" className="sm-preview-media">
                  <iframe src={previewAttachmentUrl} title={previewAttachmentItem.name} className="sm-preview-media" />
                </object>
              )}
              {!isImageAttachment(previewAttachmentItem) && !isPdfAttachment(previewAttachmentItem) && (
                <div className="sm-preview-fallback">
                  <p>Previsualisation indisponible pour ce format.</p>
                  <button type="button" className="sm-btn" onClick={() => downloadAttachment(previewAttachmentItem)}>
                    Download
                  </button>
                </div>
              )}
            </div>
            <div className="sm-modal-actions">
              <button type="button" className="sm-btn" onClick={closeAttachmentPreview}>
                Fermer
              </button>
              <button type="button" className="sm-primary-btn" onClick={() => downloadAttachment(previewAttachmentItem)}>
                Download
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDialog && (
        <div className="sm-modal-overlay sm-confirm-overlay" role="dialog" aria-modal="true" onClick={closeConfirmDialog}>
          <div className={`sm-modal sm-confirm-modal sm-confirm-${confirmDialog.tone}`} onClick={(event) => event.stopPropagation()}>
            <div className="sm-confirm-headline">
              <span className={`sm-confirm-icon sm-confirm-icon-${confirmDialog.tone}`} aria-hidden="true">
                {CONFIRM_TONE_META[confirmDialog.tone].icon}
              </span>
              <div>
                <h3>{confirmDialog.title}</h3>
                <p className="sm-confirm-subtitle">{CONFIRM_TONE_META[confirmDialog.tone].subtitle}</p>
              </div>
              <button type="button" className="sm-close" onClick={closeConfirmDialog}>
                ×
              </button>
            </div>
            <p className="sm-confirm-message">{confirmDialog.message}</p>
            <div className="sm-modal-actions">
              <button type="button" className="sm-btn" onClick={closeConfirmDialog}>
                Annuler
              </button>
              <button
                type="button"
                className={confirmDialog.tone === 'danger' ? 'sm-danger-btn' : 'sm-primary-btn'}
                onClick={submitConfirmDialog}
              >
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
