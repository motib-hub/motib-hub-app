-- ============================================================
-- Motib HUB · Migración 001 — columnas que faltaban
-- Correr en: Supabase → SQL Editor → New query → Run
-- Es aditiva e idempotente: se puede correr más de una vez sin romper nada.
-- ============================================================

-- El catálogo de clientes necesita saber cuáles llevan calendario mensual.
alter table clients add column if not exists has_monthly_calendar boolean default false;

-- Los bloques de la semana pueden tener categorías (diseño, edición, planning, etc).
alter table blocks add column if not exists categories jsonb default '[]'::jsonb;
