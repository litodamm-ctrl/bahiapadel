/* ────────────────────────────────────────────────────────────────
   Bahía Padel Social Club · /.netlify/functions/kv

   Única puerta entre el navegador y Supabase.
   La SUPABASE_SERVICE_ROLE_KEY vive SOLO aquí; nunca se envía al cliente.

   ── PROTOCOLO ──
     POST JSON, campo "action":
       { action:"auth",    code }                        → valida el código de entrada
       { action:"get",     code, key }                   → { key, value, version } | null
       { action:"set",     code, key, value }            → { ok:true }
       { action:"set",     code, key, value, ifVersion } → { ok:true, version } | 409 si otro escribió antes
       { action:"mset",    code, items:[{key,value}] }   → { ok:true, n }   (varias claves, una llamada)
       { action:"delete",  code, key }                   → { ok:true }
       { action:"list",    code, prefix }                → { keys:[...] }
       { action:"listv",   code, prefix }                → { items:[{key,value}] }  (máx. 500)
       { action:"dia.get", code, fecha }                 → { cancha, historial, heartbeat } con versiones
       { action:"login",   code }                        → { ok:true, token } (opcional)

   ── SEGURIDAD ──
     1. El código se valida ANTES de tocar la base de datos.
     2. Comparación en tiempo constante (sha256 + timingSafeEqual).
     3. Códigos por-usuario opcionales (revocación individual).
     4. Rate limiting por IP: solo penaliza los intentos FALLIDOS.
     5. Token de sesión firmado con caducidad (opcional).
     6. Código de SOLO LECTURA para la app de videos (claves video:*).
     7. Código de PEDIDOS para el worker del club: video:* (leer),
        pedido:* y worker:* (leer/escribir). Nada más.
     8. Escritura condicional por versión (ifVersion) para que dos
        recepcionistas no se pisen una reserva.

   ── VARIABLES DE ENTORNO (scope "Functions") ──
     SUPABASE_URL                (obligatoria)
     SUPABASE_SERVICE_ROLE_KEY   (obligatoria, SOLO scope Functions)
     APP_ACCESS_CODE             código único del staff
        —o, en su lugar/además—
     ACCESS_CODES                "david:codigo1,sary:codigo2"
     APP_READ_CODE               (opcional) solo lectura para la app de videos
     APP_PEDIDO_CODE             (recomendado) worker + app de videos
     ADMIN_PIN / ADMIN_PINS      PIN del Panel
     SESSION_SECRET              (opcional) token de sesión con caducidad
     SESSION_TTL_HOURS           (opcional) horas de validez del token (def. 12)
   ──────────────────────────────────────────────────────────────── */

const crypto = require("crypto");

const URL_BASE = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ACCESS_CODE = process.env.APP_ACCESS_CODE;
const READ_CODE = process.env.APP_READ_CODE;
const PEDIDO_CODE = process.env.APP_PEDIDO_CODE;
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const SESSION_TTL_HOURS = parseInt(process.env.SESSION_TTL_HOURS || "12", 10);

function cargarCodigos() {
  const map = new Map();
  if (process.env.ACCESS_CODES) {
    for (const par of process.env.ACCESS_CODES.split(",")) {
      const i = par.indexOf(":");
      if (i > 0) {
        const usuario = par.slice(0, i).trim();
        const codigo = par.slice(i + 1).trim();
        if (usuario && codigo) map.set(usuario, codigo);
      }
    }
  }
  if (ACCESS_CODE) map.set("_staff", String(ACCESS_CODE).trim());
  return map;
}
const CODES = cargarCodigos();

function cargarPins() {
  const map = new Map();
  if (process.env.ADMIN_PINS) {
    for (const par of process.env.ADMIN_PINS.split(",")) {
      const i = par.indexOf(":");
      if (i > 0) {
        const usuario = par.slice(0, i).trim();
        const pin = par.slice(i + 1).trim();
        if (usuario && pin) map.set(usuario, pin);
      }
    }
  }
  if (process.env.ADMIN_PIN) map.set("_panel", String(process.env.ADMIN_PIN).trim());
  return map;
}
const PINS = cargarPins();
const ADMIN_TTL_HOURS = parseInt(process.env.ADMIN_TTL_HOURS || "12", 10);

function usuarioDePin(pin) {
  if (!pin) return null;
  let encontrado = null;
  for (const [usuario, real] of PINS.entries()) {
    if (igualSeguro(pin, real)) encontrado = usuario;
  }
  return encontrado;
}
function firmarAdmin(usuario) {
  if (!SESSION_SECRET) return null;
  const exp = Date.now() + ADMIN_TTL_HOURS * 3600 * 1000;
  const payload = base64url(JSON.stringify({ u: usuario, exp, r: "panel" }));
  const sig = base64url(crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest());
  return payload + "." + sig;
}
function verificarAdmin(token) {
  if (!SESSION_SECRET || !token || typeof token !== "string") return null;
  const p = token.split(".");
  if (p.length !== 2) return null;
  const esperado = base64url(crypto.createHmac("sha256", SESSION_SECRET).update(p[0]).digest());
  if (!igualSeguro(p[1], esperado)) return null;
  try {
    const data = JSON.parse(Buffer.from(p[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    if (data.r !== "panel" || !data.exp || Date.now() > data.exp) return null;
    return data.u || "_panel";
  } catch (_) {
    return null;
  }
}

/* ── Rate limiting ── */
const RL_MAX = 10;
const RL_WINDOW = 300;
const RL_BLOCK = 900;

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function respuesta(status, body, extra) {
  return { statusCode: status, headers: Object.assign({}, JSON_HEADERS, extra || {}), body: JSON.stringify(body) };
}

function cabecerasSupabase(extra) {
  return Object.assign({
    apikey: SERVICE_KEY,
    Authorization: "Bearer " + SERVICE_KEY,
    "Content-Type": "application/json",
  }, extra || {});
}

function igualSeguro(a, b) {
  const ha = crypto.createHash("sha256").update(String(a || "")).digest();
  const hb = crypto.createHash("sha256").update(String(b || "")).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function usuarioDeCodigo(code) {
  if (!code) return null;
  let encontrado = null;
  for (const [usuario, real] of CODES.entries()) {
    if (igualSeguro(code, real)) encontrado = usuario;
  }
  return encontrado;
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function firmarToken(usuario) {
  if (!SESSION_SECRET) return null;
  const exp = Date.now() + SESSION_TTL_HOURS * 3600 * 1000;
  const payload = base64url(JSON.stringify({ u: usuario, exp }));
  const sig = base64url(crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest());
  return payload + "." + sig;
}
function verificarToken(token) {
  if (!SESSION_SECRET || !token || typeof token !== "string") return null;
  const p = token.split(".");
  if (p.length !== 2) return null;
  const esperado = base64url(crypto.createHmac("sha256", SESSION_SECRET).update(p[0]).digest());
  if (!igualSeguro(p[1], esperado)) return null;
  try {
    const data = JSON.parse(Buffer.from(p[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    if (!data.exp || Date.now() > data.exp) return null;
    return data.u || "_staff";
  } catch (_) {
    return null;
  }
}

/* ── Acceso crudo a la tabla kv ── */
function tablaKV() {
  return URL_BASE.replace(/\/+$/, "") + "/rest/v1/kv";
}
async function kvGet(key) {
  const r = await fetch(tablaKV() + "?key=eq." + encodeURIComponent(key) + "&select=key,value,version",
    { headers: cabecerasSupabase() });
  if (!r.ok) throw new Error("Supabase: " + (await r.text()));
  const filas = await r.json();
  return filas.length ? filas[0] : null;
}
async function kvSet(key, value) {
  const r = await fetch(tablaKV(), {
    method: "POST",
    headers: cabecerasSupabase({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ key, value }),
  });
  if (!r.ok) throw new Error("Supabase: " + (await r.text()));
}
/* Escritura condicional: solo si la versión guardada es la que el cliente leyó.
   Devuelve la versión nueva o null si alguien escribió antes (conflicto). */
async function kvSetSi(key, value, ifVersion) {
  if (ifVersion === 0) {
    // El documento no existía cuando el cliente lo leyó: insertar sin pisar.
    const r = await fetch(tablaKV(), {
      method: "POST",
      headers: cabecerasSupabase({ Prefer: "return=representation" }),
      body: JSON.stringify({ key, value }),
    });
    if (r.status === 409) return null;
    if (!r.ok) throw new Error("Supabase: " + (await r.text()));
    const filas = await r.json();
    return filas.length ? (filas[0].version || 0) : 0;
  }
  const r = await fetch(tablaKV() + "?key=eq." + encodeURIComponent(key) + "&version=eq." + ifVersion, {
    method: "PATCH",
    headers: cabecerasSupabase({ Prefer: "return=representation" }),
    body: JSON.stringify({ value }),
  });
  if (!r.ok) throw new Error("Supabase: " + (await r.text()));
  const filas = await r.json();
  if (!filas.length) return null;
  return filas[0].version;
}
async function kvMSet(items) {
  const r = await fetch(tablaKV(), {
    method: "POST",
    headers: cabecerasSupabase({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(items),
  });
  if (!r.ok) throw new Error("Supabase: " + (await r.text()));
}
async function kvDel(key) {
  const r = await fetch(tablaKV() + "?key=eq." + encodeURIComponent(key),
    { method: "DELETE", headers: cabecerasSupabase({ Prefer: "return=minimal" }) });
  if (!r.ok) throw new Error("Supabase: " + (await r.text()));
}
async function kvVarios(keys) {
  const lista = "(" + keys.map(k => '"' + k.replace(/"/g, "") + '"').join(",") + ")";
  const r = await fetch(tablaKV() + "?key=in." + encodeURIComponent(lista) + "&select=key,value,version",
    { headers: cabecerasSupabase() });
  if (!r.ok) throw new Error("Supabase: " + (await r.text()));
  return r.json();
}

/* Rate limit por IP: solo lee; penaliza únicamente fallos. */
async function rlEstado(ip) {
  const now = Math.floor(Date.now() / 1000);
  let rec = null;
  try {
    const fila = await kvGet("rl:" + ip);
    if (fila) rec = JSON.parse(fila.value);
  } catch (_) { rec = null; }
  if (rec && rec.blockedUntil && now < rec.blockedUntil) {
    return { bloqueado: true, retryAfter: rec.blockedUntil - now, rec };
  }
  return { bloqueado: false, rec };
}
async function rlFallo(ip, recPrevio) {
  const now = Math.floor(Date.now() / 1000);
  let rec = recPrevio || { count: 0, start: now, blockedUntil: 0 };
  if (now - rec.start > RL_WINDOW) rec = { count: 0, start: now, blockedUntil: 0 };
  rec.count += 1;
  if (rec.count > RL_MAX) rec.blockedUntil = now + RL_BLOCK;
  try { await kvSet("rl:" + ip, JSON.stringify(rec)); } catch (_) {}
}
async function rlLimpiar(ip, recPrevio) {
  if (!recPrevio) return;
  try { await kvDel("rl:" + ip); } catch (_) {}
}

const RE_CLAVE = /^[\w:.-]{1,200}$/;
const RE_PREFIJO = /^[\w:.-]{0,200}$/;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/* ¿Puede este rol hacer `accion` (leer|escribir) sobre `clave`? Solo para no-admin. */
function permitido(rol, accion, clave) {
  const c = String(clave || "");
  if (rol === "lectura") return accion === "leer" && c.indexOf("video:") === 0;
  if (rol === "pedido") {
    if (c.indexOf("video:") === 0) return accion === "leer";
    return c.indexOf("pedido:") === 0 || c.indexOf("worker:") === 0;
  }
  return false;
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return respuesta(405, { error: "Método no permitido" });

  if (!URL_BASE || !SERVICE_KEY || (CODES.size === 0)) {
    return respuesta(500, { error: "Faltan variables de entorno en Netlify" });
  }

  const h = event.headers || {};
  const ip = (h["x-nf-client-connection-ip"] || h["client-ip"] ||
    (h["x-forwarded-for"] || "").split(",")[0] || "unknown").trim();

  const rl = await rlEstado(ip);
  if (rl.bloqueado) {
    return respuesta(429, { error: "Demasiados intentos. Espera un momento." },
      { "Retry-After": String(rl.retryAfter) });
  }

  let cuerpo;
  try { cuerpo = JSON.parse(event.body || "{}"); }
  catch (_) { return respuesta(400, { error: "JSON inválido" }); }

  const { action, code, key, value, prefix, token } = cuerpo;

  // ── Autenticación (antes de cualquier operación de datos) ──
  let usuario = verificarToken(token);
  if (!usuario) usuario = usuarioDeCodigo(code);
  const esAdmin = !!usuario;
  const esLectura = !esAdmin && READ_CODE ? igualSeguro(code, READ_CODE) : false;
  const esPedido = !esAdmin && !esLectura && PEDIDO_CODE ? igualSeguro(code, PEDIDO_CODE) : false;
  const rol = esAdmin ? "admin" : esLectura ? "lectura" : esPedido ? "pedido" : null;

  if (!rol) {
    await rlFallo(ip, rl.rec);
    return respuesta(401, { error: "Código incorrecto" });
  }
  await rlLimpiar(ip, rl.rec);

  if (action === "auth") return respuesta(200, { ok: true, modo: rol });
  if (action === "login") {
    const t = esAdmin ? firmarToken(usuario) : null;
    return respuesta(200, { ok: true, token: t, ttlHours: SESSION_TTL_HOURS });
  }

  // ── Panel de administración ──
  if (action === "admin.login" || action === "admin.verify") {
    if (!esAdmin) return respuesta(403, { error: "Solo el staff puede abrir el panel" });

    if (action === "admin.verify") {
      const u = verificarAdmin(cuerpo.adminToken);
      return respuesta(200, u ? { ok: true, usuario: u } : { ok: false });
    }

    if (PINS.size === 0) return respuesta(500, { error: "Falta ADMIN_PIN en Netlify" });

    const rlp = await rlEstado("pin:" + ip);
    if (rlp.bloqueado) {
      return respuesta(429, { error: "Demasiados intentos de PIN. Espera un momento." },
        { "Retry-After": String(rlp.retryAfter) });
    }

    const u = usuarioDePin(cuerpo.pin);
    if (!u) {
      await rlFallo("pin:" + ip, rlp.rec);
      return respuesta(403, { error: "PIN incorrecto" });
    }
    await rlLimpiar("pin:" + ip, rlp.rec);
    return respuesta(200, { ok: true, usuario: u, adminToken: firmarAdmin(u), ttlHours: ADMIN_TTL_HOURS });
  }

  // ── Lectura de un día completo (solo staff): reservas + historial + latido del worker ──
  if (action === "dia.get") {
    if (!esAdmin) return respuesta(403, { error: "Solo el staff puede leer el día" });
    const fecha = String(cuerpo.fecha || "");
    if (!RE_FECHA.test(fecha)) return respuesta(400, { error: "Fecha inválida (AAAA-MM-DD)" });
    try {
      const filas = await kvVarios(["cancha:" + fecha, "historial:" + fecha, "worker:heartbeat"]);
      const por = {};
      for (const f of filas) por[f.key] = { value: f.value, version: f.version || 0 };
      return respuesta(200, {
        fecha,
        cancha: por["cancha:" + fecha] || null,
        historial: por["historial:" + fecha] || null,
        heartbeat: por["worker:heartbeat"] ? { value: por["worker:heartbeat"].value } : null,
      });
    } catch (e) {
      return respuesta(500, { error: "Error interno: " + e.message });
    }
  }

  // ── Permisos de los códigos acotados (no-admin) ──
  if (!esAdmin) {
    if (action === "mset") {
      const items = Array.isArray(cuerpo.items) ? cuerpo.items : [];
      for (const it of items) {
        if (!permitido(rol, "escribir", it && it.key)) return respuesta(403, { error: "Este código no puede escribir " + (it && it.key) });
      }
    } else {
      const objetivo = (action === "list" || action === "listv") ? String(prefix || "") : String(key || "");
      const accion = (action === "get" || action === "list" || action === "listv") ? "leer" : "escribir";
      if (!permitido(rol, accion, objetivo)) {
        return respuesta(403, { error: "Este código no puede " + accion + " " + (objetivo || "(sin clave)") });
      }
    }
  }

  if (action !== "list" && action !== "listv" && action !== "mset" && !RE_CLAVE.test(key || "")) {
    return respuesta(400, { error: "Clave inválida" });
  }

  try {
    if (action === "get") {
      const fila = await kvGet(key);
      return respuesta(200, fila ? { key: fila.key, value: fila.value, version: fila.version || 0 } : null);
    }

    if (action === "set") {
      if (typeof value !== "string") return respuesta(400, { error: "value debe ser texto" });
      if (value.length > 5000000) return respuesta(413, { error: "Valor demasiado grande" });
      if (typeof cuerpo.ifVersion === "number") {
        const v = await kvSetSi(key, value, cuerpo.ifVersion);
        if (v === null) return respuesta(409, { error: "Alguien más modificó este día hace un momento. Se recargó; intenta de nuevo.", conflicto: true });
        return respuesta(200, { ok: true, key, version: v });
      }
      await kvSet(key, value);
      return respuesta(200, { ok: true, key });
    }

    if (action === "mset") {
      const items = Array.isArray(cuerpo.items) ? cuerpo.items : [];
      if (!items.length || items.length > 50) return respuesta(400, { error: "items debe tener entre 1 y 50 claves" });
      for (const it of items) {
        if (!it || !RE_CLAVE.test(it.key || "")) return respuesta(400, { error: "Clave inválida: " + (it && it.key) });
        if (typeof it.value !== "string" || it.value.length > 5000000) return respuesta(400, { error: "value debe ser texto: " + it.key });
      }
      await kvMSet(items.map(it => ({ key: it.key, value: it.value })));
      return respuesta(200, { ok: true, n: items.length });
    }

    if (action === "delete") {
      await kvDel(key);
      return respuesta(200, { ok: true, deleted: true, key });
    }

    if (action === "list" || action === "listv") {
      const p = String(prefix || "");
      if (!RE_PREFIJO.test(p)) return respuesta(400, { error: "Prefijo inválido" });
      const select = action === "listv" ? "key,value" : "key";
      const r = await fetch(tablaKV() + "?key=like." + encodeURIComponent(p + "%") + "&select=" + select + "&order=key.asc&limit=500",
        { headers: cabecerasSupabase() });
      if (!r.ok) return respuesta(502, { error: "Supabase: " + (await r.text()) });
      const filas = await r.json();
      if (action === "listv") return respuesta(200, { items: filas.map(f => ({ key: f.key, value: f.value })), prefix: p });
      return respuesta(200, { keys: filas.map(f => f.key), prefix: p });
    }

    return respuesta(400, { error: "Acción desconocida" });
  } catch (e) {
    return respuesta(500, { error: "Error interno: " + e.message });
  }
};
