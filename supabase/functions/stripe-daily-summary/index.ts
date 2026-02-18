import { createClient } from 'npm:@supabase/supabase-js@2.95.3';

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, x-store-id',
  'access-control-allow-methods': 'POST, OPTIONS',
};

const jsonResponse = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'content-type': 'application/json',
    },
  });

const todayIsoUtc = (): string => new Date().toISOString().slice(0, 10);

const postSlack = async (webhookUrl: string, text: string) => {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ username: 'SunStore Stripe Monitor', text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Slack webhook failed (${res.status}): ${body || res.statusText}`);
  }
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const storeIdEnv = Deno.env.get('SUPABASE_STORE_ID') ?? '';
  const slackWebhookUrl = Deno.env.get('SLACK_WEBHOOK_URL') ?? '';
  const monitorToken = Deno.env.get('MONITOR_TOKEN') ?? '';

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, { error: 'Missing Supabase env secrets.' });
  }
  if (!slackWebhookUrl) {
    return jsonResponse(500, { error: 'Missing SLACK_WEBHOOK_URL.' });
  }
  if (!monitorToken) {
    return jsonResponse(500, { error: 'Missing MONITOR_TOKEN.' });
  }

  const auth = request.headers.get('authorization')?.trim() ?? '';
  if (auth !== `Bearer ${monitorToken}`) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  const storeId = request.headers.get('x-store-id')?.trim() ?? storeIdEnv.trim();
  if (!storeId) {
    return jsonResponse(400, { error: 'Missing store id (x-store-id header or SUPABASE_STORE_ID env).' });
  }

  const body = (await request.json().catch(() => ({}))) as { date?: string };
  const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : todayIsoUtc();

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const start = `${date}T00:00:00.000Z`;
  const endDate = new Date(`${date}T00:00:00.000Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  const end = endDate.toISOString();

  const { data, error } = await supabase
    .from('ingest_events')
    .select('source_event_id,created_at,payload')
    .eq('store_id', storeId)
    .eq('source', 'stripe')
    .gte('created_at', start)
    .lt('created_at', end)
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) {
    return jsonResponse(500, { error: error.message });
  }

  const rows = Array.isArray(data) ? data : [];
  const counts = new Map<string, number>();
  const zeroAmount: { id: string; type: string }[] = [];
  const samples = new Map<string, string[]>();

  for (const row of rows) {
    const payload = (row as { payload?: unknown }).payload as
      | { parsed?: { source_event_type?: unknown; source_payload?: { amount_received?: unknown; amount?: unknown } } }
      | undefined;
    const parsed = payload?.parsed ?? {};
    const eventType = typeof parsed.source_event_type === 'string' ? parsed.source_event_type : 'unknown';
    counts.set(eventType, (counts.get(eventType) ?? 0) + 1);

    const list = samples.get(eventType) ?? [];
    if (list.length < 3 && typeof (row as { source_event_id?: unknown }).source_event_id === 'string') {
      list.push((row as { source_event_id: string }).source_event_id);
      samples.set(eventType, list);
    }

    const amountReceived = parsed?.source_payload && typeof parsed.source_payload.amount_received === 'number'
      ? parsed.source_payload.amount_received
      : parsed?.source_payload && typeof (parsed.source_payload as { amount?: unknown }).amount === 'number'
        ? (parsed.source_payload as { amount: number }).amount
        : null;
    if (amountReceived !== null && amountReceived === 0 && typeof (row as { source_event_id?: unknown }).source_event_id === 'string') {
      zeroAmount.push({ id: (row as { source_event_id: string }).source_event_id, type: eventType });
    }
  }

  const getCount = (type: string) => counts.get(type) ?? 0;
  const payoutTypes = Array.from(counts.keys()).filter((key) => key.startsWith('payout.'));
  const payoutTotal = payoutTypes.reduce((sum, key) => sum + (counts.get(key) ?? 0), 0);

  const lines: string[] = [];
  lines.push(`[SunStore][Stripe] Events recues ${date} (UTC) | total=${rows.length}`);
  lines.push(`- payment_intent.created: ${getCount('payment_intent.created')}`);
  lines.push(`- payment_intent.succeeded: ${getCount('payment_intent.succeeded')}`);
  lines.push(`- checkout.session.completed: ${getCount('checkout.session.completed')}`);
  lines.push(`- payout.*: ${payoutTotal}${payoutTypes.length ? ` (${payoutTypes.map((t) => `${t}=${getCount(t)}`).join(', ')})` : ''}`);

  const otherTypes = Array.from(counts.entries())
    .filter(([type]) => !type.startsWith('payout.') && !['payment_intent.created', 'payment_intent.succeeded', 'checkout.session.completed'].includes(type))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  if (otherTypes.length > 0) {
    lines.push(`Autres: ${otherTypes.map(([t, c]) => `${t}=${c}`).join(', ')}`);
  }

  if (zeroAmount.length > 0) {
    lines.push(`Zero amount: ${zeroAmount.slice(0, 6).map((z) => `${z.type}:${z.id}`).join(' | ')}${zeroAmount.length > 6 ? ` (+${zeroAmount.length - 6})` : ''}`);
  }

  const succeededSamples = samples.get('payment_intent.succeeded') ?? [];
  if (succeededSamples.length > 0) {
    lines.push(`Samples succeeded: ${succeededSamples.map((id) => `\`${id}\``).join(' ')}`);
  }

  await postSlack(slackWebhookUrl, lines.join('\n'));
  return jsonResponse(200, {
    ok: true,
    date,
    total: rows.length,
    counts: Object.fromEntries(counts.entries()),
    payout_total: payoutTotal,
  });
});
