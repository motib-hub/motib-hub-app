-- ============================================================
-- Motib HUB · Migración 002 — BLINDAJE de la base (seguridad)
-- Correr en: Supabase → SQL Editor → New query → Run
--
-- Qué hace: exige sesión autenticada Y además que esa sesión sea la de la
-- cuenta del equipo (motibhub@gmail.com). Esto cierra el agujero de que
-- cualquiera se registre con su propio mail y acceda: aunque tenga sesión,
-- si su email no es el del equipo, la base no le devuelve ni le acepta nada.
--
-- Si algún día cambiás el email de la cuenta de acceso, cambialo acá también
-- (variable team_email) y volvé a correr esto.
--
-- Idempotente: se puede correr más de una vez sin romper nada.
-- ============================================================

do $$
declare
  t text;
  team_email text := 'motibhub@gmail.com';
  pol text := format('(auth.jwt() ->> ''email'') = %L', team_email);
begin
  foreach t in array array['users','clients','projects','recurring_blocks','blocks','urgents','calendars']
  loop
    execute format('alter table %I enable row level security', t);
    -- Limpiar policies viejas (abiertas a anon o a cualquier autenticado)
    execute format('drop policy if exists "anon all" on %I', t);
    execute format('drop policy if exists "auth all" on %I', t);
    execute format('drop policy if exists "team only" on %I', t);
    -- Solo la cuenta del equipo puede leer/escribir
    execute format(
      'create policy "team only" on %I for all to authenticated using (%s) with check (%s)',
      t, pol, pol
    );
  end loop;
end $$;
