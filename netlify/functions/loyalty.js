/* ════════════════════════════════════════════════════════════════
Bahía Padel · /.netlify/functions/loyalty
Módulo de PREMIOS por recurrencia + CAMPAÑAS de reactivación.

· Reutiliza las mismas variables de entorno que kv.js:
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
    APP_ACCESS_CODE  y/o  ACCESS_CODES ("david:xxx,sary:yyy")
· Autentica con el MISMO código de staff que la app (solo staff).
· SOLO LEE las reservas (claves cancha:* de la tabla kv). No las modifica.
· Escribe únicamente en premios_entregados y campanas_reactivacion.
· Todo el tiempo se calcula en America/Bogotá (UTC-5 fijo, sin horario de verano).
──────────────────────────────────────────────────────────────── */

const crypto = require("crypto");

const URL_BASE   = process.env.SUPABASE_URL;
const SERVICE_KEY= process.env.SUPABASE_SERVICE_ROLE_KEY;

/* ── Autenticación (staff) ── */
function cargarCodigos() {
  const set = new Set();
  if (process.env.ACCESS_CODES) {
    for (const par of process.env.ACCESS_CODES.split(",")) {
      const i = par.indexOf(":");
      if (i > 0) { const c = par.slice(i + 1).trim(); if (c) set.add(c); }
    }
  }
  if (process.env.APP_ACCESS_CODE) set.add(String(process.env.APP_ACCESS_CODE).trim());
  return set;
}
const CODES = cargarCodigos();
function igualSeguro(a, b) {
  const ha = crypto.createHash("sha256").update(String(a || "")).digest();
  const hb = crypto.createHash("sha256").update(String(b || "")).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function codigoValido(code) {
  if (!code) return false;
  let ok = false;
  for (const real of CODES) { if (igualSeguro(code, real)) ok = true; } // sin cortocircuito
  return ok;
}

/* ── Zona horaria Bogotá (UTC-5 fijo) ── */
const BOGOTA_MS = 5 * 3600 * 1000;
function hoyBogota() { return new Date(Date.now() - BOGOTA_MS); }          // Date "corrido" a Bogotá
function ymd(d)      { return d.toISOString().slice(0, 10); }              // 'AAAA-MM-DD' en pared Bogotá
function mesDe(dateStr) { return String(dateStr || "").slice(0, 7); }      // 'AAAA-MM'
function diasEntre(aStr, bStr) {                                           // b - a en días (fechas Y-M-D)
  const a = new Date(aStr + "T00:00:00Z"), b = new Date(bStr + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}
function sumaMeses(mesStr, delta) {                                        // 'AAAA-MM' + delta meses
  let [y, m] = mesStr.split("-").map(Number); m += delta;
  y += Math.floor((m - 1) / 12); m = ((m - 1) % 12 + 12) % 12 + 1;
  return y + "-" + String(m).padStart(2, "0");
}
function ultimoDiaMes(mesStr) {
  const [y, m] = mesStr.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0)); return ymd(d);
}

/* ── Teléfono normalizado (mismo criterio que la app + saneo) ── */
function normPhone(x) {
  let d = String(x == null ? "" : x).replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 10 && d[0] === "3") d = "57" + d;
  if (!d || /^(\d)\1+$/.test(d) || /0{7,}/.test(d) || d.length < 8 || d.length > 15) return null;
  return d;
}

/* ── Catálogo de hitos → premios ── */
const HITOS = [
  { n: 2,  premio: "Botella de agua" },
  { n: 4,  premio: "Coca-Cola" },
  { n: 7,  premio: "½ tarro de bolas" },
  { n: 9,  premio: "¼ de cancha en hora valle" },
  { n: 11, premio: "¼ de cancha gratis" },
  { n: 13, premio: "½ cancha gratis en hora valle" },
];

/* ════════════════ Lógica pura (testeable sin red) ════════════════ */

/* Extrae reservas USADAS de cancha de un mapa de documentos cancha:<fecha> -> objeto.
   `hoy` = 'AAAA-MM-DD' Bogotá. Solo cuentan fechas < hoy (jugadas), bookingType cancha
   y con teléfono. Dedup por groupId. Devuelve [{phone,name,fecha,price,groupId}]. */
function reservasUsadas(docsPorFecha, hoy) {
  const out = [];
  const vistos = new Set();
  for (const fecha of Object.keys(docsPorFecha)) {
    if (!(fecha < hoy)) continue;                        // futura o de hoy = aún no usada
    const dia = docsPorFecha[fecha] || {};
    for (const slotKey of Object.keys(dia)) {
      const b = dia[slotKey];
      if (!b) continue;
      if ((b.bookingType || "cancha") !== "cancha") continue;
      const phone = normPhone(b.phone);
      if (!phone) continue;
      const gid = b.groupId || (fecha + "|" + slotKey);
      if (vistos.has(gid)) continue;
      vistos.add(gid);
      out.push({ phone, name: b.name || "", fecha, price: Number(b.price) || 0, groupId: gid });
    }
  }
  return out;
}

/* Cuenta por teléfono dentro de un mes concreto. */
function conteoDelMes(usadas, mes) {
  const map = new Map();
  for (const r of usadas) {
    if (mesDe(r.fecha) !== mes) continue;
    map.set(r.phone, (map.get(r.phone) || 0) + 1);
  }
  return map; // phone -> n
}

/* Hitos alcanzados dado un conteo n. */
function hitosAlcanzados(n) { return HITOS.filter(h => h.n <= n); }

/* Agregados históricos por teléfono (para campañas): última fecha jugada,
   total de reservas usadas, facturación (suma de price), y un nombre. */
function statsPorCliente(usadas) {
  const m = new Map();
  for (const r of usadas) {
    let s = m.get(r.phone);
    if (!s) { s = { phone: r.phone, nombre: r.name, ultima: r.fecha, total: 0, facturacion: 0 }; m.set(r.phone, s); }
    s.total += 1; s.facturacion += r.price;
    if (r.fecha > s.ultima) { s.ultima = r.fecha; s.nombre = r.name || s.nombre; }
  }
  return m;
}

/* ════════════════ Acceso a Supabase (PostgREST) ════════════════ */
function headers(extra) {
  return Object.assign({ apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY,
    "Content-Type": "application/json" }, extra || {});
}
function rest(path) { return URL_BASE.replace(/\/+$/, "") + "/rest/v1/" + path; }

async function kvGet(key) {
  const r = await fetch(rest("kv?select=key,value&key=eq." + encodeURIComponent(key)), { headers: headers() });
  if (!r.ok) throw new Error("kvGet: " + await r.text());
  const f = await r.json(); return f.length ? f[0].value : null;
}
async function kvSet(key, value) {
  const r = await fetch(rest("kv"), { method: "POST",
    headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ key, value }) });
  if (!r.ok) throw new Error("kvSet: " + await r.text());
}
/* Trae documentos cancha:<prefijo>%  ->  { 'AAAA-MM-DD': objeto } */
async function traerCancha(prefijo) {
  const r = await fetch(rest("kv?select=key,value&key=like." + encodeURIComponent("cancha:" + prefijo + "%")),
    { headers: headers() });
  if (!r.ok) throw new Error("traerCancha: " + await r.text());
  const filas = await r.json();
  const docs = {};
  for (const f of filas) {
    const fecha = f.key.slice("cancha:".length);
    try { docs[fecha] = JSON.parse(f.value); } catch (_) { docs[fecha] = {}; }
  }
  return docs;
}

async function selectPremios(qs) {
  const r = await fetch(rest("premios_entregados?" + qs), { headers: headers() });
  if (!r.ok) throw new Error("selectPremios: " + await r.text());
  return r.json();
}
async function insertPremios(filas) {
  if (!filas.length) return [];
  const r = await fetch(rest("premios_entregados?on_conflict=cliente_id,mes,hito"), { method: "POST",
    headers: headers({ Prefer: "resolution=ignore-duplicates,return=representation" }),
    body: JSON.stringify(filas) });
  if (!r.ok) throw new Error("insertPremios: " + await r.text());
  return r.json();
}
async function patchPremios(qs, body) {
  const r = await fetch(rest("premios_entregados?" + qs), { method: "PATCH",
    headers: headers({ Prefer: "return=representation" }), body: JSON.stringify(body) });
  if (!r.ok) throw new Error("patchPremios: " + await r.text());
  return r.json();
}
async function selectCampanas(qs) {
  const r = await fetch(rest("campanas_reactivacion?" + qs), { headers: headers() });
  if (!r.ok) throw new Error("selectCampanas: " + await r.text());
  return r.json();
}
async function upsertCampanas(filas) {
  if (!filas.length) return [];
  const r = await fetch(rest("campanas_reactivacion?on_conflict=cliente_id,campana"), { method: "POST",
    headers: headers({ Prefer: "resolution=merge-duplicates,return=representation" }),
    body: JSON.stringify(filas) });
  if (!r.ok) throw new Error("upsertCampanas: " + await r.text());
  return r.json();
}
async function patchCampanas(qs, body) {
  const r = await fetch(rest("campanas_reactivacion?" + qs), { method: "PATCH",
    headers: headers({ Prefer: "return=representation" }), body: JSON.stringify(body) });
  if (!r.ok) throw new Error("patchCampanas: " + await r.text());
  return r.json();
}

/* ════════════════ Casos de uso ════════════════ */

/* Emite los premios de un mes para un cliente (o todos). Idempotente. */
async function premiosRecompute(mes, clienteId) {
  const hoy = ymd(hoyBogota());
  mes = mes || mesDe(hoy);
  const docs = await traerCancha(mes);                         // solo ese mes
  const usadas = reservasUsadas(docs, hoy);
  const conteo = conteoDelMes(usadas, mes);

  const objetivo = clienteId ? [clienteId] : [...conteo.keys()];
  const nuevos = [];
  for (const phone of objetivo) {
    const n = conteo.get(phone) || 0;
    const alcanzados = hitosAlcanzados(n);
    if (!alcanzados.length) continue;
    const yaTiene = new Set((await selectPremios(
      "select=hito&cliente_id=eq." + encodeURIComponent(phone) + "&mes=eq." + mes)).map(x => x.hito));
    // secuencia del código dentro del mes
    let seq = (await selectPremios("select=id&mes=eq." + mes)).length;
    for (const h of alcanzados) {
      if (yaTiene.has(h.n)) continue;
      seq += 1;
      nuevos.push({
        cliente_id: phone, mes, hito: h.n, premio: h.premio,
        codigo_unico: mes.replace("-", "") + "-" + String(seq).padStart(4, "0"),
        estado: "emitido", avisado: false,
      });
    }
  }
  const insertados = await insertPremios(nuevos);
  return { mes, clientes: objetivo.length, emitidos_nuevos: insertados.length };
}

/* Premios ganados aún no avisados (para adjuntar a la próxima confirmación). */
async function premiosPendienteAviso(clienteId) {
  return selectPremios("select=*&cliente_id=eq." + encodeURIComponent(clienteId) +
    "&estado=eq.emitido&avisado=eq.false&order=hito.asc");
}
async function premiosMarcarAvisado(codigo) {
  return patchPremios("codigo_unico=eq." + encodeURIComponent(codigo), { avisado: true });
}
async function premiosBuscar(codigo) {
  const f = await selectPremios("select=*&codigo_unico=eq." + encodeURIComponent(codigo));
  return f.length ? f[0] : null;
}
async function premiosCanjear(codigo, usuario) {
  const p = await premiosBuscar(codigo);
  if (!p) return { ok: false, error: "Código no encontrado" };
  if (p.estado === "canjeado") return { ok: false, error: "Ya fue canjeado", premio: p };
  if (p.estado === "vencido")  return { ok: false, error: "Premio vencido", premio: p };
  const upd = await patchPremios("codigo_unico=eq." + encodeURIComponent(codigo) + "&estado=eq.emitido",
    { estado: "canjeado", fecha_canje: new Date().toISOString(), usuario_canje: usuario || "staff" });
  return { ok: true, premio: upd[0] || p };
}
/* Marca vencidos los 'emitido' de meses ya cerrados. */
async function premiosExpirar() {
  const mesActual = mesDe(ymd(hoyBogota()));
  const upd = await patchPremios("estado=eq.emitido&mes=lt." + mesActual, { estado: "vencido" });
  return { vencidos: upd.length };
}
async function premiosReporte(mes) {
  const filas = await selectPremios("select=hito,premio,estado&mes=eq." + mes);
  const costos = JSON.parse((await kvGet("premio-costos")) || "{}");
  const r = { mes, emitidos: 0, canjeados: 0, vencidos: 0, por_hito: {}, costo_estimado: 0 };
  const mesActual = mesDe(ymd(hoyBogota()));
  for (const f of filas) {
    let est = f.estado;
    if (est === "emitido" && mes < mesActual) est = "vencido"; // vencimiento lazy en la vista
    if (est === "emitido") r.emitidos++; else if (est === "canjeado") r.canjeados++; else r.vencidos++;
    const k = String(f.hito);
    r.por_hito[k] = r.por_hito[k] || { premio: f.premio, emitidos: 0, canjeados: 0, vencidos: 0 };
    r.por_hito[k][est === "emitido" ? "emitidos" : est === "canjeado" ? "canjeados" : "vencidos"]++;
    r.costo_estimado += Number(costos[k] || 0);
  }
  return r;
}

/* ── Campañas ── */
async function statsHistoricos() {
  const docs = await traerCancha("");                 // TODO el histórico
  const hoy = ymd(hoyBogota());
  const usadas = reservasUsadas(docs, hoy);
  const m = statsPorCliente(usadas);
  const arr = [...m.values()];
  try { await kvSet("cliente-stats-cache", JSON.stringify({ generado: hoy, clientes: arr })); } catch (_) {}
  return { hoy, arr };
}
async function campanaGenerar(campana) {
  const { hoy, arr } = await statsHistoricos();
  const limite3m = sumaMeses(mesDe(hoy), -3) + "-01";
  // mensajes enviados por cliente en los últimos 3 meses
  const enviadosRec = await selectCampanas(
    "select=cliente_id&enviado=eq.true&fecha_envio=gte." + limite3m);
  const conteoMsg = {};
  for (const e of enviadosRec) conteoMsg[e.cliente_id] = (conteoMsg[e.cliente_id] || 0) + 1;

  const candidatos = arr.filter(s =>
    diasEntre(s.ultima, hoy) > 20 &&                   // +20 días sin jugar
    s.total >= 2 &&                                    // ≥2 jugadas históricas
    (conteoMsg[s.phone] || 0) <= 1                     // ≤1 mensaje en 3 meses
  ).sort((a, b) => b.facturacion - a.facturacion);      // orden por facturación

  const filas = candidatos.map(s => ({
    cliente_id: s.phone, campana, enviado: false,
    nombre: s.nombre, telefono: s.phone,
    dias_sin_jugar: diasEntre(s.ultima, hoy),
    total_reservas: s.total, facturacion_historica: s.facturacion,
  }));
  await upsertCampanas(filas);
  return { campana, candidatos: filas.length };
}
async function campanaLista(campana) {
  return selectCampanas("select=*&campana=eq." + encodeURIComponent(campana) +
    "&order=facturacion_historica.desc");
}
async function campanaMarcarEnviado(clienteId, campana) {
  return patchCampanas("cliente_id=eq." + encodeURIComponent(clienteId) + "&campana=eq." + encodeURIComponent(campana),
    { enviado: true, fecha_envio: new Date().toISOString() });
}
async function plantillaGet(campana) {
  return (await kvGet("campana:" + campana + ":plantilla")) ||
         (await kvGet("campana-plantilla-default")) || "";
}
async function plantillaSet(campana, texto) {
  await kvSet("campana:" + campana + ":plantilla", String(texto || "")); return { ok: true };
}
async function campanaReporte(campana) {
  const filas = await selectCampanas("select=*&campana=eq." + encodeURIComponent(campana) + "&enviado=eq.true");
  const hoy = ymd(hoyBogota());
  const docs = await traerCancha("");
  const usadas = reservasUsadas(docs, hoy);
  let enviados = 0, reservaron = 0, facturacion = 0;
  const actualizaciones = [];
  for (const f of filas) {
    enviados++;
    if (!f.fecha_envio) continue;
    const desde = f.fecha_envio.slice(0, 10);
    const hasta = ymd(new Date(new Date(desde + "T00:00:00Z").getTime() + 14 * 86400000));
    const jugadas = usadas.filter(r => r.phone === f.cliente_id && r.fecha >= desde && r.fecha <= hasta);
    if (jugadas.length) {
      reservaron++;
      const fact = jugadas.reduce((a, r) => a + r.price, 0);
      facturacion += fact;
      const primera = jugadas.map(r => r.fecha).sort()[0];
      if (!f.reservo_despues || f.fecha_reserva_posterior !== primera) {
        actualizaciones.push({ id: f.id, primera });
      }
    }
  }
  for (const u of actualizaciones) {
    await patchCampanas("id=eq." + u.id, { reservo_despues: true, fecha_reserva_posterior: u.primera });
  }
  return { campana, enviados, reservaron, facturacion };
}

/* ════════════════ Handler HTTP ════════════════ */
exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return resp(405, { error: "Método no permitido" });
  if (!URL_BASE || !SERVICE_KEY || CODES.size === 0)
    return resp(500, { error: "Faltan variables de entorno" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (_) { return resp(400, { error: "JSON inválido" }); }
  if (!codigoValido(body.code)) return resp(401, { error: "Código incorrecto" });

  try {
    const a = body.action;
    if (a === "auth")                     return resp(200, { ok: true });
    if (a === "premios.recompute")        return resp(200, await premiosRecompute(body.mes, body.cliente_id ? normPhone(body.cliente_id) : null));
    if (a === "premios.pendiente_aviso")  return resp(200, { premios: await premiosPendienteAviso(normPhone(body.cliente_id)) });
    if (a === "premios.marcar_avisado")   return resp(200, { premios: await premiosMarcarAvisado(body.codigo_unico) });
    if (a === "premios.buscar")           return resp(200, { premio: await premiosBuscar(body.codigo_unico) });
    if (a === "premios.canjear")          return resp(200, await premiosCanjear(body.codigo_unico, body.usuario_canje));
    if (a === "premios.expirar")          return resp(200, await premiosExpirar());
    if (a === "premios.reporte")          return resp(200, await premiosReporte(body.mes || mesDe(ymd(hoyBogota()))));
    if (a === "campanas.generar")         return resp(200, await campanaGenerar(body.campana));
    if (a === "campanas.lista")           return resp(200, { filas: await campanaLista(body.campana) });
    if (a === "campanas.marcar_enviado")  return resp(200, { filas: await campanaMarcarEnviado(normPhone(body.cliente_id), body.campana) });
    if (a === "campanas.plantilla_get")   return resp(200, { texto: await plantillaGet(body.campana) });
    if (a === "campanas.plantilla_set")   return resp(200, await plantillaSet(body.campana, body.texto));
    if (a === "campanas.reporte")         return resp(200, await campanaReporte(body.campana));
    return resp(400, { error: "Acción desconocida" });
  } catch (e) {
    return resp(500, { error: "Error interno: " + e.message });
  }
};
function resp(status, obj) {
  return { statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj) };
}

/* Exporta helpers puros para el script de prueba (no afecta a Netlify). */
if (typeof module !== "undefined") {
  module.exports.__test = { normPhone, reservasUsadas, conteoDelMes, hitosAlcanzados,
    statsPorCliente, diasEntre, mesDe, HITOS };
  /* Jobs internos para el cron (server-to-server, sin auth de usuario). */
  module.exports.__jobs = { premiosRecompute, premiosExpirar };
}
