import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { BackupPayload, ChatMessage } from '../types';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.trim() ?? '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? '';
const SUPABASE_TABLE = import.meta.env.VITE_SUPABASE_TABLE?.trim() || 'sales_margin_state';
const SUPABASE_MESSAGES_TABLE =
  import.meta.env.VITE_SUPABASE_MESSAGES_TABLE?.trim() || 'sales_margin_messages';
const SUPABASE_PUSH_SUBS_TABLE =
  import.meta.env.VITE_SUPABASE_PUSH_SUBS_TABLE?.trim() || 'sales_margin_push_subscriptions';
const SUPABASE_PUSH_FUNCTION_URL =
  import.meta.env.VITE_SUPABASE_PUSH_FUNCTION_URL?.trim() ||
  (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/chat-push-notify` : '');
const WEB_PUSH_PUBLIC_KEY = import.meta.env.VITE_WEB_PUSH_PUBLIC_KEY?.trim() ?? '';
const STORE_ID_STORAGE_KEY = 'sales_margin_tracker_supabase_store_id_v2';

export const isSupabaseConfigured = SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
export const webPushPublicKey = WEB_PUSH_PUBLIC_KEY;
export const isWebPushClientConfigured = WEB_PUSH_PUBLIC_KEY.length > 0;
export const supabaseUrl = SUPABASE_URL;
export const supabaseAnonKey = SUPABASE_ANON_KEY;
export const supabaseMessagesTable = SUPABASE_MESSAGES_TABLE;

export const getSupabaseStoreId = (): string => {
  try {
    return (localStorage.getItem(STORE_ID_STORAGE_KEY) ?? '').trim();
  } catch {
    return '';
  }
};

export const hasSupabaseStoreId = (): boolean => getSupabaseStoreId().length > 0;

export const setSupabaseStoreId = (storeId: string): void => {
  const normalized = storeId.trim();
  if (!normalized) {
    throw new Error('Store ID vide.');
  }
  try {
    localStorage.setItem(STORE_ID_STORAGE_KEY, normalized);
  } catch {
    // ignore
  }
  // Recreate the client with the new store header on next request.
  client = null;
  clientStoreId = null;
};

export const clearSupabaseStoreId = (): void => {
  try {
    localStorage.removeItem(STORE_ID_STORAGE_KEY);
  } catch {
    // ignore
  }
  client = null;
  clientStoreId = null;
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
let clientStoreId: string | null = null;

const getClient = (): SupabaseClient => {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase non configure (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).');
  }
  const storeId = getSupabaseStoreId();
  if (!storeId) {
    throw new Error('Supabase: store id manquant (configure la cle cloud).');
  }
  if (!client || clientStoreId !== storeId) {
    clientStoreId = storeId;
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: {
          'x-store-id': storeId,
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
  const row = await pullCloudBackupWithMeta();
  return row ? row.payload : null;
};

export const pullCloudBackupWithMeta = async (): Promise<{ payload: BackupPayload; updated_at: string } | null> => {
  const storeId = getSupabaseStoreId();
  const supabase = getClient();
  const { data, error } = await supabase
    .from(SUPABASE_TABLE)
    .select('id,payload,updated_at')
    .eq('id', storeId)
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
  return { payload: data.payload, updated_at: data.updated_at };
};

export const pullCloudUpdatedAt = async (): Promise<string | null> => {
  const storeId = getSupabaseStoreId();
  const supabase = getClient();
  const { data, error } = await supabase
    .from(SUPABASE_TABLE)
    .select('updated_at')
    .eq('id', storeId)
    .maybeSingle<{ updated_at: string }>();

  if (error) {
    throw new Error(error.message);
  }
  return data?.updated_at ?? null;
};

export const pushCloudBackup = async (payload: BackupPayload): Promise<string> => {
  const storeId = getSupabaseStoreId();
  const supabase = getClient();
  const { data, error } = await supabase
    .from(SUPABASE_TABLE)
    .upsert(
      {
        id: storeId,
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
  const storeId = getSupabaseStoreId();
  const supabase = getClient();
  const { data, error } = await supabase
    .from(SUPABASE_MESSAGES_TABLE)
    .select('id,store_id,author,body,device_id,created_at')
    .eq('store_id', storeId)
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

  const storeId = getSupabaseStoreId();
  const supabase = getClient();
  const { data, error } = await supabase
    .from(SUPABASE_MESSAGES_TABLE)
    .insert({
      store_id: storeId,
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
  const storeId = getSupabaseStoreId();
  const supabase = getClient();
  const { error } = await supabase.from(SUPABASE_PUSH_SUBS_TABLE).upsert(
    {
      store_id: storeId,
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
  const storeId = getSupabaseStoreId();
  const supabase = getClient();
  const { error } = await supabase
    .from(SUPABASE_PUSH_SUBS_TABLE)
    .delete()
    .eq('store_id', storeId)
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
  const storeId = getSupabaseStoreId();
  if (!SUPABASE_PUSH_FUNCTION_URL) {
    throw new Error('URL fonction push non configuree.');
  }
  const response = await fetch(SUPABASE_PUSH_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'x-store-id': storeId,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Push HTTP ${response.status}: ${text}`);
  }
};
