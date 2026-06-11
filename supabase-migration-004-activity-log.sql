-- ============================================================
-- Motib HUB · Migración 004 — Registro de actividad (historial)
-- Correr en: Supabase → SQL Editor → New query → Run
--
-- Qué hace: guarda cada acción real sobre los bloques (crear / editar / cambiar
-- estado / posponer / borrar), con quién, cuándo y un resumen legible del cambio.
-- Alimenta la sección Resultados (seguimiento de los ajustes de Ailén) para no
-- confiar a ciegas: se ve qué tocó y en qué momento.
--
-- Nota: se escribe desde la app SOLO en acciones explícitas del usuario, así no
-- se ensucia con las operaciones automáticas (seed / materializar / deduplicar).
--
-- Idempotente: se puede correr más de una vez sin romper nada.
-- ============================================================

create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  actor text,                          -- 'ailen' | 'tomi' (usuario de la app)
  action text not null,                -- 'create' | 'edit' | 'status' | 'postpone' | 'delete'
  entity text not null default 'block',
  entity_id uuid,                      -- id del bloque afectado
  week_start date,                     -- semana del bloque
  day text,                            -- día del bloque
  summary text not null,               -- texto legible: "Movió 'Editar X' de Lun a Mar"
  detail jsonb default '{}'::jsonb,    -- {campo: {from, to}} opcional
  created_at timestamptz default now()
);

create index if not exists idx_activity_created on activity_log (created_at desc);
create index if not exists idx_activity_week    on activity_log (week_start);

alter table activity_log enable row level security;
drop policy if exists "team only" on activity_log;
create policy "team only" on activity_log for all to authenticated
  using ((auth.jwt() ->> 'email') = 'motibhub@gmail.com')
  with check ((auth.jwt() ->> 'email') = 'motibhub@gmail.com');
