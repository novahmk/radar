-- Fila de processamento gradual das conversas (usada pela radar-ponte).
create table if not exists public.fila_conversas (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  conversa_id uuid not null unique references public.conversas (id) on delete cascade,
  status text not null default 'pendente'
    check (status in ('pendente', 'em_processamento', 'processada', 'erro')),
  lote_numero integer,
  enfileirada_em timestamptz not null default now(),
  processada_em timestamptz,
  tentativas integer not null default 0
);

create index if not exists fila_conversas_owner_status_idx on public.fila_conversas (owner_id, status);

alter table public.fila_conversas enable row level security;

-- O app só lê a própria fila; a ponte grava com a service role (que ignora RLS).
drop policy if exists "fila_conversas_select_proprio" on public.fila_conversas;
create policy "fila_conversas_select_proprio" on public.fila_conversas
  for select using (auth.uid() = owner_id);
