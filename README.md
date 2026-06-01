# Motib HUB · App interna

App web para que ella cargue su semana y vos la veas en tiempo real, sin pasar por Notion ni WhatsApp.

**Stack:** HTML + CSS + JS vanilla · Storage: **Supabase** (Postgres). Datos compartidos en tiempo (casi) real entre Ailén y Tomi.

---

## ⚠️ Único paso pendiente para que funcione

El proyecto Supabase ya está conectado (`storage.js` apunta a él). Falta correr **una** migración que agrega dos columnas:

1. Supabase → **SQL Editor** → New query.
2. Pegar el contenido de `supabase-migration-001.sql` → **Run**.

Es idempotente (se puede correr de nuevo sin romper nada). Hasta que se corra, la app va a tirar error de "column does not exist".

---

## Cómo probarla

**No** abrir con doble click (`file://` no permite Supabase ni módulos). Servirla:

```bash
npx serve "/Users/mac/Desktop/MOTIB HUB/Herramientas del equipo/motib-hub-app"
```

Abrir la URL que imprime (ej. `http://localhost:3000`). Como los datos viven en Supabase, lo que carga uno lo ve el otro al recargar.

---

## Conceptos del modelo

### 1. Semana
La grilla diaria L–V con bloques (horario · cliente · tarea · estado). Estado en 1 toque cicla: Pendiente → En curso → Hecho → Postergado → Bloqueado.

### 2. Clientes (con base)
Cada cliente tiene una ficha con:
- **Cómo trabajamos** (playbook editable): qué se hace típicamente con este cliente.
- **Ritmo** (cadence): periodicidad fija (semanal, mensual, urgencias).
- **Tareas habituales**: lista de tareas que aparecen como sugerencias al cargar un bloque del cliente.
- **Proyecto activo** si tiene uno (ej: La Crema · Brand 8 semanas).

Al cargar un bloque, elegir el cliente trae automáticamente sus tareas habituales como sugerencias en el campo "tarea". Y desde cualquier bloque podés tocar "Ver base de [Cliente]" para abrir la ficha.

### 3. Bloques recurrentes
Bloques que se repiten todas las semanas (ej: Reunión equipo Mar/Jue 8:30–9:30, almuerzos). Cuando navegás a una semana nueva vacía, se **materializan automáticamente**.

### 4. Proyectos
Procesos largos con etapas semanales y checklist (caso: Brand La Crema). Cada item tildable, semana actual destacada, progreso visible.

### 5. Urgentes
Lo que entra por WhatsApp intrasemana. Botón flotante "+ Urgente" → cliente, descripción, tiempo estimado, si desplaza algo planificado. Queda registrado por semana.

---

## Funciones del Sprint 1 (lo que está hecho)

**Pestaña "Semana":**
- Lista de bloques por día, con estado en 1 toque.
- Tap en bloque: editar (horario, cliente, tarea, nota). Cliente se elige del catálogo. Sugerencias de tarea según el cliente.
- "+ Agregar bloque" en el día activo.
- "+ Urgente" flotante.
- "Cerrar el día": postergar lo pendiente.
- Indicadores en cada día: verde (todo hecho), amarillo (pendientes), gris (sin cargar).
- "Ver base de [Cliente]" en cada bloque → abre ficha del cliente.

**Pestaña "Clientes":**
- Catálogo con los 5+1 (Motib, La Crema, FDV, Maracaibo, SPF, Interno).
- Tap → ficha completa con playbook editable, ritmo, tareas habituales, proyecto activo.

**Modo "Yo / Dueño":**
- Toggle del header. En modo Dueño es read-only: ves todo pero no editás.

---

## Supabase (ya conectado ✅)

`storage.js` ya escribe/lee de Supabase (proyecto `mbwjqxhauizsbvffvdil`) vía API REST.
Tablas creadas: `users`, `clients`, `projects`, `recurring_blocks`, `blocks`, `urgents`, `calendars`.

- **Config:** URL + anon key hardcodeadas arriba de `storage.js`. La anon key es pública por diseño (RLS protege el resto; hoy las policies están abiertas a anon — 2 personas, sin login real todavía).
- **Migración pendiente:** correr `supabase-migration-001.sql` (ver arriba).
- **Versión vieja:** `storage.localStorage.bak.js` (backup de la capa localStorage, por si hace falta volver).

---

## Hosting (URL pública para celular)

```bash
# Rápido sin cuenta:
npx serve "/Users/mac/Desktop/MOTIB HUB/Herramientas del equipo/motib-hub-app"
```

Para URL permanente:
- **Vercel** (1 min): `npm i -g vercel`, ir a la carpeta, `vercel`, seguir prompts. Queda `motib-hub.vercel.app`.
- Compartir URL → desde el celu "Agregar a pantalla de inicio" → abre como app.

---

## Roadmap

- **Sprint 2:** ✅ Swap a Supabase hecho. Pendiente: auth real (PIN ya funciona como barrera leve; falta magic link).
- **Sprint 3:** Push diario para cierre del día + push a vos cuando ella registra urgente.
- **Sprint 4:** Reportes semanales para reunión Mar/Jue (cumplimiento, % urgentes, top clientes).
- **Sprint 5:** Vista de ciclo mensual (S1 Ejecución / S2 Planning / S3 Producción / S4 Cierre).
- **Sprint 6:** Editor de bloques recurrentes desde la app (hoy se editan en código).
- **Sprint 7:** Editor de proyectos: crear/cerrar proyectos desde la app (hoy solo el Brand La Crema seedeado).

---

## Reset

Los datos ahora viven en Supabase, no en el navegador. Para resetear:
- **Borrar la sesión local** (volver a la pantalla de elegir usuario): DevTools → Consola → `localStorage.clear(); location.reload();`
- **Borrar datos reales:** Supabase → Table Editor → borrar filas, o `truncate` en SQL Editor. Al recargar, el bootstrap vuelve a sembrar clientes/proyecto/recurrentes.
