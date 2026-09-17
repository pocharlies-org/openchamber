/**
 * El panel AIOPS del ticket: quién trabaja, su equipo, qué está haciendo AHORA
 * y una conversación lateral para preguntárselo.
 *
 * Dos orígenes, a propósito:
 *
 *  1. `invoke('panel')` — el resolver de Forge, que devuelve el último latido
 *     que el host empujó. Funciona SIEMPRE, desde cualquier red, y es lo que se
 *     pinta primero: sin él, un host inalcanzable dejaría el panel en blanco.
 *  2. El host privado, directo desde este navegador (EventSource + fetch). Solo
 *     responde desde el tailnet. Es el directo y el `/btw`; si no contesta, el
 *     panel lo dice y se queda con lo de (1) en vez de fingir que no hay nada.
 *
 * Nada de lo que llega por (2) es cuerpo de conversación: la espina del host
 * emite nombres de tool, roles y contadores. Aun así todo se pinta con
 * `textContent`, nunca con `innerHTML`: lo que entra por la red no construye
 * marcado.
 */
import { invoke } from '@forge/bridge';

const $ = (id) => document.getElementById(id);

const CHIP = {
  busy: ['chip--verde', 'Trabajando'],
  idle: ['chip--azul', 'En reposo'],
  stale: ['chip--ambar', 'Sin señal'],
  missing: ['chip--gris', 'Sin sesión'],
  unknown: ['chip--gris', 'Sin datos'],
  never_reported: ['chip--gris', 'Sin datos'],
};

const hhmm = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? '--:--:--'
    : d.toLocaleTimeString([], { hour12: false });
};

const duracion = (s) => {
  if (!Number.isFinite(s)) return null;
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
};

// ── estado pintado desde el latido ──────────────────────────────────────────
const pintarLatido = (hb) => {
  const estado = hb?.state ?? 'unknown';
  const [clase, etiqueta] = CHIP[estado] ?? CHIP.unknown;
  const chip = $('estado');
  chip.className = `chip ${clase}`;
  chip.textContent = etiqueta;

  const quien = [];
  if (hb?.agent) quien.push(hb.agent);
  if (hb?.modelo) quien.push(hb.modelo);
  if (Number.isFinite(hb?.quietaS) && estado === 'idle') {
    quien.push(`quieta ${duracion(hb.quietaS)}`);
  }
  if (Number.isFinite(hb?.reanudaciones) && hb.reanudaciones > 0) {
    quien.push(`${hb.reanudaciones} reanudaciones`);
  }
  $('quien').textContent = quien.join(' · ');

  const tool = $('tool');
  tool.textContent = hb?.actividad ?? '';
  tool.classList.toggle('oculto', !hb?.actividad);

  // El «por qué» solo lo sabe el supervisor (cuota, pregunta al VP, sin hueco):
  // sin esto, una épica parada y una trabajando se ven igual de verdes.
  const motivo = $('motivo');
  const texto = [hb?.motivo, hb?.enCola ? 'en cola: aún no hay hueco' : null, hb?.ultimo]
    .filter(Boolean).join(' · ');
  motivo.textContent = texto;
  motivo.classList.toggle('oculto', !texto);

  pintarHijos(hb?.hijos ?? [], hb?.hijosTotal ?? 0, hb?.hijosActivos ?? 0);
};

const pintarHijos = (hijos, total, activos) => {
  const seccion = $('equipo');
  const lista = $('hijos');
  lista.replaceChildren();
  if (!hijos.length) {
    seccion.classList.add('oculto');
    return;
  }
  seccion.classList.remove('oculto');
  seccion.querySelector('h2').textContent =
    `Equipo de la sesión · ${activos} de ${total} activos`;
  for (const h of hijos) {
    const li = document.createElement('li');
    const rol = document.createElement('span');
    rol.className = 'rol';
    rol.textContent = h.agentType ?? 'agente';
    const encargo = document.createElement('span');
    encargo.className = 'encargo';
    encargo.textContent = h.description ?? '';
    const chip = document.createElement('span');
    chip.className = `chip ${h.activo ? 'chip--verde' : 'chip--gris'}`;
    chip.textContent = h.activo ? (h.tool ?? 'activo') : 'terminado';
    li.append(rol, encargo, chip);
    lista.append(li);
  }
};

// ── el directo ──────────────────────────────────────────────────────────────
const MAX_FEED = 200;
const FRASE = {
  tool: (e) => e.name,
  fin_tool: (e) => (e.err ? '↳ error' : '↳ ok'),
  pensando: () => 'pensando…',
  dice: (e) => `escribe ${e.n} caracteres`,
  humano: () => '— turno de una persona —',
  turno: (e) => `turno · ${e.out ?? '?'} tokens de salida`,
};

const anadirEventos = (eventos) => {
  const feed = $('feed');
  const pegado = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 4;
  for (const e of eventos) {
    const frase = FRASE[e.k];
    if (!frase) continue;
    const li = document.createElement('li');
    const hora = document.createElement('span');
    hora.className = 'hora';
    hora.textContent = hhmm(e.ts);
    const que = document.createElement('span');
    que.className = e.err ? 'que err' : 'que';
    que.textContent = frase(e);
    li.append(hora, que);
    feed.append(li);
  }
  while (feed.childElementCount > MAX_FEED) feed.firstElementChild.remove();
  // Solo se autoscrollea a quien ya estaba mirando el final: si alguien subió a
  // leer algo, el directo no se lo arranca de las manos.
  if (pegado) feed.scrollTop = feed.scrollHeight;
};

const abrirDirecto = (live) => {
  const url = new URL(`${live.base}/company-live/${live.sessionId}`);
  url.searchParams.set('sse', '1');
  url.searchParams.set('offset', '-1');
  url.searchParams.set('token', live.token);
  const es = new EventSource(url);
  let visto = false;

  es.onmessage = (ev) => {
    visto = true;
    $('vivo').textContent = 'en vivo';
    $('sin-directo').classList.add('oculto');
    try {
      anadirEventos(JSON.parse(ev.data).eventos ?? []);
    } catch { /* un tic ilegible no tumba el flujo */ }
  };
  es.addEventListener('hijos', (ev) => {
    visto = true;
    $('vivo').textContent = 'en vivo';
    $('sin-directo').classList.add('oculto');
    try {
      const d = JSON.parse(ev.data);
      pintarHijos(d.hijos ?? [], (d.hijos ?? []).length,
        (d.hijos ?? []).filter((h) => h.activo).length);
    } catch { /* idem */ }
  });
  es.onerror = () => {
    // EventSource reintenta solo. Solo se avisa si NUNCA llegó nada: un corte
    // de un segundo no tiene por qué pintarse como «no alcanzable».
    if (!visto) {
      $('vivo').textContent = 'sin directo';
      $('sin-directo').classList.remove('oculto');
    }
  };
  window.addEventListener('pagehide', () => es.close());
};

// ── la conversación lateral (/btw) ──────────────────────────────────────────
const SONDEO_MS = 3000;

const preguntar = async (live, texto) => {
  const estado = $('btw-estado');
  const boton = $('btw-enviar');
  boton.disabled = true;
  estado.textContent = 'preguntando…';

  const qs = `?token=${encodeURIComponent(live.token)}`;
  let job;
  try {
    const r = await fetch(`${live.base}/company-ask/${live.sessionId}${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: texto }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
    job = d.job;
  } catch (err) {
    estado.textContent = `no se pudo preguntar: ${err.message}`;
    boton.disabled = false;
    return;
  }

  const li = document.createElement('li');
  const p = document.createElement('p');
  p.className = 'pregunta';
  p.textContent = texto;
  const r = document.createElement('p');
  r.className = 'respuesta';
  r.textContent = '…';
  li.append(p, r);
  $('btw-hilo').prepend(li);
  $('btw-texto').value = '';

  // Una respuesta lateral tarda decenas de segundos: se sondea, no se espera.
  const tirar = async () => {
    try {
      const resp = await fetch(`${live.base}/company-ask/${job}${qs}`);
      const d = await resp.json();
      if (d.estado === 'corriendo') return setTimeout(tirar, SONDEO_MS);
      r.textContent = d.respuesta || `(${d.estado})`;
      estado.textContent = d.duracion_s ? `${d.duracion_s} s` : '';
    } catch (err) {
      r.textContent = `(se perdió la respuesta: ${err.message})`;
      estado.textContent = '';
    }
    boton.disabled = false;
    return undefined;
  };
  setTimeout(tirar, SONDEO_MS);
};

// ── arranque ────────────────────────────────────────────────────────────────
const arrancar = async () => {
  let datos;
  try {
    datos = await invoke('panel');
  } catch (err) {
    $('estado').textContent = 'No se pudo leer el estado';
    $('quien').textContent = String(err?.message ?? err);
    return;
  }
  pintarLatido(datos?.heartbeat);

  const live = datos?.live;
  if (!live?.token) {
    $('vivo').textContent = 'sin sesión';
    $('btw-abrir').disabled = true;
    return;
  }
  abrirDirecto(live);

  $('btw-abrir').addEventListener('click', () => {
    const caja = $('btw-caja');
    const abierta = !caja.classList.toggle('oculto');
    $('btw-abrir').textContent = abierta ? 'Cerrar' : 'Preguntar a esta sesión';
    if (abierta) $('btw-texto').focus();
  });
  $('btw-enviar').addEventListener('click', () => {
    const texto = $('btw-texto').value.trim();
    if (texto) preguntar(live, texto);
  });
};

arrancar();
