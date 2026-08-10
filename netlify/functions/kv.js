/* ────────────────────────────────────────────────────────────────
   Bahía Padel Social Club · /.netlify/functions/kv

   Única puerta entre el navegador y Supabase.
   La SUPABASE_SERVICE_ROLE_KEY vive SOLO aquí; nunca se envía al cliente.

   ── PROTOCOLO (el que ya usa index.html; NO cambió) ──
     POST JSON, campo "action":
       { action:"auth",   code }                  → valida el código de entrada
       { action:"get",    code, key }             → { key, value } | null
       { action:"set",    code, key, value }      → { ok:true }
       { action:"delete", code, key }             → { ok:true }
       { action:"list",   code, prefix }          → { keys:[...] }
       { action:"login",  code }                  → { ok:true, token } (opcional)

   ── SEGURIDAD (incorporada de SEGURIDAD.md, adaptada a este backend) ──
     1. El código se valida ANTES de tocar la base de datos.
     2. Comparación en tiempo constante (sha256 + timingSafeEqual): no filtra
        ni el valor ni la longitud del código.
     3. Códigos por-usuario opcionales (revocación individual).
     4. Rate limiting por IP: frena la fuerza bruta de códigos (solo penaliza
        los intentos FALLIDOS, para no ralentizar el uso normal).
     5. Token de sesión firmado con caducidad (opcional): permite no dejar el
        código "vivo" para siempre en el navegador. Compatible hacia atrás.
     6. Código de SOLO LECTURA para la app de videos (claves video:* únicamente).

   ── VARIABLES DE ENTORNO (Netlify → Site configuration → Environment variables,
      scope "Functions") ──
     SUPABASE_URL                (obligatoria)
     SUPABASE_SERVICE_ROLE_KEY   (obligatoria, SOLO scope Functions)
     APP_ACCESS_CODE             código único del staff (compatibilidad actual)
        —o, en su lugar/además—
     ACCESS_CODES                "david:codigo1,sary:codigo2" (uno por persona;
                                 permite revocar a una sola quitando su línea)
     APP_READ_CODE               (opcional) solo lectura para la app de videos
     SESSION_SECRET              (opcional) para el token de sesión con caducidad
     SESSION_TTL_HOURS           (opcional) horas de validez del token (def. 12)
   ──────────────────────────────────────────────────────────────── */

const crypto = require("crypto");

const URL_BASE = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ACCESS_CODE = process.env.APP_ACCESS_CODE;
const READ_CODE = process.env.APP_READ_CODE;
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const SESSION_TTL_HOURS = parseInt(process.env.SESSION_TTL_HOURS || "12", 10);

/* Mapa usuario→código a partir de ACCESS_CODES ("david:xxx,sary:yyy").
   El código único APP_ACCESS_CODE se añade como usuario "_staff". */
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

/* ── Rate limiting ── */
const RL_MAX = 10; // intentos fallidos permitidos...
const RL_WINDOW = 300; // ...cada 5 minutos
const RL_BLOCK = 900; // bloqueo de 15 min al superarlos

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

/* Comparación en tiempo constante. Se hashea cada lado para igualar longitud
   (timingSafeEqual exige buffers del mismo tamaño) y no filtrar la longitud. */
function igualSeguro(a, b) {
  const ha = crypto.createHash("sha256").update(String(a || "")).digest();
  const hb = crypto.createHash("sha256").update(String(b || "")).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* ¿El código coincide con el de algún usuario? Recorre TODOS sin cortocircuito
   para no filtrar por temporización qué usuario existe. Devuelve el usuario o null. */
function usuarioDeCodigo(code) {
  if (!code) return null;
  let encontrado = null;
  for (const [usuario, real] of CODES.entries()) {
    if (igualSeguro(code, real)) encontrado = usuario;
  }
  return encontrado;
}

/* ── Token de sesión firmado (HMAC) con caducidad ── */
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
    if (!data.exp || Date.now() > data.exp) return null; // caducado
    return data.u || "_staff";
  } catch (_) {
    return null;
  }
}

/* ── Acceso crudo a la tabla kv de Supabase (reutilizado por datos y rate-limit) ── */
function tablaKV() {
  return URL_BASE.replace(/\/+$/, "") + "/rest/v1/kv";
}
async function kvGet(key) {
  const r = await fetch(tablaKV() + "?key=eq." + encodeURIComponent(key) + "&select=key,value",
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
async function kvDel(key) {
  const r = await fetch(tablaKV() + "?key=eq." + encodeURIComponent(key),
    { method: "DELETE", headers: cabecerasSupabase({ Prefer: "return=minimal" }) });
  if (!r.ok) throw new Error("Supabase: " + (await r.text()));
}

/* Estado de bloqueo por IP. Solo LEE (no penaliza el tráfico legítimo). */
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
/* Registra un intento FALLIDO y bloquea si se pasa del límite. */
async function rlFallo(ip, recPrevio) {
  const now = Math.floor(Date.now() / 1000);
  let rec = recPrevio || { count: 0, start: now, blockedUntil: 0 };
  if (now - rec.start > RL_WINDOW) rec = { count: 0, start: now, blockedUntil: 0 };
  rec.count += 1;
  if (rec.count > RL_MAX) rec.blockedUntil = now + RL_BLOCK;
  try { await kvSet("rl:" + ip, JSON.stringify(rec)); } catch (_) {}
}
/* Limpia el contador tras un acceso válido (si lo había). */
async function rlLimpiar(ip, recPrevio) {
  if (!recPrevio) return;
  try { await kvDel("rl:" + ip); } catch (_) {}
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return respuesta(405, { error: "Método no permitido" });

  if (!URL_BASE || !SERVICE_KEY || (CODES.size === 0)) {
    return respuesta(500, { error: "Faltan variables de entorno en Netlify" });
  }

  // IP del cliente (Netlify la pone en estas cabeceras).
  const h = event.headers || {};
  const ip = (h["x-nf-client-connection-ip"] || h["client-ip"] ||
    (h["x-forwarded-for"] || "").split(",")[0] || "unknown").trim();

  // ── Rate limit: primero solo comprobamos si esta IP está bloqueada. ──
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
  // Acepta token de sesión (preferido) O código (compatibilidad con el cliente actual).
  let usuario = verificarToken(token);
  if (!usuario) usuario = usuarioDeCodigo(code);
  const esAdmin = !!usuario;
  const esLectura = !esAdmin && READ_CODE ? igualSeguro(code, READ_CODE) : false;

  if (!esAdmin && !esLectura) {
    await rlFallo(ip, rl.rec); // credencial inválida → cuenta como intento fallido
    return respuesta(401, { error: "Código incorrecto" });
  }

  // Acceso válido → no penalizar; limpiar el contador si existía.
  await rlLimpiar(ip, rl.rec);

  if (action === "auth") return respuesta(200, { ok: true, modo: esAdmin ? "admin" : "lectura" });
  if (action === "login") {
    const t = esAdmin ? firmarToken(usuario) : null;
    return respuesta(200, { ok: true, token: t, ttlHours: SESSION_TTL_HOURS });
  }

  // El código de la app de videos es de SOLO LECTURA y solo sobre claves video:*
  if (!esAdmin) {
    if (action !== "get" && action !== "list") {
      return respuesta(403, { error: "Código de solo lectura: solo get/list" });
    }
    const objetivo = action === "list" ? String(prefix || "") : String(key || "");
    if (objetivo.indexOf("video:") !== 0) {
      return respuesta(403, { error: "Código de solo lectura: solo claves video:*" });
    }
  }

  // Claves permitidas: letras, números y : . - _  (evita inyección en la query)
  if (action !== "list" && !/^[\w:.-]{1,200}$/.test(key || "")) {
    return respuesta(400, { error: "Clave inválida" });
  }

  try {
    if (action === "get") {
      const fila = await kvGet(key);
      return respuesta(200, fila ? { key: fila.key, value: fila.value } : null);
    }

    if (action === "set") {
      if (typeof value !== "string") return respuesta(400, { error: "value debe ser texto" });
      if (value.length > 5000000) return respuesta(413, { error: "Valor demasiado grande" });
      await kvSet(key, value);
      return respuesta(200, { ok: true, key });
    }

    if (action === "delete") {
      await kvDel(key);
      return respuesta(200, { ok: true, deleted: true, key });
    }

    if (action === "list") {
      const p = String(prefix || "");
      if (!/^[\w:.-]{0,200}$/.test(p)) return respuesta(400, { error: "Prefijo inválido" });
      const r = await fetch(tablaKV() + "?key=like." + encodeURIComponent(p + "%") + "&select=key",
        { headers: cabecerasSupabase() });
      if (!r.ok) return respuesta(502, { error: "Supabase: " + (await r.text()) });
      const filas = await r.json();
      return respuesta(200, { keys: filas.map(function (f) { return f.key; }), prefix: p });
    }

    return respuesta(400, { error: "Acción desconocida" });
  } catch (e) {
    return respuesta(500, { error: "Error interno: " + e.message });
  }
};
