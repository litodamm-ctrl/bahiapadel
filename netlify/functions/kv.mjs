// =====================================================================
//  Bahía Padel — Función-proxy segura entre la app y Supabase
//  (Netlify Functions v2)
//
//  Qué hace:
//   - Guarda las llaves de Supabase en el SERVIDOR (nunca en el navegador).
//   - Exige el código de acceso del club en CADA petición.
//   - Habla con Supabase usando la llave secreta "service_role".
//
//  Variables de entorno que debes configurar en Netlify
//  (Site settings -> Environment variables), con alcance "Functions":
//    SUPABASE_URL                = https://xxxxxxxx.supabase.co
//    SUPABASE_SERVICE_ROLE_KEY   = (llave service_role de Supabase)
//    APP_ACCESS_CODE             = el código que escribirá el staff al entrar
// =====================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ACCESS_CODE  = process.env.APP_ACCESS_CODE;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  if (!SUPABASE_URL || !SERVICE_KEY || !ACCESS_CODE) {
    // Falta configurar las variables de entorno en Netlify.
    return json({ error: "server_not_configured" }, 500);
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const { op, key, value, accessCode } = payload || {};

  // --- Puerta de seguridad: el código de acceso se valida aquí, en el
  //     servidor. Si es incorrecto, no se toca la base de datos. ---
  if (typeof accessCode !== "string" || accessCode !== ACCESS_CODE) {
    return json({ error: "unauthorized" }, 401);
  }

  // "ping": sólo sirve para validar el código en la pantalla de entrada.
  if (op === "ping") return json({ ok: true });

  if (typeof key !== "string" || !key) return json({ error: "missing_key" }, 400);

  const base = `${SUPABASE_URL}/rest/v1/kv_store`;
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "content-type": "application/json",
  };

  try {
    if (op === "get") {
      const res = await fetch(
        `${base}?key=eq.${encodeURIComponent(key)}&select=value`,
        { headers }
      );
      if (!res.ok) return json({ error: "db_error", detail: await res.text() }, 502);
      const rows = await res.json();
      return json({ value: rows.length ? rows[0].value : null });
    }

    if (op === "set") {
      if (typeof value !== "string") return json({ error: "missing_value" }, 400);
      const res = await fetch(base, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
      });
      if (!res.ok) return json({ error: "db_error", detail: await res.text() }, 502);
      return json({ ok: true });
    }

    if (op === "delete") {
      const res = await fetch(`${base}?key=eq.${encodeURIComponent(key)}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) return json({ error: "db_error", detail: await res.text() }, 502);
      return json({ ok: true });
    }

    return json({ error: "unknown_op" }, 400);
  } catch (e) {
    return json({ error: "proxy_error", detail: String(e) }, 500);
  }
};
