-- ============================================================
-- Motib HUB · Schema (Supabase / Postgres)
-- Copy-paste en: Supabase → SQL Editor → New query → Run
-- ============================================================

-- Usuarios del equipo (auth simple, sin Supabase Auth todavía)
create table if not exists users (
  id text primary key,                           -- 'ailen' | 'tomi'
  name text not null,
  password_hash text default null,               -- SHA-256 hex (cliente lo computa)
  created_at timestamptz default now()
);

insert into users (id, name) values
  ('ailen', 'Ailén'),
  ('tomi', 'Tomi')
on conflict (id) do nothing;

-- Clientes (catálogo)
create table if not exists clients (
  id text primary key,                          -- ej: 'cli-lacrema'
  name text not null,
  type text not null check (type in ('cuenta_propia','cliente','interno')),
  color text default '#9a9aa3',
  playbook text default '',
  cadence text default '',
  typical_tasks jsonb default '[]'::jsonb,      -- array de strings
  has_monthly_calendar boolean default false,   -- ¿lleva calendario mensual de contenido?
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Proyectos (con etapas/semanas y checklist embebido)
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  client_id text references clients(id) on delete cascade,
  name text not null,
  description text default '',
  status text not null default 'activo'
    check (status in ('activo','pausado','cerrado')),
  current_week int default 1,
  weeks jsonb default '[]'::jsonb,              -- [{week_num,title,items:[{text,done}]}]
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_projects_client on projects (client_id);

-- Bloques recurrentes (se materializan automáticamente en cada semana nueva)
create table if not exists recurring_blocks (
  id uuid primary key default gen_random_uuid(),
  day text not null check (day in ('lunes','martes','miercoles','jueves','viernes')),
  time_slot text not null,
  client text default '',
  task text not null,
  active boolean default true,
  created_at timestamptz default now()
);

-- Bloques de la semana
create table if not exists blocks (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  day text not null check (day in ('lunes','martes','miercoles','jueves','viernes')),
  time_slot text not null,
  client text default '',
  task text not null,
  status text not null default 'pendiente'
    check (status in ('pendiente','progreso','hecho','postergado','bloqueado')),
  note text default '',
  categories jsonb default '[]'::jsonb,         -- ['diseno','edicion','planning',...]
  recurring_id uuid references recurring_blocks(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_blocks_week on blocks (week_start);
create index if not exists idx_blocks_week_day on blocks (week_start, day);

-- Urgentes
create table if not exists urgents (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  occurred_at timestamptz default now(),
  client text not null,
  description text not null,
  estimated_minutes int,
  displaces boolean default false,
  displaced_block_id uuid references blocks(id) on delete set null,
  status text not null default 'recibido'
    check (status in ('recibido','programado','hecho','descartado')),
  created_at timestamptz default now()
);

create index if not exists idx_urgents_week on urgents (week_start);

-- Auto-update de updated_at
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists trg_clients_updated_at on clients;
create trigger trg_clients_updated_at before update on clients
  for each row execute function set_updated_at();

drop trigger if exists trg_projects_updated_at on projects;
create trigger trg_projects_updated_at before update on projects
  for each row execute function set_updated_at();

drop trigger if exists trg_blocks_updated_at on blocks;
create trigger trg_blocks_updated_at before update on blocks
  for each row execute function set_updated_at();

-- RLS: por ahora abierto a anon (2 personas, sin login en Sprint 1-2)
alter table users enable row level security;
alter table clients enable row level security;
alter table projects enable row level security;
alter table recurring_blocks enable row level security;
alter table blocks enable row level security;
alter table urgents enable row level security;

-- Faltaba calendars en la versión anterior — la sumamos por si no fue creada antes
create table if not exists calendars (
  id uuid primary key default gen_random_uuid(),
  client_id text references clients(id) on delete cascade,
  year int not null,
  month int not null check (month between 1 and 12),
  status text not null default 'vacio' check (status in ('vacio','planificado','produccion','cerrado')),
  weeks jsonb default '[]'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (client_id, year, month)
);
create index if not exists idx_calendars_client on calendars (client_id, year, month);
alter table calendars enable row level security;
drop trigger if exists trg_calendars_updated_at on calendars;
create trigger trg_calendars_updated_at before update on calendars
  for each row execute function set_updated_at();

drop policy if exists "anon all" on users;
create policy "anon all" on users for all using (true) with check (true);
drop policy if exists "anon all" on clients;
create policy "anon all" on clients for all using (true) with check (true);
drop policy if exists "anon all" on projects;
create policy "anon all" on projects for all using (true) with check (true);
drop policy if exists "anon all" on recurring_blocks;
create policy "anon all" on recurring_blocks for all using (true) with check (true);
drop policy if exists "anon all" on blocks;
create policy "anon all" on blocks for all using (true) with check (true);
drop policy if exists "anon all" on urgents;
create policy "anon all" on urgents for all using (true) with check (true);
drop policy if exists "anon all" on calendars;
create policy "anon all" on calendars for all using (true) with check (true);
