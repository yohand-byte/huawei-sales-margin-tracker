const corsHeaders: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers':
    'authorization, x-client-info, apikey, content-type, x-store-id, x-app-secret',
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

type StripeListResponse<T> = {
  data?: T[];
  has_more?: boolean;
};

type StripeBalanceTxn = {
  id: string;
  amount: number; // cents
  fee: number; // cents
  net: number; // cents
  type: string;
  currency: string;
  created: number;
};

type StripePayout = {
  id: string;
  amount: number; // cents
  currency: string;
  status: string;
  created: number;
  arrival_date: number;
};

const centsToEur = (cents: number): number => Math.round(cents) / 100;

const parseYmd = (ymd: string): { y: number; m: number; d: number } | null => {
  const match = ymd.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return null;
  }
  return { y, m, d };
};

const computeUtcRangeForLocalDay = (
  ymd: string,
  tzOffsetMin: number,
): { start: number; end: number } | null => {
  const parsed = parseYmd(ymd);
  if (!parsed) {
    return null;
  }
  // JS getTimezoneOffset() convention: minutes to add to local time to get UTC.
  // Example: Paris winter is -60.
  const offsetMs = Math.round(tzOffsetMin) * 60 * 1000;
  const startMs = Date.UTC(parsed.y, parsed.m - 1, parsed.d, 0, 0, 0) + offsetMs;
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return { start: Math.floor(startMs / 1000), end: Math.floor(endMs / 1000) };
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
  const appSharedSecret = Deno.env.get('APP_SHARED_SECRET') ?? '';

  if (!stripeSecretKey) {
    return jsonResponse(503, { error: 'STRIPE_SECRET_KEY manquant dans les secrets Supabase.' });
  }
  if (!appSharedSecret) {
    return jsonResponse(503, { error: 'APP_SHARED_SECRET manquant dans les secrets Supabase.' });
  }

  const storeId = request.headers.get('x-store-id')?.trim() ?? '';
  if (!storeId) {
    return jsonResponse(400, { error: 'Missing x-store-id header.' });
  }

  const provided = request.headers.get('x-app-secret')?.trim() ?? '';
  if (!provided || provided !== appSharedSecret) {
    return jsonResponse(401, { error: 'Unauthorized (x-app-secret requis).' });
  }

  const body = (await request.json().catch(() => ({}))) as {
    date?: string;
    tz_offset_min?: number;
    currency?: string;
  };

  const date = (body.date?.trim() || '').slice(0, 10);
  const tzOffsetMin = Number(body.tz_offset_min ?? 0);
  const currency = (body.currency?.trim().toLowerCase() || 'eur').slice(0, 8);
  if (!date) {
    return jsonResponse(400, { error: 'Missing date (YYYY-MM-DD).' });
  }
  if (!Number.isFinite(tzOffsetMin) || Math.abs(tzOffsetMin) > 24 * 60) {
    return jsonResponse(400, { error: 'Invalid tz_offset_min.' });
  }

  const range = computeUtcRangeForLocalDay(date, tzOffsetMin);
  if (!range) {
    return jsonResponse(400, { error: 'Invalid date format.' });
  }

  const stripeFetch = async (path: string, searchParams: URLSearchParams): Promise<Response> => {
    const url = `https://api.stripe.com${path}?${searchParams.toString()}`;
    return await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${stripeSecretKey}`,
      },
    });
  };

  // Balance transactions (charges/fees/net). Paginate a bit to cover busy days.
  const balanceTxns: StripeBalanceTxn[] = [];
  let startingAfter = '';
  for (let page = 0; page < 5; page += 1) {
    const params = new URLSearchParams();
    params.set('limit', '100');
    params.set('created[gte]', String(range.start));
    params.set('created[lt]', String(range.end));
    if (startingAfter) {
      params.set('starting_after', startingAfter);
    }

    const resp = await stripeFetch('/v1/balance_transactions', params);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return jsonResponse(502, { error: `Stripe balance_transactions HTTP ${resp.status}: ${text.slice(0, 800)}` });
    }
    const data = (await resp.json().catch(() => ({}))) as StripeListResponse<StripeBalanceTxn>;
    const items = Array.isArray(data.data) ? data.data : [];
    for (const item of items) {
      if (item && item.currency === currency) {
        balanceTxns.push(item);
      }
    }
    if (!data.has_more || items.length === 0) {
      break;
    }
    startingAfter = items[items.length - 1]?.id ?? '';
    if (!startingAfter) {
      break;
    }
  }

  const sumsByType = new Map<string, { gross: number; fee: number; net: number; count: number }>();
  for (const txn of balanceTxns) {
    const type = txn.type || 'unknown';
    const existing = sumsByType.get(type) ?? { gross: 0, fee: 0, net: 0, count: 0 };
    sumsByType.set(type, {
      gross: existing.gross + txn.amount,
      fee: existing.fee + txn.fee,
      net: existing.net + txn.net,
      count: existing.count + 1,
    });
  }

  const charges = sumsByType.get('charge') ?? { gross: 0, fee: 0, net: 0, count: 0 };
  const refunds = sumsByType.get('refund') ?? { gross: 0, fee: 0, net: 0, count: 0 };
  const disputes = sumsByType.get('dispute') ?? { gross: 0, fee: 0, net: 0, count: 0 };
  const payoutsTx = sumsByType.get('payout') ?? { gross: 0, fee: 0, net: 0, count: 0 };

  // Payouts list (arrival today in local day range, best effort)
  const payouts: StripePayout[] = [];
  const payoutParams = new URLSearchParams();
  payoutParams.set('limit', '50');
  payoutParams.set('arrival_date[gte]', String(range.start));
  payoutParams.set('arrival_date[lt]', String(range.end));
  const payoutResp = await stripeFetch('/v1/payouts', payoutParams);
  if (payoutResp.ok) {
    const data = (await payoutResp.json().catch(() => ({}))) as StripeListResponse<StripePayout>;
    const items = Array.isArray(data.data) ? data.data : [];
    for (const item of items) {
      if (item && item.currency === currency) {
        payouts.push(item);
      }
    }
  }

  const payoutTotal = payouts.reduce((sum, payout) => sum + payout.amount, 0);

  return jsonResponse(200, {
    date,
    tz_offset_min: tzOffsetMin,
    currency,
    charges: {
      count: charges.count,
      gross: centsToEur(charges.gross),
      fees: centsToEur(charges.fee),
      net: centsToEur(charges.net),
    },
    refunds: {
      count: refunds.count,
      gross: centsToEur(refunds.gross),
      fees: centsToEur(refunds.fee),
      net: centsToEur(refunds.net),
    },
    disputes: {
      count: disputes.count,
      gross: centsToEur(disputes.gross),
      fees: centsToEur(disputes.fee),
      net: centsToEur(disputes.net),
    },
    payouts_from_balance_txns: {
      count: payoutsTx.count,
      gross: centsToEur(payoutsTx.gross),
      fees: centsToEur(payoutsTx.fee),
      net: centsToEur(payoutsTx.net),
    },
    payouts: {
      count: payouts.length,
      total: centsToEur(payoutTotal),
      items: payouts.slice(0, 20).map((payout) => ({
        id: payout.id,
        amount: centsToEur(payout.amount),
        status: payout.status,
        created: payout.created,
        arrival_date: payout.arrival_date,
      })),
    },
  });
});

