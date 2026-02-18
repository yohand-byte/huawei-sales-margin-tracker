import process from 'node:process';
import { createClient } from '@supabase/supabase-js';
import { isSlackConfigured, postSlackMessage } from './slack.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL?.trim() ?? '';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ??
  process.env.SUPABASE_ANON_KEY?.trim() ??
  process.env.VITE_SUPABASE_ANON_KEY?.trim() ??
  '';
const STORE_ID = process.env.SUPABASE_STORE_ID?.trim() ?? 'default-store';
let cachedClient = null;

const getSupabase = () => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing SUPABASE_URL or Supabase key.');
  }
  if (!cachedClient) {
    cachedClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: {
          'x-store-id': STORE_ID,
        },
      },
    });
  }
  return cachedClient;
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
};

const toNumber = (value) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  return Number((value / 100).toFixed(2));
};

const normalizeCountry = (country) => {
  if (typeof country !== 'string') {
    return null;
  }
  const trimmed = country.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed;
};

const money = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  return `${num.toFixed(2)} EUR`;
};

const shouldNotifySlackForEvent = (parsed) => {
  const type = String(parsed?.source_event_type ?? '');
  // We want "transactions du jour": only successful payment events with a real amount.
  if (
    type !== 'payment_intent.succeeded' &&
    type !== 'charge.succeeded' &&
    type !== 'checkout.session.completed' &&
    type !== 'checkout.session.async_payment_succeeded'
  ) {
    return false;
  }
  const received = typeof parsed?.net_received === 'number' ? parsed.net_received : null;
  const gross = typeof parsed?.source_payload?.amount_received === 'number' ? parsed.source_payload.amount_received : null;
  return (received !== null && received > 0) || (gross !== null && gross > 0);
};

export const parseStripeEvent = (event) => {
  const type = event?.type;
  const obj = event?.data?.object;
  if (!type || !obj || typeof obj !== 'object') {
    throw new Error('Invalid Stripe event payload.');
  }

  const metadata = obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : {};

  const createdAt =
    typeof event.created === 'number'
      ? new Date(event.created * 1000).toISOString()
      : new Date().toISOString();

  const paymentIntentId =
    typeof obj.payment_intent === 'string'
      ? obj.payment_intent
      : typeof obj.id === 'string' && obj.id.startsWith('pi_')
        ? obj.id
        : typeof obj.payment_intent?.id === 'string'
          ? obj.payment_intent.id
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
    typeof obj.shipping_cost?.amount_total === 'number'
      ? obj.shipping_cost.amount_total
      : typeof obj.total_details?.amount_shipping === 'number'
        ? obj.total_details.amount_shipping
        : null;

  const applicationFeeRaw =
    typeof obj.application_fee_amount === 'number' ? obj.application_fee_amount : null;

  const balanceTx = obj.balance_transaction && typeof obj.balance_transaction === 'object' ? obj.balance_transaction : null;
  const stripeFeeRaw = typeof balanceTx?.fee === 'number' ? balanceTx.fee : null;
  const netRaw = typeof balanceTx?.net === 'number' ? balanceTx.net : null;

  const clientName =
    obj.customer_details?.name ??
    obj.billing_details?.name ??
    obj.customer_email ??
    metadata.customer_name ??
    null;

  const customerCountry = normalizeCountry(
    obj.customer_details?.address?.country ?? obj.billing_details?.address?.country ?? metadata.customer_country,
  );

  const feesPlatform = toNumber(applicationFeeRaw);
  const feesStripe = toNumber(stripeFeeRaw);
  const amountReceived = toNumber(amountReceivedRaw);
  const netReceived = toNumber(netRaw) ??
    (amountReceived !== null
      ? Number(
          (
            amountReceived - (feesPlatform ?? 0) - (feesStripe ?? 0)
          ).toFixed(2),
        )
      : null);

  return {
    source_event_type: type,
    source_event_id: event.id,
    event_created_at: createdAt,
    channel: 'Sun.store',
    external_order_id: extOrder,
    transaction_ref: transactionRef,
    order_date: createdAt.slice(0, 10),
    customer_country: customerCountry,
    client_name: clientName,
    payment_method: 'Stripe',
    shipping_charged_ht: toNumber(shippingRaw),
    fees_platform: feesPlatform,
    fees_stripe: feesStripe,
    net_received: netReceived,
    source_payload: {
      stripe_type: type,
      negotiation_id: negotiationId,
      payment_intent_id: paymentIntentId,
      charge_id: chargeId,
      checkout_session_id: checkoutSessionId,
      amount_received: amountReceived,
      raw_event_amount_eur: amountReceived,
      raw_metadata: metadata,
    },
  };
};

const notifySlack = async (parsed, orderId, insertedNewEvent) => {
  if (!insertedNewEvent || !isSlackConfigured() || !shouldNotifySlackForEvent(parsed)) {
    return;
  }

  const negotiationId = parsed?.source_payload?.negotiation_id ?? null;
  const orderRef = negotiationId ? `#${negotiationId}` : parsed.external_order_id;
  const lines = [
    `*${parsed.channel}* transaction recue`,
    `Order: \`${orderRef}\``,
    parsed.transaction_ref ? `PI/TX: \`${parsed.transaction_ref}\`` : null,
    parsed.client_name ? `Client: *${parsed.client_name}*` : null,
    parsed.customer_country ? `Pays: *${parsed.customer_country}*` : null,
    parsed.source_payload?.amount_received ? `Montant: *${money(parsed.source_payload.amount_received)}*` : null,
    parsed.fees_platform ? `Fees platform: *${money(parsed.fees_platform)}*` : null,
    parsed.fees_stripe ? `Fees Stripe: *${money(parsed.fees_stripe)}*` : null,
    parsed.net_received ? `Net: *${money(parsed.net_received)}*` : null,
    orderId ? `Order id: \`${orderId}\`` : null,
  ].filter(Boolean);

  await postSlackMessage({
    username: 'SunStore Stripe Monitor',
    text: lines.join('\n'),
  });
};

const insertIngestEvent = async (parsed, event) => {
  const supabase = getSupabase();
  const row = {
    store_id: STORE_ID,
    source: 'stripe',
    source_event_id: parsed.source_event_id,
    channel: parsed.channel,
    external_order_id: parsed.external_order_id,
    status: 'processed',
    payload: {
      parsed,
      stripe_event_type: parsed.source_event_type,
      raw_event_id: event.id,
    },
    processed_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('ingest_events')
    .insert(row, { onConflict: 'store_id,source,source_event_id', ignoreDuplicates: true })
    .select('id');

  if (error) {
    throw new Error(`ingest_events insert failed: ${error.message}`);
  }
  return Array.isArray(data) && data.length > 0;
};

const upsertOrder = async (parsed) => {
  const supabase = getSupabase();
  const { data: existing, error: selectError } = await supabase
    .from('orders')
    .select('id,order_status')
    .eq('store_id', STORE_ID)
    .eq('channel', parsed.channel)
    .eq('external_order_id', parsed.external_order_id)
    .maybeSingle();

  if (selectError) {
    throw new Error(`orders select failed: ${selectError.message}`);
  }

  const orderStatus = existing?.order_status === 'VALIDE' ? 'VALIDE' : 'ENRICHI';

  const payload = {
    store_id: STORE_ID,
    channel: parsed.channel,
    external_order_id: parsed.external_order_id,
    source_status: 'stripe_enriched',
    order_status: orderStatus,
    order_date: parsed.order_date,
    source_event_at: parsed.event_created_at,
    transaction_ref: parsed.transaction_ref,
    customer_country: parsed.customer_country,
    client_name: parsed.client_name,
    payment_method: parsed.payment_method,
    shipping_charged_ht: parsed.shipping_charged_ht,
    fees_platform: parsed.fees_platform,
    fees_stripe: parsed.fees_stripe,
    net_received: parsed.net_received,
    source_payload: parsed.source_payload,
  };

  const { data, error } = await supabase
    .from('orders')
    .upsert(payload, { onConflict: 'store_id,channel,external_order_id' })
    .select('id')
    .single();

  if (error) {
    throw new Error(`orders upsert failed: ${error.message}`);
  }

  return data.id;
};

const logSync = async (parsed, orderId) => {
  const supabase = getSupabase();
  const { error } = await supabase.from('sync_logs').insert({
    store_id: STORE_ID,
    component: 'stripe-webhook',
    level: 'info',
    message: `Stripe event ingested (${parsed.source_event_type})`,
    context: {
      event_id: parsed.source_event_id,
      external_order_id: parsed.external_order_id,
      order_id: orderId,
      transaction_ref: parsed.transaction_ref,
    },
  });

  if (error) {
    throw new Error(`sync_logs insert failed: ${error.message}`);
  }
};

const main = async () => {
  const rawInput = await readStdin();
  if (!rawInput) {
    throw new Error('No JSON payload received on stdin.');
  }

  const event = JSON.parse(rawInput);
  if (typeof event?.id !== 'string') {
    throw new Error('Stripe event id is required.');
  }

  const parsed = parseStripeEvent(event);
  const insertedNewEvent = await insertIngestEvent(parsed, event);
  const orderId = await upsertOrder(parsed);
  await logSync(parsed, orderId);
  await notifySlack(parsed, orderId, insertedNewEvent);

  console.log(
    JSON.stringify({
      status: 'processed',
      event_id: parsed.source_event_id,
      event_type: parsed.source_event_type,
      external_order_id: parsed.external_order_id,
      order_id: orderId,
      transaction_ref: parsed.transaction_ref,
    }),
  );
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
