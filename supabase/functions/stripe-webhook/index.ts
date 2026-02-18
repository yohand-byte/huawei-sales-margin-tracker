import { createClient } from 'npm:@supabase/supabase-js@2.95.3';

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers':
    'authorization, x-client-info, apikey, content-type, x-store-id, stripe-signature',
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

const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
};

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const hmacSha256Hex = async (secret: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return toHex(sig);
};

const verifyStripeSignature = async (rawBody: string, signatureHeader: string, secret: string): Promise<boolean> => {
  // Header format: t=...,v1=...,v1=...
  const parts = signatureHeader.split(',').map((p) => p.trim());
  const timestamp = parts
    .map((p) => p.split('='))
    .find(([k]) => k === 't')?.[1];
  const signatures = parts
    .map((p) => p.split('='))
    .filter(([k]) => k === 'v1')
    .map(([, v]) => v)
    .filter(Boolean);

  if (!timestamp || signatures.length === 0) return false;
  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = await hmacSha256Hex(secret, signedPayload);
  return signatures.some((sig) => timingSafeEqual(sig, expected));
};

const toEur = (value: unknown): number | null => {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return Number((value / 100).toFixed(2));
};

const isNonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

type StripeEvent = {
  id: string;
  type: string;
  created?: number;
  data: { object: Record<string, unknown> };
};

const formatMoney = (value: number | null, currency = 'EUR'): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '-';
  }
  return `${value.toFixed(2)} ${currency.toUpperCase()}`;
};

const parseStripeEvent = (event: StripeEvent) => {
  const obj = event.data.object ?? {};
  const metadata =
    obj.metadata && typeof obj.metadata === 'object' ? (obj.metadata as Record<string, unknown>) : {};

  const createdAt =
    typeof event.created === 'number'
      ? new Date(event.created * 1000).toISOString()
      : new Date().toISOString();

  const paymentIntentId =
    typeof obj.payment_intent === 'string'
      ? obj.payment_intent
      : typeof obj.id === 'string' && obj.id.startsWith('pi_')
        ? obj.id
        : typeof (obj.payment_intent as { id?: unknown } | undefined)?.id === 'string'
          ? (obj.payment_intent as { id: string }).id
          : null;

  const checkoutSessionId = typeof obj.id === 'string' && obj.id.startsWith('cs_') ? obj.id : null;
  const chargeId = typeof obj.id === 'string' && obj.id.startsWith('ch_') ? obj.id : null;

  const transactionRef =
    paymentIntentId ??
    (typeof metadata.transaction_ref === 'string' ? metadata.transaction_ref : null) ??
    chargeId ??
    checkoutSessionId;

  const negotiationId =
    (typeof metadata.negotiation_id === 'string' && metadata.negotiation_id) ||
    (typeof metadata.external_order_id === 'string' && metadata.external_order_id) ||
    (typeof metadata.order_ref === 'string' && metadata.order_ref) ||
    null;

  const extOrder = negotiationId ?? transactionRef ?? `stripe-${event.id}`;

  const amountReceivedRaw =
    typeof obj.amount_received === 'number'
      ? obj.amount_received
      : typeof obj.amount_total === 'number'
        ? obj.amount_total
        : typeof obj.amount === 'number'
          ? obj.amount
          : null;

  const shippingRaw =
    typeof (obj.shipping_cost as { amount_total?: unknown } | undefined)?.amount_total === 'number'
      ? (obj.shipping_cost as { amount_total: number }).amount_total
      : typeof (obj.total_details as { amount_shipping?: unknown } | undefined)?.amount_shipping === 'number'
        ? (obj.total_details as { amount_shipping: number }).amount_shipping
        : null;

  const applicationFeeRaw = typeof obj.application_fee_amount === 'number' ? obj.application_fee_amount : null;

  const balanceTx = obj.balance_transaction && typeof obj.balance_transaction === 'object'
    ? (obj.balance_transaction as Record<string, unknown>)
    : null;
  const stripeFeeRaw = typeof balanceTx?.fee === 'number' ? (balanceTx.fee as number) : null;
  const netRaw = typeof balanceTx?.net === 'number' ? (balanceTx.net as number) : null;

  const clientName =
    (obj.customer_details as { name?: unknown } | undefined)?.name ??
    (obj.billing_details as { name?: unknown } | undefined)?.name ??
    (obj.customer_email as string | undefined) ??
    (metadata.customer_name as string | undefined) ??
    null;

  const customerCountryRaw =
    (obj.customer_details as { address?: { country?: unknown } } | undefined)?.address?.country ??
    (obj.billing_details as { address?: { country?: unknown } } | undefined)?.address?.country ??
    metadata.customer_country ??
    null;

  const customerCountry =
    typeof customerCountryRaw === 'string' && customerCountryRaw.trim().length > 0 ? customerCountryRaw.trim() : null;

  const feesPlatform = toEur(applicationFeeRaw);
  const feesStripe = toEur(stripeFeeRaw);
  const amountReceived = toEur(amountReceivedRaw);
  const netReceived =
    toEur(netRaw) ??
    (amountReceived !== null
      ? Number((amountReceived - (feesPlatform ?? 0) - (feesStripe ?? 0)).toFixed(2))
      : null);
  const currency =
    typeof obj.currency === 'string' && obj.currency ? obj.currency.toUpperCase()
      : typeof (metadata.currency as unknown) === 'string'
        ? String(metadata.currency).toUpperCase()
        : 'EUR';

  return {
    source_event_type: event.type,
    source_event_id: event.id,
    event_created_at: createdAt,
    channel: 'Sun.store' as const,
    external_order_id: extOrder,
    transaction_ref: transactionRef,
    order_date: createdAt.slice(0, 10),
    customer_country: customerCountry,
    client_name: typeof clientName === 'string' ? clientName : null,
    payment_method: 'Stripe' as const,
    shipping_charged_ht: toEur(shippingRaw),
    fees_platform: feesPlatform,
    fees_stripe: feesStripe,
    net_received: netReceived,
    source_payload: {
      stripe_type: event.type,
      negotiation_id: negotiationId,
      payment_intent_id: paymentIntentId,
      charge_id: chargeId,
      checkout_session_id: checkoutSessionId,
      amount_received: amountReceived,
      currency,
      raw_metadata: metadata,
    },
  };
};

const parsePayoutEvent = (event: StripeEvent) => {
  const obj = event.data.object ?? {};
  const createdAt =
    typeof event.created === 'number'
      ? new Date(event.created * 1000).toISOString()
      : new Date().toISOString();

  const payoutId = typeof obj.id === 'string' ? obj.id : `payout-${event.id}`;
  const amount = toEur(obj.amount);
  const currency = typeof obj.currency === 'string' && obj.currency ? obj.currency.toUpperCase() : 'EUR';
  const status = typeof obj.status === 'string' ? obj.status : null;
  const arrivalDate =
    typeof obj.arrival_date === 'number' ? new Date(obj.arrival_date * 1000).toISOString().slice(0, 10) : null;

  return {
    source_event_type: event.type,
    source_event_id: event.id,
    event_created_at: createdAt,
    channel: 'Sun.store' as const,
    external_order_id: payoutId,
    transaction_ref: payoutId,
    order_date: createdAt.slice(0, 10),
    customer_country: null,
    client_name: null,
    payment_method: 'Stripe' as const,
    shipping_charged_ht: 0,
    fees_platform: 0,
    fees_stripe: 0,
    net_received: null,
    source_payload: {
      stripe_type: event.type,
      payout_id: payoutId,
      amount,
      currency,
      status,
      arrival_date: arrivalDate,
    },
  };
};

const shouldNotifySlack = (type: string): boolean => {
  return (
    type === 'payment_intent.created' ||
    type === 'payment_intent.succeeded' ||
    type === 'charge.succeeded' ||
    type === 'checkout.session.completed' ||
    type === 'checkout.session.async_payment_succeeded' ||
    type.startsWith('payout.')
  );
};

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
  const stripeSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
  const slackWebhookUrl = Deno.env.get('SLACK_WEBHOOK_URL') ?? '';

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, { error: 'Missing Supabase env secrets.' });
  }
  if (!stripeSecret) {
    return jsonResponse(500, { error: 'Missing STRIPE_WEBHOOK_SECRET.' });
  }

  const storeId = (request.headers.get('x-store-id')?.trim() ?? storeIdEnv.trim());
  if (!storeId) {
    return jsonResponse(400, { error: 'Missing store id (x-store-id header or SUPABASE_STORE_ID env).' });
  }

  const signatureHeader = request.headers.get('stripe-signature')?.trim() ?? '';
  if (!signatureHeader) {
    return jsonResponse(400, { error: 'Missing stripe-signature header.' });
  }

  const rawBody = await request.text();
  const ok = await verifyStripeSignature(rawBody, signatureHeader, stripeSecret);
  if (!ok) {
    return jsonResponse(401, { error: 'Invalid Stripe signature.' });
  }

  const event = JSON.parse(rawBody) as StripeEvent;
  if (!event?.id || !event?.type) {
    return jsonResponse(400, { error: 'Invalid Stripe event.' });
  }

  const parsed = event.type.startsWith('payout.') ? parsePayoutEvent(event) : parseStripeEvent(event);
  const shouldUpsertOrder = event.type === 'payment_intent.succeeded' ||
    event.type === 'charge.succeeded' ||
    event.type === 'checkout.session.completed' ||
    event.type === 'checkout.session.async_payment_succeeded';

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  // Idempotence: only notify once per Stripe event id.
  const { data: ingestRows, error: ingestError } = await supabase
    .from('ingest_events')
    .insert(
      {
        store_id: storeId,
        source: 'stripe',
        source_event_id: parsed.source_event_id,
        channel: parsed.channel,
        external_order_id: parsed.external_order_id,
        status: 'processed',
        payload: { parsed },
        processed_at: new Date().toISOString(),
      },
      { onConflict: 'store_id,source,source_event_id', ignoreDuplicates: true },
    )
    .select('id');

  if (ingestError) {
    return jsonResponse(500, { error: `ingest_events insert failed: ${ingestError.message}` });
  }
  const insertedNew = Array.isArray(ingestRows) && ingestRows.length > 0;

  let orderId: string | null = null;
  if (shouldUpsertOrder) {
    const { data: orderRow, error: orderError } = await supabase
      .from('orders')
      .upsert(
        {
          store_id: storeId,
          channel: parsed.channel,
          external_order_id: parsed.external_order_id,
          source_status: 'stripe_enriched',
          order_status: 'ENRICHI',
          order_date: parsed.order_date,
          source_event_at: parsed.event_created_at,
          transaction_ref: parsed.transaction_ref,
          customer_country: parsed.customer_country,
          client_name: parsed.client_name,
          payment_method: parsed.payment_method,
          shipping_charged_ht: parsed.shipping_charged_ht ?? 0,
          fees_platform: parsed.fees_platform ?? 0,
          fees_stripe: parsed.fees_stripe ?? 0,
          net_received: parsed.net_received,
          source_payload: parsed.source_payload,
        },
        { onConflict: 'store_id,channel,external_order_id' },
      )
      .select('id')
      .single();

    if (orderError) {
      return jsonResponse(500, { error: `orders upsert failed: ${orderError.message}` });
    }
    orderId = orderRow?.id ?? null;
  }

  if (insertedNew && slackWebhookUrl && shouldNotifySlack(parsed.source_event_type)) {
    const negotiationId = parsed.source_payload.negotiation_id;
    const orderRef = negotiationId ? `#${negotiationId}` : parsed.external_order_id;
    const currency = typeof parsed.source_payload.currency === 'string' ? parsed.source_payload.currency : 'EUR';
    const amount = typeof parsed.source_payload.amount_received === 'number' ? parsed.source_payload.amount_received : null;
    const lines = [
      `*[SunStore][Stripe]* ${parsed.source_event_type}`,
      `Event: \`${parsed.source_event_id}\``,
      `Order: \`${orderRef}\``,
      parsed.transaction_ref ? `PI/TX: \`${parsed.transaction_ref}\`` : null,
      isNonEmpty(parsed.client_name) ? `Client: *${parsed.client_name}*` : null,
      isNonEmpty(parsed.customer_country) ? `Pays: *${parsed.customer_country}*` : null,
      amount !== null ? `Montant: *${formatMoney(amount, currency)}*` : null,
      parsed.fees_platform ? `Fees platform: *${formatMoney(parsed.fees_platform, currency)}*` : null,
      parsed.fees_stripe ? `Fees Stripe: *${formatMoney(parsed.fees_stripe, currency)}*` : null,
      parsed.net_received ? `Net: *${formatMoney(parsed.net_received, currency)}*` : null,
      typeof parsed.source_payload.status === 'string' ? `Status: *${parsed.source_payload.status}*` : null,
      typeof parsed.source_payload.arrival_date === 'string' ? `Arrival: *${parsed.source_payload.arrival_date}*` : null,
      orderId ? `Order id: \`${orderId}\`` : null,
    ].filter(Boolean);
    try {
      await postSlack(slackWebhookUrl, lines.join('\n'));
    } catch (error) {
      // Don't fail the webhook on Slack outage.
      await supabase.from('sync_logs').insert({
        store_id: storeId,
        component: 'stripe-webhook',
        level: 'warn',
        message: 'Slack notify failed',
        context: { error: String((error as Error).message ?? error), event_id: event.id },
      });
    }
  }

  return jsonResponse(200, {
    status: insertedNew ? 'processed' : 'duplicate',
    event_id: parsed.source_event_id,
    event_type: parsed.source_event_type,
    order_id: orderId,
    external_order_id: parsed.external_order_id,
  });
});
