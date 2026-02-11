import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { BackupPayload } from '../types';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.trim() ?? '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? '';
const SUPABASE_TABLE = import.meta.env.VITE_SUPABASE_TABLE?.trim() || 'sales_margin_state';
const SUPABASE_STORE_ID = import.meta.env.VITE_SUPABASE_STORE_ID?.trim() || 'default-store';

export const isSupabaseConfigured = SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;

interface CloudStateRow {
  id: string;
  payload: BackupPayload;
  updated_at: string;
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

