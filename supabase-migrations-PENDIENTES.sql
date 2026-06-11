-- ============================================================
-- Motib HUB · Migraciones PENDIENTES (003 + 004) en un solo bloque
-- Correr UNA vez en: Supabase → SQL Editor → New query → pegar todo → Run
--
-- Idempotente: se puede correr más de una vez sin romper nada.
-- Después de correr esto, la app nueva queda 100% funcional.
-- ============================================================

-- ---- 003 · Motivo de postergación -------------------------
alter table blocks add column if not exists postpone_reason text default null;
alter table blocks add column if not exists postpone_note   text default null;

-- ---- 004 · Registro de actividad (historial) --------------
create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  actor text,
  action text not null,
  entity text not null default 'block',
  entity_id uuid,
  week_start date,
  day text,
  summary text not null,
  detail jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_activity_created on activity_log (created_at desc);
create index if not exists idx_activity_week    on activity_log (week_start);

alter table activity_log enable row level security;
drop policy if exists "team only" on activity_log;
create policy "team only" on activity_log for all to authenticated
  using ((auth.jwt() ->> 'email') = 'motibhub@gmail.com')
  with check ((auth.jwt() ->> 'email') = 'motibhub@gmail.com');
