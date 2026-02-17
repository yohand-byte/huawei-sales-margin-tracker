-- Table unique pour stocker l'etat complet de l'application (backup JSON).
create table if not exists public.sales_margin_state (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default timezone('utc', now())
);

create extension if not exists pgcrypto;

create or replace function public.set_sales_margin_state_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists trg_sales_margin_state_updated_at on public.sales_margin_state;

create trigger trg_sales_margin_state_updated_at
before update on public.sales_margin_state
for each row
execute function public.set_sales_margin_state_updated_at();

-- Mode simple sans auth (compatible frontend pur navigateur).
-- IMPORTANT: Utilise un STORE_ID fort/unique dans .env pour eviter les collisions.
alter table public.sales_margin_state disable row level security;

-- Pipeline plateforme-first (Sun.store / Solartraders) ------------------------

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  store_id text not null,
  channel text not null check (channel in ('Sun.store', 'Solartraders', 'Direct', 'Other')),
  external_order_id text not null,
  source_status text,
  order_status text not null default 'PROVISOIRE'
    check (order_status in ('PROVISOIRE', 'ENRICHI', 'A_COMPLETER', 'VALIDE')),
  order_date date,
  source_event_at timestamptz,
  client_name text,
  transaction_ref text,
  customer_country text,
  payment_method text,
  currency text not null default 'EUR',
  shipping_charged_ht numeric(12, 2) default 0,
  shipping_charged_ttc numeric(12, 2),
  shipping_real_ht numeric(12, 2) default 0,
  shipping_real_ttc numeric(12, 2),
  fees_platform numeric(12, 2) default 0,
  fees_stripe numeric(12, 2) default 0,
  net_received numeric(12, 2),
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (store_id, channel, external_order_id)
);

create index if not exists idx_orders_store_id on public.orders (store_id);
create index if not exists idx_orders_transaction_ref on public.orders (transaction_ref);
create index if not exists idx_orders_status on public.orders (order_status);

drop trigger if exists trg_orders_updated_at on public.orders;
create trigger trg_orders_updated_at
before update on public.orders
for each row
execute function public.set_sales_margin_state_updated_at();

create table if not exists public.order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  line_index integer not null default 1,
  product_ref text not null,
  product_label text,
  quantity numeric(12, 3) not null default 1,
  category text,
  sell_price_unit_ht numeric(12, 2),
  sell_price_unit_ttc numeric(12, 2),
  buy_price_unit numeric(12, 2),
  shipping_allocated_ht numeric(12, 2) default 0,
  power_wp numeric(14, 2),
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (order_id, line_index)
);

create index if not exists idx_order_lines_order_id on public.order_lines (order_id);
create index if not exists idx_order_lines_product_ref on public.order_lines (product_ref);

drop trigger if exists trg_order_lines_updated_at on public.order_lines;
create trigger trg_order_lines_updated_at
before update on public.order_lines
for each row
execute function public.set_sales_margin_state_updated_at();

create table if not exists public.ingest_events (
  id bigserial primary key,
  store_id text not null,
  source text not null check (source in ('email', 'playwright', 'stripe', 'manual')),
  source_event_id text not null,
  channel text check (channel in ('Sun.store', 'Solartraders', 'Direct', 'Other')),
  external_order_id text,
  status text not null default 'received'
    check (status in ('received', 'processed', 'ignored', 'failed')),
  payload jsonb not null default '{}'::jsonb,
  error_message text,
  processed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  unique (store_id, source, source_event_id)
);

create index if not exists idx_ingest_events_store_created
  on public.ingest_events (store_id, created_at desc);

create table if not exists public.inbox_messages (
  id uuid primary key default gen_random_uuid(),
  store_id text not null,
  provider text not null default 'imap',
  message_id text not null,
  thread_id text,
  received_at timestamptz not null,
  from_email text,
  subject text,
  raw_text text,
  channel text check (channel in ('Sun.store', 'Solartraders')),
  negotiation_id text,
  parsed_product_refs text[] not null default '{}'::text[],
  parse_confidence numeric(4, 3) not null default 0,
  parse_errors text[] not null default '{}'::text[],
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (store_id, message_id)
);

create index if not exists idx_inbox_messages_store_received
  on public.inbox_messages (store_id, received_at desc);
create index if not exists idx_inbox_messages_negotiation
  on public.inbox_messages (store_id, channel, negotiation_id);

drop trigger if exists trg_inbox_messages_updated_at on public.inbox_messages;
create trigger trg_inbox_messages_updated_at
before update on public.inbox_messages
for each row
execute function public.set_sales_margin_state_updated_at();

create table if not exists public.sync_logs (
  id bigserial primary key,
  store_id text not null,
  component text not null,
  level text not null check (level in ('info', 'warn', 'error')),
  message text not null,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_sync_logs_store_created
  on public.sync_logs (store_id, created_at desc);

-- Mode simple sans auth pour les tables de sync (meme logique que sales_margin_state).
-- IMPORTANT: garde un STORE_ID fort/unique.
alter table public.orders disable row level security;
alter table public.order_lines disable row level security;
alter table public.ingest_events disable row level security;
alter table public.inbox_messages disable row level security;
alter table public.sync_logs disable row level security;
