# Platform-First Sync (Sun.store / Solartraders)

This project now includes a backend ingestion foundation to build orders from platform signals first,
then enrich with Stripe fees.

## Flow (source of truth)

1. **Email trigger** receives a platform email.
2. Email payload is ingested into Supabase (`inbox_messages`, `ingest_events`).
3. Parser extracts:
   - `channel` (`Sun.store` or `Solartraders`)
   - `negotiation_id` (for example `wpT5sgv0`)
   - `product_refs[]`
4. A provisional order is upserted in `orders` and lines in `order_lines`.
5. Later stages enrich missing fields (Playwright scrape, Stripe webhook).

## Tables

Defined in `/Users/yohanaboujdid/sales-margin-tracker/supabase/schema.sql`:

- `orders`: one business order per platform negotiation
- `order_lines`: one row per product reference
- `ingest_events`: idempotence and ingestion lifecycle
- `inbox_messages`: raw + parsed email content
- `sync_logs`: operational logs

## Setup

1. Apply SQL schema in Supabase SQL Editor:
   - `/Users/yohanaboujdid/sales-margin-tracker/supabase/schema.sql`
   - this now enables RLS and store isolation policies (`x-store-id` header based)
2. Export backend env vars (service role preferred, anon key fallback in no-auth mode):

```bash
export SUPABASE_URL="https://YOUR_PROJECT_REF.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY"
export SUPABASE_ANON_KEY="YOUR_PUBLIC_ANON_KEY"
export SUPABASE_STORE_ID="huawei-sales-margin-tracker-prod"
```

3. Configure IMAP trigger env vars:

```bash
export IMAP_HOST="imap.gmail.com"
export IMAP_PORT="993"
export IMAP_SECURE="true"
export IMAP_USER="you@example.com"
export IMAP_PASSWORD="YOUR_APP_PASSWORD"
export IMAP_MAILBOX="INBOX"
export IMAP_LOOKBACK_DAYS="7"
export IMAP_MAX_MESSAGES="25"
export IMAP_ONLY_UNSEEN="true"
export IMAP_MARK_SEEN="true"
export IMAP_ALLOWED_SENDER_DOMAINS="sun.store,solartraders.com"
export SYNC_POLL_INTERVAL_SECONDS="300"
export SYNC_RUN_ONCE="false"
export PLAYWRIGHT_AUTO_SCRAPE="false"
export PLAYWRIGHT_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
export PLAYWRIGHT_STATE_PATH="/ABSOLUTE/PATH/playwright-state.json"
export PLAYWRIGHT_HEADLESS="true"
export PLAYWRIGHT_LOGIN_URL="https://sun.store/en/sign-in"
export SUNSTORE_PANEL_MAX_PAGES="10"
export SUNSTORE_NEGOTIATION_URL_TEMPLATE="https://sun.store/en/seller/negotiations/{id}"
export SOLARTRADERS_NEGOTIATION_URL_TEMPLATE="https://app.solartraders.com/negotiations/{id}"
```

For Gmail IMAP, use an **App Password** (Google blocks normal account passwords on IMAP).

## Ingest one email

Send a JSON payload to stdin:

```bash
cat <<'JSON' | npm run sync:ingest-email
{
  "message_id": "<mail-001@sun.store>",
  "thread_id": "thread-001",
  "provider": "imap",
  "from_email": "no-reply@sun.store",
  "subject": "Inbox notification: a new sun.store message for negotiations [#wpT5sgv0] awaits you!",
  "text": "This message regards the negotiations #wpT5sgv0 with the following products: Huawei SUN2000-12K-MAP0.",
  "received_at": "2026-02-17T15:51:00Z",
  "payload": {
    "mailbox": "INBOX"
  }
}
JSON
```

## Poll unread platform emails (IMAP)

```bash
npm run sync:poll-imap
```

Behavior:

- reads unseen emails from `IMAP_MAILBOX`
- filters sender domains (`sun.store`, `solartraders.com` by default)
- keeps only transactional subjects/messages (negotiation/order/payment/invoice)
- parses and ingests each message through `sync:ingest-email`
- marks message as seen when ingestion succeeds (`IMAP_MARK_SEEN=true`)
- if `PLAYWRIGHT_AUTO_SCRAPE=true`, launches one targeted scrape per detected negotiation

Run continuously (every 5 min by default):

```bash
npm run sync:worker
```

## Scrape one negotiation manually (Playwright)

Capture login state once:

```bash
npm run sync:playwright-capture-state
```

Then scrape:

```bash
export PLAYWRIGHT_CHANNEL="Sun.store"
export PLAYWRIGHT_NEGOTIATION_ID="wpT5sgv0"
npm run sync:playwright-fetch-order
```

Result:

- screenshot proof saved in `output/playwright/`
- extracted refs/amounts persisted in `orders` + `order_lines` when Supabase service vars are set

## Ingest one Stripe event (enrichment)

```bash
cat <<'JSON' | npm run sync:ingest-stripe-event
{
  "id": "evt_test_1",
  "type": "checkout.session.completed",
  "created": 1771360000,
  "data": {
    "object": {
      "id": "cs_test_1",
      "payment_intent": "pi_test_1",
      "amount_total": 107000,
      "total_details": { "amount_shipping": 3000 },
      "metadata": { "negotiation_id": "wpT5sgv0" }
    }
  }
}
JSON
```

This updates/creates the order with Stripe enrichment fields:

- `transaction_ref`
- `fees_platform`
- `fees_stripe`
- `net_received`
- `shipping_charged_ht`

## Idempotence rules

- Email ingestion is unique on `(store_id, source='email', source_event_id=message_id)`.
- Replaying the same payload returns `duplicate` without creating a second order.

## Security notes

- Keep `SUPABASE_SERVICE_ROLE_KEY` local only (never commit).
- Access is now restricted by RLS policies using `x-store-id`; keep `STORE_ID` unique per instance.
- Frontend local/cloud backup (`sales_margin_state`) remains unchanged for compatibility.

## Next steps

1. Add Playwright job triggered only for newly detected `negotiation_id`.
2. Add Stripe webhook to enrich `fees_platform`, `fees_stripe`, and `net_received`.
3. Add UI queue for `A_COMPLETER` orders.
