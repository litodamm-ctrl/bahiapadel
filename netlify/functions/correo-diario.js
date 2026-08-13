/* ════════════════════════════════════════════════════════════════
   Bahía Padel · /.netlify/functions/correo-diario
   Correo AUTOMÁTICO al día siguiente de cada reserva jugada.
   Incluye: resumen del partido + video (código + enlace a padelreplay)
   + estado de premiación (visitas del mes y próximo premio) + reactivación.

   · Corre server-to-server como Scheduled Function (ver netlify.toml).
   · Reutiliza las MISMAS variables de entorno que kv.js / loyalty.js:
       SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
   · Variables NUEVAS que debes crear en Netlify:
       RESEND_API_KEY   → tu API key de Resend
       MAIL_FROM        → remitente verificado, ej: "Bahía Padel <hola@tudominio.com>"
       MAIL_REPLY_TO    → (opcional) correo de respuestas, ej: reservas@tudominio.com
   · SOLO LEE las reservas (cancha:* en la tabla kv). Escribe un marcador
     "mailsent:*" en kv para no enviar dos veces el mismo correo.
   · Todo el tiempo se calcula en America/Bogotá (UTC-5 fijo).
──────────────────────────────────────────────────────────────── */

const URL_BASE   = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM  = process.env.MAIL_FROM || "Bahía Padel <onboarding@resend.dev>";
const MAIL_REPLY = process.env.MAIL_REPLY_TO || "";

const REPLAY_URL = "https://padelreplay.netlify.app/"; // ?codigo=BP-XXXXXX
const WEB_URL    = process.env.WEB_URL || "https://bahiapadel.com";     // web del club
// Canal de reservas de CLIENTES = WhatsApp del club (padelmanager es interno).
// Configura WHATSAPP_NUMBER (solo dígitos, con indicativo: 57XXXXXXXXXX).
const WA_NUMBER  = process.env.WHATSAPP_NUMBER || "573233884528";
const WA_TEXT    = "Hola, quiero reservar en Bahía Padel 🎾";
const BOOK_URL   = process.env.BOOK_URL || ("https://wa.me/" + WA_NUMBER + "?text=" + encodeURIComponent(WA_TEXT));

/* ── Zona horaria Bogotá (UTC-5 fijo) ── */
const BOGOTA_MS = 5 * 3600 * 1000;
function ahoraBogota() { return new Date(Date.now() - BOGOTA_MS); }
function ymd(d) { return d.toISOString().slice(0, 10); }              // 'AAAA-MM-DD'
function mesDe(s) { return String(s || "").slice(0, 7); }             // 'AAAA-MM'

/* ── Teléfono normalizado (mismo criterio que la app) ── */
function normPhone(x) {
  let d = String(x == null ? "" : x).replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 10 && d[0] === "3") d = "57" + d;
  if (!d || /^(\d)\1+$/.test(d) || /0{7,}/.test(d) || d.length < 8 || d.length > 15) return null;
  return d;
}
function emailValido(e) {
  return typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
}

/* ── Catálogo de hitos → premios (idéntico a loyalty.js) ── */
const HITOS = [
  { n: 2,  premio: "Botella de agua" },
  { n: 4,  premio: "Coca-Cola" },
  { n: 7,  premio: "½ tarro de bolas" },
  { n: 9,  premio: "¼ de cancha en hora valle" },
  { n: 11, premio: "¼ de cancha gratis" },
  { n: 13, premio: "½ cancha gratis en hora valle" },
];

/* ── Formato de dinero COP ── */
function formatCOP(n) {
  const v = Math.round(Number(n) || 0);
  return "$" + v.toLocaleString("es-CO");
}
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* ════════════════ Acceso a Supabase (PostgREST) ════════════════ */
function headers(extra) {
  return Object.assign({
    apikey: SERVICE_KEY,
    Authorization: "Bearer " + SERVICE_KEY,
    "Content-Type": "application/json",
  }, extra || {});
}
function rest(path) { return URL_BASE.replace(/\/+$/, "") + "/rest/v1/" + path; }

async function kvGet(key) {
  const r = await fetch(rest("kv?select=key,value&key=eq." + encodeURIComponent(key)), { headers: headers() });
  if (!r.ok) throw new Error("kvGet: " + await r.text());
  const f = await r.json();
  if (!f.length) return null;
  try { return JSON.parse(f[0].value); } catch (_) { return f[0].value; }
}
async function kvSet(key, value) {
  const r = await fetch(rest("kv"), {
    method: "POST",
    headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ key, value: JSON.stringify(value) }),
  });
  if (!r.ok) throw new Error("kvSet: " + await r.text());
}
/* Trae todos los documentos cancha:<prefijo>% -> { 'AAAA-MM-DD': objeto } */
async function traerCancha(prefijo) {
  const r = await fetch(rest("kv?select=key,value&key=like." + encodeURIComponent("cancha:" + prefijo + "%")), { headers: headers() });
  if (!r.ok) throw new Error("traerCancha: " + await r.text());
  const filas = await r.json();
  const docs = {};
  for (const f of filas) {
    const fecha = f.key.slice("cancha:".length);
    try { docs[fecha] = JSON.parse(f.value); } catch (_) { docs[fecha] = {}; }
  }
  return docs;
}

/* ════════════════ Premiación: conteo del mes por teléfono ════════════════
   Cuenta reservas de CANCHA ya jugadas (fecha < hoy) del mes, dedup por groupId. */
function conteoCanchaDelMes(docsMes, hoyStr) {
  const map = new Map();     // phone -> nº de canchas jugadas en el mes
  const vistos = new Set();
  for (const fecha of Object.keys(docsMes)) {
    if (!(fecha < hoyStr)) continue;               // hoy o futuro = aún no jugada
    const dia = docsMes[fecha] || {};
    for (const slotKey of Object.keys(dia)) {
      const b = dia[slotKey];
      if (!b) continue;
      if ((b.bookingType || "cancha") !== "cancha") continue;
      const phone = normPhone(b.phone);
      if (!phone) continue;
      const gid = b.groupId || (fecha + "|" + slotKey);
      if (vistos.has(gid)) continue;
      vistos.add(gid);
      map.set(phone, (map.get(phone) || 0) + 1);
    }
  }
  return map;
}
function estadoPremios(n) {
  const alcanzados = HITOS.filter(h => h.n <= n);
  const proximo = HITOS.find(h => h.n > n) || null;
  const ultimo = alcanzados.length ? alcanzados[alcanzados.length - 1] : null;
  return { alcanzados, proximo, ultimo };
}

/* ════════════════ Reservas únicas del día (dedup por groupId) ════════════════ */
function reservasDelDia(doc) {
  const out = [];
  const vistos = new Set();
  for (const slotKey of Object.keys(doc || {})) {
    const b = doc[slotKey];
    if (!b) continue;
    const gid = b.groupId || slotKey;
    if (vistos.has(gid)) continue;
    vistos.add(gid);
    out.push(Object.assign({ _slot: slotKey, _gid: gid }, b));
  }
  return out;
}

/* ════════════════ Plantilla del correo (HTML + texto) ════════════════ */
function construirCorreo(b, fecha, prem) {
  const nombre = (b.name || "").trim().split(/\s+/)[0] || "crack";
  const esClase = (b.bookingType || "cancha") === "clase";
  const tipoTxt = esClase ? ("Clase con " + esc(b.trainer || "tu profe")) : "Reserva de cancha";
  const codigo = b.codigo_video || "";
  const linkVideo = codigo ? (REPLAY_URL + "?codigo=" + encodeURIComponent(codigo)) : REPLAY_URL;

  // Bloque premiación
  let premHtml = "";
  let premTxt = "";
  if (prem) {
    if (prem.proximo) {
      const faltan = prem.proximo.n - prem.visitas;
      premHtml =
        '<p style="margin:0 0 6px;font-size:15px;color:#0f5132;"><strong>🎾 Vas por ' + prem.visitas +
        ' ' + (prem.visitas === 1 ? "visita" : "visitas") + ' este mes.</strong></p>' +
        '<p style="margin:0;font-size:15px;color:#333;">Te falta' + (faltan === 1 ? "" : "n") + ' <strong>' + faltan + '</strong> para ganar <strong>' +
        esc(prem.proximo.premio) + '</strong>. ¡Reserva otra y reclámalo!</p>';
      premTxt = "Vas por " + prem.visitas + " visitas este mes. Te faltan " + faltan + " para ganar " + prem.proximo.premio + ".";
    } else {
      premHtml = '<p style="margin:0;font-size:15px;color:#0f5132;"><strong>🏆 ¡Máximo nivel! ' + prem.visitas +
        ' visitas este mes. Eres leyenda de Bahía Padel.</strong></p>';
      premTxt = "¡" + prem.visitas + " visitas este mes! Máximo nivel.";
    }
    if (prem.ultimo) {
      premHtml += '<p style="margin:8px 0 0;font-size:13px;color:#666;">Ya te ganaste: ' + esc(prem.ultimo.premio) + '. Reclámalo en el club.</p>';
    }
  }

  const html =
'<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;">' +
'<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 0;"><tr><td align="center">' +
'<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;">' +
  // Header
  '<tr><td style="background:#0b3d2e;padding:22px 28px;">' +
    '<span style="color:#ffffff;font-size:20px;font-weight:bold;letter-spacing:.5px;">BAHÍA PADEL</span>' +
  '</td></tr>' +
  // Saludo
  '<tr><td style="padding:28px 28px 8px;">' +
    '<h1 style="margin:0;font-size:22px;color:#0b3d2e;">¡' + esc(nombre) + ', ya está tu video! 🎬</h1>' +
    '<p style="margin:10px 0 0;font-size:15px;color:#444;line-height:1.5;">Gracias por jugar en Bahía Padel. Revive tu partido y comparte los mejores puntos.</p>' +
  '</td></tr>' +
  // Botón video
  '<tr><td align="center" style="padding:20px 28px 6px;">' +
    '<a href="' + esc(linkVideo) + '" style="display:inline-block;background:#12b76a;color:#fff;text-decoration:none;font-size:17px;font-weight:bold;padding:14px 34px;border-radius:10px;">▶ Ver mi video</a>' +
    (codigo ? '<p style="margin:12px 0 0;font-size:13px;color:#888;">Código de video: <strong style="color:#333;letter-spacing:1px;">' + esc(codigo) + '</strong></p>' : "") +
  '</td></tr>' +
  // Resumen del partido
  '<tr><td style="padding:16px 28px 4px;">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;border-radius:10px;">' +
      '<tr><td style="padding:16px 18px;font-size:14px;color:#333;line-height:1.7;">' +
        '<strong style="color:#0b3d2e;">' + tipoTxt + '</strong><br>' +
        '📅 ' + esc(fecha) + '<br>' +
        '🕐 ' + esc(b.startTime || "") + (b.endTime ? " – " + esc(b.endTime) : "") + '<br>' +
        '🎾 ' + esc(b.court || "") +
        (esClase && b.players ? '<br>👥 ' + esc(b.players) + ' jugadores' : "") +
      '</td></tr>' +
    '</table>' +
  '</td></tr>' +
  // Premiación
  (premHtml ? '<tr><td style="padding:14px 28px 4px;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#e7f7ee;border-radius:10px;"><tr><td style="padding:16px 18px;">' + premHtml + '</td></tr></table></td></tr>' : "") +
  // Reactivación / CTA próxima reserva
  '<tr><td align="center" style="padding:22px 28px 4px;">' +
    '<p style="margin:0 0 12px;font-size:15px;color:#444;">¿Listos para la revancha? Reserva tu cancha por WhatsApp:</p>' +
    '<a href="' + esc(BOOK_URL) + '" style="display:inline-block;background:#25D366;color:#0b3d2e;text-decoration:none;font-size:15px;font-weight:bold;padding:12px 28px;border-radius:10px;">Reservar por WhatsApp</a>' +
  '</td></tr>' +
  // Invitación a la web del club
  '<tr><td align="center" style="padding:8px 28px 20px;">' +
    '<p style="margin:0 0 10px;font-size:14px;color:#555;">Torneos, clases, tienda y novedades en nuestra web</p>' +
    '<a href="' + esc(WEB_URL) + '" style="display:inline-block;border:2px solid #0b3d2e;color:#0b3d2e;text-decoration:none;font-size:14px;font-weight:bold;padding:10px 26px;border-radius:10px;">Visitar bahiapadel.com →</a>' +
  '</td></tr>' +
  // Footer
  '<tr><td style="padding:22px 28px 26px;border-top:1px solid #eee;">' +
    '<p style="margin:0;font-size:12px;color:#999;line-height:1.5;">Bahía Padel · Recibes este correo porque tienes una reserva registrada con nosotros. Si no deseas recibir estos mensajes, responde con la palabra <strong>BAJA</strong>.</p>' +
  '</td></tr>' +
'</table></td></tr></table></body></html>';

  const text =
'¡' + nombre + ', ya está tu video!\n\n' +
'Gracias por jugar en Bahía Padel. Revive tu partido:\n' + linkVideo + '\n' +
(codigo ? 'Código de video: ' + codigo + '\n' : '') + '\n' +
'Tu partido:\n' + tipoTxt + '\n' + fecha + ' · ' + (b.startTime || "") + (b.endTime ? " - " + b.endTime : "") + ' · ' + (b.court || "") + '\n\n' +
(premTxt ? premTxt + '\n\n' : '') +
'¿Listos para la revancha? Reserva por WhatsApp: ' + BOOK_URL + '\n' +
'Torneos, clases y novedades en nuestra web: ' + WEB_URL + '\n\n' +
'Bahía Padel · Si no deseas recibir estos correos, responde BAJA.';

  const subject = codigo
    ? "🎬 Tu video de Bahía Padel ya está listo, " + nombre + " (" + codigo + ")"
    : "🎾 Gracias por jugar en Bahía Padel, " + nombre;

  return { subject, html, text };
}

/* ════════════════ Envío vía Resend ════════════════ */
async function enviarResend(to, correo) {
  const body = {
    from: MAIL_FROM,
    to: [to],
    subject: correo.subject,
    html: correo.html,
    text: correo.text,
  };
  if (MAIL_REPLY) body.reply_to = MAIL_REPLY;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error("Resend " + r.status + ": " + txt);
  return txt;
}

/* ════════════════════════ Handler ════════════════════════ */
exports.handler = async function () {
  const out = { fecha: null, encontradas: 0, enviados: 0, saltados: 0, sin_email: 0, errores: [] };
  try {
    if (!URL_BASE || !SERVICE_KEY) throw new Error("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    if (!RESEND_KEY) throw new Error("Falta RESEND_API_KEY");

    // Día de AYER en Bogotá
    const hoyB = ahoraBogota();
    const hoyStr = ymd(hoyB);
    const ayerB = new Date(hoyB.getTime() - 24 * 3600 * 1000);
    const ayerStr = ymd(ayerB);
    out.fecha = ayerStr;

    // Reservas de ayer
    const doc = await kvGet("cancha:" + ayerStr);
    if (!doc) return { statusCode: 200, body: JSON.stringify(Object.assign(out, { nota: "Sin reservas ese día" })) };
    const reservas = reservasDelDia(doc);
    out.encontradas = reservas.length;

    // Directorio (para recuperar email por teléfono si la reserva no lo trae)
    let dirPorTel = new Map();
    try {
      const dir = await kvGet("clientes-directorio");
      if (Array.isArray(dir)) for (const c of dir) { const p = normPhone(c.phone); if (p && emailValido(c.email)) dirPorTel.set(p, c.email.trim()); }
    } catch (_) {}

    // Conteo de premios del mes (una sola carga)
    let conteoMes = new Map();
    try {
      const docsMes = await traerCancha(mesDe(ayerStr));
      conteoMes = conteoCanchaDelMes(docsMes, hoyStr);
    } catch (e) { out.errores.push("conteoMes: " + e.message); }

    for (const b of reservas) {
      try {
        // Email destino
        let email = emailValido(b.email) ? b.email.trim() : null;
        const phone = normPhone(b.phone);
        if (!email && phone && dirPorTel.has(phone)) email = dirPorTel.get(phone);
        if (!email) { out.sin_email++; continue; }

        // Anti-duplicado
        const marca = "mailsent:" + ayerStr + ":" + b._gid;
        const ya = await kvGet(marca);
        if (ya) { out.saltados++; continue; }

        // Premiación: se basa en las CANCHAS jugadas del mes (las clases no suman
        // premios). Se envía a cancha y a clase por igual, pero el bloque de
        // premios solo se muestra si el cliente tiene al menos 1 cancha este mes;
        // así una clase de un cliente sin canchas no muestra "0 visitas".
        let prem = null;
        if (phone && conteoMes.has(phone)) {
          const n = conteoMes.get(phone);
          if (n >= 1) {
            const est = estadoPremios(n);
            prem = { visitas: n, proximo: est.proximo, ultimo: est.ultimo };
          }
        }

        const correo = construirCorreo(b, ayerStr, prem);
        await enviarResend(email, correo);
        await kvSet(marca, { ts: Date.now(), email, codigo: b.codigo_video || null });
        out.enviados++;
      } catch (e) {
        out.errores.push((b._gid || "?") + ": " + e.message);
      }
    }

    return { statusCode: 200, body: JSON.stringify(out) };
  } catch (e) {
    out.errores.push("fatal: " + e.message);
    return { statusCode: 500, body: JSON.stringify(out) };
  }
};
