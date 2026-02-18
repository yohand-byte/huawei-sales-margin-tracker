import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
const SUPABASE_ANON_KEY = (process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
const STORE_ID = (process.env.SUPABASE_STORE_ID || '').trim();
const TABLE = (process.env.VITE_SUPABASE_TABLE || 'sales_margin_state').trim();

const toTs = (iso) => {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
};

const round2 = (n) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

const summarize = (backup) => {
  const sales = Array.isArray(backup?.sales) ? backup.sales : [];
  const keys = new Set();
  let revenue = 0;
  let netMargin = 0;
  let missingTx = 0;

  for (const sale of sales) {
    const date = typeof sale?.date === 'string' ? sale.date : '';
    const client = String(sale?.client_or_tx ?? '').trim();
    const tx = String(sale?.transaction_ref ?? '').trim();
    const channel = String(sale?.channel ?? '').trim();
    keys.add(`${date}::${client}::${tx}::${channel}`);
    if (!tx) missingTx += 1;
    const tv = Number(sale?.transaction_value ?? 0);
    if (Number.isFinite(tv)) revenue += tv;
    const nm = Number(sale?.net_margin ?? 0);
    if (Number.isFinite(nm)) netMargin += nm;
  }

  return {
    generated_at: typeof backup?.generated_at === 'string' ? backup.generated_at : '',
    sales_lines: sales.length,
    orders: keys.size,
    revenue: round2(revenue),
    net_margin: round2(netMargin),
    missing_transaction_ref: missingTx,
  };
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

  const payload = data.payload;
  const summary = summarize(payload);
  console.log(
    [
      'Cloud backup audit',
      `updated_at: ${String(data.updated_at)}`,
      `generated_at: ${summary.generated_at}`,
      `orders: ${summary.orders}`,
      `sales_lines: ${summary.sales_lines}`,
      `revenue_eur: ${summary.revenue}`,
      `net_margin_eur: ${summary.net_margin}`,
      `missing_transaction_ref: ${summary.missing_transaction_ref}`,
    ].join('\n'),
  );

  // Quick sanity: spot duplicates of the same (date/client/tx/channel) when tx is empty.
  const sales = Array.isArray(payload?.sales) ? payload.sales : [];
  const suspicious = new Map();
  for (const sale of sales) {
    const tx = String(sale?.transaction_ref ?? '').trim();
    if (tx) continue;
    const key = `${sale?.date ?? ''}::${sale?.client_or_tx ?? ''}::${sale?.channel ?? ''}`;
    suspicious.set(key, (suspicious.get(key) ?? 0) + 1);
  }
  const worst = [...suspicious.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  if (worst.length > 0) {
    console.log('\nPotential grouping collisions (missing transaction_ref):');
    for (const [key, count] of worst) {
      console.log(`- ${count}x ${key}`);
    }
  }

  // Timestamp sanity.
  const cloudTs = toTs(summary.generated_at);
  if (!cloudTs) {
    console.log('\nWarning: generated_at is missing/invalid in cloud payload.');
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

