import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';

const TABLE = (process.env.VITE_SUPABASE_TABLE || 'sales_margin_state').trim();
const DRY_RUN = !process.argv.includes('--apply');

const loadEnvFile = (filePath) => {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
};

loadEnvFile(path.resolve('.env.local'));
loadEnvFile(path.resolve('.env.sync.local'));
loadEnvFile(path.join(os.homedir(), '.zoho_token.env'));

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = (process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
const STORE_ID = (process.env.SUPABASE_STORE_ID || '').trim();

const ZOHO_CLIENT_ID = (process.env.ZOHO_CLIENT_ID || '').trim();
const ZOHO_CLIENT_SECRET = (process.env.ZOHO_CLIENT_SECRET || '').trim();
const ZOHO_REFRESH_TOKEN = (process.env.ZOHO_REFRESH_TOKEN || '').trim();
const ZOHO_ORG_ID = (process.env.ZOHO_ORG_ID || '').trim();
const ZOHO_ACCOUNTS = (process.env.ZOHO_ACCOUNTS || 'https://accounts.zoho.eu/oauth/v2/token').trim();
const ZOHO_API_BASE = (process.env.ZOHO_API_BASE || 'https://www.zohoapis.eu/books/v3').trim();

const requireValue = (name, value) => {
  if (!value) {
    throw new Error(`Missing env: ${name}`);
  }
};

const normalizeTracking = (value) => {
  const raw = String(value || '').trim().replace(/\s+/g, '').toUpperCase();
  if (!raw) return '';
  if (raw.includes('TEST')) return '';
  if (/^X{6,}$/.test(raw)) return '';
  if (/^1ZX{6,}$/.test(raw)) return '';
  if (raw.length < 8) return '';
  if (!/[0-9]/.test(raw) || !/[A-Z]/.test(raw)) return '';
  return raw;
};

const normalizeStatus = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw.includes('deliver') || raw.includes('livr')) return 'delivered';
  if (raw.includes('not_shipped') || raw.includes('not shipped') || raw.includes('draft')) return 'label_created';
  if (raw.includes('shipped') || raw.includes('in_transit') || raw.includes('transit')) return 'in_transit';
  if (raw.includes('out_for_delivery') || raw.includes('livraison')) return 'out_for_delivery';
  if (raw.includes('cancel')) return 'cancelled';
  if (raw.includes('exception') || raw.includes('failed') || raw.includes('retour')) return 'exception';
  return raw.replace(/\s+/g, '_');
};

const extractOrderCode = (value) => {
  const text = String(value || '').toUpperCase();
  const match = text.match(/\bCC-\d{3,10}\b/);
  return match ? match[0] : null;
};

const orderCodeFromSale = (sale) => {
  const idMatch = String(sale.id || '').match(/^zoho-(CC-\d+)-/i);
  if (idMatch?.[1]) return idMatch[1].toUpperCase();
  return extractOrderCode(sale.transaction_ref);
};

const asIsoDate = (value) => {
  if (!value) return '';
  const text = String(value).trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T00:00:00Z`;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
};

const pickLatest = (items) => {
  if (!items.length) return null;
  return [...items].sort((a, b) => {
    const aTime = asIsoDate(a.last_modified_time || a.shipment_date || a.date || a.created_time);
    const bTime = asIsoDate(b.last_modified_time || b.shipment_date || b.date || b.created_time);
    return bTime.localeCompare(aTime);
  })[0];
};

const inferProvider = (carrier, tracking) => {
  const c = String(carrier || '').trim();
  if (c && c.toLowerCase() !== 'none' && c.toLowerCase() !== 'null') {
    if (c.toLowerCase().includes('dap')) {
      if (tracking.startsWith('1Z')) return 'UPS';
    } else {
      return c;
    }
  }
  if (tracking.startsWith('1Z')) return 'UPS';
  return null;
};

const buildEnviaTrackingUrl = (tracking) => `https://envia.com/fr-FR/tracking?label=${encodeURIComponent(tracking)}`;
const buildUpsProofUrl = (tracking) =>
  `https://s3.us-east-2.amazonaws.com/enviapaqueteria/uploads/ups_proof_of_delivery/${encodeURIComponent(tracking)}.pdf`;

const refreshZohoAccessToken = async () => {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    refresh_token: ZOHO_REFRESH_TOKEN,
  });
  const response = await fetch(ZOHO_ACCOUNTS, { method: 'POST', body });
  if (!response.ok) {
    throw new Error(`Zoho token refresh failed: ${response.status} ${await response.text()}`);
  }
  const json = await response.json();
  if (!json.access_token) {
    throw new Error(`Zoho token missing access_token: ${JSON.stringify(json)}`);
  }
  return json.access_token;
};

const zohoGet = async (accessToken, endpoint, params = {}) => {
  const url = new URL(`${ZOHO_API_BASE.replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}`);
  url.searchParams.set('organization_id', ZOHO_ORG_ID);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Zoho GET ${endpoint} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
};

const fetchAllZohoRows = async (accessToken, endpoint, key) => {
  const all = [];
  for (let page = 1; page <= 25; page += 1) {
    const json = await zohoGet(accessToken, endpoint, { per_page: 200, page });
    const rows = Array.isArray(json[key]) ? json[key] : [];
    all.push(...rows);
    if (rows.length < 200) break;
  }
  return all;
};

const main = async () => {
  requireValue('VITE_SUPABASE_URL/SUPABASE_URL', SUPABASE_URL);
  requireValue('VITE_SUPABASE_ANON_KEY/SUPABASE_ANON_KEY', SUPABASE_KEY);
  requireValue('SUPABASE_STORE_ID', STORE_ID);
  requireValue('ZOHO_CLIENT_ID', ZOHO_CLIENT_ID);
  requireValue('ZOHO_CLIENT_SECRET', ZOHO_CLIENT_SECRET);
  requireValue('ZOHO_REFRESH_TOKEN', ZOHO_REFRESH_TOKEN);
  requireValue('ZOHO_ORG_ID', ZOHO_ORG_ID);

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
    global: { headers: { 'x-store-id': STORE_ID } },
  });

  const { data, error } = await supabase
    .from(TABLE)
    .select('payload')
    .eq('id', STORE_ID)
    .maybeSingle();
  if (error) throw new Error(`Supabase read failed: ${error.message}`);

  const payload = data?.payload || {};
  const sales = Array.isArray(payload.sales) ? [...payload.sales] : [];

  const accessToken = await refreshZohoAccessToken();
  const [shipmentOrders, packages] = await Promise.all([
    fetchAllZohoRows(accessToken, 'shipmentorders', 'shipmentorders'),
    fetchAllZohoRows(accessToken, 'packages', 'packages'),
  ]);

  const shipmentsByCc = new Map();
  for (const row of shipmentOrders) {
    const cc = extractOrderCode(row.salesorder_number || row.reference_number || row.salesorder_id);
    if (!cc) continue;
    if (!shipmentsByCc.has(cc)) shipmentsByCc.set(cc, []);
    shipmentsByCc.get(cc).push(row);
  }

  const packagesByCc = new Map();
  for (const row of packages) {
    const cc = extractOrderCode(row.salesorder_number || row.reference_number || row.salesorder_id);
    if (!cc) continue;
    if (!packagesByCc.has(cc)) packagesByCc.set(cc, []);
    packagesByCc.get(cc).push(row);
  }

  const summary = [];
  let changed = 0;

  for (let i = 0; i < sales.length; i += 1) {
    const sale = sales[i];
    const cc = orderCodeFromSale(sale);
    if (!cc) continue;

    const latestShipment = pickLatest(shipmentsByCc.get(cc) || []);
    const latestPackage = pickLatest(packagesByCc.get(cc) || []);

    const shipmentStatus = normalizeStatus(latestShipment?.shipment_status || latestShipment?.status);
    const packageStatus = normalizeStatus(latestPackage?.status);
    const nextStatus = shipmentStatus || packageStatus;

    const tracking = normalizeTracking(
      latestShipment?.tracking_number ||
        latestPackage?.tracking_number ||
        latestPackage?.cf_as_num_ro_de_suivi_unformatted ||
        latestPackage?.cf_as_num_ro_de_suivi,
    );
    const trackingNumbers = tracking ? [tracking] : [];

    const provider = inferProvider(latestShipment?.carrier || latestPackage?.carrier, tracking);
    const trackingUrl =
      latestPackage?.cf_as_url_de_suivi_unformatted ||
      latestPackage?.cf_as_url_de_suivi ||
      (tracking ? buildEnviaTrackingUrl(tracking) : null);

    const proofUrl =
      tracking && nextStatus === 'delivered' && tracking.startsWith('1Z')
        ? buildUpsProofUrl(tracking)
        : null;

    const shouldClear = !tracking && (nextStatus === 'label_created' || nextStatus === 'cancelled' || nextStatus === null);

    const nextSale = {
      ...sale,
      tracking_numbers: shouldClear ? [] : trackingNumbers,
      shipping_provider: provider,
      shipping_status: nextStatus,
      shipping_event_at:
        latestShipment?.shipment_date || latestShipment?.date || latestShipment?.last_modified_time || latestPackage?.last_modified_time || sale.shipping_event_at || null,
      shipping_tracking_url: trackingUrl,
      shipping_proof_url: proofUrl,
      updated_at: new Date().toISOString(),
    };

    const before = JSON.stringify({
      tracking_numbers: sale.tracking_numbers || [],
      shipping_provider: sale.shipping_provider || null,
      shipping_status: sale.shipping_status || null,
      shipping_tracking_url: sale.shipping_tracking_url || null,
      shipping_proof_url: sale.shipping_proof_url || null,
    });
    const after = JSON.stringify({
      tracking_numbers: nextSale.tracking_numbers || [],
      shipping_provider: nextSale.shipping_provider || null,
      shipping_status: nextSale.shipping_status || null,
      shipping_tracking_url: nextSale.shipping_tracking_url || null,
      shipping_proof_url: nextSale.shipping_proof_url || null,
    });

    if (before !== after) {
      sales[i] = nextSale;
      changed += 1;
      summary.push({
        cc,
        tx: sale.transaction_ref,
        from: JSON.parse(before),
        to: JSON.parse(after),
      });
    }
  }

  const byCc = new Map();
  for (const item of summary) {
    if (!byCc.has(item.cc)) byCc.set(item.cc, item);
  }

  console.log(`Dry-run: ${DRY_RUN ? 'yes' : 'no'}`);
  console.log(`ShipmentOrders fetched: ${shipmentOrders.length}`);
  console.log(`Packages fetched: ${packages.length}`);
  console.log(`Sales lines changed: ${changed}`);
  console.log(`Orders touched: ${byCc.size}`);
  for (const item of byCc.values()) {
    const fromTracking = Array.isArray(item.from.tracking_numbers) ? item.from.tracking_numbers.join(', ') || '-' : '-';
    const toTracking = Array.isArray(item.to.tracking_numbers) ? item.to.tracking_numbers.join(', ') || '-' : '-';
    console.log(`- ${item.cc} | ${item.tx} | ${fromTracking} -> ${toTracking} | ${item.from.shipping_status || '-'} -> ${item.to.shipping_status || '-'}`);
  }

  if (DRY_RUN) {
    console.log('\nRun with --apply to persist changes in cloud.');
    return;
  }

  const updatedPayload = {
    ...payload,
    generated_at: new Date().toISOString(),
    sales,
  };

  const { error: writeError } = await supabase
    .from(TABLE)
    .upsert({ id: STORE_ID, payload: updatedPayload }, { onConflict: 'id' });

  if (writeError) {
    throw new Error(`Supabase write failed: ${writeError.message}`);
  }

  console.log('\nCloud payload updated successfully.');
};

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
