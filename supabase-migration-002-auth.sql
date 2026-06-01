-- ============================================================
-- Motib HUB · Migración 002 — BLINDAJE de la base (seguridad)
-- Correr en: Supabase → SQL Editor → New query → Run
--
-- Qué hace: saca el acceso anónimo (cualquiera con la anon key podía leer/escribir)
-- y exige sesión autenticada en TODAS las tablas. A partir de acá, sin la contraseña
-- de acceso del equipo (que genera una sesión real), la base no se puede tocar.
--
-- Idempotente: se puede correr más de una vez sin romper nada.
-- ============================================================

do $$
declare t text;
begin
  foreach t in array array['users','clients','projects','recurring_blocks','blocks','urgents','calendars']
  loop
    -- Asegurar RLS encendido
    execute format('alter table %I enable row level security', t);
    -- Quitar la policy abierta a anon
    execute format('drop policy if exists "anon all" on %I', t);
    -- (Re)crear la policy que exige sesión autenticada
    execute format('drop policy if exists "auth all" on %I', t);
    execute format('create policy "auth all" on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;
