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

  const body = (await request.json().catch(() => ({}))) as { date?: string; channel?: string };
  const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : todayIsoUtc();
  const channel = body.channel === 'Solartraders' ? 'Solartraders' : 'Sun.store';

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const { data, error } = await supabase
    .from('orders')
    .select(
      'external_order_id,transaction_ref,client_name,customer_country,order_date,net_received,fees_platform,fees_stripe,shipping_charged_ht',
    )
    .eq('store_id', storeId)
    .eq('channel', channel)
    .eq('order_date', date)
    .order('updated_at', { ascending: false })
    .limit(40);

  if (error) {
    return jsonResponse(500, { error: error.message });
  }

  const rows = Array.isArray(data) ? data : [];
  const paid = rows.filter((row) => typeof row.net_received === 'number' && row.net_received > 0);
  const count = paid.length;
  const totalNet = paid.reduce((sum, row) => sum + (typeof row.net_received === 'number' ? row.net_received : 0), 0);

  const lines: string[] = [];
  lines.push(`[${channel}] Daily report ${date} | paid=${count} net=${totalNet.toFixed(2)} EUR`);
  if (paid.length === 0) {
    lines.push('Aucune transaction payee detectee.');
  } else {
    for (const row of paid.slice(0, 15)) {
      const tx = row.transaction_ref ? ` ${row.transaction_ref}` : '';
      const client = row.client_name ? ` | ${row.client_name}` : '';
      const country = row.customer_country ? ` | ${row.customer_country}` : '';
      lines.push(`- ${row.external_order_id}${tx}${client}${country} | net ${Number(row.net_received).toFixed(2)} EUR`);
    }
    if (paid.length > 15) {
      lines.push(`... +${paid.length - 15} autres`);
    }
  }

  await postSlack(slackWebhookUrl, lines.join('\n'));
  return jsonResponse(200, { ok: true, date, channel, paid: count });
});

