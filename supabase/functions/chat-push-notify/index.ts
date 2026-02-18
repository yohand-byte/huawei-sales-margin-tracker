import { createClient } from 'npm:@supabase/supabase-js@2.95.3';
import webpush from 'npm:web-push@3.6.7';

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

interface PushSubscriptionRow {
  id: string;
  device_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const vapidPublicKey = Deno.env.get('WEB_PUSH_PUBLIC_KEY') ?? '';
  const vapidPrivateKey = Deno.env.get('WEB_PUSH_PRIVATE_KEY') ?? '';
  const vapidSubject = Deno.env.get('WEB_PUSH_SUBJECT') ?? 'mailto:admin@example.com';
  const tableName = Deno.env.get('PUSH_SUBSCRIPTIONS_TABLE') ?? 'sales_margin_push_subscriptions';
  const appBaseUrl = Deno.env.get('APP_BASE_URL') ?? '/';

  if (!supabaseUrl || !serviceRoleKey || !vapidPublicKey || !vapidPrivateKey) {
    return jsonResponse(500, { error: 'Missing required env secrets for push notifications.' });
  }

  const storeId = request.headers.get('x-store-id')?.trim() ?? '';
  if (!storeId) {
    return jsonResponse(400, { error: 'Missing x-store-id header.' });
  }

  const body = (await request.json().catch(() => ({}))) as {
    author?: string;
    body?: string;
    sender_device_id?: string;
    url?: string;
  };
  const author = body.author?.trim() ?? '';
  const message = body.body?.trim() ?? '';
  const senderDeviceId = body.sender_device_id?.trim() ?? '';
  const targetUrl = body.url?.trim() || appBaseUrl;

  if (!author || !message) {
    return jsonResponse(400, { error: 'Invalid payload. author/body required.' });
  }

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  let query = supabase
    .from(tableName)
    .select('id,device_id,endpoint,p256dh,auth')
    .eq('store_id', storeId)
    .eq('enabled', true);
  if (senderDeviceId) {
    query = query.neq('device_id', senderDeviceId);
  }

  const { data, error } = await query.returns<PushSubscriptionRow[]>();
  if (error) {
    return jsonResponse(500, { error: error.message });
  }
  if (!data || data.length === 0) {
    return jsonResponse(200, { sent: 0, failed: 0, disabled: 0, total: 0 });
  }

  const payload = JSON.stringify({
    title: `${author} • Sales Manager`,
    body: message.length > 180 ? `${message.slice(0, 177)}...` : message,
    url: targetUrl,
    tag: 'chat-message',
  });

  let sent = 0;
  let failed = 0;
  let disabled = 0;

  for (const subscription of data) {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.p256dh,
            auth: subscription.auth,
          },
        },
        payload,
      );
      sent += 1;
    } catch (error: unknown) {
      failed += 1;
      const statusCode = (error as { statusCode?: number; status?: number }).statusCode
        ?? (error as { statusCode?: number; status?: number }).status;
      if (statusCode === 404 || statusCode === 410) {
        disabled += 1;
        await supabase.from(tableName).update({ enabled: false }).eq('id', subscription.id);
      }
    }
  }

  return jsonResponse(200, {
    sent,
    failed,
    disabled,
    total: data.length,
  });
});
