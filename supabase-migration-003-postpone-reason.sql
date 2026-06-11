-- ============================================================
-- Motib HUB · Migración 003 — Motivo de postergación
-- Correr en: Supabase → SQL Editor → New query → Run
--
-- Qué hace: agrega a cada bloque el motivo (y nota opcional) de por qué se
-- postergó / no se llegó a lo planeado. Sirve para los reportes Mar/Jue:
-- ver patrones (¿siempre se cae lo de Maracaibo? ¿los urgentes comen edición?).
--
-- Idempotente: se puede correr más de una vez sin romper nada.
-- ============================================================

alter table blocks add column if not exists postpone_reason text default null;
alter table blocks add column if not exists postpone_note   text default null;
