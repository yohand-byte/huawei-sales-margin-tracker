-- Table unique pour stocker l'etat complet de l'application (backup JSON).
create table if not exists public.sales_margin_state (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default timezone('utc', now())
);

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

