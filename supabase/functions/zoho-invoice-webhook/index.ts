/**
 * zoho-salesorder-webhook
 *
 * Reçoit les webhooks Zoho Books (commandes clients).
 * Mappe les lignes → Sale avec calcul de marge complet.
 * Upsert dans la table Supabase sales_margin_state.
 *
 * Secrets requis (Supabase Dashboard → Edge Functions → Secrets) :
 *   SUPABASE_URL              – auto
 *   SUPABASE_SERVICE_ROLE_KEY – auto
 *   ZOHO_WEBHOOK_TOKEN        – token secret que tu choisis
 *   STORE_ID                  – ton store ID (Settings Cloud dans l'app)
 *   STATE_TABLE               – (optionnel) défaut: sales_margin_state
 */

import { createClient } from 'npm:@supabase/supabase-js@2.95.3';

// ─── Types internes ───────────────────────────────────────────────────────────

type Channel = 'Sun.store' | 'Solartraders' | 'Direct' | 'Other';
type PaymentMethod = 'Stripe' | 'Wire' | 'PayPal' | 'Cash';
type Category = 'Inverters' | 'Solar Panels' | 'Batteries' | 'Accessories';

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
  attachments: unknown[];
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

interface CatalogItem {
  ref: string;           // champ réel dans le backup (CatalogProduct.ref)
  sku?: string;          // alias possible
  category: string;
  buy_price_unit: number;  // champ réel dans le backup
  buy_price_eur?: number;  // alias catalog.json statique
  initial_stock?: number;
  stock_qty?: number;
}

interface BackupPayload {
  generated_at: string;
  sales: Sale[];
  catalog: CatalogItem[];
  stock: Record<string, number>;
}

// ─── Calculs de commission (copie exacte de calculations.ts) ─────────────────

interface RateTier { min: number; max: number | null; stripe: number; wire: number; }

const inverterBatteryTiers: RateTier[] = [
  { min: 0,      max: 5000,   stripe: 0.0399, wire: 0.0519 },
  { min: 5000,   max: 10000,  stripe: 0.0365, wire: 0.0474 },
  { min: 10000,  max: 25000,  stripe: 0.0314, wire: 0.0393 },
  { min: 25000,  max: 80000,  stripe: 0.0261, wire: 0.0326 },
  { min: 80000,  max: 150000, stripe: 0.0179, wire: 0.0206 },
  { min: 150000, max: null,   stripe: 0.0103, wire: 0.0118 },
];
const solarPanelTiers: RateTier[] = [
  { min: 0,      max: 5000,   stripe: 0.0299, wire: 0.0389 },
  { min: 5000,   max: 10000,  stripe: 0.0276, wire: 0.0359 },
  { min: 10000,  max: 25000,  stripe: 0.0226, wire: 0.0282 },
  { min: 25000,  max: 80000,  stripe: 0.0181, wire: 0.0226 },
  { min: 80000,  max: 150000, stripe: 0.0131, wire: 0.0151 },
  { min: 150000, max: null,   stripe: 0.0084, wire: 0.0097 },
];
const accessoriesTiers: RateTier[] = [
  { min: 0,       max: 5000,   stripe: 0.0488, wire: 0.0634 },
  { min: 5000,    max: 10000,  stripe: 0.0421, wire: 0.0547 },
  { min: 10000,   max: 25000,  stripe: 0.0363, wire: 0.0454 },
  { min: 25000,   max: 80000,  stripe: 0.0301, wire: 0.0376 },
  { min: 80000,   max: 100000, stripe: 0.0206, wire: 0.0237 },
  { min: 100000,  max: null,   stripe: 0.0119, wire: 0.0137 },
];

const round2 = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 100) / 100;
const roundUp2 = (v: number) => (v <= 0 ? round2(v) : Math.ceil(v * 100) / 100);
const fmt = (r: number) => `${round2(r * 100)}%`;
const pickTier = (val: number, tiers: RateTier[]) =>
  tiers.find((t) => val >= t.min && (t.max === null || val < t.max)) ?? tiers[tiers.length - 1];

function computeCommission(
  channel: Channel, category: Category, pm: PaymentMethod,
  txValue: number, powerWp: number | null,
): { commission_rate_display: string; commission_eur: number; payment_fee: number } {
  if (channel === 'Sun.store') {
    const tiers = category === 'Solar Panels' ? solarPanelTiers
      : category === 'Accessories' ? accessoriesTiers : inverterBatteryTiers;
    const tier = pickTier(txValue, tiers);
    const rate = pm === 'Wire' ? tier.wire : tier.stripe;
    const raw = txValue * rate;
    return {
      commission_rate_display: fmt(rate),
      commission_eur: pm === 'Stripe' ? roundUp2(raw) : round2(raw),
      payment_fee: pm === 'Stripe' ? 5 : 0,
    };
  }
  if (channel === 'Solartraders') {
    if (category !== 'Solar Panels') {
      return { commission_rate_display: '5%', commission_eur: round2(txValue * 0.05), payment_fee: 0 };
    }
    const wp = powerWp ?? 0;
    return wp >= 1_000_000
      ? { commission_rate_display: '1 cent/Wp', commission_eur: round2(wp * 0.01), payment_fee: 0 }
      : { commission_rate_display: '1.5 cent/Wp', commission_eur: round2(wp * 0.015), payment_fee: 0 };
  }
  return { commission_rate_display: '0%', commission_eur: 0, payment_fee: 0 };
}

function computeSale(input: SaleInput): SaleComputed {
  const sellTotalHt = round2(input.quantity * input.sell_price_unit_ht);
  const transactionValue = round2(sellTotalHt + input.shipping_charged);
  const comm = computeCommission(input.channel, input.category, input.payment_method, transactionValue, input.power_wp);
  const netReceived = round2(transactionValue - comm.commission_eur - comm.payment_fee);
  const totalCost = round2(input.quantity * input.buy_price_unit + input.shipping_real);
  const grossMargin = round2(transactionValue - totalCost);
  const netMargin = round2(netReceived - totalCost);
  const netMarginPct = transactionValue <= 0 ? 0 : round2((netMargin / transactionValue) * 100);
  return {
    sell_total_ht: sellTotalHt,
    transaction_value: transactionValue,
    ...comm,
    net_received: netReceived,
    total_cost: totalCost,
    gross_margin: grossMargin,
    net_margin: netMargin,
    net_margin_pct: netMarginPct,
  };
}

// ─── Helpers mapping Zoho → Tracker ───────────────────────────────────────────

/**
 * Détecte le canal de vente depuis le N° de référence Zoho.
 *   "Transaction #kj8OZ3Fi" → Sun.store (Stripe)
 *   "DC-001234"             → Direct
 *   champ custom "Canal"    → prioritaire
 */
function inferChannel(referenceNumber: string, customFields: ZohoCustomField[]): Channel {
  const cf = getCustomFieldText(customFields, ['canal', 'channel', 'canal de vente']);
  if (cf) {
    const key = normalizeKey(cf);
    if (key.includes('sunstore')) return 'Sun.store';
    if (key.includes('solartraders')) return 'Solartraders';
    if (key.includes('direct')) return 'Direct';
    if (key.includes('other') || key.includes('autre')) return 'Other';
  }

  const ref = (referenceNumber ?? '').trim();
  if (/transaction\s*#\s*[a-z0-9]{6,}/i.test(ref)) return 'Sun.store';
  if (/solartraders/i.test(ref)) return 'Solartraders';
  if (/^dc-/i.test(ref)) return 'Direct';
  return 'Other';
}

/**
 * Détecte le moyen de paiement.
 * Priorité : champ custom → inférence depuis ref.
 */
function inferPaymentMethod(
  referenceNumber: string,
  customFields: ZohoCustomField[],
  channel: Channel,
): PaymentMethod {
  const cf = getCustomFieldText(customFields, ['moyen de paiement', 'payment method', 'paiement']);
  if (cf) {
    const key = normalizeKey(cf);
    if (key.includes('stripe') || key.includes('carte')) return 'Stripe';
    if (key.includes('paypal')) return 'PayPal';
    if (key.includes('wire') || key.includes('virement') || key.includes('bank')) return 'Wire';
    if (key.includes('cash') || key.includes('especes')) return 'Cash';
  }

  const ref = (referenceNumber ?? '').trim();
  if (/transaction\s*#/i.test(ref)) return 'Stripe';
  if (channel === 'Sun.store') return 'Stripe';
  return 'Wire';
}

/**
 * Extrait le pays depuis l'adresse de facturation Zoho.
 * Retourne le code pays ISO (ex: "IT", "FR", "DE") ou le nom.
 */
function extractCountry(billingAddress: ZohoBillingAddress | undefined): string {
  if (!billingAddress) return 'FR';
  // Préférer le code pays ISO si disponible
  if (billingAddress.country_code && billingAddress.country_code.length === 2) {
    return billingAddress.country_code.toUpperCase();
  }
  // Fallback sur le nom du pays
  const countryMap: Record<string, string> = {
    france: 'FR', italy: 'IT', italie: 'IT', germany: 'DE', allemagne: 'DE',
    spain: 'ES', espagne: 'ES', belgium: 'BE', belgique: 'BE',
    netherlands: 'NL', 'pays-bas': 'NL', portugal: 'PT',
    switzerland: 'CH', suisse: 'CH', austria: 'AT', autriche: 'AT',
    poland: 'PL', pologne: 'PL',
  };
  const country = (billingAddress.country ?? '').toLowerCase().trim();
  return countryMap[country] ?? (billingAddress.country?.toUpperCase().slice(0, 2) ?? 'FR');
}

/**
 * Détecte si une ligne est un frais de port/transport à exclure des sales
 * et retourner comme shipping_charged.
 * Ex: SKU "TRANSP_16-30", "TRANSP_XX", nom "Frais de port"
 */
function isShippingLine(sku: string, name: string): boolean {
  const s = (sku ?? '').toUpperCase();
  const n = (name ?? '').toLowerCase();
  return (
    s.startsWith('TRANSP') ||
    n.includes('frais de port') ||
    n.includes('shipping') ||
    n.includes('livraison') ||
    n.includes('transport')
  );
}

/**
 * Infère la catégorie depuis le nom/SKU du produit.
 */
function inferCategory(name: string, sku: string): Category {
  const text = `${name} ${sku}`.toLowerCase();
  if (text.includes('panel') || text.includes('panneau') || text.includes('bifacial') || text.includes('wp')) {
    return 'Solar Panels';
  }
  if (text.includes('battery') || text.includes('batterie') || text.includes('luna') || text.includes('byd')) {
    return 'Batteries';
  }
  if (
    text.includes('onduleur') || text.includes('inverter') || text.includes('hybrid') ||
    text.includes('sun2000') || text.includes('solis') || text.includes('deye') ||
    text.includes('-lc') || text.includes('-mb') || text.includes('monophasé') || text.includes('triphasé')
  ) {
    return 'Inverters';
  }
  return 'Accessories';
}

/**
 * Vérifie si une ligne produit est un article Huawei.
 * SKU commence par HUA/ ou nom/SKU contient un modèle Huawei connu.
 */
function isHuaweiProduct(sku: string, name: string): boolean {
  const s = (sku ?? '').toUpperCase();
  const text = `${name} ${sku}`.toLowerCase();
  if (s.startsWith('HUA/') || s.startsWith('HUAWEI')) return true;
  return (
    text.includes('sun2000') ||
    text.includes('sdongle') ||
    text.includes('smart dongle') ||
    text.includes('smartlogger') ||
    text.includes('smart logger') ||
    text.includes('luna2000') ||
    text.includes('emma') ||
    text.includes('optimiseur') && text.includes('huawei') ||
    text.includes('optimizer') && text.includes('huawei')
  );
}

function normalizeKey(input: string): string {
  return input
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.replace(/\s/g, '').replace(',', '.').replace(/[^0-9.-]/g, '');
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toSafeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

function findCustomField(fields: ZohoCustomField[], aliases: string[]): ZohoCustomField | undefined {
  if (!fields?.length) return undefined;
  const wanted = new Set(aliases.map(normalizeKey));
  return fields.find((cf) => {
    const label = typeof cf.label === 'string' ? normalizeKey(cf.label) : '';
    const apiName = typeof cf.api_name === 'string' ? normalizeKey(cf.api_name) : '';
    return wanted.has(label) || wanted.has(apiName);
  });
}

function getCustomFieldText(fields: ZohoCustomField[], aliases: string[]): string {
  const field = findCustomField(fields, aliases);
  if (!field) return '';
  if (typeof field.value === 'string') return field.value.trim();
  if (typeof field.value === 'number') return String(field.value);
  return '';
}

function getCustomFieldNumber(fields: ZohoCustomField[], aliases: string[]): number | null {
  const field = findCustomField(fields, aliases);
  if (!field) return null;
  return parseNumber(field.value);
}

// ─── Types Zoho Books Sales Order ─────────────────────────────────────────────

interface ZohoCustomField {
  label?: string;
  api_name?: string;
  value?: unknown;
}

interface ZohoBillingAddress {
  country?: string;
  country_code?: string;
  address?: string;
  city?: string;
  zip?: string;
}

interface ZohoLineItem {
  line_item_id?: string;
  item_id?: string;
  name?: string;
  sku?: string;
  quantity?: number;
  rate?: number;       // prix unitaire HT avant remise
  discount?: number | string;   // % de remise — Zoho retourne parfois "20.00%" (string)
  amount?: number;     // total ligne après remise (parfois absent de l'API)
}

interface ZohoSalesOrder {
  salesorder_id?: string;
  salesorder_number?: string;   // CC-014276
  reference_number?: string;    // Transaction #kj8OZ3Fi (ref Stripe/Sun.store)
  date?: string;
  customer_name?: string;
  billing_address?: ZohoBillingAddress;
  shipping_charge?: number;     // frais de port en champ dédié (souvent 0 si ligne article)
  sub_total?: number;
  total?: number;
  custom_fields?: ZohoCustomField[];
  line_items?: ZohoLineItem[];
}

interface ZohoWebhookBody {
  salesorder?: ZohoSalesOrder;
  invoice?: ZohoSalesOrder;     // fallback si webhook configuré sur factures
  token?: string;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// ─── Handler principal ────────────────────────────────────────────────────────

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });

  // ── 1. Parse du body ──────────────────────────────────────────────────────
  let body: ZohoWebhookBody;
  try {
    body = (await request.json()) as ZohoWebhookBody;
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  // ── 2. Vérification token secret ─────────────────────────────────────────
  const webhookToken = Deno.env.get('ZOHO_WEBHOOK_TOKEN') ?? '';
  if (webhookToken) {
    const headerToken = (request.headers.get('x-zoho-webhook-token') ?? '').trim();
    const urlToken = (new URL(request.url).searchParams.get('token') ?? '').trim();
    const bodyToken = (body.token ?? '').trim();
    const tokenOk = [headerToken, urlToken, bodyToken].some((v) => v.length > 0 && v === webhookToken);
    if (!tokenOk) {
      return json(401, { error: 'Invalid webhook token' });
    }
  }

  const order: ZohoSalesOrder | undefined = body.salesorder ?? body.invoice;
  if (!order) return json(400, { error: 'No salesorder/invoice in payload' });

  const allLineItems = order.line_items ?? [];
  if (allLineItems.length === 0) return json(200, { message: 'No line items' });

  // ── 3. Séparer lignes produit vs frais de port ────────────────────────────
  let totalShippingFromLines = 0;
  const productLines: ZohoLineItem[] = [];

  for (const li of allLineItems) {
    const sku = (li.sku ?? '').trim();
    const name = (li.name ?? '').trim();
    if (isShippingLine(sku, name)) {
      totalShippingFromLines += li.amount ?? (li.rate ?? 0) * (li.quantity ?? 1);
    } else {
      productLines.push(li);
    }
  }

  // Shipping facture client = ligne transport + champ shipping_charge Zoho.
  const totalShipping = round2(totalShippingFromLines + (order.shipping_charge ?? 0));
  if (productLines.length === 0) return json(200, { message: 'Only shipping lines — nothing to sync as sales' });

  // Filtre métier: on ne sync que les lignes Huawei (même si la commande est mixte).
  const huaweiLines = productLines.filter((li) =>
    isHuaweiProduct(li.sku ?? '', li.name ?? ''),
  );
  if (huaweiLines.length === 0) {
    return json(200, {
      ok: false,
      message: 'No Huawei products in this order — skipped',
      order: order.salesorder_number ?? order.salesorder_id,
    });
  }

  // ── 4. Extraction des métadonnées de la commande ──────────────────────────
  const orderDate = order.date ?? new Date().toISOString().slice(0, 10);
  const orderNumber = order.salesorder_number ?? order.salesorder_id ?? 'ZOHO-?';
  const rawRef = order.reference_number ?? '';
  const customFields = order.custom_fields ?? [];
  const customerName = order.customer_name ?? 'Unknown';

  const channel = inferChannel(rawRef, customFields);
  const paymentMethod = inferPaymentMethod(rawRef, customFields, channel);

  // transaction_ref :
  //   - Sun.store → référence Stripe (ex: "Transaction #kj8OZ3Fi") renseignée dans Zoho Books
  //   - Direct/Other → N° de commande Zoho Books (CC-XXXXX), plus lisible que DC-XXXXX
  const referenceNumber = channel !== 'Direct' && rawRef
    ? rawRef
    : orderNumber;
  const customerCountry = extractCountry(order.billing_address);

  // TVA auto uniquement pour la France.
  const isFrenchCustomer = customerCountry.toUpperCase() === 'FR';

  // Cout réel transport commande HT/TTC depuis custom fields Zoho.
  const shippingRealOrderHtFromCustom = getCustomFieldNumber(customFields, [
    'cout transport commande ht',
    'coût transport commande ht',
    'cost transport commande ht',
    'shipping real ht',
    'frais port reels ht',
    'frais de port reels ht',
    'cout frais de port ht',
  ]);
  const shippingRealOrderTtcFromCustom = getCustomFieldNumber(customFields, [
    'cout transport commande ttc',
    'coût transport commande ttc',
    'cost transport commande ttc',
    'shipping real ttc',
    'frais port reels ttc',
    'frais de port reels ttc',
    'cout frais de port ttc',
  ]);

  const totalShippingRealOrderHt = round2(shippingRealOrderHtFromCustom ?? 0);
  const totalShippingRealOrderTtc = round2(
    shippingRealOrderTtcFromCustom ??
      (isFrenchCustomer ? totalShippingRealOrderHt * 1.2 : 0),
  );
  const invoiceUrlFromCustom = toSafeUrl(getCustomFieldText(customFields, [
    'invoice_url',
    'invoice_link',
    'facture_url',
    'facture_link',
    'pdf_facture',
  ]));
  const invoiceUrlFromOrder = toSafeUrl((order as Record<string, unknown>)['invoice_url']);
  const invoiceUrl = invoiceUrlFromCustom ?? invoiceUrlFromOrder;

  // Sous-total des lignes Huawei sur montants réellement facturés (après remise).
  const lineAmounts = huaweiLines.map((li) => {
    const quantity = Math.max(li.quantity ?? 1, 0.001);
    const discountPct = Math.min(Math.max(parseFloat(String(li.discount ?? 0)), 0), 100);
    const rateAfterDiscount = round2((li.rate ?? 0) * (1 - discountPct / 100));
    return li.amount != null
      ? Number(li.amount)
      : round2(rateAfterDiscount * quantity);
  });
  const productSubtotal = lineAmounts.reduce((sum, amount) => sum + amount, 0);

  // ── 5. Init Supabase ──────────────────────────────────────────────────────
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const storeId = Deno.env.get('STORE_ID') ?? '';
  const tableState = Deno.env.get('STATE_TABLE') ?? 'sales_margin_state';

  if (!supabaseUrl || !serviceRoleKey || !storeId) {
    return json(500, { error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / STORE_ID' });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ── 6. Lecture du backup actuel ───────────────────────────────────────────
  const { data: row, error: readErr } = await supabase
    .from(tableState)
    .select('payload')
    .eq('id', storeId)
    .maybeSingle<{ payload: BackupPayload }>();

  if (readErr) return json(500, { error: `Supabase read: ${readErr.message}` });

  const currentBackup: BackupPayload = row?.payload ?? {
    generated_at: new Date().toISOString(),
    sales: [],
    catalog: [],
    stock: {},
  };

  // ── Catalogue : liste de tous les items pour matching intelligent ────────
  const catalogItems: CatalogItem[] = currentBackup.catalog ?? [];
  const normalizeProductRef = (value: string): string =>
    value.toUpperCase().replace(/[^A-Z0-9]/g, '');

  const catalogByNormalized = new Map<string, CatalogItem>();
  for (const item of catalogItems) {
    const ref = (item.ref ?? item.sku ?? '').trim();
    if (!ref) continue;
    const key = normalizeProductRef(ref);
    if (key && !catalogByNormalized.has(key)) {
      catalogByNormalized.set(key, item);
    }
  }

  // Alias SKU Zoho -> ref catalogue (table optionnelle).
  type CatalogAliasRow = {
    alias_sku: string;
    product_ref: string;
    active: boolean | null;
  };
  const aliasByNormalized = new Map<string, string>();
  const { data: aliasRows, error: aliasErr } = await supabase
    .from('catalog_sku_aliases')
    .select('alias_sku,product_ref,active')
    .eq('store_id', storeId)
    .returns<CatalogAliasRow[]>();
  if (!aliasErr && aliasRows) {
    for (const row of aliasRows) {
      if (row.active === false) continue;
      const alias = normalizeProductRef(row.alias_sku ?? '');
      const productRef = normalizeProductRef(row.product_ref ?? '');
      if (alias && productRef) aliasByNormalized.set(alias, productRef);
    }
  }

  /**
   * Cherche un article du catalogue depuis un SKU Zoho + nom produit.
   *
   * Stratégie (ordre de priorité) :
   *  1. Correspondance exacte sur ref ou sku
   *  2. SKU Zoho sans préfixe HUA/ HW- etc.  → ex: HUA/SUN2000-8K-LC0 → SUN2000-8K-LC0
   *  3. Modèle extrait du nom  → ex: "(Model: SDongleA-05)" → SDongleA-05
   *  4. Modèle extrait du SKU Zoho (dernier segment après /)
   *  5. Substring : ref du catalogue contenue dans le nom/SKU Zoho
   */
  function findCatalogItem(zohoSku: string, zohoName: string): CatalogItem | undefined {
    const skuLower = zohoSku.toLowerCase();
    const nameLower = zohoName.toLowerCase();
    const skuNormalized = normalizeProductRef(zohoSku);

    // 0. Alias explicites.
    const aliasedRef = aliasByNormalized.get(skuNormalized);
    if (aliasedRef) {
      const aliasMatch = catalogByNormalized.get(aliasedRef);
      if (aliasMatch) return aliasMatch;
    }

    // 1. Correspondance exacte
    let found = catalogByNormalized.get(skuNormalized);
    if (found) return found;

    // 2. SKU sans préfixe fournisseur (HUA/, HW-, HUAWEI-)
    const strippedSku = zohoSku
      .replace(/^(HUA\/|HW-|HUAWEI-)/i, '')
      .toLowerCase();
    if (strippedSku && strippedSku !== skuLower) {
      found = catalogByNormalized.get(normalizeProductRef(strippedSku));
      if (found) return found;
    }

    // 3. Modèle entre parenthèses dans le nom Zoho → ex: (Model: SDongleA-05)
    const modelMatch = zohoName.match(/\(Model:\s*([^)]+)\)/i);
    if (modelMatch) {
      const model = modelMatch[1].trim().toLowerCase();
      found = catalogItems.find(
        (c) => (c.ref ?? c.sku ?? '').toLowerCase().includes(model) ||
               model.includes((c.ref ?? c.sku ?? '').toLowerCase()),
      );
      if (found) return found;
    }

    // 4. Dernier segment du SKU Zoho après /  → ex: HUA/SUN2000-8K-LC0 → SUN2000-8K-LC0
    const skuSegment = zohoSku.split('/').pop()?.toLowerCase() ?? '';
    if (skuSegment && skuSegment !== skuLower) {
      found = catalogByNormalized.get(normalizeProductRef(skuSegment));
      if (!found) {
        found = catalogItems.find(
          (c) => {
            const ref = (c.ref ?? c.sku ?? '').toLowerCase();
            return ref === skuSegment || ref.includes(skuSegment) || skuSegment.includes(ref);
          },
        );
      }
      if (found) return found;
    }

    // 5. Substring : ref catalogue contenue dans le nom ou SKU Zoho (pour noms longs)
    found = catalogItems.find((c) => {
      const ref = (c.ref ?? c.sku ?? '').toLowerCase();
      if (ref.length < 4) return false; // éviter faux positifs sur refs courtes
      return nameLower.includes(ref) || skuLower.includes(ref);
    });
    if (found) return found;

    // 6. Multi-segment : retire les préfixes Zoho (HUA/, BAT-DC-, BAT-, OPT-, etc.)
    //    puis vérifie que tous les segments restants (≥ 2 chars) apparaissent dans la ref catalogue.
    //    Ex: HUA/BAT-DC-LUNA2000-C0 → segments [luna2000, c0]
    //        → matche "luna2000-5kw-c0 power module,5kw (bms)" ✓ mais pas "luna2000-5-e0 battery" ✓
    const keyPart = zohoSku
      .replace(/^HUA\//i, '')
      .replace(/^(BAT-DC-|BAT-|OPT-|ACC-|GRID-)/i, '')
      .toLowerCase();
    const keySegments = keyPart.split('-').filter((s) => s.length >= 2);
    if (keySegments.length >= 2) {
      found = catalogItems.find((c) => {
        const ref = (c.ref ?? c.sku ?? '').toLowerCase();
        return keySegments.every((seg) => ref.includes(seg));
      });
      if (found) return found;
    }

    return undefined;
  }

  // ── 7. Mapping lignes produit → Sales ─────────────────────────────────────
  const now = new Date().toISOString();
  const newSales: Sale[] = [];
  const hasOrderShippingReal =
    shippingRealOrderHtFromCustom !== null || shippingRealOrderTtcFromCustom !== null;
  const totalShippingChargedTtc = isFrenchCustomer ? round2(totalShipping * 1.2) : 0;

  // Préserver les enrichissements déjà reçus (tracking, coût réel, PJ...) lors d'un resync Zoho.
  const existingById = new Map<string, Sale>();
  for (const sale of currentBackup.sales ?? []) {
    if (sale.id) existingById.set(sale.id, sale);
  }

  let allocatedShippingChargedHt = 0;
  let allocatedShippingChargedTtc = 0;
  let allocatedShippingRealHt = 0;
  let allocatedShippingRealTtc = 0;

  for (const [index, li] of huaweiLines.entries()) {
    const sku = (li.sku ?? '').trim();
    const productName = ((li.name ?? sku) || 'Unknown').trim();
    const quantity = Math.max(li.quantity ?? 1, 0.001);
    // Prix réel unitaire = rate × (1 - discount/100)
    // Zoho Books retourne souvent amount=null mais rate + discount séparément
    // Attention: discount peut être string "20.00%" → parseFloat gère les deux cas
    const discountPct = Math.min(Math.max(parseFloat(String(li.discount ?? 0)), 0), 100);
    const rateAfterDiscount = round2((li.rate ?? 0) * (1 - discountPct / 100));
    const lineAmount = lineAmounts[index];
    const rate = quantity > 0 ? round2(lineAmount / quantity) : rateAfterDiscount;

    // ID idempotent : si même commande re-webhookée → pas de doublon
    const lineId = li.line_item_id ?? li.item_id ?? `${sku}-${lineAmount}`;
    const saleId = `zoho-${orderNumber}-${lineId}`;
    const existingSale = existingById.get(saleId);

    // Frais de port proportionnels + correction sur la dernière ligne.
    const lineRatio = productSubtotal > 0 ? lineAmount / productSubtotal : 1 / huaweiLines.length;
    const isLastLine = index === huaweiLines.length - 1;
    const shippingCharged = isLastLine
      ? round2(totalShipping - allocatedShippingChargedHt)
      : round2(totalShipping * lineRatio);
    allocatedShippingChargedHt = round2(allocatedShippingChargedHt + shippingCharged);

    const shippingChargedTtc = isFrenchCustomer
      ? (isLastLine
        ? round2(totalShippingChargedTtc - allocatedShippingChargedTtc)
        : round2(totalShippingChargedTtc * lineRatio))
      : null;
    if (isFrenchCustomer && shippingChargedTtc !== null) {
      allocatedShippingChargedTtc = round2(allocatedShippingChargedTtc + shippingChargedTtc);
    }

    const fallbackShippingReal = existingSale?.shipping_real ?? shippingCharged;
    const shippingReal = hasOrderShippingReal
      ? (isLastLine
        ? round2(totalShippingRealOrderHt - allocatedShippingRealHt)
        : round2(totalShippingRealOrderHt * lineRatio))
      : fallbackShippingReal;
    if (hasOrderShippingReal) {
      allocatedShippingRealHt = round2(allocatedShippingRealHt + shippingReal);
    }

    const shippingRealTtc = isFrenchCustomer
      ? (hasOrderShippingReal
        ? (isLastLine
          ? round2(totalShippingRealOrderTtc - allocatedShippingRealTtc)
          : round2(totalShippingRealOrderTtc * lineRatio))
        : (existingSale?.shipping_real_ttc ?? round2(shippingReal * 1.2)))
      : null;
    if (isFrenchCustomer && hasOrderShippingReal && shippingRealTtc !== null) {
      allocatedShippingRealTtc = round2(allocatedShippingRealTtc + shippingRealTtc);
    }

    // Lookup catalogue — matching intelligent SKU Zoho → ref catalogue
    const catalogEntry = findCatalogItem(sku, productName);
    const buyPriceUnit = catalogEntry?.buy_price_unit ?? catalogEntry?.buy_price_eur ?? 0;
    const category = catalogEntry
      ? (catalogEntry.category as Category)
      : inferCategory(productName, sku);

    const input: SaleInput = {
      date: orderDate,
      client_or_tx: customerName,
      // transaction_ref = N° de référence Zoho (ex: "Transaction #kj8OZ3Fi")
      transaction_ref: referenceNumber,
      channel,
      customer_country: customerCountry,
      product_ref: sku || productName,
      quantity: round2(quantity),
      sell_price_unit_ht: round2(rate),
      sell_price_unit_ttc: isFrenchCustomer ? round2(rate * 1.2) : null,
      shipping_charged: shippingCharged,
      shipping_charged_ttc: shippingChargedTtc,
      shipping_real: shippingReal,
      shipping_real_ttc: shippingRealTtc,
      payment_method: paymentMethod,
      category,
      buy_price_unit: buyPriceUnit,
      power_wp: null,
      attachments: Array.isArray(existingSale?.attachments) ? existingSale.attachments : [],
      tracking_numbers: Array.isArray(existingSale?.tracking_numbers) ? existingSale.tracking_numbers : [],
      shipping_provider: existingSale?.shipping_provider ?? null,
      shipping_status: existingSale?.shipping_status ?? null,
      shipping_cost_source:
        existingSale?.shipping_cost_source ??
        (hasOrderShippingReal ? 'manual' : (shippingCharged > 0 ? 'estimated_from_charged' : 'manual')),
      shipping_event_at: existingSale?.shipping_event_at ?? null,
      shipping_tracking_url: existingSale?.shipping_tracking_url ?? null,
      shipping_label_url: existingSale?.shipping_label_url ?? null,
      shipping_proof_url: existingSale?.shipping_proof_url ?? null,
      invoice_url: existingSale?.invoice_url ?? invoiceUrl ?? null,
    };

    const computed = computeSale(input);
    newSales.push({
      id: saleId,
      created_at: existingSale?.created_at ?? now,
      updated_at: now,
      ...input,
      ...computed,
    });
  }

  // ── 8. Remplacement complet de la commande Zoho (idempotent + suppressions) ─
  const orderPrefix = `zoho-${orderNumber}-`;
  const keptSales = (currentBackup.sales ?? []).filter((s) => !s.id.startsWith(orderPrefix));
  const updatedSales = [...keptSales, ...newSales].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  const updatedBackup: BackupPayload = {
    ...currentBackup,
    generated_at: now,
    sales: updatedSales,
  };

  // ── 9. Sauvegarde Supabase ─────────────────────────────────────────────────
  const { error: writeErr } = await supabase
    .from(tableState)
    .upsert({ id: storeId, payload: updatedBackup }, { onConflict: 'id' });

  if (writeErr) return json(500, { error: `Supabase write: ${writeErr.message}` });

  return json(200, {
    ok: true,
    order: orderNumber,
    reference: referenceNumber,
    channel,
    payment_method: paymentMethod,
    country: customerCountry,
    shipping_total: totalShipping,
    shipping_real_order_ht: totalShippingRealOrderHt,
    non_huawei_lines_skipped: productLines.length - huaweiLines.length,
    sales_synced: newSales.map((s) => ({
      id: s.id,
      product_ref: s.product_ref,
      qty: s.quantity,
      sell_unit_ht: s.sell_price_unit_ht,
      transaction_value: s.transaction_value,
      commission_eur: s.commission_eur,
      total_cost: s.total_cost,
      net_received: s.net_received,
      net_margin_eur: s.net_margin,
      net_margin_pct: `${s.net_margin_pct}%`,
    })),
  });
});
