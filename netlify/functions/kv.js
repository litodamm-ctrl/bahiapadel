/* ───────────────────────────────────────────────────────────────
   Bahía Padel Social Club · /.netlify/functions/kv

   Única puerta entre el navegador y Supabase.
   La SUPABASE_SERVICE_ROLE_KEY vive SOLO aquí; nunca se envía al cliente.

   Variables de entorno necesarias (Netlify → Site configuration → Environment variables):
     SUPABASE_URL                (ya la tienes)
     SUPABASE_SERVICE_ROLE_KEY   (ya la tienes, scoped to Functions)
     APP_ACCESS_CODE             (ya la tienes, scoped to Functions)

   Acciones (POST con JSON):
     { action:"auth",   code }                  → valida el código de entrada
     { action:"get",    code, key }             → { key, value } | null
     { action:"set",    code, key, value }      → { ok:true }
     { action:"delete", code, key }             → { ok:true }
     { action:"list",   code, prefix }          → { keys:[...] }
   ─────────────────────────────────────────────────────────────── */

const URL_BASE = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ACCESS_CODE = process.env.APP_ACCESS_CODE;

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

function respuesta(status, body) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function cabecerasSupabase(extra) {
  return Object.assign({
    apikey: SERVICE_KEY,
    Authorization: "Bearer " + SERVICE_KEY,
    "Content-Type": "application/json",
  }, extra || {});
}

/* Comparación en tiempo constante: evita adivinar el código midiendo respuestas */
function igualSeguro(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return respuesta(405, { error: "Método no permitido" });

  if (!URL_BASE || !SERVICE_KEY || !ACCESS_CODE) {
    return respuesta(500, { error: "Faltan variables de entorno en Netlify" });
  }

  let cuerpo;
  try { cuerpo = JSON.parse(event.body || "{}"); }
  catch (e) { return respuesta(400, { error: "JSON inválido" }); }

      const action = cuerpo.action || cuerpo.op, code = cuerpo.code != null ? cuerpo.code : cuerpo.accessCode, key = cuerpo.key, value = cuerpo.value, prefix = cuerpo.prefix != null ? cuerpo.prefix : cuerpo.key;

  if (!igualSeguro(code, ACCESS_CODE)) return respuesta(401, { error: "Código incorrecto" });
  if (action === "auth" || action === "ping") return respuesta(200, { ok: true });

  // Claves permitidas: letras, números y : . - _  (evita inyección en la query)
  if (action !== "list" && !/^[\w:.-]{1,200}$/.test(key || "")) {
    return respuesta(400, { error: "Clave inválida" });
  }

  const tabla = URL_BASE.replace(/\/+$/, "") + "/rest/v1/kv";

  try {
    if (action === "get") {
      const r = await fetch(tabla + "?key=eq." + encodeURIComponent(key) + "&select=key,value",
        { headers: cabecerasSupabase() });
      if (!r.ok) return respuesta(502, { error: "Supabase: " + (await r.text()) });
      const filas = await r.json();
      return respuesta(200, filas.length ? { key: filas[0].key, value: filas[0].value } : null);
    }

    if (action === "set") {
      if (typeof value !== "string") return respuesta(400, { error: "value debe ser texto" });
      if (value.length > 5000000) return respuesta(413, { error: "Valor demasiado grande" });
      const r = await fetch(tabla, {
        method: "POST",
        headers: cabecerasSupabase({ Prefer: "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify({ key, value }),
      });
      if (!r.ok) return respuesta(502, { error: "Supabase: " + (await r.text()) });
      return respuesta(200, { ok: true, key });
    }

    if (action === "delete") {
      const r = await fetch(tabla + "?key=eq." + encodeURIComponent(key),
        { method: "DELETE", headers: cabecerasSupabase({ Prefer: "return=minimal" }) });
      if (!r.ok) return respuesta(502, { error: "Supabase: " + (await r.text()) });
      return respuesta(200, { ok: true, deleted: true, key });
    }

    if (action === "list") {
      const p = String(prefix || "");
      if (!/^[\w:.-]{0,200}$/.test(p)) return respuesta(400, { error: "Prefijo inválido" });
      const r = await fetch(tabla + "?key=like." + encodeURIComponent(p + "%") + "&select=key",
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
