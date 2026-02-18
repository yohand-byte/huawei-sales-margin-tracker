const corsHeaders: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, x-store-id, x-app-secret',
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

type CreateClientSecretResponse = {
  value?: string;
  expires_at?: number;
  session?: {
    model?: string;
    audio?: {
      output?: {
        voice?: string;
      };
    };
  };
};

const coerceOpenAiErrorMessage = async (response: Response): Promise<string> => {
  // OpenAI usually returns JSON: { error: { message, type, code, ... } }.
  try {
    const data = (await response.json().catch(() => null)) as
      | { error?: { message?: unknown; type?: unknown; code?: unknown } }
      | null;
    const msg = typeof data?.error?.message === 'string' ? data.error.message.trim() : '';
    const code = typeof data?.error?.code === 'string' ? data.error.code.trim() : '';
    const type = typeof data?.error?.type === 'string' ? data.error.type.trim() : '';
    const parts = [code, type, msg].filter(Boolean);
    if (parts.length) {
      return parts.join(' - ').slice(0, 800);
    }
  } catch {
    // ignore
  }
  const text = await response.text().catch(() => '');
  return text.trim().slice(0, 800) || `OpenAI HTTP ${response.status}`;
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const openaiApiKey = Deno.env.get('OPENAI_API_KEY') ?? '';
  const model = Deno.env.get('OPENAI_REALTIME_MODEL') ?? 'gpt-realtime';
  const defaultVoice = Deno.env.get('OPENAI_REALTIME_VOICE') ?? 'marin';
  const appSharedSecret = Deno.env.get('APP_SHARED_SECRET') ?? '';

  if (!openaiApiKey) {
    return jsonResponse(503, { error: 'OPENAI_API_KEY manquant dans les secrets Supabase.' });
  }

  const storeId = request.headers.get('x-store-id')?.trim() ?? '';
  if (!storeId) {
    return jsonResponse(400, { error: 'Missing x-store-id header.' });
  }

  if (appSharedSecret) {
    const provided = request.headers.get('x-app-secret')?.trim() ?? '';
    if (!provided || provided !== appSharedSecret) {
      return jsonResponse(401, { error: 'Unauthorized (x-app-secret requis).' });
    }
  }

  const body = (await request.json().catch(() => ({}))) as {
    voice?: string;
    instructions?: string;
  };

  const voice = (body.voice?.trim() || defaultVoice).slice(0, 40);
  const instructions =
    body.instructions?.trim() ||
    [
      'Tu es un assistant vocal interne pour Huawei Sales Manager.',
      'Tu aides a comprendre marges, commissions, stock, et a resumer les commandes/PJ.',
      'Reponds en francais, tres concret, sans blabla.',
      'Si une info manque, pose une seule question courte.',
    ].join('\n');

  const session = {
    type: 'realtime',
    model,
    instructions,
    // Better end-user experience than raw server VAD on laptop mics.
    audio: {
      input: {
        turn_detection: {
          // Realtime client_secrets expects server_vad today.
          // (semantic_vad is accepted by some clients, but isn't stable on the REST config.)
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          // Slightly longer silence avoids "jumping in" on short pauses.
          silence_duration_ms: 450,
          create_response: true,
          interrupt_response: true,
        },
        noise_reduction: { type: 'near_field' },
      },
      output: {
        voice,
        // Default to a calmer speaking rate; user can still override via session.update from the client.
        speed: 0.9,
      },
    },
  };

  const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${openaiApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      // Default TTL is usually short; we set 10 minutes to reduce token churn,
      // but it remains ephemeral and scoped to realtime.
      expires_after: { anchor: 'created_at', seconds: 600 },
      session,
    }),
  });

  if (!response.ok) {
    const message = await coerceOpenAiErrorMessage(response);
    const status = [400, 401, 403, 404, 409, 422, 429].includes(response.status) ? response.status : 502;
    return jsonResponse(status, { error: `OpenAI: ${message}` });
  }

  const data = (await response.json().catch(() => ({}))) as CreateClientSecretResponse;
  const value = typeof data.value === 'string' ? data.value.trim() : '';
  const expiresAt = typeof data.expires_at === 'number' ? data.expires_at : 0;
  if (!value || !expiresAt) {
    return jsonResponse(502, { error: 'OpenAI: reponse client_secrets invalide (value/expires_at manquants).' });
  }

  const effectiveModel = typeof data.session?.model === 'string' ? data.session.model : model;
  const effectiveVoice =
    typeof data.session?.audio?.output?.voice === 'string' ? data.session.audio.output.voice : voice;

  return jsonResponse(200, {
    client_secret: {
      value,
      expires_at: expiresAt,
    },
    model: effectiveModel,
    voice: effectiveVoice,
  });
});
