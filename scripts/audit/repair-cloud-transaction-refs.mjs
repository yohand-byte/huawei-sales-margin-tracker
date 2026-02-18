import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
const SUPABASE_ANON_KEY = (process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
const STORE_ID = (process.env.SUPABASE_STORE_ID || '').trim();
const TABLE = (process.env.VITE_SUPABASE_TABLE || 'sales_margin_state').trim();

const CHANNEL_TAG = {
  'Sun.store': 'SUN',
  Solartraders: 'SOL',
  Direct: 'DIR',
  Other: 'OTH',
};

const TX_REF_REGEX = /(?:^|\b)transaction\s*#\s*([A-Za-z0-9_-]{4,})\b/i;
const HASH_TAG_REF_REGEX = /#([A-Za-z0-9_-]{4,})\b/;
const ORDER_CODE_REGEX = /\b([A-Z]{2,5}-\d{3,10})\b/;

const toTs = (iso) => {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
};

const simpleHash32 = (input) => {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const extractTransactionRef = (clientOrTx) => {
  const raw = String(clientOrTx ?? '').trim();
  if (!raw) return '';
  const txMatch = raw.match(TX_REF_REGEX);
  if (txMatch?.[1]) return `#${txMatch[1]}`;
  const hashMatch = raw.match(HASH_TAG_REF_REGEX);
  if (hashMatch?.[1]) return `#${hashMatch[1]}`;
  const orderMatch = raw.match(ORDER_CODE_REGEX);
  if (orderMatch?.[1]) return orderMatch[1];
  return '';
};

const migrateMissingTx = (sales) => {
  const cloned = sales.map((s) => ({ ...s }));
  const pending = [];
  let extractedCount = 0;

  for (let i = 0; i < cloned.length; i += 1) {
    const sale = cloned[i];
    const existing = typeof sale.transaction_ref === 'string' ? sale.transaction_ref.trim() : '';
    if (existing) continue;
    const extracted = extractTransactionRef(sale.client_or_tx);
    if (extracted) {
      sale.transaction_ref = extracted;
      extractedCount += 1;
      continue;
    }
    pending.push(i);
  }

  const groups = new Map();
  for (const idx of pending) {
    const sale = cloned[idx];
    const date = typeof sale.date === 'string' ? sale.date : '';
    const client = String(sale.client_or_tx ?? '').trim();
    const channel = String(sale.channel ?? 'Other');
    const key = `${date}::${client}::${channel}`;
    const list = groups.get(key) ?? [];
    list.push(idx);
    groups.set(key, list);
  }

  let syntheticCount = 0;
  for (const [key, indexes] of groups.entries()) {
    indexes.sort((a, b) => toTs(cloned[a].created_at) - toTs(cloned[b].created_at));
    const [date, client, channel] = key.split('::');
    const tag = CHANNEL_TAG[channel] ?? 'OTH';
    const clientHash = simpleHash32(client).toString(36).slice(0, 6);
    let cluster = 1;
    let lastTs = 0;
    for (let j = 0; j < indexes.length; j += 1) {
      const idx = indexes[j];
      const ts = toTs(cloned[idx].created_at);
      if (j === 0) {
        lastTs = ts;
      } else {
        const gap = ts > 0 && lastTs > 0 ? ts - lastTs : 0;
        if (gap > 2 * 60 * 60 * 1000) cluster += 1;
        lastTs = ts;
      }
      cloned[idx].transaction_ref = `AUTO-${date}-${tag}-${clientHash}-${cluster}`;
      syntheticCount += 1;
    }
  }

  return { sales: cloned, extractedCount, syntheticCount };
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
    .select('id,payload,updated_at')
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
  const beforeMissing = sales.filter((s) => !String(s?.transaction_ref ?? '').trim()).length;
  console.log(`Before: sales_lines=${sales.length} missing_transaction_ref=${beforeMissing}`);

  const migrated = migrateMissingTx(sales);
  const afterMissing = migrated.sales.filter((s) => !String(s?.transaction_ref ?? '').trim()).length;
  const nextPayload = {
    ...payload,
    sales: migrated.sales,
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

  console.log(
    `After: missing_transaction_ref=${afterMissing} extracted=${migrated.extractedCount} synthetic=${migrated.syntheticCount}`,
  );
  console.log(`Cloud updated_at: ${String(upData?.updated_at ?? '')}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

