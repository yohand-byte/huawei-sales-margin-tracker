import { createClient } from 'npm:@supabase/supabase-js@2.95.3';

type Channel = 'Sun.store' | 'Solartraders' | 'Direct' | 'Other';
type PaymentMethod = 'Stripe' | 'Wire' | 'PayPal' | 'Cash';
type Category = 'Inverters' | 'Solar Panels' | 'Batteries' | 'Accessories';

interface Attachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  base64: string;
}

interface SaleInput {
  date: string;
  client_or_tx: string;
  transaction_ref: string;
  channel: Channel;
  customer_country: string;
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

interface SaleComputed {
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

interface Sale extends SaleInput, SaleComputed {
  id: string;
  created_at: string;
  updated_at: string;
}

interface BackupPayload {
  generated_at: string;
  sales: Sale[];
  catalog: unknown[];
  stock: Record<string, number>;
}

interface EnviaShipmentEvent {
  transaction_ref: string;
  order_number: string | null;
  tracking_numbers: string[];
  tracking_number: string | null;
  carrier: string | null;
  status: string | null;
  shipping_cost_ttc: number | null;
  occurred_at: string | null;
  source_event_id: string | null;
  tracking_url: string | null;
  label_url: string | null;
  proof_url: string | null;
}

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, x-store-id, x-envia-webhook-token',
  'access-control-allow-methods': 'POST, OPTIONS',
};

const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'content-type': 'application/json',
    },
  });

const round2 = (v: number): number => Math.round((Number.isFinite(v) ? v : 0) * 100) / 100;

interface RateTier {
  min: number;
  max: number | null;
  stripe: number;
  wire: number;
}

const inverterBatteryTiers: RateTier[] = [
  { min: 0, max: 5000, stripe: 0.0399, wire: 0.0519 },
  { min: 5000, max: 10000, stripe: 0.0365, wire: 0.0474 },
  { min: 10000, max: 25000, stripe: 0.0314, wire: 0.0393 },
  { min: 25000, max: 80000, stripe: 0.0261, wire: 0.0326 },
  { min: 80000, max: 150000, stripe: 0.0179, wire: 0.0206 },
  { min: 150000, max: null, stripe: 0.0103, wire: 0.0118 },
];
const solarPanelTiers: RateTier[] = [
  { min: 0, max: 5000, stripe: 0.0299, wire: 0.0389 },
  { min: 5000, max: 10000, stripe: 0.0276, wire: 0.0359 },
  { min: 10000, max: 25000, stripe: 0.0226, wire: 0.0282 },
  { min: 25000, max: 80000, stripe: 0.0181, wire: 0.0226 },
  { min: 80000, max: 150000, stripe: 0.0131, wire: 0.0151 },
  { min: 150000, max: null, stripe: 0.0084, wire: 0.0097 },
];
const accessoriesTiers: RateTier[] = [
  { min: 0, max: 5000, stripe: 0.0488, wire: 0.0634 },
  { min: 5000, max: 10000, stripe: 0.0421, wire: 0.0547 },
  { min: 10000, max: 25000, stripe: 0.0363, wire: 0.0454 },
  { min: 25000, max: 80000, stripe: 0.0301, wire: 0.0376 },
  { min: 80000, max: 100000, stripe: 0.0206, wire: 0.0237 },
  { min: 100000, max: null, stripe: 0.0119, wire: 0.0137 },
];

const fmtRate = (rate: number): string => `${round2(rate * 100)}%`;

const roundUp2 = (v: number): number => {
  if (v <= 0) return round2(v);
  return Math.ceil(v * 100) / 100;
};

const pickTier = (value: number, tiers: RateTier[]): RateTier =>
  tiers.find((tier) => value >= tier.min && (tier.max === null || value < tier.max)) ?? tiers[tiers.length - 1];

function computeCommission(
  channel: Channel,
  category: Category,
  paymentMethod: PaymentMethod,
  transactionValue: number,
  powerWp: number | null,
): { commission_rate_display: string; commission_eur: number; payment_fee: number } {
  if (channel === 'Sun.store') {
    const tiers =
      category === 'Solar Panels'
        ? solarPanelTiers
        : category === 'Accessories'
          ? accessoriesTiers
          : inverterBatteryTiers;
    const tier = pickTier(transactionValue, tiers);
    const rate = paymentMethod === 'Wire' ? tier.wire : tier.stripe;
    const rawCommission = transactionValue * rate;
    return {
      commission_rate_display: fmtRate(rate),
      commission_eur: paymentMethod === 'Stripe' ? roundUp2(rawCommission) : round2(rawCommission),
      payment_fee: paymentMethod === 'Stripe' ? 5 : 0,
    };
  }

  if (channel === 'Solartraders') {
    if (category !== 'Solar Panels') {
      return {
        commission_rate_display: '5%',
        commission_eur: round2(transactionValue * 0.05),
        payment_fee: 0,
      };
    }
    const wp = powerWp ?? 0;
    return wp >= 1_000_000
      ? { commission_rate_display: '1 cent/Wp', commission_eur: round2(wp * 0.01), payment_fee: 0 }
      : { commission_rate_display: '1.5 cent/Wp', commission_eur: round2(wp * 0.015), payment_fee: 0 };
  }

  return {
    commission_rate_display: '0%',
    commission_eur: 0,
    payment_fee: 0,
  };
}

function computeSale(input: SaleInput): SaleComputed {
  const sellTotalHt = round2(input.quantity * input.sell_price_unit_ht);
  const transactionValue = round2(sellTotalHt + input.shipping_charged);
  const commission = computeCommission(
    input.channel,
    input.category,
    input.payment_method,
    transactionValue,
    input.power_wp,
  );
  const netReceived = round2(transactionValue - commission.commission_eur - commission.payment_fee);
  const totalCost = round2(input.quantity * input.buy_price_unit + input.shipping_real);
  const grossMargin = round2(transactionValue - totalCost);
  const netMargin = round2(netReceived - totalCost);
  const netMarginPct = transactionValue <= 0 ? 0 : round2((netMargin / transactionValue) * 100);

  return {
    sell_total_ht: sellTotalHt,
    transaction_value: transactionValue,
    ...commission,
    net_received: netReceived,
    total_cost: totalCost,
    gross_margin: grossMargin,
    net_margin: netMargin,
    net_margin_pct: netMarginPct,
  };
}

function normalizeKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;

  let raw = value.trim();
  if (!raw) return null;
  raw = raw.replace(/\s/g, '').replace(/€/g, '');

  const hasComma = raw.includes(',');
  const hasDot = raw.includes('.');
  if (hasComma && hasDot) {
    const lastComma = raw.lastIndexOf(',');
    const lastDot = raw.lastIndexOf('.');
    if (lastComma > lastDot) {
      raw = raw.replace(/\./g, '').replace(',', '.');
    } else {
      raw = raw.replace(/,/g, '');
    }
  } else if (hasComma) {
    raw = raw.replace(',', '.');
  }

  raw = raw.replace(/[^0-9.-]/g, '');
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function findFirstByAliases(payload: unknown, aliases: string[]): unknown {
  const wanted = new Set(aliases.map(normalizeKey));
  const visited = new Set<unknown>();

  const visit = (value: unknown): unknown => {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (typeof value !== 'object') return undefined;
    if (visited.has(value)) return undefined;
    visited.add(value);

    const obj = value as Record<string, unknown>;
    for (const [key, val] of Object.entries(obj)) {
      if (wanted.has(normalizeKey(key)) && val !== null && val !== undefined && `${val}`.trim() !== '') {
        return val;
      }
    }
    for (const val of Object.values(obj)) {
      const found = visit(val);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  return visit(payload);
}

function findUrlByParentAliases(payload: unknown, parentAliases: string[]): string | null {
  const wanted = new Set(parentAliases.map(normalizeKey));
  const urlKeys = new Set(['url', 'link', 'href', 'download_url', 'pdf_url'].map(normalizeKey));
  const visited = new Set<unknown>();

  const extractUrlFromValue = (value: unknown): string | null => {
    if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) {
      return value.trim();
    }
    if (!value || typeof value !== 'object') return null;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (!urlKeys.has(normalizeKey(key))) continue;
      if (typeof nested === 'string' && /^https?:\/\//i.test(nested.trim())) {
        return nested.trim();
      }
    }
    return null;
  };

  const visit = (value: unknown): string | null => {
    if (!value || typeof value !== 'object') return null;
    if (visited.has(value)) return null;
    visited.add(value);

    const obj = value as Record<string, unknown>;
    for (const [key, nested] of Object.entries(obj)) {
      if (wanted.has(normalizeKey(key))) {
        const url = extractUrlFromValue(nested);
        if (url) return url;
      }
    }
    for (const nested of Object.values(obj)) {
      const found = visit(nested);
      if (found) return found;
    }
    return null;
  };

  return visit(payload);
}

function toTrackingNumbers(value: unknown): string[] {
  const sanitize = (rawValue: unknown): string => {
    if (rawValue === null || rawValue === undefined) return '';
    const normalized = String(rawValue).trim().replace(/\s+/g, '').toUpperCase();
    if (!normalized) return '';
    if (normalized.includes('TEST')) return '';
    if (/^X{6,}$/.test(normalized)) return '';
    if (/^1ZX{6,}$/.test(normalized)) return '';
    if (normalized.length < 8) return '';
    if (!/[0-9]/.test(normalized) || !/[A-Z]/.test(normalized)) return '';
    return normalized;
  };

  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of list) {
    if (item === null || item === undefined) continue;
    const raw = String(item)
      .split(/[;,\n]/)
      .map((part) => sanitize(part))
      .filter((part) => part.length > 0);
    out.push(...raw);
  }
  return Array.from(new Set(out));
}

function firstNonEmptyText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function parseEnviaEvent(payload: unknown): EnviaShipmentEvent {
  const transactionRefRaw = findFirstByAliases(payload, [
    'transaction_ref',
    'transaction_number',
    'reference_number',
    'reference',
    'order_reference',
    'order_number',
    'salesorder_number',
    'external_order_id',
    'external_reference',
    'client_reference',
    'imported_id',
    'order_id',
    'shipment_id',
    'shipment_number',
    'pedido',
    'numero_de_comande',
  ]);

  const trackingRaw = findFirstByAliases(payload, [
    'tracking_number',
    'tracking_numbers',
    'tracking',
    'tracking_no',
    'tracking_code',
    'carrier_tracking_number',
    'guide_number',
    'waybill',
    'awb',
  ]);

  const carrierRaw = findFirstByAliases(payload, [
    'carrier',
    'carrier_name',
    'carrier_code',
    'courier',
    'provider',
    'shipping_provider',
    'transport_service',
  ]);

  const statusRaw = findFirstByAliases(payload, [
    'status',
    'shipment_status',
    'tracking_status',
    'status_name',
    'state',
  ]);

  const shippingCostTtcRaw = findFirstByAliases(payload, [
    'shipping_cost_ttc',
    'shipping_total_ttc',
    'cost_ttc',
    'total_cost_ttc',
    'total_ttc',
    'cost_total',
    'shipping_cost',
    'shipment_cost',
    'cout_total',
    'coût_total',
    'price_total',
  ]);

  const occurredAtRaw = findFirstByAliases(payload, [
    'occurred_at',
    'event_at',
    'status_date',
    'updated_at',
    'created_at',
    'shipped_at',
    'timestamp',
  ]);

  const sourceEventRaw = findFirstByAliases(payload, ['event_id', 'id', 'webhook_id']);
  const trackingUrlRaw = findFirstByAliases(payload, [
    'tracking_url',
    'tracking_link',
    'tracking_page',
    'url_tracking',
    'tracking_public_url',
    'carrier_tracking_url',
  ]);
  const labelUrlRaw = findFirstByAliases(payload, [
    'label_url',
    'label_link',
    'etiquette_url',
    'shipping_label_url',
    'label_download_url',
    'shipping_label_download_url',
    'label_pdf_url',
    'etiquette_link',
  ]);
  const proofUrlRaw = findFirstByAliases(payload, [
    'proof_url',
    'proof_of_delivery_url',
    'pod_url',
    'delivery_proof_url',
    'delivery_receipt_url',
    'preuve_livraison_url',
    'justificatif_livraison_url',
  ]);

  const transactionRef = firstNonEmptyText(transactionRefRaw) ?? '';
  const orderNumber = extractOrderCodeFromText(transactionRef);
  const trackingNumbers = toTrackingNumbers(trackingRaw);

  return {
    transaction_ref: transactionRef,
    order_number: orderNumber,
    tracking_numbers: trackingNumbers,
    tracking_number: trackingNumbers[0] ?? null,
    carrier: firstNonEmptyText(carrierRaw),
    status: firstNonEmptyText(statusRaw),
    shipping_cost_ttc: parseNumber(shippingCostTtcRaw),
    occurred_at: firstNonEmptyText(occurredAtRaw),
    source_event_id: firstNonEmptyText(sourceEventRaw),
    tracking_url:
      firstNonEmptyText(trackingUrlRaw) ??
      findUrlByParentAliases(payload, ['tracking', 'tracking_info']),
    label_url:
      firstNonEmptyText(labelUrlRaw) ??
      findUrlByParentAliases(payload, ['label', 'etiquette', 'shipping_label', 'label_document']),
    proof_url:
      firstNonEmptyText(proofUrlRaw) ??
      findUrlByParentAliases(payload, ['proof', 'proof_of_delivery', 'delivery_proof', 'pod', 'preuve_livraison']),
  };
}

function allocateByWeight(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const safeTotal = round2(total);
  const totalCents = Math.round(safeTotal * 100);
  if (totalCents === 0) return new Array(weights.length).fill(0);

  const safeWeights = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const sumWeights = safeWeights.reduce((sum, w) => sum + w, 0);
  const effective = sumWeights > 0 ? safeWeights : new Array(weights.length).fill(1);
  const effectiveSum = effective.reduce((sum, w) => sum + w, 0);

  const rawShares = effective.map((w, idx) => {
    if (idx === effective.length - 1) {
      return totalCents;
    }
    return Math.floor((totalCents * w) / effectiveSum);
  });

  const assigned = rawShares.reduce((sum, value, idx) => (idx === rawShares.length - 1 ? sum : sum + value), 0);
  rawShares[rawShares.length - 1] = totalCents - assigned;
  return rawShares.map((cents) => round2(cents / 100));
}

function sameOrderGroup(a: Sale, b: Sale): boolean {
  return (
    a.date === b.date &&
    a.client_or_tx === b.client_or_tx &&
    a.transaction_ref === b.transaction_ref &&
    a.channel === b.channel
  );
}

function normalizeRef(value: string): string {
  return value.trim().toLowerCase();
}

function extractOrderCodeFromText(value: string | null | undefined): string | null {
  const text = (value ?? '').trim().toUpperCase();
  if (!text) return null;
  const match = text.match(/\bCC-\d{3,10}\b/);
  return match?.[0] ?? null;
}

function extractOrderCodeFromSaleId(saleId: string): string | null {
  const match = saleId.match(/^zoho-(CC-\d+)-/i);
  return match?.[1] ? match[1].toUpperCase() : null;
}

function parsePayloadList(body: unknown): unknown[] {
  if (!body || typeof body !== 'object') return [];
  const objectBody = body as Record<string, unknown>;

  const directArrays = [
    objectBody.shipments,
    objectBody.events,
    objectBody.data,
    objectBody.items,
  ].find((candidate) => Array.isArray(candidate)) as unknown[] | undefined;

  if (directArrays && directArrays.length > 0) return directArrays;
  return [objectBody];
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method === 'GET') {
    return json(200, {
      ok: true,
      service: 'envia-webhook',
      message: 'health',
    });
  }
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const rawBody = await request.text();
  if (!rawBody.trim()) {
    return json(200, { ok: true, message: 'empty payload (connectivity ok)' });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // Envia "Tester" can send plain text / non-JSON probes.
    const asQuery = new URLSearchParams(rawBody);
    if (asQuery.size > 0) {
      const obj: Record<string, string> = {};
      for (const [key, value] of asQuery.entries()) obj[key] = value;
      body = obj;
    } else {
      return json(200, {
        ok: true,
        message: 'connectivity test received (non-JSON payload)',
      });
    }
  }

  const token = Deno.env.get('ENVIA_WEBHOOK_TOKEN') ?? '';
  if (token) {
    const headerToken = (request.headers.get('x-envia-webhook-token') ?? '').trim();
    const altHeaderToken = (request.headers.get('x-webhook-token') ?? '').trim();
    const bearer = (request.headers.get('authorization') ?? '').trim();
    const bearerToken = bearer.toLowerCase().startsWith('bearer ') ? bearer.slice(7).trim() : '';
    const queryToken = new URL(request.url).searchParams.get('token')?.trim() ?? '';
    const queryVerifyToken = new URL(request.url).searchParams.get('verify_token')?.trim() ?? '';
    const queryApiKey = new URL(request.url).searchParams.get('apikey')?.trim() ?? '';
    const queryZapikey = new URL(request.url).searchParams.get('zapikey')?.trim() ?? '';
    const bodyToken =
      body && typeof body === 'object' && typeof (body as Record<string, unknown>).token === 'string'
        ? String((body as Record<string, unknown>).token).trim()
        : '';
    const bodyVerifyToken =
      body && typeof body === 'object' && typeof (body as Record<string, unknown>).verify_token === 'string'
        ? String((body as Record<string, unknown>).verify_token).trim()
        : '';
    const bodyApiKey =
      body && typeof body === 'object' && typeof (body as Record<string, unknown>).apikey === 'string'
        ? String((body as Record<string, unknown>).apikey).trim()
        : '';
    const bodyZapikey =
      body && typeof body === 'object' && typeof (body as Record<string, unknown>).zapikey === 'string'
        ? String((body as Record<string, unknown>).zapikey).trim()
        : '';
    const valid = [
      headerToken,
      altHeaderToken,
      bearerToken,
      queryToken,
      queryVerifyToken,
      queryApiKey,
      queryZapikey,
      bodyToken,
      bodyVerifyToken,
      bodyApiKey,
      bodyZapikey,
    ].some((candidate) => candidate && candidate === token);
    if (!valid) return json(401, { error: 'Invalid webhook token' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const storeId = Deno.env.get('STORE_ID') ?? '';
  const tableState = Deno.env.get('STATE_TABLE') ?? 'sales_margin_state';
  const vatRate = parseNumber(Deno.env.get('ENVIA_TTC_VAT_RATE') ?? '0.2') ?? 0.2;

  if (!supabaseUrl || !serviceRoleKey || !storeId) {
    return json(500, { error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / STORE_ID' });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const { data: row, error: readErr } = await supabase
    .from(tableState)
    .select('payload')
    .eq('id', storeId)
    .maybeSingle<{ payload: BackupPayload }>();

  if (readErr) return json(500, { error: `Supabase read: ${readErr.message}` });

  const currentBackup: BackupPayload =
    row?.payload ?? {
      generated_at: new Date().toISOString(),
      sales: [],
      catalog: [],
      stock: {},
    };

  const sales = [...(currentBackup.sales ?? [])];
  const candidates = parsePayloadList(body);
  if (candidates.length === 0) {
    return json(400, { error: 'No shipment payload found' });
  }

  const now = new Date().toISOString();
  const results: Array<Record<string, unknown>> = [];

  for (const candidate of candidates) {
    const event = parseEnviaEvent(candidate);
    const eventLabel = event.source_event_id ?? event.tracking_number ?? 'unknown';

    if (!event.transaction_ref) {
      results.push({
        event: eventLabel,
        ok: false,
        reason: 'transaction_ref_missing',
      });
      continue;
    }

    const txNormalized = normalizeRef(event.transaction_ref);
    const orderCode = event.order_number ?? extractOrderCodeFromText(event.transaction_ref);
    let baseMatches = orderCode
      ? sales.filter((sale) => extractOrderCodeFromSaleId(sale.id) === orderCode)
      : [];

    if (baseMatches.length === 0) {
      baseMatches = sales.filter((sale) => normalizeRef(sale.transaction_ref) === txNormalized);
    }

    if (baseMatches.length === 0) {
      const prefix = `zoho-${event.transaction_ref}-`;
      baseMatches = sales.filter((sale) => typeof sale.id === 'string' && sale.id.startsWith(prefix));
    }

    if (baseMatches.length === 0) {
      results.push({
        event: eventLabel,
        ok: false,
        reason: 'order_not_found',
        transaction_ref: event.transaction_ref,
      });
      continue;
    }

    const pivot = baseMatches[0];
    const orderLines = sales.filter((sale) => sameOrderGroup(sale, pivot));
    const orderIds = new Set(orderLines.map((sale) => sale.id));

    const orderIsFrance = orderLines.every((line) => (line.customer_country ?? '').toUpperCase() === 'FR');

    const weights = orderLines.map((line) => (line.sell_total_ht > 0 ? line.sell_total_ht : line.quantity));

    let allocatedShippingHt: number[] | null = null;
    let allocatedShippingTtc: number[] | null = null;

    if (event.shipping_cost_ttc !== null) {
      const orderShippingTtc = round2(event.shipping_cost_ttc);
      const orderShippingHt = orderIsFrance
        ? round2(orderShippingTtc / (1 + vatRate))
        : round2(orderShippingTtc);
      allocatedShippingHt = allocateByWeight(orderShippingHt, weights);
      allocatedShippingTtc = orderIsFrance ? allocateByWeight(orderShippingTtc, weights) : null;
    }

    const mergedTracking = event.tracking_numbers;
    let lineIdx = 0;

    for (let i = 0; i < sales.length; i += 1) {
      const current = sales[i];
      if (!orderIds.has(current.id)) continue;

      const previousTracking = Array.isArray(current.tracking_numbers)
        ? current.tracking_numbers.filter((item) => typeof item === 'string' && item.trim())
        : [];
      const trackingNumbers = mergedTracking.length > 0 ? mergedTracking : previousTracking;

      const effectiveStatus = event.proof_url ? 'delivered' : event.status;
      const updated: Sale = {
        ...current,
        tracking_numbers: trackingNumbers,
        shipping_provider: event.carrier ?? current.shipping_provider ?? null,
        shipping_status: effectiveStatus ?? current.shipping_status ?? null,
        shipping_event_at: event.occurred_at ?? now,
        shipping_cost_source: event.shipping_cost_ttc !== null ? 'envia_webhook' : current.shipping_cost_source ?? 'manual',
        shipping_tracking_url: event.tracking_url ?? current.shipping_tracking_url ?? null,
        shipping_label_url: event.label_url ?? current.shipping_label_url ?? null,
        shipping_proof_url: event.proof_url ?? current.shipping_proof_url ?? null,
      };

      if (allocatedShippingHt) {
        updated.shipping_real = allocatedShippingHt[lineIdx] ?? updated.shipping_real;
      }
      if (orderIsFrance) {
        updated.shipping_real_ttc = allocatedShippingTtc ? allocatedShippingTtc[lineIdx] ?? null : updated.shipping_real_ttc;
      } else {
        updated.shipping_real_ttc = null;
      }

      const recomputed = computeSale(updated);
      sales[i] = {
        ...updated,
        ...recomputed,
        updated_at: now,
      };
      lineIdx += 1;
    }

    results.push({
      event: eventLabel,
      ok: true,
      transaction_ref: pivot.transaction_ref,
      order_number: orderCode ?? extractOrderCodeFromSaleId(pivot.id),
      order_lines: orderLines.length,
      carrier: event.carrier,
      status: event.status,
      tracking_numbers: mergedTracking,
      shipping_cost_ttc: event.shipping_cost_ttc,
      tracking_url: event.tracking_url,
      label_url: event.label_url,
      proof_url: event.proof_url,
    });
  }

  const updatedBackup: BackupPayload = {
    ...currentBackup,
    generated_at: now,
    sales,
  };

  const { error: writeErr } = await supabase
    .from(tableState)
    .upsert({ id: storeId, payload: updatedBackup }, { onConflict: 'id' });

  if (writeErr) return json(500, { error: `Supabase write: ${writeErr.message}` });

  const successCount = results.filter((item) => item.ok === true).length;
  return json(200, {
    ok: true,
    processed: results.length,
    success: successCount,
    failed: results.length - successCount,
    results,
  });
});
