/* Bahía Padel · respaldo de correos de confirmación.
   Revisa las reservas de hoy y reintenta las confirmaciones que no tengan
   marcador invite:<groupId>. La función confirmacion.js ya es idempotente,
   así que ejecutarla varias veces no duplica correos enviados correctamente. */
"use strict";

const confirmacion = require("./confirmacion.js");
const EMAIL_CONFIRMATIONS_ENABLED = !/^(0|false|off|no)$/i.test(String(process.env.EMAIL_CONFIRMATIONS_ENABLED || "true").trim());

function cabecerasSupabase() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  return {
    apikey: key,
    Authorization: "Bearer " + key,
    "Content-Type": "application/json",
  };
}

function fechaBogota() {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const o = {};
  for (const p of partes) o[p.type] = p.value;
  return o.year + "-" + o.month + "-" + o.day;
}

function codigoStaff() {
  if (process.env.APP_ACCESS_CODE) return String(process.env.APP_ACCESS_CODE).trim();
  const varios = String(process.env.ACCESS_CODES || "");
  for (const par of varios.split(",")) {
    const i = par.indexOf(":");
    if (i > 0) {
      const c = par.slice(i + 1).trim();
      if (c) return c;
    }
  }
  return "";
}

async function leerDia(fecha) {
  const base = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  if (!base || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Faltan variables de Supabase");
  const key = "cancha:" + fecha;
  const url = base + "/rest/v1/kv?select=value&key=eq." + encodeURIComponent(key);
  const r = await fetch(url, { headers: cabecerasSupabase() });
  if (!r.ok) throw new Error("Supabase " + r.status + ": " + await r.text());
  const filas = await r.json();
  if (!filas.length) return {};
  try { return JSON.parse(filas[0].value || "{}"); }
  catch (_) { return {}; }
}

exports.handler = async function () {
  const fecha = fechaBogota();
  if (!EMAIL_CONFIRMATIONS_ENABLED) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ fecha, desactivado: true, mensaje: "Correos de confirmación pausados" }),
    };
  }
  const code = codigoStaff();
  if (!code) return { statusCode: 500, body: JSON.stringify({ error: "Falta código de staff" }) };

  let dia;
  try { dia = await leerDia(fecha); }
  catch (e) { return { statusCode: 500, body: JSON.stringify({ error: e.message }) }; }

  const grupos = new Map();
  for (const b of Object.values(dia || {})) {
    if (!b || typeof b !== "object" || !b.groupId || !b.email) continue;
    if (String(b.groupId).startsWith("pm-")) continue; // import histórico: no reenviar confirmaciones
    if (!grupos.has(b.groupId)) grupos.set(b.groupId, b);
  }

  const resultado = { fecha, revisadas: grupos.size, enviadas: 0, repetidas: 0, sinCorreo: 0, errores: [] };

  for (const b of grupos.values()) {
    const reserva = Object.assign({}, b, { fecha });
    try {
      const r = await confirmacion.handler({
        httpMethod: "POST",
        headers: { "x-nf-client-connection-ip": "127.0.0.1" },
        body: JSON.stringify({ action: "crear", code, reserva }),
      });
      let body = {};
      try { body = JSON.parse(r.body || "{}"); } catch (_) {}
      if (r.statusCode >= 400 || body.ok === false) {
        resultado.errores.push({ groupId: b.groupId, error: body.error || body.error_correo || ("HTTP " + r.statusCode) });
      } else if (body.correo_enviado) {
        resultado.enviadas += 1;
      } else if (body.repetido) {
        resultado.repetidas += 1;
      } else {
        resultado.sinCorreo += 1;
      }
    } catch (e) {
      resultado.errores.push({ groupId: b.groupId, error: e.message });
    }
  }

  return {
    statusCode: resultado.errores.length ? 207 : 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(resultado),
  };
};
