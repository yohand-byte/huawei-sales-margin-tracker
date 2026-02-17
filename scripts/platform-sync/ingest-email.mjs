import process from 'node:process';
import { createClient } from '@supabase/supabase-js';
import { parsePlatformEmail } from './email-parser.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL?.trim() ?? '';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ??
  process.env.SUPABASE_ANON_KEY?.trim() ??
  process.env.VITE_SUPABASE_ANON_KEY?.trim() ??
  '';
const STORE_ID = process.env.SUPABASE_STORE_ID?.trim() ?? 'default-store';

const requiredEnvMissing = SUPABASE_URL.length === 0 || SUPABASE_KEY.length === 0;
if (requiredEnvMissing) {
  console.error('Missing SUPABASE_URL or SUPABASE key (service role preferred, anon fallback).');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
};

const toIsoTimestamp = (value) => {
  if (!value) {
    return new Date().toISOString();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
};

const createIngestEvent = async (eventId, payload) => {
  const row = {
    store_id: STORE_ID,
    source: 'email',
    source_event_id: eventId,
    status: 'received',
    payload,
  };

  const { data, error } = await supabase
    .from('ingest_events')
    .upsert(row, {
      onConflict: 'store_id,source,source_event_id',
      ignoreDuplicates: true,
    })
    .select('id,status')
    .maybeSingle();

  if (error) {
    throw new Error(`ingest_events upsert failed: ${error.message}`);
  }

  if (!data) {
    return { duplicate: true, id: null };
  }

  return { duplicate: false, id: data.id };
};

const updateIngestEvent = async (eventId, status, payload, errorMessage = null) => {
  const patch = {
    status,
    payload,
    error_message: errorMessage,
    processed_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('ingest_events')
    .update(patch)
    .eq('store_id', STORE_ID)
    .eq('source', 'email')
    .eq('source_event_id', eventId);

  if (error) {
    throw new Error(`ingest_events update failed: ${error.message}`);
  }
};

const logSync = async (level, message, context = {}) => {
  const { error } = await supabase.from('sync_logs').insert({
    store_id: STORE_ID,
    component: 'email-trigger',
    level,
    message,
    context,
  });
  if (error) {
    throw new Error(`sync_logs insert failed: ${error.message}`);
  }
};

const upsertInboxMessage = async ({ message, parsed }) => {
  const row = {
    store_id: STORE_ID,
    provider: message.provider ?? 'imap',
    message_id: message.message_id,
    thread_id: message.thread_id ?? null,
    received_at: toIsoTimestamp(message.received_at),
    from_email: message.from_email ?? null,
    subject: message.subject ?? null,
    raw_text: message.text ?? null,
    channel: parsed.channel,
    negotiation_id: parsed.negotiationId,
    parsed_product_refs: parsed.productRefs,
    parse_confidence: parsed.confidence,
    parse_errors: parsed.errors,
    payload: message.payload ?? {},
  };

  const { error } = await supabase
    .from('inbox_messages')
    .upsert(row, { onConflict: 'store_id,message_id' });

  if (error) {
    throw new Error(`inbox_messages upsert failed: ${error.message}`);
  }
};

const upsertOrder = async ({ message, parsed }) => {
  if (!parsed.channel || !parsed.negotiationId) {
    return null;
  }

  const orderDate = toIsoTimestamp(message.received_at).slice(0, 10);

  const payload = {
    store_id: STORE_ID,
    channel: parsed.channel,
    external_order_id: parsed.negotiationId,
    source_status: 'email_detected',
    order_status: 'PROVISOIRE',
    order_date: orderDate,
    source_event_at: toIsoTimestamp(message.received_at),
    source_payload: {
      last_message_id: message.message_id,
      from_email: message.from_email ?? null,
      ready_in_days: parsed.readyInDays,
      parse_confidence: parsed.confidence,
    },
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

const replaceOrderLines = async (orderId, productRefs) => {
  if (!orderId || productRefs.length === 0) {
    return;
  }

  const { error: deleteError } = await supabase.from('order_lines').delete().eq('order_id', orderId);
  if (deleteError) {
    throw new Error(`order_lines delete failed: ${deleteError.message}`);
  }

  const rows = productRefs.map((productRef, index) => ({
    order_id: orderId,
    line_index: index + 1,
    product_ref: productRef,
    quantity: 1,
    source_payload: {
      source: 'email',
    },
  }));

  const { error: insertError } = await supabase.from('order_lines').insert(rows);
  if (insertError) {
    throw new Error(`order_lines insert failed: ${insertError.message}`);
  }
};

const validateInput = (payload) => {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Input must be a JSON object.');
  }
  if (typeof payload.message_id !== 'string' || payload.message_id.trim().length === 0) {
    throw new Error('message_id is required.');
  }
  if (typeof payload.subject !== 'string') {
    throw new Error('subject is required.');
  }
  if (typeof payload.text !== 'string') {
    throw new Error('text is required.');
  }
};

const main = async () => {
  const rawInput = await readStdin();
  if (!rawInput) {
    throw new Error('No JSON payload received on stdin.');
  }

  const message = JSON.parse(rawInput);
  validateInput(message);

  const ingestEvent = await createIngestEvent(message.message_id, {
    subject: message.subject,
    from_email: message.from_email ?? null,
  });

  if (ingestEvent.duplicate) {
    console.log(JSON.stringify({ status: 'duplicate', message_id: message.message_id }));
    return;
  }

  const parsed = parsePlatformEmail({
    fromEmail: message.from_email ?? '',
    subject: message.subject,
    text: message.text,
  });

  await upsertInboxMessage({ message, parsed });

  const orderId = await upsertOrder({ message, parsed });
  if (orderId && parsed.productRefs.length > 0) {
    await replaceOrderLines(orderId, parsed.productRefs);
  }

  const finalStatus = parsed.errors.length === 0 ? 'processed' : 'failed';
  await updateIngestEvent(
    message.message_id,
    finalStatus,
    {
      parsed,
      order_id: orderId,
    },
    parsed.errors.length > 0 ? parsed.errors.join(',') : null,
  );

  await logSync(
    parsed.errors.length > 0 ? 'warn' : 'info',
    `Email ingested (${finalStatus})`,
    {
      message_id: message.message_id,
      channel: parsed.channel,
      negotiation_id: parsed.negotiationId,
      order_id: orderId,
      errors: parsed.errors,
    },
  );

  console.log(
    JSON.stringify({
      status: finalStatus,
      message_id: message.message_id,
      channel: parsed.channel,
      negotiation_id: parsed.negotiationId,
      order_id: orderId,
      product_refs: parsed.productRefs,
    }),
  );
};

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
