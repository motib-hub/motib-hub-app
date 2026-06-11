import { store, auth, seedIfEmpty, materializeRecurring, dedupeRecurringInList, ensureCalendarsForRelevantMonths, weeksForMonth, USERS, DRIVE_FOLDERS } from './storage.js';

// Motivos de postergación: clave guardada en DB → etiqueta corta para badges/reportes.
const POSTPONE_REASONS = {
  urgente:   '🔥 Urgente',
  tardo:     '⏳ Tardó más',
  material:  '🧩 Faltó material',
  bloqueada: '🚧 Bloqueada',
  prioridad: '🔀 Otra prioridad',
  tiempo:    '😴 Sin tiempo',
};

// ---------- Utilidades ----------
const DAYS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'];
const DAY_LABELS = { lunes: 'Lun', martes: 'Mar', miercoles: 'Mié', jueves: 'Jue', viernes: 'Vie' };
const STATUS_CYCLE = ['pendiente', 'hecho', 'postergado'];
const STATUS_LABEL = {
  pendiente: 'Pendiente',
  hecho: 'Hecho',
  postergado: 'Postergado',
};
// Normaliza estados viejos (progreso/bloqueado) a alguno del nuevo set
function normalizeStatus(s) {
  if (s === 'progreso') return 'pendiente';
  if (s === 'bloqueado') return 'postergado';
  return STATUS_CYCLE.includes(s) ? s : 'pendiente';
}

function mondayOf(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay() === 0 ? 7 : d.getDay();
  d.setDate(d.getDate() - (day - 1));
  d.setHours(0, 0, 0, 0);
  return d;
}
// Fechas SIEMPRE en hora local (no UTC), para no correr el día en zonas como AR (UTC-3).
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtISO(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function parseISO(iso) { return new Date(iso + 'T00:00:00'); }
function fmtRange(monday) {
  const friday = new Date(monday); friday.setDate(monday.getDate() + 4);
  const opts = { day: 'numeric', month: 'short' };
  return `${monday.toLocaleDateString('es-AR', opts)} → ${friday.toLocaleDateString('es-AR', opts)}`;
}
function todayDay() {
  const idx = new Date().getDay();
  if (idx >= 1 && idx <= 5) return DAYS[idx - 1];
  return 'lunes';
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ---------- Helpers de horario ----------
// Convierte "9:00 – 10:00" o "9:00 - 10:00" en { start, end } en minutos desde 00:00
function parseSlot(slot) {
  const m = (slot || '').match(/(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/);
  if (!m) return { start: 0, end: 0 };
  return {
    start: parseInt(m[1], 10) * 60 + parseInt(m[2], 10),
    end:   parseInt(m[3], 10) * 60 + parseInt(m[4], 10),
  };
}
function formatHHMM(totalMin) {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}
function buildSlot(startMin, durMin) {
  return `${formatHHMM(startMin)} – ${formatHHMM(startMin + durMin)}`;
}
function slotsOverlap(a, b) {
  const r1 = parseSlot(a), r2 = parseSlot(b);
  return r1.start < r2.end && r2.start < r1.end;
}
// Genera todos los inicios posibles cada 30 min de 8:00 a 19:30
function generateStartOptions() {
  const out = [];
  for (let mins = 8 * 60; mins <= 19 * 60 + 30; mins += 30) out.push(mins);
  return out;
}
// Compacta cronológicamente los bloques de un día: si dos se superponen,
// el segundo se mueve a la hora de fin del primero. Cascada hacia adelante.
// Devuelve la lista de bloques cuyo horario fue modificado.
function compactDayBlocks(dayBlocks, anchorId = null) {
  const sorted = [...dayBlocks].sort((a, b) => parseSlot(a.time_slot).start - parseSlot(b.time_slot).start);
  const moved = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = parseSlot(sorted[i - 1].time_slot);
    const cur = parseSlot(sorted[i].time_slot);
    if (cur.start < prev.end) {
      // Choque → mover sorted[i] al fin del previo
      if (sorted[i].id === anchorId) continue; // no movemos el bloque ancla (el que se acaba de postergar)
      const durMin = cur.end - cur.start;
      const newStart = prev.end;
      sorted[i].time_slot = buildSlot(newStart, durMin);
      moved.push(sorted[i]);
    }
  }
  return moved;
}

// Devuelve el primer slot libre de 1h del día (≥ 8:00) que no choque con bloques existentes
function nextFreeSlot(dayBlocks) {
  const taken = dayBlocks.map(b => parseSlot(b.time_slot)).sort((a, b) => a.start - b.start);
  let cursor = 8 * 60; // arranca a las 8
  for (const t of taken) {
    if (cursor + 60 <= t.start) break;
    cursor = Math.max(cursor, t.end);
  }
  if (cursor + 60 > 19 * 60 + 30 + 60) cursor = 8 * 60; // fallback
  return { startMin: cursor, durMin: 60 };
}

// ---------- State ----------
const state = {
  section: 'semana',     // 'semana' | 'calendarios' | 'clientes'
  user: null,            // objeto USERS[id] una vez elegido el usuario
  weekStart: fmtISO(mondayOf()),
  activeDay: todayDay(),
  blocks: [],
  urgents: [],
  clients: [],
  projects: [],
  calendars: [],
  calYear: new Date().getFullYear(),
};

// Helpers de permisos
function can(action) {
  return state.user?.permissions?.[action] === true;
}
// "Read-only en semana": el usuario actual NO puede editar la semana de otro
function isWeekReadOnly() {
  return !can('editOwnWeek');
}

const MONTH_NAMES_ES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const MONTH_STATUS_LABEL = { vacio: 'Sin planificar', planificado: 'Planificado', produccion: 'En producción', cerrado: 'Cerrado' };

// Categorías universales para tipo de trabajo (consistentes para reportes)
const CATEGORIES = [
  { id: 'edicion',       emoji: '🎬', label: 'Edición' },
  { id: 'diseno',        emoji: '🎨', label: 'Diseño' },
  { id: 'produccion',    emoji: '📹', label: 'Producción' },
  { id: 'planning',      emoji: '📅', label: 'Planning' },
  { id: 'reunion',       emoji: '👥', label: 'Reunión' },
  { id: 'investigacion', emoji: '🔍', label: 'Investigación' },
  { id: 'gestion',       emoji: '💬', label: 'Gestión' },
  { id: 'pausa',         emoji: '🍴', label: 'Pausa' },
  { id: 'otro',          emoji: '➕', label: 'Otro' },
];

function categoryById(id) { return CATEGORIES.find(c => c.id === id); }

// Auto-detectar 1 categoría a partir del task (fallback)
function inferCategory(block) {
  const t = (block?.task || '').toLowerCase();
  if (/almuerzo|pausa|break/.test(t)) return 'pausa';
  if (/reuni[oó]n/.test(t)) return 'reunion';
  if (/edici[oó]n|editar|edit/.test(t)) return 'edicion';
  if (/dise[ñn]o|piezas|placas/.test(t)) return 'diseno';
  if (/producci[oó]n|grabaci[oó]n|fotos/.test(t)) return 'produccion';
  if (/calendario|planning|brief|organizar/.test(t)) return 'planning';
  if (/contactar|mensajes|en fr[ií]o/.test(t)) return 'gestion';
  if (/benchmark|investigar|brand/.test(t)) return 'investigacion';
  return 'otro';
}

// Devuelve siempre un array de categorías (compatible con datos viejos)
function getCategories(block) {
  if (Array.isArray(block?.categories) && block.categories.length > 0) return block.categories;
  if (block?.category) return [block.category];
  return [inferCategory(block)];
}

// Lunes ISO de "hoy"
function todaysMondayIso() {
  const d = mondayOf(new Date());
  return fmtISO(d);
}
// ¿Es la última semana del mes? (el lunes dado es el último lunes que cae en su mes)
function isLastWeekOfMonth(mondayIso) {
  const d = new Date(mondayIso + 'T00:00:00');
  const next = new Date(d); next.setDate(d.getDate() + 7);
  return next.getMonth() !== d.getMonth();
}
function isPenultimateWeekOfMonth(mondayIso) {
  const d = new Date(mondayIso + 'T00:00:00');
  const after = new Date(d); after.setDate(d.getDate() + 14);
  return after.getMonth() !== d.getMonth() && !isLastWeekOfMonth(mondayIso);
}
// Índice de semana del mes (1..N) basado en el lunes actual
function currentWeekIndexOfMonth() {
  const monday = mondayOf(new Date());
  const weeks = weeksForMonth(monday.getFullYear(), monday.getMonth() + 1);
  const iso = fmtISO(monday);
  const idx = weeks.findIndex(w => w.monday === iso);
  return idx >= 0 ? idx + 1 : weeks.length; // si no encontrado, asumir última
}
function nextMonth(year, month) {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}
function getCal(clientId, year, month) {
  return state.calendars.find(c => c.client_id === clientId && c.year === year && c.month === month);
}

// ---------- Refs ----------
const $content = document.getElementById('content');
const $dayTabs = document.getElementById('day-tabs');
const $weekRange = document.getElementById('week-range');
const $weekSummary = document.getElementById('week-summary');
const $clientsContent = document.getElementById('clients-content');
const $calendarsContent = document.getElementById('calendars-content');
const $sheet = document.getElementById('client-sheet');
const $sheetTitle = document.getElementById('sheet-title');
const $sheetBody = document.getElementById('sheet-body');

// ============================================================
// SEMANA
// ============================================================
function renderWeekHeader() {
  const monday = parseISO(state.weekStart);
  $weekRange.textContent = `Semana del ${fmtRange(monday)}`;
  const total = state.blocks.length;
  const done = state.blocks.filter(b => b.status === 'hecho').length;
  $weekSummary.textContent = total
    ? `${done}/${total} bloques cerrados · ${state.urgents.length} urgentes`
    : 'Sin bloques cargados';
}

function dayNumberOf(weekStart, dayKey) {
  const idx = DAYS.indexOf(dayKey);
  if (idx < 0) return '';
  const d = new Date(weekStart + 'T00:00:00');
  d.setDate(d.getDate() + idx);
  return d.getDate();
}
function renderDayTabs() {
  $dayTabs.innerHTML = DAYS.map(d => {
    const dayBlocks = state.blocks.filter(b => b.day === d).map(b => ({ ...b, status: normalizeStatus(b.status) }));
    const isEmpty = dayBlocks.length === 0;
    const total = dayBlocks.length;
    const done = dayBlocks.filter(b => b.status === 'hecho').length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const allDone = !isEmpty && done === total;
    const stateCls = isEmpty ? 'is-empty' : (allDone ? 'all-done' : 'has-pending');
    const cls = ['day-tab',
      state.activeDay === d ? 'is-active' : '',
      stateCls,
    ].filter(Boolean).join(' ');
    const dayNum = dayNumberOf(state.weekStart, d);
    return `
      <button class="${cls}" data-day="${d}">
        <span class="lbl">${DAY_LABELS[d]} <small>${dayNum}</small></span>
        <span class="bar" aria-hidden="true"><span class="fill" style="width:${pct}%"></span></span>
      </button>`;
  }).join('');
  $dayTabs.querySelectorAll('.day-tab').forEach(btn => {
    btn.addEventListener('click', () => { state.activeDay = btn.dataset.day; renderSemana(); });
  });
}

function clientByName(name) {
  return state.clients.find(c => c.name === name);
}

function renderContent() {
  const dayBlocks = state.blocks
    .filter(b => b.day === state.activeDay)
    .sort((a, b) => parseSlot(a.time_slot).start - parseSlot(b.time_slot).start);

  const isReadOnly = isWeekReadOnly();
  document.body.classList.toggle('readonly', isReadOnly);

  let html = '';
  if (dayBlocks.length === 0) {
    html += `<div class="empty">
      <h4>Sin bloques cargados para ${DAY_LABELS[state.activeDay]}</h4>
      <p>${isReadOnly ? 'Ailén todavía no cargó este día.' : 'Tocá "Agregar bloque" para arrancar.'}</p>
    </div>`;
  } else {
    html += dayBlocks.map(b => blockCard(b)).join('');
  }
  if (!isReadOnly) {
    html += `<button class="add-row" id="add-block">+ Agregar bloque</button>`;
  }
  if (state.urgents.length > 0) {
    html += `<div class="section-title"><span>Urgentes de la semana</span><span>${state.urgents.length}</span></div>
      ${state.urgents.map(u => urgentCard(u)).join('')}`;
  }
  $content.innerHTML = html;
  attachBlockHandlers();
  const addBtn = document.getElementById('add-block');
  if (addBtn) addBtn.addEventListener('click', () => openBlockModal(null));
}

function blockCard(b) {
  const client = clientByName(b.client);
  const cats = getCategories(b).map(id => categoryById(id)).filter(Boolean);
  const status = normalizeStatus(b.status);
  const noteHtml = b.note ? `<span class="note">${escapeHtml(b.note)}</span>` : '';
  const catHtml = cats.map(c => `<span class="category-chip">${c.emoji} ${c.label}</span>`).join('');
  const clientHtml = b.client ? `<span class="client-chip" style="background:${client?.color || '#27272d'}22;color:${client?.color || '#9a9aa3'}">${escapeHtml(b.client)}</span>` : '';
  const metaLine = (cats.length > 0 || b.client) ? `<span class="client-line">${catHtml}${clientHtml}</span>` : '';
  const baseBtn = client ? `
    <button class="base-link" data-client-id="${client.id}" type="button">
      Ver base de ${escapeHtml(client.name)}
    </button>` : '';
  const recBadge = b.recurring_id ? `<span class="recurring-badge">fijo</span>` : '';
  const reasonHtml = (status === 'postergado' && b.postpone_reason && POSTPONE_REASONS[b.postpone_reason])
    ? `<span class="postpone-reason-tag" title="${escapeHtml(b.postpone_note || '')}">${POSTPONE_REASONS[b.postpone_reason]}${b.postpone_note ? ' · ' + escapeHtml(b.postpone_note) : ''}</span>`
    : '';

  return `
    <article class="block ${status === 'hecho' ? 'is-done' : ''}" data-id="${b.id}">
      ${recBadge}
      <div class="time">${escapeHtml(b.time_slot || '')}</div>
      <div class="body">
        <strong>${escapeHtml(b.task || 'Sin tarea')}</strong>
        ${metaLine}
        ${noteHtml}
        ${reasonHtml}
        ${baseBtn}
      </div>
      <button class="status" data-status="${status}" data-id="${b.id}">
        ${STATUS_LABEL[status]}
      </button>
    </article>`;
}

function urgentCard(u) {
  const when = new Date(u.occurred_at).toLocaleString('es-AR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return `<div class="urgent">
    <div class="meta">${when} · ${escapeHtml(u.client)} · ~${u.estimated_minutes || '?'} min</div>
    <div class="desc">${escapeHtml(u.description)}</div>
    ${u.displaces ? `<div class="displaced">Desplazó algo planificado</div>` : ''}
  </div>`;
}

function attachBlockHandlers() {
  $content.querySelectorAll('.status').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!can('editOwnWeek')) return;
      const id = btn.dataset.id;
      const block = state.blocks.find(b => b.id === id);
      if (!block) return;
      const cur = normalizeStatus(block.status);
      const next = STATUS_CYCLE[(STATUS_CYCLE.indexOf(cur) + 1) % STATUS_CYCLE.length];
      block.status = next;
      await store.upsertBlock(block);
      renderSemana();
      // Si pasó a "postergado", abrir popup para reprogramar
      if (next === 'postergado') openPostponeModal(block);
    });
  });
  $content.querySelectorAll('.base-link').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openClientSheet(btn.dataset.clientId);
    });
  });
  $content.querySelectorAll('.block').forEach(card => {
    card.addEventListener('click', () => {
      if (!can('editOwnWeek')) return;
      const block = state.blocks.find(b => b.id === card.dataset.id);
      if (block) openBlockModal(block);
    });
  });
}

function renderSemana() {
  renderWeekHeader();
  renderDayTabs();
  renderContent();
}

// ============================================================
// CLIENTES
// ============================================================
function renderClientes() {
  const html = state.clients.map(c => {
    const projects = state.projects.filter(p => p.client_id === c.id);
    const activeProj = projects.find(p => p.status === 'activo');
    return `
      <article class="client-card" data-id="${c.id}">
        <div class="head">
          <span class="swatch" style="background:${c.color}"></span>
          <span class="name">${escapeHtml(c.name)}</span>
          <span class="tag">${c.type === 'cuenta_propia' ? 'propia' : c.type === 'interno' ? 'interno' : 'cliente'}</span>
        </div>
        <div class="playbook">${escapeHtml(c.playbook || 'Sin playbook todavía.')}</div>
        ${c.cadence ? `<div class="cadence">${escapeHtml(c.cadence)}</div>` : ''}
        ${activeProj ? `<span class="project-pill">Proyecto activo · ${escapeHtml(activeProj.name)} (Sem ${activeProj.current_week})</span>` : ''}
      </article>
    `;
  }).join('');
  $clientsContent.innerHTML = `
    <div style="padding:14px 0 6px;color:var(--text-dim);font-size:12px;letter-spacing:.6px;text-transform:uppercase">Base de clientes</div>
    ${html || '<div class="empty"><h4>Sin clientes</h4></div>'}
  `;
  $clientsContent.querySelectorAll('.client-card').forEach(card => {
    card.addEventListener('click', () => openClientSheet(card.dataset.id));
  });
}

// ============================================================
// SIDE-SHEET: ficha de cliente
// ============================================================
async function openClientSheet(clientId) {
  const c = state.clients.find(x => x.id === clientId);
  if (!c) return;
  $sheetTitle.textContent = c.name;

  const projects = state.projects.filter(p => p.client_id === c.id);
  const blocksForClient = state.blocks.filter(b => b.client === c.name);

  $sheetBody.innerHTML = `
    <div class="sheet-section">
      <h4>Cómo trabajamos</h4>
      <div class="text editable" contenteditable="${can('editClientPlaybook') ? 'true' : 'false'}" data-field="playbook" data-id="${c.id}">${escapeHtml(c.playbook)}</div>
    </div>

    <div class="sheet-section">
      <h4>Ritmo</h4>
      <div class="text editable" contenteditable="${can('editClientPlaybook') ? 'true' : 'false'}" data-field="cadence" data-id="${c.id}">${escapeHtml(c.cadence || '—')}</div>
    </div>

    <div class="sheet-section">
      <h4>Tareas habituales</h4>
      <div class="task-chips">
        ${(c.typical_tasks || []).map(t => `<span class="chip">${escapeHtml(t)}</span>`).join('') || '<span class="text dim">—</span>'}
      </div>
    </div>

    <div class="sheet-section">
      <h4>Esta semana</h4>
      <div class="text dim">${blocksForClient.length > 0
        ? blocksForClient.length + ' bloque(s) asignados'
        : 'Sin bloques asignados esta semana.'}</div>
    </div>

    ${c.has_monthly_calendar ? clientCalendarHtml(c) : ''}

    ${projects.map(p => projectHtml(p)).join('')}
  `;

  // Eventos: editar playbook/cadence inline
  $sheetBody.querySelectorAll('[contenteditable="true"]').forEach(el => {
    el.addEventListener('blur', async () => {
      const cl = state.clients.find(x => x.id === el.dataset.id);
      if (!cl) return;
      cl[el.dataset.field] = el.textContent.trim();
      await store.upsertClient(cl);
      if (state.section === 'clientes') renderClientes();
    });
  });

  // Eventos: checklist de proyecto
  $sheetBody.querySelectorAll('.week-items input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', async () => {
      const { projectId, weekIdx, itemIdx } = cb.dataset;
      await store.toggleProjectItem(projectId, +weekIdx, +itemIdx);
      state.projects = await store.listProjects();
      openClientSheet(clientId); // re-render
    });
  });

  // Expandible por semana
  $sheetBody.querySelectorAll('.week-row .wh').forEach(wh => {
    wh.addEventListener('click', () => {
      const row = wh.parentElement;
      const items = row.querySelector('.week-items');
      if (items.style.display === 'none') { items.style.display = ''; }
      else { items.style.display = 'none'; }
    });
  });

  $sheet.setAttribute('aria-hidden', 'false');
}

function clientCalendarHtml(c) {
  const months = relevantMonths();
  const monthsHtml = months.map(({ year, month }) => monthCardHtml(c, year, month)).join('');
  setTimeout(() => attachMonthCardHandlers($sheetBody), 0);
  return `
    <div class="sheet-section">
      <h4>Calendario de contenido · mes anterior, actual y siguiente</h4>
      <p class="text dim" style="margin:0 0 8px;font-size:12px">Tap en la card = planificar el mes. Tap en una semana = marcar como editada.</p>
      <div class="month-grid three-months">${monthsHtml}</div>
    </div>
  `;
}

function projectHtml(p) {
  const allItems = p.weeks.flatMap(w => w.items);
  const done = allItems.filter(i => i.done).length;
  const pct = allItems.length ? Math.round(done / allItems.length * 100) : 0;
  const isReadOnly = !can('editProjectChecklist');

  return `
    <div class="sheet-section">
      <h4>Proyecto activo</h4>
      <div class="project-block">
        <div class="ph">
          <strong>${escapeHtml(p.name)}</strong>
          <span class="status-pill">${escapeHtml(p.status)}</span>
        </div>
        <div class="text dim">${escapeHtml(p.description || '')}</div>
        <div class="progress-bar"><div class="fill" style="width:${pct}%"></div></div>
        <div class="text dim" style="margin-bottom:10px">${done}/${allItems.length} items · ${pct}% completado · Semana ${p.current_week}</div>

        ${p.weeks.map((w, wi) => {
          const wd = w.items.filter(i => i.done).length;
          const isCurrent = w.week_num === p.current_week;
          return `
            <div class="week-row ${isCurrent ? 'is-current' : ''}">
              <div class="wh">
                <div class="left">
                  <span class="week-num">S${w.week_num}</span>
                  <span class="wt">${escapeHtml(w.title)}</span>
                </div>
                <span class="count">${wd}/${w.items.length}</span>
              </div>
              <ul class="week-items" style="${isCurrent ? '' : 'display:none'}">
                ${w.items.map((it, ii) => `
                  <li class="${it.done ? 'done' : ''}">
                    <input type="checkbox" ${it.done ? 'checked' : ''}
                           ${isReadOnly ? 'disabled' : ''}
                           data-project-id="${p.id}" data-week-idx="${wi}" data-item-idx="${ii}" />
                    <span>${escapeHtml(it.text)}</span>
                  </li>
                `).join('')}
              </ul>
            </div>`;
        }).join('')}
      </div>
    </div>
  `;
}

$sheet.querySelectorAll('[data-close]').forEach(el => {
  el.addEventListener('click', () => $sheet.setAttribute('aria-hidden', 'true'));
});

// ============================================================
// SISTEMA DE ALERTAS · ciclo Motib (S1 Ejecución → S2 Planning → S3 Producción → S4 Cierre)
// ============================================================
function computeAlerts() {
  const today = new Date();
  const curYear = today.getFullYear();
  const curMonth = today.getMonth() + 1;
  const cw = currentWeekIndexOfMonth(); // 1..N
  const alerts = [];
  const clientsCal = state.clients.filter(c => c.has_monthly_calendar);

  for (const c of clientsCal) {
    const thisM = getCal(c.id, curYear, curMonth);
    const { year: nY, month: nM } = nextMonth(curYear, curMonth);
    const nextM_ = getCal(c.id, nY, nM);
    const monthName = MONTH_NAMES_ES[curMonth - 1];
    const nextName = MONTH_NAMES_ES[nM - 1];

    // PRIMARY · mes corriente no planificado (debería estar listo desde el mes anterior)
    if (!thisM || thisM.status === 'vacio') {
      alerts.push({
        level: 'primary',
        clientId: c.id,
        year: curYear, month: curMonth,
        icon: '🟥',
        title: `${c.name} · ${monthName} sin planificar`,
        detail: `S${cw} del mes y el calendario todavía no está en el excel. Según el ciclo Motib, debería estar planificado desde la S2 del mes anterior.`,
      });
    }

    // PRIMARY · S2+ y mes siguiente vacío (Planning del Notion)
    if (cw >= 2 && (!nextM_ || nextM_.status === 'vacio')) {
      alerts.push({
        level: 'primary',
        clientId: c.id,
        year: nY, month: nM,
        icon: '🟥',
        title: `${c.name} · planning de ${nextName} pendiente`,
        detail: `Estamos en S${cw} del mes. Según el ciclo (S2 = Planning), el calendario de ${nextName} ya debería estar definido.`,
      });
    }

    // PRIMARY · S3+ y mes siguiente sin ninguna semana editada (debería estar en producción)
    if (cw >= 3 && nextM_ && nextM_.weeks?.every(w => !w.edited)) {
      alerts.push({
        level: 'primary',
        clientId: c.id,
        year: nY, month: nM,
        icon: '🟥',
        title: `${c.name} · producción de ${nextName} pendiente`,
        detail: `S${cw} del mes. Según el ciclo (S3 = Producción), ya deberían estar editadas las primeras semanas de ${nextName} en Drive.`,
      });
    }

    // SECONDARY · Mes vista: S4 y primera semana del siguiente sin editar
    if (cw >= 4) {
      const fw = nextM_?.weeks?.[0];
      if (!fw || !fw.edited) {
        alerts.push({
          level: 'secondary',
          clientId: c.id,
          year: nY, month: nM,
          icon: '🟧',
          title: `${c.name} · 1ª semana de ${nextName} sin editar`,
          detail: `Última semana del mes — la primera semana de ${nextName} aún no tiene contenido editado en Drive. Mes vista en riesgo.`,
        });
      }
    }
  }
  return alerts;
}

function renderAlertsBadge() {
  const alerts = computeAlerts();
  const $bell = document.getElementById('alerts-bell');
  const $count = document.getElementById('alerts-count');
  if (alerts.length === 0) {
    $count.hidden = true;
    $bell.classList.remove('has-alerts');
  } else {
    $count.hidden = false;
    $count.textContent = alerts.length;
    $bell.classList.add('has-alerts');
  }
  return alerts;
}

function renderAlertsPanel() {
  const alerts = computeAlerts();
  const $body = document.getElementById('alerts-body');
  if (alerts.length === 0) {
    $body.innerHTML = `<div class="alerts-empty"><span class="em">✓</span>Sin alertas pendientes.<br>El ciclo Motib se está cumpliendo.</div>`;
    return;
  }
  // Orden: primary primero, luego secondary
  const sorted = [...alerts].sort((a, b) => (a.level === 'primary' ? -1 : 1));
  $body.innerHTML = sorted.map(a => `
    <div class="alert-item level-${a.level}">
      <span class="icon">${a.icon}</span>
      <div class="body">
        <strong>${escapeHtml(a.title)}</strong>
        <div class="det">${escapeHtml(a.detail)}</div>
      </div>
      <button class="goto" data-client-id="${a.clientId}" data-year="${a.year}" data-month="${a.month}">Ver mes</button>
    </div>
  `).join('');
  $body.querySelectorAll('.goto').forEach(btn => {
    btn.addEventListener('click', () => {
      // Cerrar panel, ir a Calendarios y resaltar la card del mes
      document.getElementById('alerts-panel').hidden = true;
      switchSection('calendarios');
      requestAnimationFrame(() => {
        const sel = `.month-card[data-client-id="${btn.dataset.clientId}"][data-year="${btn.dataset.year}"][data-month="${btn.dataset.month}"]`;
        const card = document.querySelector(sel);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.classList.add('highlight-flash');
          setTimeout(() => card.classList.remove('highlight-flash'), 1500);
        }
      });
    });
  });
}

function switchSection(section) {
  state.section = section;
  document.querySelectorAll('.section-btn').forEach(b => b.classList.toggle('is-active', b.dataset.section === section));
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('is-active'));
  document.getElementById('screen-' + section).classList.add('is-active');
  if (section === 'semana') renderSemana();
  if (section === 'clientes') renderClientes();
  if (section === 'calendarios') renderCalendarios();
  if (section === 'resultados') renderResultados();
}

document.getElementById('alerts-bell').addEventListener('click', () => {
  const panel = document.getElementById('alerts-panel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderAlertsPanel();
});
document.getElementById('alerts-close').addEventListener('click', () => {
  document.getElementById('alerts-panel').hidden = true;
});

// ============================================================
// CALENDARIOS · vista macro anual
// ============================================================
// Devuelve los 3 meses a mostrar: anterior, actual, siguiente
function relevantMonths() {
  const today = new Date();
  const months = [];
  for (let offset = -1; offset <= 1; offset++) {
    const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }
  return months;
}

// ¿El mes (year, month) necesita alerta de "mes vista" no planificado?
// Regla: si estás en la última o anteúltima semana del mes anterior y el mes destino está vacío.
function shouldAlertMonth(clientId, year, month) {
  const today = new Date();
  // El mes anterior a (year, month):
  const prev = new Date(year, month - 2, 1);
  const isPrevCurrent = today.getFullYear() === prev.getFullYear() && today.getMonth() === prev.getMonth();
  if (!isPrevCurrent) return false;
  const myMonday = todaysMondayIso();
  const isCloseToEnd = isLastWeekOfMonth(myMonday) || isPenultimateWeekOfMonth(myMonday);
  if (!isCloseToEnd) return false;
  const cal = state.calendars.find(c => c.client_id === clientId && c.year === year && c.month === month);
  return !cal || cal.status === 'vacio';
}

// HTML de un mini-cuadrado de semana (muestra el día del lunes y permite toggle)
function weekChipHtml(w) {
  const d = new Date(w.monday + 'T00:00:00');
  const day = d.getDate();
  return `<div class="w ${w.edited ? 'edited' : ''}" data-w="${day}" data-monday="${w.monday}" title="Sem del ${day}/${d.getMonth() + 1} · tap para tildar/destildar"></div>`;
}

// Card de un mes para un cliente (estados simples: vacio | planificado, + bonus all-edited)
function monthCardHtml(c, year, month) {
  const today = new Date();
  const isCurrent = year === today.getFullYear() && month === today.getMonth() + 1;
  let cal = state.calendars.find(x => x.client_id === c.id && x.year === year && x.month === month);
  if (!cal) cal = { status: 'vacio', weeks: weeksForMonth(year, month) };
  if (!cal.weeks || cal.weeks.length === 0 || !cal.weeks[0].monday) cal = { ...cal, weeks: weeksForMonth(year, month) };

  // Normalizamos: solo aceptamos 'vacio' o 'planificado' como status manuales.
  // Los viejos 'produccion'/'cerrado' los tratamos como 'planificado' para no romper.
  const effectiveStatus = (cal.status === 'vacio') ? 'vacio' : 'planificado';

  const isAlert = shouldAlertMonth(c.id, year, month);
  const editedCount = cal.weeks.filter(w => w.edited).length;
  const allEdited = cal.weeks.length > 0 && editedCount === cal.weeks.length;
  const statusLabel = effectiveStatus === 'vacio' ? 'Sin planificar' : (allEdited ? 'Mes completo' : 'Planificado');
  const weeksHtml = cal.weeks.map(weekChipHtml).join('');

  return `
    <article class="month-card status-${effectiveStatus} ${allEdited ? 'all-edited' : ''} ${isCurrent ? 'is-current' : ''} ${isAlert ? 'alert' : ''}"
             data-client-id="${c.id}" data-year="${year}" data-month="${month}">
      <div class="mh">
        <span class="mn">${MONTH_NAMES_ES[month - 1]}</span>
        <span class="my">${year}</span>
      </div>
      <div class="ms">${isAlert ? '⚠ falta planificar' : statusLabel}${editedCount > 0 ? ` · ${editedCount}/${cal.weeks.length}` : ''}</div>
      <div class="weeks">${weeksHtml}</div>
    </article>
  `;
}

// Handlers directos: card → toggle status / mini-semana → toggle edited
async function handleMonthCardClick(card, ev) {
  if (!can('planMonth')) return;
  // Si tocó un mini-cuadrado de semana, no hacemos nada acá (lo maneja su propio handler)
  if (ev.target.classList.contains('w')) return;
  const clientId = card.dataset.clientId;
  const year = +card.dataset.year;
  const month = +card.dataset.month;
  const cal = await store.getCalendar(clientId, year, month);
  const current = cal?.status === 'planificado' ? 'planificado' : 'vacio';
  const next = current === 'vacio' ? 'planificado' : 'vacio';
  await store.setCalendarStatus(clientId, year, month, next);
  state.calendars = await store.listCalendars();
  if (state.section === 'calendarios') renderCalendarios();
  if (state.section === 'clientes') renderClientes();
  renderAlertsBadge();
}

async function handleWeekChipClick(chip, ev) {
  ev.stopPropagation();
  if (!can('markWeekEdited')) return;
  const card = chip.closest('.month-card');
  if (!card) return;
  const clientId = card.dataset.clientId;
  const year = +card.dataset.year;
  const month = +card.dataset.month;
  const monday = chip.dataset.monday;
  await store.toggleCalendarWeek(clientId, year, month, monday);
  state.calendars = await store.listCalendars();
  if (state.section === 'calendarios') renderCalendarios();
  if (state.section === 'clientes') renderClientes();
  renderAlertsBadge();
}

function attachMonthCardHandlers(container) {
  container.querySelectorAll('.month-card').forEach(card => {
    card.addEventListener('click', (e) => handleMonthCardClick(card, e));
  });
  container.querySelectorAll('.month-card .w').forEach(chip => {
    chip.addEventListener('click', (e) => handleWeekChipClick(chip, e));
  });
}

function renderCalendarios() {
  const months = relevantMonths();
  const clientsWithCal = state.clients.filter(c => c.has_monthly_calendar);

  // Banner: resumen de alertas activas
  const alerts = computeAlerts();
  const primaryCount = alerts.filter(a => a.level === 'primary').length;
  const secondaryCount = alerts.filter(a => a.level === 'secondary').length;
  let alertsHtml = '';
  if (alerts.length > 0) {
    const partes = [];
    if (primaryCount > 0) partes.push(`<strong>${primaryCount}</strong> del ciclo Motib`);
    if (secondaryCount > 0) partes.push(`<strong>${secondaryCount}</strong> de mes vista`);
    alertsHtml = `<div class="alert-banner" id="cal-alert-banner" style="cursor:pointer">⚠️ ${alerts.length} alerta${alerts.length > 1 ? 's' : ''}: ${partes.join(' · ')}. Tocar la 🔔 para ver detalle.</div>`;
  }

  const html = clientsWithCal.map(c => {
    const monthsHtml = months.map(({ year, month }) => monthCardHtml(c, year, month)).join('');
    return `
      <div class="cal-client-row">
        <div class="ch-title">
          <span class="swatch" style="background:${c.color}"></span>
          <span class="name">${escapeHtml(c.name)}</span>
          <span class="meta">${escapeHtml(c.cadence || '')}</span>
        </div>
        <div class="month-grid three-months">${monthsHtml}</div>
      </div>
    `;
  }).join('');

  // Accesos rápidos a las carpetas de Drive (al pie de la sección).
  const foldersHtml = `
    <div class="drive-folders">
      <h3 class="drive-folders-title">Carpetas de Drive</h3>
      <div class="drive-folders-grid">
        ${DRIVE_FOLDERS.map(f => f.url
          ? `<a class="drive-folder" href="${escapeHtml(f.url)}" target="_blank" rel="noopener noreferrer">📁 ${escapeHtml(f.label)}</a>`
          : `<span class="drive-folder is-empty" title="Pegá el link en storage.js → DRIVE_FOLDERS">📁 ${escapeHtml(f.label)} <small>(falta link)</small></span>`
        ).join('')}
      </div>
    </div>`;

  $calendarsContent.innerHTML = alertsHtml + (html || '<div class="empty"><h4>Sin clientes con calendario</h4></div>') + foldersHtml;

  attachMonthCardHandlers($calendarsContent);
  const banner = document.getElementById('cal-alert-banner');
  if (banner) banner.addEventListener('click', () => {
    const p = document.getElementById('alerts-panel');
    p.hidden = false; renderAlertsPanel();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// ============================================================
// RESULTADOS · desglose de la semana de Ailén (solo Tomi)
// ============================================================
const $resWeekRange = document.getElementById('res-week-range');
const $resultadosContent = document.getElementById('resultados-content');

// Colores por categoría para las barras de "tipo de trabajo".
const CAT_COLORS = {
  edicion: '#ED6A5A', diseno: '#FF7F11', produccion: '#689ABC', planning: '#9b87c4',
  reunion: '#95CA9A', investigacion: '#e0a458', gestion: '#5b8a8a', pausa: '#c8c5bf', otro: '#9a9aa3',
};

function fmtDur(min) {
  min = Math.round(min);
  const h = Math.floor(min / 60), m = min % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}
function blockDurMin(b) {
  const s = parseSlot(b.time_slot);
  return s ? Math.max(0, s.end - s.start) : 0;
}
// Una barra horizontal con etiqueta + valor.
function resBarRow(label, value, maxValue, color, valueLabel) {
  const w = maxValue > 0 ? Math.max(4, Math.round((value / maxValue) * 100)) : 0;
  return `<div class="res-bar-row">
    <span class="res-bar-label">${label}</span>
    <div class="res-bar-track"><div class="res-bar-fill" style="width:${w}%;background:${color}"></div></div>
    <span class="res-bar-val">${valueLabel}</span>
  </div>`;
}

function renderResultados() {
  const monday = parseISO(state.weekStart);
  if ($resWeekRange) $resWeekRange.textContent = `Semana del ${fmtRange(monday)}`;

  // Trabajo real = todo menos pausas (almuerzos), para que el cumplimiento sea honesto.
  const work = state.blocks.filter(b => !getCategories(b).includes('pausa'));

  if (work.length === 0) {
    $resultadosContent.innerHTML = `<div class="empty"><h4>Sin bloques esta semana</h4>
      <p>Ailén todavía no cargó nada en esta semana.</p></div>`;
    return;
  }

  const buckets = { hecho: [], pendiente: [], postergado: [] };
  for (const b of work) buckets[normalizeStatus(b.status)].push(b);
  const total = work.length;
  const doneCount = buckets.hecho.length;
  const pendCount = buckets.pendiente.length;
  const postCount = buckets.postergado.length;
  const pct = Math.round((doneCount / total) * 100);
  const plannedMin = work.reduce((a, b) => a + blockDurMin(b), 0);
  const doneMin = buckets.hecho.reduce((a, b) => a + blockDurMin(b), 0);

  // Carga por cliente (horas planeadas).
  const byClient = new Map();
  for (const b of work) {
    const k = b.client || 'Sin cliente';
    byClient.set(k, (byClient.get(k) || 0) + blockDurMin(b));
  }
  const clientRows = [...byClient.entries()].sort((a, b) => b[1] - a[1]);
  const maxClient = clientRows.length ? clientRows[0][1] : 0;

  // Carga por tipo de trabajo (categoría).
  const byCat = new Map();
  for (const b of work) for (const c of getCategories(b)) {
    if (c === 'pausa') continue;
    byCat.set(c, (byCat.get(c) || 0) + blockDurMin(b));
  }
  const catRows = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
  const maxCat = catRows.length ? catRows[0][1] : 0;

  // Motivos de postergación + notas libres.
  const byReason = new Map();
  for (const b of buckets.postergado) {
    if (b.postpone_reason) byReason.set(b.postpone_reason, (byReason.get(b.postpone_reason) || 0) + 1);
  }
  const reasonRows = [...byReason.entries()].sort((a, b) => b[1] - a[1]);
  const maxReason = reasonRows.length ? reasonRows[0][1] : 0;
  const reasonNotes = buckets.postergado.filter(b => b.postpone_note);

  // Urgentes de la semana.
  const urg = state.urgents;
  const urgDisplaced = urg.filter(u => u.displaces).length;
  const urgMin = urg.reduce((a, u) => a + (u.estimated_minutes || 0), 0);

  // ---- Render ----
  const hero = `
    <div class="res-hero">
      <div class="res-hero-num">${pct}<span>%</span></div>
      <div class="res-hero-meta">
        <strong>${doneCount} de ${total} bloques cerrados</strong>
        <span>${fmtDur(doneMin)} hechas · ${fmtDur(plannedMin)} planeadas</span>
        <div class="res-hero-bar"><div style="width:${pct}%"></div></div>
      </div>
    </div>`;

  const estado = `
    <div class="res-card">
      <h3>Estado de los bloques</h3>
      <div class="res-segbar">
        <div class="seg done" style="flex:${doneCount}"></div>
        <div class="seg pend" style="flex:${pendCount}"></div>
        <div class="seg post" style="flex:${postCount}"></div>
      </div>
      <div class="res-legend">
        <span><i class="dot done"></i> ${doneCount} hechos</span>
        <span><i class="dot pend"></i> ${pendCount} pendientes</span>
        <span><i class="dot post"></i> ${postCount} postergados</span>
      </div>
    </div>`;

  const motivos = `
    <div class="res-card">
      <h3>¿Por qué no se llegó?</h3>
      ${reasonRows.length === 0
        ? `<p class="res-empty-inline">Sin postergaciones esta semana 🎉</p>`
        : reasonRows.map(([r, c]) =>
            resBarRow(POSTPONE_REASONS[r] || r, c, maxReason, '#b5546b', `${c}`)).join('')}
      ${reasonNotes.length
        ? `<div class="res-notes">${reasonNotes.map(b =>
            `<div class="res-note"><span class="res-note-task">${escapeHtml(b.task)}</span>${escapeHtml(b.postpone_note)}</div>`).join('')}</div>`
        : ''}
    </div>`;

  const porCliente = `
    <div class="res-card">
      <h3>Dónde fue el tiempo · por cliente</h3>
      ${clientRows.map(([name, min]) =>
        resBarRow(escapeHtml(name), min, maxClient, clientByName(name)?.color || '#9a9aa3', fmtDur(min))).join('')}
    </div>`;

  const porTipo = `
    <div class="res-card">
      <h3>Tipo de trabajo</h3>
      ${catRows.map(([id, min]) => {
        const c = categoryById(id);
        const label = c ? `${c.emoji} ${c.label}` : id;
        return resBarRow(label, min, maxCat, CAT_COLORS[id] || '#9a9aa3', fmtDur(min));
      }).join('')}
    </div>`;

  const urgentes = `
    <div class="res-card">
      <h3>Urgentes</h3>
      <div class="res-urg-grid">
        <div><strong>${urg.length}</strong><span>recibidos</span></div>
        <div><strong>${urgDisplaced}</strong><span>desplazaron bloques</span></div>
        <div><strong>${fmtDur(urgMin)}</strong><span>tiempo estimado</span></div>
      </div>
    </div>`;

  $resultadosContent.innerHTML = hero + estado + motivos + porCliente + porTipo + urgentes;
}

async function shiftWeekResultados(delta) {
  const d = parseISO(state.weekStart);
  d.setDate(d.getDate() + delta);
  state.weekStart = fmtISO(d);
  await loadWeek();
  renderResultados();
}
document.getElementById('res-prev-week').addEventListener('click', () => shiftWeekResultados(-7));
document.getElementById('res-next-week').addEventListener('click', () => shiftWeekResultados(+7));

// Muestra/oculta el tab Resultados según el usuario (solo quien puede ver la semana de otro).
function applyUserGating() {
  const tab = document.getElementById('tab-resultados');
  if (tab) tab.hidden = !can('viewOthersWeek');
  if (!can('viewOthersWeek') && state.section === 'resultados') switchSection('semana');
}

// ============================================================
// POSTPONE MODAL · postergar bloque (más tarde hoy / otro día / sin fecha)
// ============================================================
const $postponeModal = document.getElementById('postpone-modal');
const $postponeInfo = document.getElementById('postpone-info');
const $postponeModes = document.getElementById('postpone-modes');
const $postponeDetails = document.getElementById('postpone-details');
const $postponeConfirm = document.getElementById('postpone-confirm');
const $prChips = document.getElementById('pr-chips');
const $prNote = document.getElementById('pr-note');
let postponeBlock = null;
let postponeMode = null;
let postponePayload = null; // { newSlot, newDay } según modo
let postponeReason = null;  // clave en POSTPONE_REASONS (requerida: un toque)

// El Confirmar se habilita solo con modo válido (payload) Y motivo elegido.
function refreshPostponeConfirm() {
  $postponeConfirm.disabled = !(postponePayload && postponeReason);
}

function openPostponeModal(block) {
  postponeBlock = block;
  postponeMode = null;
  postponePayload = null;
  $postponeInfo.textContent = `${block.time_slot} · ${DAY_LABELS[block.day]} · ${block.task}`;
  $postponeModes.querySelectorAll('.pm-btn').forEach(b => b.classList.remove('active'));
  $postponeDetails.innerHTML = '';
  postponeReason = null;
  $prChips.querySelectorAll('button').forEach(b => b.classList.remove('active'));
  $prNote.value = '';
  $postponeConfirm.disabled = true;
  $postponeModal.showModal();
}

function closePostponeModal() {
  postponeBlock = null;
  postponeMode = null;
  postponePayload = null;
  postponeReason = null;
  $postponeModal.close();
}

// Chips de motivo: elegir uno habilita (junto al modo) el Confirmar.
$prChips.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => {
    postponeReason = btn.dataset.reason;
    $prChips.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    refreshPostponeConfirm();
  });
});

$postponeModes.querySelectorAll('.pm-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    postponeMode = btn.dataset.mode;
    $postponeModes.querySelectorAll('.pm-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderPostponeDetails();
  });
});

function renderPostponeDetails() {
  postponePayload = null;
  $postponeConfirm.disabled = true;
  if (!postponeBlock) return;
  const orig = parseSlot(postponeBlock.time_slot);
  const durMin = orig.end - orig.start;

  if (postponeMode === 'no-date') {
    $postponeDetails.innerHTML = `<div class="pd-block"><span class="pd-label">Sin reprogramar</span>
      <div class="text dim">El bloque queda postergado en su lugar original. Decidís cuándo retomarlo.</div></div>`;
    postponePayload = { type: 'no-date' };
    refreshPostponeConfirm();
    return;
  }

  if (postponeMode === 'later-today') {
    const dayBlocks = state.blocks.filter(b => b.day === postponeBlock.day && b.id !== postponeBlock.id);
    const taken = dayBlocks.map(b => parseSlot(b.time_slot));
    const freeStarts = [];
    for (let mins = orig.end; mins + durMin <= 19 * 60 + 30 + 60; mins += 30) {
      const slot = { start: mins, end: mins + durMin };
      const clash = taken.some(t => slot.start < t.end && t.start < slot.end);
      if (!clash) freeStarts.push(mins);
      if (freeStarts.length >= 8) break;
    }
    if (freeStarts.length === 0) {
      $postponeDetails.innerHTML = `<div class="pd-block"><span class="pd-label">No hay slots libres hoy</span>
        <div class="text dim">Probá "Otro día" o "Sin fecha".</div></div>`;
      return;
    }
    $postponeDetails.innerHTML = `
      <div class="pd-block">
        <span class="pd-label">Elegí horario libre · duración ${durMin} min</span>
        <div class="pd-chips" id="pd-slot-chips">
          ${freeStarts.map(m => `<button type="button" data-start="${m}">${formatHHMM(m)}</button>`).join('')}
        </div>
      </div>
    `;
    document.getElementById('pd-slot-chips').querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        document.getElementById('pd-slot-chips').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
        const startMin = parseInt(b.dataset.start, 10);
        postponePayload = { type: 'later-today', newSlot: buildSlot(startMin, durMin) };
        refreshPostponeConfirm();
      });
    });
    return;
  }

  if (postponeMode === 'other-day') {
    const otherDays = DAYS.filter(d => d !== postponeBlock.day);
    $postponeDetails.innerHTML = `
      <div class="pd-block">
        <span class="pd-label">Elegí día · misma hora (${postponeBlock.time_slot})</span>
        <div class="pd-chips" id="pd-day-chips">
          ${otherDays.map(d => `<button type="button" data-day="${d}">${DAY_LABELS[d]}</button>`).join('')}
        </div>
        <div class="text dim" style="font-size:11px;margin-top:4px">Si hay bloques que ocupan ese horario, se corren hacia adelante.</div>
      </div>
    `;
    document.getElementById('pd-day-chips').querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        document.getElementById('pd-day-chips').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
        const newDay = b.dataset.day;
        // Detectar si va a haber corrimiento (solo para info, no bloquea)
        const wouldShift = state.blocks.filter(x =>
          x.day === newDay && x.id !== postponeBlock.id && slotsOverlap(x.time_slot, postponeBlock.time_slot)
        );
        const info = $postponeDetails.querySelector('.pd-info');
        if (info) info.remove();
        if (wouldShift.length > 0) {
          $postponeDetails.insertAdjacentHTML('beforeend',
            `<div class="pd-info" style="margin-top:8px;color:var(--info-text);background:var(--info-soft);padding:8px;border-radius:8px;font-size:12px">
              ℹ ${wouldShift.length} bloque${wouldShift.length > 1 ? 's' : ''} en ${DAY_LABELS[newDay]} se va${wouldShift.length > 1 ? 'n' : ''} a correr hacia adelante.
            </div>`);
        }
        postponePayload = { type: 'other-day', newDay };
        refreshPostponeConfirm();
      });
    });
    return;
  }
}

$postponeConfirm.addEventListener('click', async () => {
  if (!postponeBlock || !postponePayload || !postponeReason) return;
  const b = postponeBlock;
  let movedCount = 0;

  // Registrar el motivo (y nota opcional) de por qué no se llegó a lo planeado.
  b.postpone_reason = postponeReason;
  b.postpone_note = $prNote.value.trim() || null;

  if (postponePayload.type === 'no-date') {
    // status ya está 'postergado'; no movemos nada
  } else if (postponePayload.type === 'later-today') {
    b.time_slot = postponePayload.newSlot;
    b.status = 'pendiente';
  } else if (postponePayload.type === 'other-day') {
    b.day = postponePayload.newDay;
    b.status = 'pendiente';

    // Compactar el día destino: el bloque postergado queda fijo en su hora,
    // los que estaban antes se corren hacia adelante.
    await store.upsertBlock(b);
    // Cargar estado fresco para no usar referencia obsoleta
    const allBlocksInDay = (await store.listBlocks(state.weekStart)).filter(x => x.day === b.day);
    const moved = compactDayBlocks(allBlocksInDay, b.id);
    for (const m of moved) {
      await store.upsertBlock(m);
    }
    movedCount = moved.length;
  }

  if (postponePayload.type !== 'other-day') {
    await store.upsertBlock(b);
  }

  // Recargar bloques desde storage (vía loadWeek para pasar por el saneo de duplicados)
  await loadWeek();
  closePostponeModal();
  renderSemana();

  if (movedCount > 0) {
    // Feedback discreto
    showToast(`Se corrieron ${movedCount} bloque${movedCount > 1 ? 's' : ''} hacia adelante en ${DAY_LABELS[postponePayload.newDay]}.`);
  }
});

// ---- Toast simple ----
function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timeout);
  t._timeout = setTimeout(() => t.classList.remove('show'), 3200);
}
// Botones de salida del modal: revertir el estado del bloque
async function setBlockStatusAndClose(newStatus) {
  if (postponeBlock) {
    postponeBlock.status = newStatus;
    // Volver a pendiente/hecho ⇒ el motivo de postergación deja de aplicar.
    postponeBlock.postpone_reason = null;
    postponeBlock.postpone_note = null;
    await store.upsertBlock(postponeBlock);
  }
  closePostponeModal();
  renderSemana();
}
document.getElementById('postpone-to-pending').addEventListener('click', () => setBlockStatusAndClose('pendiente'));
document.getElementById('postpone-to-done').addEventListener('click', () => setBlockStatusAndClose('hecho'));

// ============================================================
// MODALES (semana)
// ============================================================
const $blockModal = document.getElementById('block-modal');
const $blockForm = $blockModal.querySelector('form');
const $blockTitle = document.getElementById('block-modal-title');
const $blockDelete = document.getElementById('block-delete');
const $blockClientSelect = document.getElementById('block-client-select');
const $taskSuggestions = document.getElementById('task-suggestions');
const $categoryChips = document.getElementById('category-chips');
const $startSelect = document.getElementById('block-start-select');
const $durChips = document.getElementById('block-dur-chips');
const $slotPreview = document.getElementById('slot-preview');
const $slotConflict = document.getElementById('slot-conflict');
let editingBlockId = null;
let selectedCategories = new Set(); // multi-select
let selectedStartMin = 8 * 60;
let selectedDurMin = 60;

// Inicializa el select de inicios una sola vez
(function initStartSelect() {
  $startSelect.innerHTML = generateStartOptions().map(min =>
    `<option value="${min}">${formatHHMM(min)}</option>`
  ).join('');
})();

function refreshSlotPreview() {
  const slot = buildSlot(selectedStartMin, selectedDurMin);
  $slotPreview.textContent = `→ ${slot}`;
  const conflict = findConflict(slot);
  if (conflict) {
    $slotConflict.hidden = false;
    $slotConflict.textContent = `⚠ Choca con "${conflict.task}" (${conflict.time_slot})`;
  } else {
    $slotConflict.hidden = true;
  }
}

// Busca el primer bloque del día activo (≠ del que se está editando) que se superpone con el slot dado
function findConflict(slot) {
  return state.blocks.find(b =>
    b.day === state.activeDay &&
    b.id !== editingBlockId &&
    slotsOverlap(b.time_slot, slot)
  );
}

$startSelect.addEventListener('change', () => {
  selectedStartMin = parseInt($startSelect.value, 10);
  refreshSlotPreview();
});
$durChips.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => {
    $durChips.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    selectedDurMin = parseInt(btn.dataset.dur, 10);
    refreshSlotPreview();
  });
});

function populateClientSelect(selectEl, currentValue = '') {
  selectEl.innerHTML = `<option value="">— Sin cliente —</option>` +
    state.clients.map(c => `<option value="${escapeHtml(c.name)}" ${c.name === currentValue ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
}

function renderCategoryChips() {
  $categoryChips.innerHTML = CATEGORIES.map(c => `
    <button type="button" data-cat="${c.id}" class="${selectedCategories.has(c.id) ? 'active' : ''}">
      <span class="cat-emoji">${c.emoji}</span>${c.label}
    </button>
  `).join('');
  $categoryChips.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => {
      const id = b.dataset.cat;
      if (selectedCategories.has(id)) selectedCategories.delete(id);
      else selectedCategories.add(id);
      renderCategoryChips();
      refreshTaskSuggestions($blockClientSelect.value);
    });
  });
}

// Sugerencias inteligentes: filtra typical_tasks por las categorías seleccionadas
function refreshTaskSuggestions(clientName) {
  const c = clientByName(clientName);
  const tasks = c?.typical_tasks || [];
  if (tasks.length === 0) {
    $taskSuggestions.innerHTML = '';
    return;
  }
  // Tarea matchea si alguna categoría coincide con las seleccionadas
  const filtered = selectedCategories.size > 0
    ? tasks.filter(t => selectedCategories.has(inferCategory({ task: t })))
    : [];
  const suggestions = filtered.length > 0 ? filtered : tasks;
  const catLabels = [...selectedCategories].map(id => categoryById(id)?.label).filter(Boolean).join(' · ');
  const label = filtered.length > 0
    ? `Sugerencias para ${c.name} · ${catLabels}`
    : `Sugerencias para ${c.name}`;
  $taskSuggestions.innerHTML = `
    <div style="width:100%" class="task-suggestions-hint">${escapeHtml(label)}</div>
    ${suggestions.map(t => `<button type="button" class="sg" data-task="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}
  `;
  $taskSuggestions.querySelectorAll('.sg').forEach(b => {
    b.addEventListener('click', () => {
      $blockForm.task.value = b.dataset.task;
      $blockForm.task.focus();
    });
  });
}

function openBlockModal(block) {
  editingBlockId = block?.id || null;
  $blockTitle.textContent = block ? 'Editar bloque' : `Nuevo bloque · ${DAY_LABELS[state.activeDay]}`;

  // Inicializar horario: edición → del block; nuevo → próximo slot libre
  if (block?.time_slot) {
    const r = parseSlot(block.time_slot);
    selectedStartMin = r.start;
    selectedDurMin = r.end - r.start;
  } else {
    const dayBlocks = state.blocks.filter(b => b.day === state.activeDay);
    const nxt = nextFreeSlot(dayBlocks);
    selectedStartMin = nxt.startMin;
    selectedDurMin = nxt.durMin;
  }
  // Si el inicio no está en la lista (ej: 8:15 viejo), forzamos al más cercano múltiplo de 30
  selectedStartMin = Math.round(selectedStartMin / 30) * 30;
  if (selectedStartMin < 8 * 60) selectedStartMin = 8 * 60;
  if (selectedStartMin > 19 * 60 + 30) selectedStartMin = 19 * 60 + 30;
  $startSelect.value = String(selectedStartMin);
  $durChips.querySelectorAll('button').forEach(b => b.classList.toggle('active', +b.dataset.dur === selectedDurMin));
  // Si la duración no matchea ninguno de los chips, activar 1h por defecto
  if (![30, 60, 90, 120, 180].includes(selectedDurMin)) {
    selectedDurMin = 60;
    $durChips.querySelector('button[data-dur="60"]').classList.add('active');
  }
  refreshSlotPreview();

  populateClientSelect($blockClientSelect, block?.client || '');
  selectedCategories = new Set(block ? getCategories(block) : []);
  renderCategoryChips();
  refreshTaskSuggestions(block?.client || '');
  $blockForm.task.value = block?.task || '';
  $blockForm.note.value = block?.note || '';
  $blockDelete.hidden = !block;
  $blockModal.showModal();
}

$blockClientSelect.addEventListener('change', () => refreshTaskSuggestions($blockClientSelect.value));

document.getElementById('block-cancel').addEventListener('click', () => $blockModal.close());

$blockDelete.addEventListener('click', async () => {
  if (!editingBlockId) return;
  if (!confirm('¿Eliminar este bloque?')) return;
  await store.deleteBlock(editingBlockId);
  state.blocks = state.blocks.filter(b => b.id !== editingBlockId);
  $blockModal.close();
  renderSemana();
});

$blockForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const slot = buildSlot(selectedStartMin, selectedDurMin);
  // Validación: no permitir superposición
  const conflict = findConflict(slot);
  if (conflict) {
    $slotConflict.hidden = false;
    $slotConflict.textContent = `⚠ Choca con "${conflict.task}" (${conflict.time_slot}). Ajustá inicio o duración.`;
    return;
  }
  const data = {
    id: editingBlockId,
    week_start: state.weekStart,
    day: state.activeDay,
    time_slot: slot,
    client: $blockClientSelect.value,
    categories: [...selectedCategories],
    task: $blockForm.task.value.trim(),
    note: $blockForm.note.value.trim(),
    status: state.blocks.find(b => b.id === editingBlockId)?.status || 'pendiente',
  };
  const saved = await store.upsertBlock(data);
  const idx = state.blocks.findIndex(b => b.id === saved.id);
  if (idx >= 0) state.blocks[idx] = saved; else state.blocks.push(saved);
  $blockModal.close();
  renderSemana();
});

// Urgente
const $urgentModal = document.getElementById('urgent-modal');
const $urgentForm = $urgentModal.querySelector('form');
const $urgentClientSelect = document.getElementById('urgent-client-select');
document.getElementById('add-urgent').addEventListener('click', () => {
  $urgentForm.reset();
  $urgentForm.estimated_minutes.value = 30;
  populateClientSelect($urgentClientSelect);
  $urgentModal.showModal();
});
document.getElementById('urgent-cancel').addEventListener('click', () => $urgentModal.close());
$urgentForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const saved = await store.createUrgent({
    week_start: state.weekStart,
    client: $urgentClientSelect.value.trim(),
    description: $urgentForm.description.value.trim(),
    estimated_minutes: parseInt($urgentForm.estimated_minutes.value, 10) || null,
    displaces: $urgentForm.displaces.checked,
  });
  state.urgents.push(saved);
  $urgentModal.close();
  renderSemana();
});

// ============================================================
// NAVEGACIÓN
// ============================================================
document.getElementById('prev-week').addEventListener('click', () => shiftWeek(-7));
document.getElementById('next-week').addEventListener('click', () => shiftWeek(+7));
async function shiftWeek(delta) {
  const d = parseISO(state.weekStart);
  d.setDate(d.getDate() + delta);
  state.weekStart = fmtISO(d);
  await loadWeek();
  // Solo materializar recurrentes en una semana NUEVA (sin bloques aún). En una
  // semana ya armada no se re-materializa, para no revivir fijos borrados ni clonar
  // los editados.
  if (state.blocks.length === 0) {
    await materializeRecurring(state.weekStart);
    await loadWeek();
  }
  renderSemana();
}

// Section tabs (Semana / Calendarios / Clientes)
document.querySelectorAll('.section-btn').forEach(btn => {
  btn.addEventListener('click', () => switchSection(btn.dataset.section));
});

// ============================================================
// IDENTIDAD DE USUARIO · onboarding + menú
// ============================================================
const $onboarding = document.getElementById('onboarding');
const $userChip = document.getElementById('user-chip');
const $userAvatar = document.getElementById('user-avatar-sm');
const $userName = document.getElementById('user-name-sm');
const $userDropdown = document.getElementById('user-dropdown');

function refreshUserChip() {
  if (!state.user) return;
  $userAvatar.textContent = state.user.initials;
  $userAvatar.style.background = state.user.color;
  $userName.textContent = `${state.user.name}${state.user.id === 'ailen' ? ' (yo)' : ''}`;
}

const $passwordPrompt = document.getElementById('password-prompt');
const $ppInput = document.getElementById('pp-input');
const $ppConfirm = document.getElementById('pp-confirm');
const $ppError = document.getElementById('pp-error');
const $ppTitle = document.getElementById('pp-title');
const $ppSub = document.getElementById('pp-sub');
const $ppSubmit = document.getElementById('pp-submit');
let pendingUserId = null;

function showOnboarding() {
  $onboarding.hidden = false;
  resetPasswordPrompt();
  $onboarding.querySelector('.onboarding-options').hidden = false;
  $onboarding.querySelectorAll('.user-option').forEach(btn => {
    btn.onclick = () => onUserTap(btn.dataset.user);
  });
}

function resetPasswordPrompt() {
  $passwordPrompt.hidden = true;
  $ppInput.value = ''; $ppConfirm.value = '';
  $ppError.hidden = true;
}

async function onUserTap(userId) {
  const user = USERS[userId];
  if (!user) return;
  if (!user.requiresPassword) {
    pickUser(userId);
    return;
  }
  // Tomi → flujo de password
  pendingUserId = userId;
  const hasStored = !!store.getPasswordHash(userId);
  $onboarding.querySelector('.onboarding-options').hidden = true;
  $passwordPrompt.hidden = false;
  $ppError.hidden = true;
  if (hasStored) {
    $ppTitle.textContent = `Contraseña de ${user.name}`;
    $ppSub.textContent = 'Ingresá tu contraseña para entrar.';
    $ppConfirm.hidden = true;
    $ppSubmit.textContent = 'Entrar';
  } else {
    $ppTitle.textContent = `Crear contraseña`;
    $ppSub.textContent = `Primera vez que entrás como ${user.name}. Definí tu contraseña — quedará guardada en este dispositivo.`;
    $ppConfirm.hidden = false;
    $ppSubmit.textContent = 'Crear y entrar';
  }
  setTimeout(() => $ppInput.focus(), 50);
}

document.getElementById('pp-back').addEventListener('click', () => {
  pendingUserId = null;
  resetPasswordPrompt();
  $onboarding.querySelector('.onboarding-options').hidden = false;
});

$passwordPrompt.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pendingUserId) return;
  const pass = $ppInput.value;
  if (!pass) { showPpError('Ingresá una contraseña.'); return; }
  const hasStored = !!store.getPasswordHash(pendingUserId);
  if (hasStored) {
    // Verificar
    const ok = await store.verifyPassword(pendingUserId, pass);
    if (!ok) { showPpError('Contraseña incorrecta.'); return; }
    pickUser(pendingUserId);
  } else {
    // Crear
    const confirm = $ppConfirm.value;
    if (pass.length < 4) { showPpError('Mínimo 4 caracteres.'); return; }
    if (pass !== confirm) { showPpError('Las contraseñas no coinciden.'); return; }
    await store.setPassword(pendingUserId, pass);
    pickUser(pendingUserId);
  }
});

function showPpError(msg) {
  $ppError.textContent = msg;
  $ppError.hidden = false;
}

function pickUser(userId) {
  pendingUserId = null;
  store.setCurrentUserId(userId);
  state.user = USERS[userId];
  $onboarding.hidden = true;
  resetPasswordPrompt();
  refreshUserChip();
  applyUserGating();
  rerenderCurrent();
}

function rerenderCurrent() {
  if (state.section === 'semana') renderSemana();
  else if (state.section === 'clientes') renderClientes();
  else if (state.section === 'calendarios') renderCalendarios();
  else if (state.section === 'resultados') renderResultados();
  renderAlertsBadge();
}

$userChip.addEventListener('click', (e) => {
  e.stopPropagation();
  $userDropdown.hidden = !$userDropdown.hidden;
});
document.addEventListener('click', (e) => {
  if (!$userDropdown.hidden && !$userDropdown.contains(e.target) && e.target !== $userChip) {
    $userDropdown.hidden = true;
  }
});
document.getElementById('switch-user').addEventListener('click', () => {
  $userDropdown.hidden = true;
  store.clearCurrentUser();
  state.user = null;
  showOnboarding();
});
document.getElementById('lock-app').addEventListener('click', () => {
  $userDropdown.hidden = true;
  auth.signOut();
  store.clearCurrentUser();
  state.user = null;
  $onboarding.hidden = true;
  showGate();
});

// Cerrar el día
document.getElementById('close-day').addEventListener('click', () => {
  const dayBlocks = state.blocks.filter(b => b.day === state.activeDay);
  const pendientes = dayBlocks.filter(b => normalizeStatus(b.status) === 'pendiente');
  if (pendientes.length === 0) {
    alert(`Día cerrado. Todo en orden para ${DAY_LABELS[state.activeDay]}.`);
    return;
  }
  const msg = `Quedan ${pendientes.length} bloques sin resolver:\n\n` +
    pendientes.map(b => `· ${b.time_slot} — ${b.task}`).join('\n') +
    `\n\n¿Marcarlos como postergados?`;
  if (confirm(msg)) {
    pendientes.forEach(async b => {
      b.status = 'postergado';
      await store.upsertBlock(b);
    });
    renderSemana();
  }
});

// ============================================================
// BOOT
// ============================================================
async function loadWeek() {
  // dedupeRecurringInList limpia duplicados viejos de bloques fijos sobre la misma
  // lista ya traída (sin fetch extra) y borra los sobrantes de la base. Tras el fix
  // de materializeRecurring no se generan nuevos, así que en régimen es un no-op.
  const blocks = await store.listBlocks(state.weekStart);
  state.blocks = await dedupeRecurringInList(blocks);
  state.urgents = await store.listUrgents(state.weekStart);
}
async function loadCatalogs() {
  state.clients = await store.listClients();
  state.projects = await store.listProjects();
  state.calendars = await store.listCalendars();
  renderAlertsBadge();
}

// Puerta de acceso (seguridad real): sin sesión válida no se toca la base.
const $gate = document.getElementById('gate');
const $gateForm = document.getElementById('gate-form');
const $gateInput = document.getElementById('gate-input');
const $gateError = document.getElementById('gate-error');
const $gateSubmit = document.getElementById('gate-submit');

function showGate() {
  $gate.hidden = false;
  $gateError.hidden = true;
  $gateInput.value = '';
  setTimeout(() => $gateInput.focus(), 50);
}

$gateForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pass = $gateInput.value;
  if (!pass) return;
  $gateSubmit.disabled = true;
  $gateSubmit.textContent = 'Entrando…';
  $gateError.hidden = true;
  try {
    await auth.signIn(pass);
    $gate.hidden = true;
    await startApp();
  } catch (err) {
    $gateError.textContent = err.message || 'No se pudo entrar.';
    $gateError.hidden = false;
  } finally {
    $gateSubmit.disabled = false;
    $gateSubmit.textContent = 'Entrar';
  }
});

// Carga de datos + identidad. Se llama una vez que hay sesión.
async function startApp() {
  try {
    // seedIfEmpty ya materializa los recurrentes cuando la semana está vacía.
    // NO volver a llamar materializeRecurring acá: en una semana ya armada
    // revivía los bloques fijos que el usuario había borrado a propósito.
    await seedIfEmpty(state.weekStart);
    await ensureCalendarsForRelevantMonths();
    await loadCatalogs();
    await loadWeek();
  } catch (e) {
    if (e.name === 'AuthError') { showGate(); return; }
    console.error(e);
    alert('Error cargando datos: ' + (e.message || e));
    return;
  }

  // Identidad de usuario: si no hay uno guardado, mostrar onboarding y esperar.
  state.user = store.getCurrentUser();
  if (!state.user) {
    showOnboarding();
  } else {
    refreshUserChip();
    applyUserGating();
    renderSemana();
    renderAlertsBadge();
  }
}

(async function init() {
  await auth.ensureValid();
  if (!auth.hasSession()) {
    showGate();
    return;
  }
  await startApp();
})();
