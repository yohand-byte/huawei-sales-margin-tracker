import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createClient } from '@supabase/supabase-js';

const execFileAsync = promisify(execFile);

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
const SUPABASE_ANON_KEY = (process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
const STORE_ID = (process.env.SUPABASE_STORE_ID || '').trim();
const TABLE = (process.env.VITE_SUPABASE_TABLE || 'sales_margin_state').trim();

const PLAYWRIGHT_SCRIPT = new URL('../platform-sync/playwright-fetch-order.mjs', import.meta.url).pathname;

const extractNegotiationId = (sale) => {
  const tx = String(sale?.transaction_ref ?? '').trim();
  if (tx.startsWith('#') && tx.length > 2) {
    return tx.slice(1);
  }
  const co = String(sale?.client_or_tx ?? '').trim();
  const m = co.match(/transaction\s*#\s*([A-Za-z0-9_-]{4,})/i);
  return m?.[1] ? m[1] : '';
};

const needsBackfill = (sale) => {
  if (String(sale?.channel ?? '') !== 'Sun.store') return false;
  const co = String(sale?.client_or_tx ?? '').trim().toLowerCase();
  return co === '' || co.startsWith('transaction #');
};

const fetchBuyerInfo = async (negotiationId) => {
  const env = {
    ...process.env,
    PLAYWRIGHT_CHANNEL: 'Sun.store',
    PLAYWRIGHT_NEGOTIATION_ID: negotiationId,
    PLAYWRIGHT_HEADLESS: 'true',
    // Ensure we don't need DB write access from this helper run.
    SUPABASE_URL: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
    SUPABASE_ANON_KEY: '',
  };
  const { stdout } = await execFileAsync(process.execPath, [PLAYWRIGHT_SCRIPT], {
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
};

const main = async () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('Missing SUPABASE URL/ANON KEY env.');
    process.exit(2);
  }
  if (!STORE_ID) {
    console.error('Missing SUPABASE_STORE_ID env.');
    process.exit(2);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-store-id': STORE_ID } },
  });

  const { data, error } = await supabase
    .from(TABLE)
    .select('payload,updated_at')
    .eq('id', STORE_ID)
    .maybeSingle();

  if (error) {
    console.error(`Supabase error: ${error.message}`);
    process.exit(1);
  }
  if (!data) {
    console.log('No cloud backup row found.');
    return;
  }

  const payload = data.payload ?? {};
  const sales = Array.isArray(payload.sales) ? payload.sales : [];
  const targets = sales.filter(needsBackfill);
  const ids = [...new Set(targets.map(extractNegotiationId).filter(Boolean))];

  console.log(`Sun.store client backfill: ${targets.length} sale line(s), ${ids.length} negotiation(s) to enrich.`);
  if (ids.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const buyerMap = new Map();
  for (const id of ids) {
    try {
      console.log(`Scrape negotiation ${id}...`);
      const info = await fetchBuyerInfo(id);
      const name = String(info?.client_name ?? '').trim();
      const country = String(info?.destination_country ?? '').trim();
      buyerMap.set(id, {
        client_name: name || null,
        destination_country: country || null,
      });
      console.log(`- client_name=${name || '(missing)'} destination_country=${country || '(missing)'}`);
    } catch (err) {
      console.log(`- failed: ${String(err?.message ?? err)}`);
    }
  }

  let changed = 0;
  const nextSales = sales.map((sale) => {
    if (!needsBackfill(sale)) return sale;
    const id = extractNegotiationId(sale);
    const info = buyerMap.get(id);
    if (!info?.client_name) return sale;
    changed += 1;
    return {
      ...sale,
      client_or_tx: info.client_name,
      customer_country: info.destination_country ?? sale.customer_country,
    };
  });

  if (changed === 0) {
    console.log('No sale line updated (client name not found).');
    return;
  }

  const nextPayload = {
    ...payload,
    sales: nextSales,
    generated_at: new Date().toISOString(),
  };

  const { data: upData, error: upError } = await supabase
    .from(TABLE)
    .upsert({ id: STORE_ID, payload: nextPayload }, { onConflict: 'id' })
    .select('updated_at')
    .single();

  if (upError) {
    console.error(`Supabase upsert error: ${upError.message}`);
    process.exit(1);
  }

  console.log(`Updated ${changed} sale line(s). Cloud updated_at=${String(upData?.updated_at ?? '')}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

