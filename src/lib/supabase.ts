import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { BackupPayload, ChatMessage } from '../types';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.trim() ?? '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? '';
const SUPABASE_TABLE = import.meta.env.VITE_SUPABASE_TABLE?.trim() || 'sales_margin_state';
const SUPABASE_STORE_ID = import.meta.env.VITE_SUPABASE_STORE_ID?.trim() || 'default-store';
const SUPABASE_MESSAGES_TABLE =
  import.meta.env.VITE_SUPABASE_MESSAGES_TABLE?.trim() || 'sales_margin_messages';
const SUPABASE_PUSH_SUBS_TABLE =
  import.meta.env.VITE_SUPABASE_PUSH_SUBS_TABLE?.trim() || 'sales_margin_push_subscriptions';
const SUPABASE_PUSH_FUNCTION_URL =
  import.meta.env.VITE_SUPABASE_PUSH_FUNCTION_URL?.trim() ||
  (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/chat-push-notify` : '');
const OPENAI_VOICE_TOKEN_URL =
  import.meta.env.VITE_OPENAI_VOICE_TOKEN_URL?.trim() ||
  (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/openai-voice-token` : '');
const STRIPE_DAILY_SUMMARY_URL =
  import.meta.env.VITE_STRIPE_DAILY_SUMMARY_URL?.trim() ||
  (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/stripe-daily-summary` : '');
const WEB_PUSH_PUBLIC_KEY = import.meta.env.VITE_WEB_PUSH_PUBLIC_KEY?.trim() ?? '';

export const isSupabaseConfigured = SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
export const webPushPublicKey = WEB_PUSH_PUBLIC_KEY;
export const isWebPushClientConfigured = WEB_PUSH_PUBLIC_KEY.length > 0;
export const supabaseUrl = SUPABASE_URL;
export const supabaseAnonKey = SUPABASE_ANON_KEY;
export const supabaseStoreId = SUPABASE_STORE_ID;
export const supabaseMessagesTable = SUPABASE_MESSAGES_TABLE;
export const openAiVoiceTokenUrl = OPENAI_VOICE_TOKEN_URL;
export const stripeDailySummaryUrl = STRIPE_DAILY_SUMMARY_URL;

export const isOpenAiVoiceConfigured = isSupabaseConfigured && OPENAI_VOICE_TOKEN_URL.length > 0;

export const createOpenAiRealtimeClientSecret = async (input: {
  voice?: string;
  instructions?: string;
  accessKey?: string;
}): Promise<{ value: string; expires_at: number; model: string; voice: string }> => {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase non configure.');
  }
  if (!OPENAI_VOICE_TOKEN_URL) {
    throw new Error('URL token OpenAI non configuree.');
  }

  const accessKey = input.accessKey?.trim() ?? '';
  const response = await fetch(OPENAI_VOICE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'x-store-id': SUPABASE_STORE_ID,
      ...(accessKey ? { 'x-app-secret': accessKey } : {}),
    },
    body: JSON.stringify({
      voice: input.voice,
      instructions: input.instructions,
    }),
  });
  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? '';
    const fallback = await response.text().catch(() => '');
    let message = fallback.trim();
    if (contentType.includes('application/json')) {
      try {
        const data = (JSON.parse(fallback || '{}') ?? {}) as { error?: unknown };
        if (typeof data.error === 'string' && data.error.trim()) {
          message = data.error.trim();
        }
      } catch {
        // ignore
      }
    }
    const hint =
      response.status === 401 || response.status === 403
        ? ' (cle OpenAI invalide / permissions)'
        : response.status === 503
          ? ' (secret OPENAI_API_KEY manquant dans Supabase)'
          : '';
    throw new Error(`Token OpenAI HTTP ${response.status}${hint}: ${message || 'Erreur inconnue'}`);
  }
  const data = (await response.json().catch(() => ({}))) as {
    client_secret?: { value?: string; expires_at?: number };
    model?: string;
    voice?: string;
  };
  const value = data.client_secret?.value ?? '';
  const expiresAt = data.client_secret?.expires_at ?? 0;
  if (!value || !expiresAt) {
    throw new Error('Token OpenAI invalide.');
  }
  return {
    value,
    expires_at: expiresAt,
    model: String(data.model ?? 'gpt-realtime'),
    voice: String(data.voice ?? ''),
  };
};

export const fetchStripeDailySummary = async (input: {
  date: string;
  tz_offset_min: number;
  accessKey: string;
  currency?: string;
}): Promise<{
  date: string;
  currency: string;
  charges: { count: number; gross: number; fees: number; net: number };
  refunds: { count: number; gross: number; fees: number; net: number };
  disputes: { count: number; gross: number; fees: number; net: number };
  payouts_from_balance_txns: { count: number; gross: number; fees: number; net: number };
  payouts: { count: number; total: number; items: Array<Record<string, unknown>> };
}> => {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase non configure.');
  }
  if (!STRIPE_DAILY_SUMMARY_URL) {
    throw new Error('URL Stripe daily summary non configuree.');
  }
  const accessKey = input.accessKey?.trim() ?? '';
  if (!accessKey) {
    throw new Error('Access key manquante (x-app-secret).');
  }

  const response = await fetch(STRIPE_DAILY_SUMMARY_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'x-store-id': SUPABASE_STORE_ID,
      'x-app-secret': accessKey,
    },
    body: JSON.stringify({
      date: input.date,
      tz_offset_min: input.tz_offset_min,
      currency: input.currency ?? 'eur',
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Stripe daily HTTP ${response.status}: ${text}`);
  }

  return (await response.json().catch(() => ({}))) as {
    date: string;
    currency: string;
    charges: { count: number; gross: number; fees: number; net: number };
    refunds: { count: number; gross: number; fees: number; net: number };
    disputes: { count: number; gross: number; fees: number; net: number };
    payouts_from_balance_txns: { count: number; gross: number; fees: number; net: number };
    payouts: { count: number; total: number; items: Array<Record<string, unknown>> };
  };
};

interface CloudStateRow {
  id: string;
  payload: BackupPayload;
  updated_at: string;
}

interface ChatMessageRow {
  id: string;
  store_id: string;
  author: string;
  body: string;
  device_id: string;
  created_at: string;
}

let client: SupabaseClient | null = null;

const getClient = (): SupabaseClient => {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase non configure (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).');
  }
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: {
          'x-store-id': SUPABASE_STORE_ID,
        },
      },
    });
  }
  return client;
};

const isBackupPayload = (value: unknown): value is BackupPayload => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<BackupPayload>;
  return (
    typeof candidate.generated_at === 'string' &&
    Array.isArray(candidate.sales) &&
    Array.isArray(candidate.catalog) &&
    !!candidate.stock &&
    typeof candidate.stock === 'object'
  );
};

export const pullCloudBackup = async (): Promise<BackupPayload | null> => {
  const supabase = getClient();
  const { data, error } = await supabase
    .from(SUPABASE_TABLE)
    .select('id,payload,updated_at')
    .eq('id', SUPABASE_STORE_ID)
    .maybeSingle<CloudStateRow>();

  if (error) {
    throw new Error(error.message);
  }
  if (!data) {
    return null;
  }
  if (!isBackupPayload(data.payload)) {
    throw new Error('Payload cloud invalide.');
  }
  return data.payload;
};

export const pushCloudBackup = async (payload: BackupPayload): Promise<string> => {
  const supabase = getClient();
  const { data, error } = await supabase
    .from(SUPABASE_TABLE)
    .upsert(
      {
        id: SUPABASE_STORE_ID,
        payload,
      },
      {
        onConflict: 'id',
      },
    )
    .select('updated_at')
    .single<{ updated_at: string }>();

  if (error) {
    throw new Error(error.message);
  }
  return data.updated_at;
};

export interface NewChatMessageInput {
  author: string;
  body: string;
  device_id: string;
}

export interface SavePushSubscriptionInput {
  device_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent?: string | null;
}

export const pullChatMessages = async (limit = 150): Promise<ChatMessage[]> => {
  const supabase = getClient();
  const { data, error } = await supabase
    .from(SUPABASE_MESSAGES_TABLE)
    .select('id,store_id,author,body,device_id,created_at')
    .eq('store_id', SUPABASE_STORE_ID)
    .order('created_at', { ascending: true })
    .limit(limit)
    .returns<ChatMessageRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    store_id: row.store_id,
    author: row.author,
    body: row.body,
    device_id: row.device_id,
    created_at: row.created_at,
  }));
};

export const pushChatMessage = async (input: NewChatMessageInput): Promise<ChatMessage> => {
  const author = input.author.trim();
  const body = input.body.trim();
  if (author.length === 0 || body.length === 0) {
    throw new Error('Nom et message requis.');
  }

  const supabase = getClient();
  const { data, error } = await supabase
    .from(SUPABASE_MESSAGES_TABLE)
    .insert({
      store_id: SUPABASE_STORE_ID,
      author: author.slice(0, 60),
      body: body.slice(0, 4000),
      device_id: input.device_id.trim().slice(0, 80),
    })
    .select('id,store_id,author,body,device_id,created_at')
    .single<ChatMessageRow>();

  if (error) {
    throw new Error(error.message);
  }

  return {
    id: data.id,
    store_id: data.store_id,
    author: data.author,
    body: data.body,
    device_id: data.device_id,
    created_at: data.created_at,
  };
};

export const savePushSubscription = async (input: SavePushSubscriptionInput): Promise<void> => {
  const endpoint = input.endpoint.trim();
  if (!endpoint) {
    throw new Error('Endpoint push invalide.');
  }
  const supabase = getClient();
  const { error } = await supabase.from(SUPABASE_PUSH_SUBS_TABLE).upsert(
    {
      store_id: SUPABASE_STORE_ID,
      device_id: input.device_id.trim().slice(0, 80),
      endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      user_agent: input.user_agent?.slice(0, 255) ?? null,
      enabled: true,
    },
    {
      onConflict: 'store_id,device_id,endpoint',
      ignoreDuplicates: false,
    },
  );
  if (error) {
    throw new Error(error.message);
  }
};

export const deletePushSubscription = async (endpoint: string): Promise<void> => {
  const supabase = getClient();
  const { error } = await supabase
    .from(SUPABASE_PUSH_SUBS_TABLE)
    .delete()
    .eq('store_id', SUPABASE_STORE_ID)
    .eq('endpoint', endpoint);
  if (error) {
    throw new Error(error.message);
  }
};

export const sendPushNotificationForChat = async (payload: {
  author: string;
  body: string;
  sender_device_id: string;
  url?: string;
}): Promise<void> => {
  if (!SUPABASE_PUSH_FUNCTION_URL) {
    throw new Error('URL fonction push non configuree.');
  }
  const response = await fetch(SUPABASE_PUSH_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'x-store-id': SUPABASE_STORE_ID,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Push HTTP ${response.status}: ${text}`);
  }
};
