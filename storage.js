// Capa de persistencia · Supabase (Postgres + PostgREST).
// La interfaz es idéntica a la versión localStorage anterior, así que app.js
// no se toca. Backup de la versión vieja: storage.localStorage.bak.js
//
// Datos compartidos: lo que carga Ailén lo ve Tomi y viceversa, en tiempo (casi) real.
// La sesión de usuario sigue siendo por dispositivo (localStorage), no hay auth real todavía.

// ---- Config del proyecto Supabase ----
const SUPABASE_URL = 'https://mbwjqxhauizsbvffvdil.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1id2pxeGhhdWl6c2J2ZmZ2ZGlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5OTI1MDMsImV4cCI6MjA5NTU2ODUwM30.7aRKUlpDgOBjcFkr3a-kDC6qeytFgOq7bn96wAfQWpc';
const REST = SUPABASE_URL + '/rest/v1';
// La sesión (tokens) y el usuario activo viven en localStorage de cada dispositivo.
const LS = {
  currentUser: 'motib.currentUser.v1',
  session: 'motib.session.v1',
};

// Cuenta compartida del equipo. El email NO es secreto (solo identifica la cuenta);
// la contraseña de acceso la tipea la persona en la pantalla de entrada y NUNCA vive
// en el código. Eso es lo que hace seguro el modelo: sin esa contraseña, la anon key
// (que sí viaja al navegador) no abre nada, porque las policies de la base exigen
// sesión autenticada. Cualquiera con la contraseña entra; con solo el link, no.
const SHARED_EMAIL = 'motibhub@gmail.com';

// ============================================================
// Sesión / Auth (Supabase Auth · grant de password)
// ============================================================
class AuthError extends Error {
  constructor(m = 'Sesión requerida') { super(m); this.name = 'AuthError'; }
}

function loadSession() {
  try { return JSON.parse(localStorage.getItem(LS.session) || 'null'); } catch { return null; }
}
function saveSession(data) {
  const nowSec = Math.floor(Date.now() / 1000);
  localStorage.setItem(LS.session, JSON.stringify({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at || (nowSec + (data.expires_in || 3600)),
  }));
}
function clearSession() { localStorage.removeItem(LS.session); }

export const auth = {
  hasSession() { return !!loadSession()?.refresh_token; },

  async signIn(password) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SHARED_EMAIL, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = data.error_code || data.error || '';
      if (code === 'invalid_credentials' || code === 'invalid_grant') throw new Error('Contraseña incorrecta.');
      if (code === 'email_not_confirmed') throw new Error('La cuenta de acceso todavía no fue confirmada.');
      throw new Error(data.msg || data.error_description || 'No se pudo entrar.');
    }
    saveSession(data);
    return true;
  },

  async refresh() {
    const s = loadSession();
    if (!s?.refresh_token) return false;
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    });
    if (!res.ok) { clearSession(); return false; }
    saveSession(await res.json());
    return true;
  },

  // Refresca si el access_token está por expirar (<60s). Devuelve true si hay sesión usable.
  async ensureValid() {
    const s = loadSession();
    if (!s) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    if (s.expires_at && s.expires_at - nowSec < 60) return this.refresh();
    return true;
  },

  signOut() { clearSession(); },
};

// ============================================================
// REST helpers (PostgREST) — con auth + retry de refresh en 401
// ============================================================
function authHeaders(extra = {}) {
  const token = loadSession()?.access_token || SUPABASE_ANON;
  return { apikey: SUPABASE_ANON, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...extra };
}

async function sbFetch(path, { method = 'GET', body = null, prefer = null } = {}) {
  const run = () => fetch(`${REST}/${path}`, {
    method,
    headers: authHeaders(prefer ? { Prefer: prefer } : {}),
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let res = await run();
  if (res.status === 401) {
    if (await auth.refresh()) res = await run();
  }
  if (res.status === 401) { auth.signOut(); throw new AuthError(); }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

async function sbGet(query) { return sbFetch(query); }

async function sbInsert(table, rows, { upsert = false, onConflict = null } = {}) {
  const prefer = ['return=representation'];
  if (upsert) prefer.push('resolution=merge-duplicates');
  let path = table;
  if (onConflict) path += `?on_conflict=${encodeURIComponent(onConflict)}`;
  return sbFetch(path, { method: 'POST', body: rows, prefer: prefer.join(',') }); // siempre array
}

async function sbPatch(table, filter, patch) {
  return sbFetch(`${table}?${filter}`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
}

async function sbDelete(table, filter) {
  return sbFetch(`${table}?${filter}`, { method: 'DELETE' });
}

// eq.<valor> con encoding del valor
const eq = (v) => 'eq.' + encodeURIComponent(v);

// Whitelist de columnas reales por tabla — evita mandar campos extra que
// PostgREST rechazaría (o que son manejados por la DB, como created_at/updated_at).
const COLS = {
  blocks: ['week_start', 'day', 'time_slot', 'client', 'task', 'status', 'note', 'categories', 'recurring_id', 'project_id', 'postpone_reason', 'postpone_note'],
  urgents: ['week_start', 'occurred_at', 'client', 'description', 'estimated_minutes', 'displaces', 'displaced_block_id', 'status'],
  clients: ['id', 'name', 'type', 'color', 'playbook', 'cadence', 'typical_tasks', 'has_monthly_calendar'],
  projects: ['client_id', 'name', 'description', 'status', 'current_week', 'weeks'],
  recurring_blocks: ['day', 'time_slot', 'client', 'task', 'active'],
  calendars: ['client_id', 'year', 'month', 'status', 'weeks'],
  activity_log: ['actor', 'action', 'entity', 'entity_id', 'week_start', 'day', 'summary', 'detail'],
};
function pick(table, obj) {
  const out = {};
  for (const k of COLS[table]) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// ============================================================
// Accesos rápidos a carpetas de Drive (sección Calendarios)
// ------------------------------------------------------------
// Pegá acá el link compartido de cada carpeta. Si un url queda vacío, el botón
// igual aparece pero deshabilitado con el aviso "(falta link)". Hoy se edita
// acá en código; más adelante se podrá editar desde la app.
// ============================================================
export const DRIVE_FOLDERS = [
  { label: 'Carpeta Maracaibo', url: 'https://drive.google.com/drive/folders/10Fqbu1lYqo6iCgHeyYC9-2QvsmVw8ze8?usp=drive_link' },
  { label: 'Carpeta Acai Bar',  url: 'https://drive.google.com/drive/folders/1vgah9etGH0txmclqI7NsFGH1sEfbpYl9?usp=drive_link' },
  { label: 'Carpeta Motib',     url: 'https://drive.google.com/drive/folders/1N6tHQsiJK93BMGrA3iDAGcXlYKoh5Mag?usp=drive_link' },
  { label: 'Carpeta FDV',       url: 'https://drive.google.com/drive/folders/1knFBUgNmW0Pv79GXNsTEbKW6yk64KGxE?usp=drive_link' },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ============================================================
// Catálogo de usuarios (hardcoded — son 2 personas; la auth real vendrá después)
// ============================================================
export const USERS = {
  ailen: {
    id: 'ailen',
    name: 'Ailén',
    role: 'colaborador',
    initials: 'A',
    color: '#FF7F11',
    requiresPassword: false,
    permissions: {
      editOwnWeek: true,
      viewOthersWeek: false,
      planMonth: true,            // puede marcar/desmarcar 'planificado' en Calendarios
      markWeekEdited: true,
      editClientPlaybook: false,
      editProjectChecklist: true,
      registerUrgent: true,
    },
  },
  tomi: {
    id: 'tomi',
    name: 'Tomi',
    role: 'dueño',
    initials: 'T',
    color: '#443850',
    requiresPassword: true,
    permissions: {
      editOwnWeek: false,
      viewOthersWeek: true,
      planMonth: true,
      markWeekEdited: true,
      editClientPlaybook: true,
      editProjectChecklist: true,
      registerUrgent: true,
    },
  },
};

// Cache sincrónico de hashes de password (la tabla 'users' es la fuente real).
// Se precarga en bootstrapCatalog(), que app.js await-ea antes del login.
let _pwCache = {};
async function loadPasswordCache() {
  try {
    const rows = await sbGet('users?select=id,password_hash');
    _pwCache = {};
    for (const u of rows) if (u.password_hash) _pwCache[u.id] = u.password_hash;
  } catch (e) {
    console.error('[motib] no pude cargar usuarios:', e);
  }
}

// ============================================================
// Helpers de calendario (idénticos a la versión anterior)
// ============================================================
export function weeksForMonth(year, month) {
  const first = new Date(year, month - 1, 1);
  const offset = (8 - first.getDay()) % 7;
  const d = new Date(year, month - 1, 1 + offset);
  const weeks = [];
  const pad2 = (n) => String(n).padStart(2, '0');
  while (d.getFullYear() === year && d.getMonth() === month - 1) {
    // ISO en hora local (no UTC) para no correr el día en zonas como AR (UTC-3).
    const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    weeks.push({ monday: iso, edited: false });
    d.setDate(d.getDate() + 7);
  }
  return weeks;
}

// Migra weeks de formato viejo {week_num} al nuevo {monday}. En datos nuevos es no-op.
function migrateWeeks(cal) {
  if (!cal.weeks || cal.weeks.length === 0 || cal.weeks[0].monday) return cal;
  const real = weeksForMonth(cal.year, cal.month);
  for (let i = 0; i < real.length && i < cal.weeks.length; i++) {
    real[i].edited = !!cal.weeks[i].edited;
  }
  cal.weeks = real;
  return cal;
}

// ============================================================
// store: misma API async que usa app.js, ahora contra Supabase
// ============================================================
export const store = {
  // --- Blocks ---
  async listBlocks(weekStart) {
    return sbGet(`blocks?week_start=${eq(weekStart)}&select=*&order=created_at.asc`);
  },
  async upsertBlock(block) {
    if (block.id) {
      const [r] = await sbPatch('blocks', `id=${eq(block.id)}`, pick('blocks', block));
      return r;
    }
    const [r] = await sbInsert('blocks', pick('blocks', block));
    return r;
  },
  async deleteBlock(id) {
    await sbDelete('blocks', `id=${eq(id)}`);
  },

  // --- Activity log (historial) ---
  // Fire-and-forget: el registro NUNCA debe romper la acción del usuario.
  async logActivity(entry) {
    try {
      await sbInsert('activity_log', pick('activity_log', entry));
    } catch (e) {
      console.warn('[motib] no pude registrar actividad:', e?.message || e);
    }
  },
  async listActivity({ weekStart = null, limit = 40 } = {}) {
    const f = weekStart ? `week_start=${eq(weekStart)}&` : '';
    try {
      return await sbGet(`activity_log?${f}select=*&order=created_at.desc&limit=${limit}`);
    } catch (e) {
      console.warn('[motib] no pude leer actividad:', e?.message || e);
      return [];
    }
  },

  // --- Urgents ---
  async listUrgents(weekStart) {
    return sbGet(`urgents?week_start=${eq(weekStart)}&select=*&order=occurred_at.asc`);
  },
  async createUrgent(urgent) {
    const [r] = await sbInsert('urgents', pick('urgents', urgent));
    return r;
  },

  // --- Clients ---
  async listClients() {
    const rows = await sbGet('clients?select=*');
    // Orden de visualización fijo (Motib, La Crema, FDV, …); clientes nuevos van al final.
    const order = DEFAULT_CLIENTS.map((c) => c.id);
    return rows.sort((a, b) => {
      const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
  },
  async getClient(id) {
    const [r] = await sbGet(`clients?id=${eq(id)}&select=*`);
    return r || null;
  },
  async upsertClient(client) {
    if (!client.id) client.id = uid();
    const row = { id: client.id, ...pick('clients', client) };
    const [r] = await sbInsert('clients', row, { upsert: true, onConflict: 'id' });
    return r;
  },

  // --- Projects ---
  async listProjects(clientId) {
    const f = clientId ? `client_id=${eq(clientId)}&` : '';
    return sbGet(`projects?${f}select=*&order=created_at.asc`);
  },
  async getProject(id) {
    const [r] = await sbGet(`projects?id=${eq(id)}&select=*`);
    return r || null;
  },
  async upsertProject(project) {
    if (project.id && UUID_RE.test(project.id)) {
      const [r] = await sbPatch('projects', `id=${eq(project.id)}`, pick('projects', project));
      return r;
    }
    const [r] = await sbInsert('projects', pick('projects', project));
    return r;
  },
  async toggleProjectItem(projectId, weekIdx, itemIdx) {
    const p = await this.getProject(projectId);
    if (!p) return;
    const it = p.weeks?.[weekIdx]?.items?.[itemIdx];
    if (!it) return;
    it.done = !it.done;
    const [r] = await sbPatch('projects', `id=${eq(projectId)}`, { weeks: p.weeks });
    return r;
  },

  // --- Monthly content calendars ---
  async listCalendars(clientId) {
    const f = clientId ? `client_id=${eq(clientId)}&` : '';
    return sbGet(`calendars?${f}select=*&order=year.asc,month.asc`);
  },
  async getCalendar(clientId, year, month) {
    const [r] = await sbGet(`calendars?client_id=${eq(clientId)}&year=${eq(year)}&month=${eq(month)}&select=*`);
    return r || null;
  },
  async upsertCalendar(cal) {
    const [r] = await sbInsert('calendars', pick('calendars', cal), { upsert: true, onConflict: 'client_id,year,month' });
    return r;
  },
  async setCalendarStatus(clientId, year, month, status) {
    const cur = await this.getCalendar(clientId, year, month);
    if (!cur) {
      const [r] = await sbInsert('calendars', {
        client_id: clientId, year, month, status, weeks: weeksForMonth(year, month),
      });
      return r;
    }
    migrateWeeks(cur);
    const [r] = await sbPatch(
      'calendars',
      `client_id=${eq(clientId)}&year=${eq(year)}&month=${eq(month)}`,
      { status, weeks: cur.weeks },
    );
    return r;
  },
  async toggleCalendarWeek(clientId, year, month, mondayIso) {
    let cur = await this.getCalendar(clientId, year, month);
    if (!cur) {
      [cur] = await sbInsert('calendars', {
        client_id: clientId, year, month, status: 'planificado', weeks: weeksForMonth(year, month),
      });
    }
    migrateWeeks(cur);
    const w = cur.weeks.find((x) => x.monday === mondayIso);
    if (w) w.edited = !w.edited;
    let status = cur.status;
    if (cur.weeks.length > 0 && cur.weeks.every((x) => x.edited)) status = 'cerrado';
    const [r] = await sbPatch(
      'calendars',
      `client_id=${eq(clientId)}&year=${eq(year)}&month=${eq(month)}`,
      { weeks: cur.weeks, status },
    );
    return r;
  },

  // --- Recurring blocks ---
  async listRecurring() {
    return sbGet('recurring_blocks?select=*&order=created_at.asc');
  },
  async upsertRecurring(rec) {
    if (rec.id && UUID_RE.test(rec.id)) {
      const [r] = await sbPatch('recurring_blocks', `id=${eq(rec.id)}`, pick('recurring_blocks', rec));
      return r;
    }
    const [r] = await sbInsert('recurring_blocks', pick('recurring_blocks', rec));
    return r;
  },
  async deleteRecurring(id) {
    await sbDelete('recurring_blocks', `id=${eq(id)}`);
  },

  // --- Current user (sesión por dispositivo, sin auth real) ---
  getCurrentUserId() { return localStorage.getItem(LS.currentUser) || null; },
  setCurrentUserId(id) {
    if (USERS[id]) localStorage.setItem(LS.currentUser, id);
  },
  getCurrentUser() {
    const id = localStorage.getItem(LS.currentUser);
    return id && USERS[id] ? USERS[id] : null;
  },
  clearCurrentUser() { localStorage.removeItem(LS.currentUser); },

  // --- Passwords (hash SHA-256 en tabla users; cache sync para el login) ---
  async hashPassword(plain) {
    const enc = new TextEncoder().encode(plain);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  },
  getPasswordHash(userId) {
    return _pwCache[userId] || null;
  },
  async setPassword(userId, plain) {
    const hash = await this.hashPassword(plain);
    await sbPatch('users', `id=${eq(userId)}`, { password_hash: hash });
    _pwCache[userId] = hash;
  },
  async verifyPassword(userId, plain) {
    const stored = _pwCache[userId];
    if (!stored) return false;
    return (await this.hashPassword(plain)) === stored;
  },

  // Solo limpia la sesión local (NO borra datos de Supabase).
  _reset() { localStorage.removeItem(LS.currentUser); },
};

// ============================================================
// DEFAULTS de catálogo (clientes + proyectos + recurrentes)
// ============================================================
const DEFAULT_CLIENTS = [
  {
    id: 'cli-motib', name: 'Motib', type: 'cuenta_propia', color: '#443850',
    has_monthly_calendar: true,
    playbook: 'Cuenta propia de la agencia. Necesita: (1) calendario de contenido mensual con vista a futuro — Tomi sube material de videos para editar y se publica según calendario; (2) 2hs/día de mensajes en frío comerciales para captar leads; (3) ediciones extraordinarias on-demand cuando Tomi sube material nuevo fuera del calendario; (4) mejora de procesos internos y documentación.',
    typical_tasks: ['Calendario mensual', 'Edición video (calendario)', 'Edición extraordinaria video', 'Mensajes en frío', 'Contactar', 'Documentación procesos'],
    cadence: 'Contenido semanal con vista mensual · 2hs/día mensajes en frío · ediciones extraordinarias on-demand',
  },
  {
    id: 'cli-lacrema', name: 'La Crema', type: 'cliente', color: '#FF7F11',
    has_monthly_calendar: false,
    playbook: 'Necesita actualmente: proceso de Brand completo (8 semanas) — atravesando etapa de branding nueva, lo cual concentra ~50% de reuniones de los próximos 2 meses en avance del Brand. Ver proyecto "Brand La Crema" con checklist semana a semana. Demanda más tiempo de lo normal por el momento del proyecto.',
    typical_tasks: ['Avance Brand', 'Diseño piezas', 'Reunión cliente', 'Revisión material', 'Edición'],
    cadence: 'Bloques diarios + reuniones semanales · proyecto Brand activo (8 sem)',
  },
  {
    id: 'cli-fdv', name: 'FDV', type: 'cliente', color: '#689ABC',
    has_monthly_calendar: true,
    playbook: 'Necesita: (1) edición de "placas promos" TODAS las semanas (recurrente fijo); (2) producción de 2:30hs/mes donde se graba el material del MES SIGUIENTE (mes vista) con NOE; (3) pedidos extraordinarios intrasemana frecuentes — registrarlos como Urgentes para visibilidad de impacto.',
    typical_tasks: ['Placas promos (semanal)', 'Producción NOE (mes vista)', 'Edición piezas', 'Pedido extraordinario', 'Contenido feed'],
    cadence: 'Placas promos semanales · producción mensual 2:30hs · urgencias intrasemanales',
  },
  {
    id: 'cli-maracaibo', name: 'Maracaibo', type: 'cliente', color: '#95CA9A',
    has_monthly_calendar: true,
    playbook: 'Gestión completa de Instagram a partir del 10 de junio — Mili pasa el material grabado. Base diaria: 2 stories/día en Maracaibo y 1 story/día en Acai Bar. Feed Maracaibo: mínimo por semana 2 reels + 1 carrusel o imagen. Acai Bar: 1 posteo por semana, en colaboración con un posteo de Maracaibo. Armado/edición del contenido según calendario mensual (mes vista).',
    typical_tasks: ['Stories Maracaibo (2/día)', 'Story Acai Bar (1/día)', 'Reels Maracaibo (2/sem)', 'Carrusel o img Maracaibo (1/sem)', 'Colab Acai + Maracaibo (1/sem)', 'Calendario mensual'],
    cadence: 'Diario: 2 stories Maracaibo + 1 Acai Bar · Semanal: 2 reels + 1 carru/img + 1 colab Acai · gestión completa desde 10/06',
  },
  {
    id: 'cli-spf', name: 'SPF', type: 'cliente', color: '#ED6A5A',
    has_monthly_calendar: false,
    playbook: 'Cliente recién integrado. Necesita: por ahora 100% pedidos extraordinarios — no hay calendario fijo ni proceso recurrente todavía. Cada pedido se registra como Urgente o como bloque puntual según el caso. A definir el ritmo recurrente más adelante.',
    typical_tasks: ['Pedido extraordinario', 'Trabajo SPF'],
    cadence: 'On-demand · sin calendario fijo todavía',
  },
  {
    id: 'cli-interno', name: 'Interno', type: 'interno', color: '#1e1e1e',
    has_monthly_calendar: false,
    playbook: 'Tareas internas del equipo: reuniones (Mar/Jue 8:30–9:30 con Tomi), organización de la semana (Lun), calendarios generales, edición de pendientes acumulados, planning del mes siguiente.',
    typical_tasks: ['Reunión equipo', 'Organizar semana', 'Calendarios generales', 'Editar pendientes', 'Planning mes siguiente'],
    cadence: 'Reunión Mar/Jue 8:30–9:30 · organización Lun',
  },
];

// Proyecto: Brand La Crema (sacado de las capturas del Notion)
const DEFAULT_PROJECTS = [
  {
    client_id: 'cli-lacrema',
    name: 'Brand La Crema',
    status: 'activo',
    description: 'Proceso completo de branding · 8 semanas + extra',
    current_week: 4,
    weeks: [
      { week_num: 1, title: 'Brief', items: [
        { text: 'Respuestas Brief / Cliente', done: true },
      ]},
      { week_num: 2, title: 'Investigación', items: [
        { text: 'Análisis DAFO', done: true },
        { text: 'Benchmark', done: true },
        { text: 'Mapa perceptual', done: true },
        { text: 'Canales actuales', done: true },
        { text: 'Core de marca', done: true },
        { text: 'Arquetipo', done: true },
      ]},
      { week_num: 3, title: 'Conceptualización', items: [
        { text: 'Moodboard', done: true },
        { text: 'Storytelling', done: true },
        { text: 'Tono y estilo', done: true },
        { text: 'Exploración de logotipo (Ya definido)', done: true },
        { text: 'Paletas tentativas', done: true },
        { text: 'Tipografías tentativas', done: true },
      ]},
      { week_num: 4, title: 'Aplicación', items: [
        { text: 'PACKAGING', done: false },
        { text: 'Versiones', done: false },
        { text: 'Revisión de estrategia', done: false },
        { text: 'USO DE IA', done: false },
        { text: 'Validación interna', done: false },
      ]},
      { week_num: 5, title: 'Sistema gráfico', items: [
        { text: 'REUNIÓN (Jun 5-06-2026)', done: false },
        { text: 'Sistema gráfico', done: false },
        { text: 'Aplicaciones necesarias base', done: false },
        { text: 'Recursos visuales (iconos, ilustraciones, etc.)', done: false },
        { text: 'Pruebas de uso', done: false },
      ]},
      { week_num: 6, title: 'Mockups y lineamientos', items: [
        { text: 'Mockups varios', done: true },
        { text: 'Lineamientos', done: true },
        { text: 'Ejemplos de uso correcto e incorrecto', done: false },
        { text: 'Preparación de archivos finales', done: false },
      ]},
      { week_num: 7, title: 'Manual de marca', items: [
        { text: 'Documentación de elementos visuales', done: false },
        { text: 'Guía de estilo y tono', done: false },
        { text: 'Finalización de Manual de Marca', done: false },
      ]},
      { week_num: 8, title: 'Cierre y entrega', items: [
        { text: 'Revisión de objetivos cumplidos', done: false },
        { text: 'Feedback final con cliente', done: false },
        { text: 'Ajustes de piezas y elementos visuales', done: false },
        { text: 'Entrega organizada de carpetas (PDF, editables, manual, assets)', done: false },
        { text: 'REUNIÓN Presentación final', done: false },
      ]},
      { week_num: 9, title: 'Extra', items: [
        { text: 'Documentación de resultados', done: false },
        { text: 'Guardar proceso', done: false },
        { text: 'Organización para seguir con el servicio (cm/ads/produ)', done: false },
      ]},
    ],
  },
];

// Bloques recurrentes (se materializan en cada semana nueva)
const DEFAULT_RECURRING = [
  { day: 'lunes',     time_slot: '8:00 – 9:00',   client: 'Interno', task: 'Organizar semana por bloques', active: true },
  { day: 'martes',    time_slot: '8:30 – 9:30',   client: 'Interno', task: 'Reunión de equipo', active: true },
  { day: 'jueves',    time_slot: '8:30 – 9:30',   client: 'Interno', task: 'Reunión de equipo', active: true },
  { day: 'lunes',     time_slot: '13:00 – 14:00', client: '',        task: 'Almuerzo', active: true },
  { day: 'martes',    time_slot: '11:00 – 12:00', client: '',        task: 'Almuerzo', active: true },
  { day: 'miercoles', time_slot: '13:00 – 14:00', client: '',        task: 'Almuerzo', active: true },
  { day: 'jueves',    time_slot: '12:00 – 13:00', client: '',        task: 'Almuerzo', active: true },
  { day: 'viernes',   time_slot: '12:00 – 13:00', client: '',        task: 'Almuerzo', active: true },
  { day: 'viernes',   time_slot: '9:00 – 11:00',  client: 'Motib',   task: 'Mensajes en frío (2hs/día)', active: true },
  { day: 'martes',    time_slot: '12:00 – 13:00', client: 'FDV',     task: 'Placas promos (semanal)', active: true },
];

// Bloques iniciales sugeridos (se siembran solo si la semana está vacía).
const INITIAL_WEEK_SEED = [
  // [day, time_slot, client, task, [categories?]]
  ['lunes',    '9:00 – 11:00',  'La Crema', 'Avance Brand',                       ['diseno', 'planning']],
  ['lunes',    '11:00 – 13:00', 'Motib',    'Calendario + edición video',         ['planning', 'edicion']],
  ['lunes',    '14:00 – 15:00', 'Interno',  'Calendarios generales / chequear',   ['planning']],
  ['lunes',    '15:00 – 17:00', 'SPF',      'Pedido extraordinario',              ['edicion']],
  ['martes',   '10:00 – 11:00', 'Motib',    'Edición video (calendario)',         ['edicion']],
  ['martes',   '13:00 – 15:00', '',         'Editar pendientes',                  ['edicion']],
  ['martes',   '15:00 – 17:00', 'Motib',    'Contactar + mensajes en frío',       ['gestion']],
  ['miercoles','9:00 – 12:00',  'La Crema', 'Avance Brand + Diseño piezas',       ['diseno']],
  ['miercoles','14:00 – 15:00', 'FDV',      'Placas promos (semanal)',            ['edicion', 'diseno']],
  ['miercoles','15:00 – 17:00', 'Motib',    'Contactar + Edición video',          ['gestion', 'edicion']],
  ['jueves',   '10:00 – 12:30', 'FDV',      'Producción NOE (mes vista, 2:30hs)', ['produccion']],
  ['viernes',  '11:00 – 12:00', 'Maracaibo','Edición stories (mes vista)',        ['edicion']],
  ['viernes',  '14:00 – 16:00', 'Maracaibo','Edición stories (mes vista)',        ['edicion']],
];

// ============================================================
// BOOTSTRAP: mergea defaults sin pisar lo cargado por el equipo
// ============================================================
export async function bootstrapCatalog() {
  // Precargar hashes de password para que getPasswordHash() sea sincrónico.
  await loadPasswordCache();

  // Clientes: los defaults siguen siendo "fuente de verdad" este sprint.
  // upsert por id en un solo request.
  const clientRows = DEFAULT_CLIENTS.map((d) => ({ id: d.id, ...pick('clients', d) }));
  await sbInsert('clients', clientRows, { upsert: true, onConflict: 'id' });

  // Proyectos: insertar los que falten (dedupe por nombre, preserva los checks).
  const existingProjects = await store.listProjects();
  const haveProjNames = new Set(existingProjects.map((p) => p.name));
  const newProjects = DEFAULT_PROJECTS
    .filter((p) => !haveProjNames.has(p.name))
    .map((p) => pick('projects', p));
  if (newProjects.length) await sbInsert('projects', newProjects);

  // Recurrentes: insertar los que falten (dedupe por día+hora+tarea).
  const existingRec = await store.listRecurring();
  const recKey = (r) => `${r.day}|${r.time_slot}|${r.task}`;
  const haveRec = new Set(existingRec.map(recKey));
  const newRec = DEFAULT_RECURRING
    .filter((r) => !haveRec.has(recKey(r)))
    .map((r) => pick('recurring_blocks', r));
  if (newRec.length) await sbInsert('recurring_blocks', newRec);

  // Calendarios mensuales (prev / actual / siguiente) para clientes con calendario.
  await ensureCalendarsForCurrentYear();
}

// Asegura (sin pisar) los calendarios del mes anterior, actual y siguiente
// para cada cliente con has_monthly_calendar.
export async function ensureCalendarsForRelevantMonths() {
  const today = new Date();
  const months = [];
  for (let offset = -1; offset <= 1; offset++) {
    const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }
  const clients = (await store.listClients()).filter((c) => c.has_monthly_calendar);
  const existing = await store.listCalendars();
  const have = new Set(existing.map((c) => `${c.client_id}|${c.year}|${c.month}`));
  const toAdd = [];
  for (const c of clients) {
    for (const { year, month } of months) {
      if (!have.has(`${c.id}|${year}|${month}`)) {
        toAdd.push({ client_id: c.id, year, month, status: 'vacio', weeks: weeksForMonth(year, month) });
      }
    }
  }
  if (toAdd.length) await sbInsert('calendars', toAdd);
}

// Alias para compatibilidad con el código existente
export const ensureCalendarsForCurrentYear = ensureCalendarsForRelevantMonths;

// Seedea bloques iniciales SOLO si la semana está vacía
export async function seedWeekBlocksIfEmpty(weekStart) {
  const existing = await store.listBlocks(weekStart);
  if (existing.length > 0) return;
  const rows = INITIAL_WEEK_SEED.map(([day, time_slot, client, task, categories]) => pick('blocks', {
    week_start: weekStart, day, time_slot, client, task,
    categories: categories || [], status: 'pendiente', note: '',
  }));
  if (rows.length) await sbInsert('blocks', rows);
  await materializeRecurring(weekStart);
}

// Wrapper que mantiene compatibilidad con la API previa de app.js
export async function seedIfEmpty(weekStart) {
  await bootstrapCatalog();
  await seedWeekBlocksIfEmpty(weekStart);
}

// Si una semana no tiene los bloques recurrentes, los crea. No duplica.
//
// IMPORTANTE: la deduplicación es por `recurring_id`, NO por contenido
// (día/horario/tarea). Si fuera por contenido, en cuanto alguien edita un bloque
// fijo (le mueve la hora o le cambia la tarea) dejaría de "coincidir" con su
// plantilla y esta función lo volvería a crear → bloque duplicado. Atando la
// identidad al recurring_id, un fijo editado sigue contando como materializado.
export async function materializeRecurring(weekStart) {
  const recurring = await store.listRecurring();
  const blocks = await store.listBlocks(weekStart);
  const toAdd = [];
  for (const r of recurring) {
    if (!r.active) continue;
    const exists = blocks.some((b) => b.recurring_id === r.id);
    if (!exists) {
      toAdd.push(pick('blocks', {
        week_start: weekStart,
        day: r.day, time_slot: r.time_slot,
        client: r.client || '', task: r.task,
        status: 'pendiente', note: '',
        recurring_id: r.id,
      }));
    }
  }
  if (toAdd.length) await sbInsert('blocks', toAdd);
}

// Auto-saneo: colapsa duplicados de bloques fijos que el bug viejo dejó en la base.
// Dos bloques con el MISMO recurring_id en una semana son, por definición, duplicados
// (materializeRecurring crea uno solo por plantilla). Conserva el editado más
// reciente (mayor updated_at) y borra el resto. Recibe la lista ya traída para no
// hacer otro fetch; devuelve la lista limpia y dispara los DELETE en la base.
// Cuando no hay duplicados (caso normal tras el fix) no toca nada.
export async function dedupeRecurringInList(blocks) {
  const byRec = new Map();
  for (const b of blocks) {
    if (!b.recurring_id) continue;
    const arr = byRec.get(b.recurring_id);
    if (arr) arr.push(b); else byRec.set(b.recurring_id, [b]);
  }
  const dropIds = new Set();
  for (const arr of byRec.values()) {
    if (arr.length < 2) continue;
    const ts = (b) => Date.parse(b.updated_at || b.created_at || '') || 0;
    arr.sort((a, b) => ts(b) - ts(a)); // más reciente primero
    for (let i = 1; i < arr.length; i++) dropIds.add(arr[i].id);
  }
  if (!dropIds.size) return blocks;
  for (const id of dropIds) await sbDelete('blocks', `id=${eq(id)}`);
  return blocks.filter((b) => !dropIds.has(b.id));
}
