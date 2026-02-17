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
2. Export backend env vars (service role is required for ingestion scripts):

```bash
export SUPABASE_URL="https://YOUR_PROJECT_REF.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY"
export SUPABASE_STORE_ID="huawei-sales-margin-tracker-prod"
```

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

## Idempotence rules

- Email ingestion is unique on `(store_id, source='email', source_event_id=message_id)`.
- Replaying the same payload returns `duplicate` without creating a second order.

## Security notes

- Keep `SUPABASE_SERVICE_ROLE_KEY` local only (never commit).
- New sync tables use RLS enabled and are expected to be written by backend/service-role flows.
- Frontend local/cloud backup (`sales_margin_state`) remains unchanged for compatibility.

## Next steps

1. Build IMAP watcher (or Gmail webhook) that forwards new emails as JSON into this script.
2. Add Playwright job triggered only for newly detected `negotiation_id`.
3. Add Stripe webhook to enrich `fees_platform`, `fees_stripe`, and `net_received`.
4. Add UI queue for `A_COMPLETER` orders.
