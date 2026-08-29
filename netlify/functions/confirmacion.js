/* ════════════════════════════════════════════════════════════════
   Bahía Padel · /.netlify/functions/confirmacion
   Confirmación INMEDIATA de una reserva:
     1. Envía un correo con la INVITACIÓN DE CALENDARIO adjunta (.ics,
        METHOD:REQUEST) → Google Calendar, Apple Calendar, Outlook y
        cualquier cliente que soporte iCalendar.
     2. Incluye además botones directos "Añadir a Google Calendar" y
        "Añadir a Outlook" por si el cliente no procesa el adjunto.
     3. Devuelve el texto listo para WhatsApp (con el enlace de calendario)
        para que la app lo abra con wa.me — sin costo ni API de Meta.

   · Autenticación: el MISMO código de staff que kv.js / loyalty.js, o el
     token de sesión firmado (SESSION_SECRET) que emite kv.js.
   · Idempotente: guarda "invite:<groupId>" en kv para no duplicar envíos y
     para poder mandar ACTUALIZACIÓN o CANCELACIÓN del mismo evento.
   · Zona horaria: America/Bogotá (UTC-5 fijo).

   ── VARIABLES DE ENTORNO ──
     Ya existentes:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
                     APP_ACCESS_CODE y/o ACCESS_CODES, SESSION_SECRET (opc.),
                     RESEND_API_KEY, MAIL_FROM, MAIL_REPLY_TO (opc.)
     Nuevas (todas opcionales, con valor por defecto):
       CLUB_NAME       "Bahía Padel Social Club"
       CLUB_ADDRESS    dirección que aparece en el evento
       CLUB_MAPS_URL   enlace a Google Maps del club
       MAIL_BCC        copia oculta al club (ej: reservas@tudominio.com)
       WEB_URL         web del club
   ──────────────────────────────────────────────────────────────── */

const crypto = require("crypto");

const URL_BASE    = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY  = process.env.RESEND_API_KEY;
const MAIL_FROM   = process.env.MAIL_FROM || "Bahía Padel <onboarding@resend.dev>";
const MAIL_REPLY  = process.env.MAIL_REPLY_TO || "";
const MAIL_BCC    = process.env.MAIL_BCC || "";

const CLUB_NAME   = process.env.CLUB_NAME || "Bahía Padel Social Club";
const CLUB_ADDR   = process.env.CLUB_ADDRESS || "Bahía Padel Social Club";
const CLUB_MAPS   = process.env.CLUB_MAPS_URL || "";
const WEB_URL     = process.env.WEB_URL || "https://bahiapadel.com";
const REPLAY_URL  = (process.env.REPLAY_URL || "https://padelreplay.netlify.app/").replace(/\/?$/, "/");
const ORGANIZER   = (MAIL_REPLY || (MAIL_FROM.match(/<([^>]+)>/) || [])[1] || "reservas@bahiapadel.com").trim();

const SESSION_SECRET = process.env.SESSION_SECRET || "";

/* ════════════════ Autenticación (idéntica a kv.js) ════════════════ */
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
function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function tokenValido(token) {
  if (!SESSION_SECRET || !token || typeof token !== "string") return false;
  const p = token.split(".");
  if (p.length !== 2) return false;
  const esperado = base64url(crypto.createHmac("sha256", SESSION_SECRET).update(p[0]).digest());
  if (!igualSeguro(p[1], esperado)) return false;
  try {
    const data = JSON.parse(Buffer.from(p[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    return !!(data.exp && Date.now() <= data.exp);
  } catch (_) { return false; }
}

/* ════════════════ Supabase (mismo patrón que loyalty.js) ════════════════ */
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

/* ════════════════ Utilidades de fecha (Bogotá = UTC-5 fijo) ════════════════ */
const BOGOTA_OFFSET_H = 5;

/* 'AAAA-MM-DD' + 'HH:MM' (hora Bogotá) → Date en UTC real */
function bogotaAUtc(fecha, hora) {
  const [y, m, d] = String(fecha).split("-").map(Number);
  const [hh, mm]  = String(hora).split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh + BOGOTA_OFFSET_H, mm, 0));
}
/* Date → 'AAAAMMDDTHHMMSSZ' (formato iCalendar / Google Calendar) */
function icsStamp(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
const DIAS  = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
function fechaLarga(fecha) {
  const [y, m, d] = String(fecha).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return DIAS[dt.getUTCDay()] + " " + d + " de " + MESES[m - 1] + " de " + y;
}

/* ════════════════ Construcción del .ics ════════════════ */
function escIcs(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}
/* Plegado de líneas a 75 octetos (RFC 5545). Trabaja sobre bytes UTF-8 para
   no partir un carácter multibyte por la mitad. */
function plegar(linea) {
  const bytes = Buffer.from(linea, "utf8");
  if (bytes.length <= 75) return linea;
  const partes = [];
  let i = 0, limite = 75;
  while (i < bytes.length) {
    let fin = Math.min(i + limite, bytes.length);
    // retrocede si cortamos en medio de un carácter multibyte
    while (fin > i && fin < bytes.length && (bytes[fin] & 0xC0) === 0x80) fin--;
    partes.push(bytes.slice(i, fin).toString("utf8"));
    i = fin;
    limite = 74; // las líneas continuadas llevan un espacio inicial
  }
  return partes.join("\r\n ");
}

function construirIcs(ev) {
  const dtStart = bogotaAUtc(ev.fecha, ev.startTime);
  const dtEnd   = bogotaAUtc(ev.fecha, ev.endTime);
  const lineas = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Bahia Padel Social Club//Reservas//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:" + (ev.metodo || "REQUEST"),
    "BEGIN:VEVENT",
    "UID:" + ev.uid,
    "SEQUENCE:" + (ev.seq || 0),
    "DTSTAMP:" + icsStamp(new Date()),
    "DTSTART:" + icsStamp(dtStart),
    "DTEND:" + icsStamp(dtEnd),
    "SUMMARY:" + escIcs(ev.titulo),
    "DESCRIPTION:" + escIcs(ev.descripcion),
    "LOCATION:" + escIcs(CLUB_ADDR),
    "ORGANIZER;CN=" + escIcs(CLUB_NAME) + ":mailto:" + ORGANIZER,
    "STATUS:" + (ev.metodo === "CANCEL" ? "CANCELLED" : "CONFIRMED"),
    "TRANSP:OPAQUE",
  ];
  if (ev.email) {
    lineas.push("ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=" +
      escIcs(ev.nombre || ev.email) + ":mailto:" + ev.email);
  }
  if (ev.metodo !== "CANCEL") {
    lineas.push(
      "BEGIN:VALARM",
      "TRIGGER:-PT2H",
      "ACTION:DISPLAY",
      "DESCRIPTION:" + escIcs("Tu reserva en " + CLUB_NAME + " es en 2 horas"),
      "END:VALARM"
    );
  }
  lineas.push("END:VEVENT", "END:VCALENDAR");
  return lineas.map(plegar).join("\r\n") + "\r\n";
}

/* ════════════════ Enlaces "añadir a calendario" ════════════════ */
function linkGoogle(ev) {
  const s = icsStamp(bogotaAUtc(ev.fecha, ev.startTime));
  const e = icsStamp(bogotaAUtc(ev.fecha, ev.endTime));
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: ev.titulo,
    dates: s + "/" + e,
    details: ev.descripcion,
    location: CLUB_ADDR,
    ctz: "America/Bogota",
  });
  return "https://calendar.google.com/calendar/render?" + p.toString();
}
function linkOutlook(ev) {
  const p = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: ev.titulo,
    startdt: bogotaAUtc(ev.fecha, ev.startTime).toISOString(),
    enddt: bogotaAUtc(ev.fecha, ev.endTime).toISOString(),
    body: ev.descripcion,
    location: CLUB_ADDR,
  });
  return "https://outlook.live.com/calendar/0/deeplink/compose?" + p.toString();
}

/* ════════════════ Textos ════════════════ */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function tituloEvento(r) {
  return (r.bookingType === "clase")
    ? "Clase de pádel con " + (r.trainer || "entrenador") + " · " + CLUB_NAME
    : "Pádel · " + CLUB_NAME + " (" + (r.court || "cancha") + ")";
}
function formatCOP(n) {
  const v = Math.round(Number(n) || 0);
  return "$" + v.toLocaleString("es-CO");
}
function etiquetaCortesia(c) {
  return c === "full" ? "Cortesía completa" : c === "quarter" ? "Cortesía 1/4" : "";
}
/* Duración legible. Usa duracionMin si la app la manda; si no, la deduce. */
function duracionTexto(r) {
  let min = Number(r.duracionMin) || 0;
  if (!min) {
    min = Math.max(0, Math.round((bogotaAUtc(r.fecha, r.endTime) - bogotaAUtc(r.fecha, r.startTime)) / 60000));
  }
  const h = Math.floor(min / 60), m = min % 60;
  return (h ? h + " h" : "") + (h && m ? " " : "") + (m ? m + " min" : "") || "-";
}
/* Línea de precio: si hay cortesía se muestra también el precio de lista. */
function precioTexto(r) {
  if (r.price === undefined || r.price === null || r.price === "") return "";
  const cort = etiquetaCortesia(r.courtesy);
  const lista = Number(r.listPrice);
  if (cort && lista && lista !== Number(r.price)) {
    return formatCOP(r.price) + " (" + cort + " · lista " + formatCOP(lista) + ")";
  }
  return formatCOP(r.price) + (cort ? " (" + cort + ")" : "");
}

function descripcionEvento(r) {
  const l = [];
  l.push(r.bookingType === "clase"
    ? "Clase con " + (r.trainer || "entrenador") + (r.players ? " · " + r.players + " jugador(es)" : "")
    : "Reserva de cancha");
  l.push((r.court || "") + " · " + r.startTime + " a " + r.endTime + " (" + duracionTexto(r) + ")");
  const pr = precioTexto(r);
  if (pr) l.push("Valor: " + pr);
  l.push("Pago en el club.");
  if (r.name) l.push("A nombre de: " + r.name);
  if (r.phone) l.push("Contacto: " + r.phone);
  if (r.comment) l.push("Nota: " + r.comment);
  if (r.codigo_video) {
    l.push("Código de video: " + r.codigo_video);
    l.push("Tu partido queda grabado en video. Cuando termine, míralo aquí: " + REPLAY_URL + "?codigo=" + r.codigo_video);
  }
  if (CLUB_MAPS) l.push("Cómo llegar: " + CLUB_MAPS);
  l.push(WEB_URL);
  return l.join("\n");
}

function fila(etiqueta, valor) {
  if (valor === "" || valor === undefined || valor === null) return "";
  return '<tr><td style="padding:3px 0;font-size:15px;color:#4B6167;white-space:nowrap;">' + etiqueta +
         '</td><td style="padding:3px 0 3px 12px;font-size:15px;color:#14282B;font-weight:600;">' + esc(valor) + '</td></tr>';
}

function correoHtml(r, ev, gcal, outlook) {
  const nombre = (r.name || "").trim().split(/\s+/)[0] || "crack";
  const esClase = r.bookingType === "clase";

  const detalle =
    fila("📅 Fecha", fechaLarga(r.fecha)) +
    fila("🕐 Hora", r.startTime + " – " + r.endTime + "  (" + duracionTexto(r) + ")") +
    fila("🎾 Cancha", r.court || "") +
    (esClase ? fila("🧑‍🏫 Entrenador", r.trainer || "") : "") +
    (esClase && r.players ? fila("👥 Jugadores", String(r.players)) : "") +
    fila("👤 A nombre de", r.name || "") +
    fila("📱 Contacto", r.phone || "") +
    fila("💵 Valor", precioTexto(r)) +
    fila("💳 Pago", "En el club") +
    fila("📝 Nota", r.comment || "") +
    fila("🎬 Código de video", r.codigo_video || "") +
    (r.codigo_video
      ? '<tr><td colspan="2" style="padding:10px 0 3px;font-size:13px;color:#4B6167;line-height:1.5;">Tu partido queda grabado en video. Cuando termine, míralo en ' +
        '<a href="' + esc(REPLAY_URL + "?codigo=" + r.codigo_video) + '" style="color:#1F9E92;font-weight:bold;">padelreplay</a>. ' +
        'El club conserva los videos 30 días; puedes pedir su borrado por WhatsApp.</td></tr>'
      : "");

  /* Bloque de premio: el mismo texto que va por WhatsApp. */
  const premio = String(r.premio_texto || "").trim();
  const premioHtml = premio
    ? '<tr><td style="padding:14px 28px 4px;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#FFF4E5;border-radius:10px;border:1px solid #FFD9A8;"><tr><td style="padding:16px 18px;font-size:15px;color:#7A4A00;line-height:1.6;">' +
      esc(premio).replace(/\n/g, "<br>") +
      '</td></tr></table></td></tr>'
    : "";

  return '<!doctype html><html><body style="margin:0;padding:0;background:#F3E9D2;font-family:Arial,Helvetica,sans-serif;">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:#F3E9D2;padding:24px 0;"><tr><td align="center">' +
    '<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:14px;overflow:hidden;">' +
    '<tr><td style="background:#0E3B43;padding:22px 28px;">' +
      '<span style="color:#fff;font-size:20px;font-weight:bold;letter-spacing:1px;">BAHÍA PADEL</span></td></tr>' +
    '<tr><td style="padding:28px 28px 6px;">' +
      '<h1 style="margin:0;font-size:22px;color:#0E3B43;">¡Listo ' + esc(nombre) + ', tu reserva está confirmada! 🎾</h1>' +
      '<p style="margin:10px 0 0;font-size:15px;color:#4B6167;line-height:1.5;">Te dejamos la invitación de calendario adjunta para que no se te pase.</p>' +
    '</td></tr>' +
    '<tr><td style="padding:16px 28px 4px;">' +
      '<table width="100%" cellpadding="0" cellspacing="0" style="background:#DCEFEC;border-radius:10px;"><tr><td style="padding:16px 18px;">' +
        '<p style="margin:0 0 10px;font-size:16px;font-weight:bold;color:#0E3B43;">' +
          esc(esClase ? "Clase con " + (r.trainer || "entrenador") : "Reserva de cancha") + '</p>' +
        '<table cellpadding="0" cellspacing="0">' + detalle + '</table>' +
      '</td></tr></table>' +
    '</td></tr>' +
    premioHtml +
    '<tr><td align="center" style="padding:22px 28px 6px;">' +
      '<p style="margin:0 0 12px;font-size:14px;color:#4B6167;">Añádelo a tu calendario:</p>' +
      '<a href="' + esc(gcal) + '" style="display:inline-block;background:#1F9E92;color:#fff;text-decoration:none;font-size:15px;font-weight:bold;padding:12px 24px;border-radius:10px;margin:4px;">Google Calendar</a>' +
      '<a href="' + esc(outlook) + '" style="display:inline-block;background:#0E3B43;color:#fff;text-decoration:none;font-size:15px;font-weight:bold;padding:12px 24px;border-radius:10px;margin:4px;">Outlook</a>' +
      '<p style="margin:12px 0 0;font-size:13px;color:#7C8A8D;">En iPhone, iPad o Mac abre el archivo adjunto <strong>reserva.ics</strong> y se agrega a Apple Calendar.</p>' +
    '</td></tr>' +
    (CLUB_MAPS ? '<tr><td align="center" style="padding:6px 28px 8px;"><a href="' + esc(CLUB_MAPS) + '" style="color:#1F9E92;font-size:14px;">📍 Cómo llegar al club</a></td></tr>' : "") +
    '<tr><td style="padding:20px 28px 26px;border-top:1px solid #eee;">' +
      '<p style="margin:0;font-size:12px;color:#7C8A8D;line-height:1.5;">' + esc(CLUB_NAME) + ' · Si necesitas cambiar o cancelar tu reserva, responde a este correo o escríbenos por WhatsApp.</p>' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

function correoTexto(r, gcal) {
  const nombre = (r.name || "").trim().split(/\s+/)[0] || "crack";
  const esClase = r.bookingType === "clase";
  const l = [];
  l.push("¡Listo " + nombre + ", tu reserva está confirmada!");
  l.push("");
  l.push(esClase ? "Clase con " + (r.trainer || "entrenador") : "Reserva de cancha");
  l.push("Fecha: " + fechaLarga(r.fecha));
  l.push("Hora: " + r.startTime + " a " + r.endTime + " (" + duracionTexto(r) + ")");
  l.push("Cancha: " + (r.court || ""));
  if (esClase && r.players) l.push("Jugadores: " + r.players);
  if (r.name) l.push("A nombre de: " + r.name);
  if (r.phone) l.push("Contacto: " + r.phone);
  const pr = precioTexto(r);
  if (pr) l.push("Valor: " + pr);
  l.push("Pago: en el club");
  if (r.comment) l.push("Nota: " + r.comment);
  if (r.codigo_video) {
    l.push("Código de video: " + r.codigo_video);
    l.push("Tu partido queda grabado en video. Cuando termine, míralo aquí: " + REPLAY_URL + "?codigo=" + r.codigo_video);
  }
  const premio = String(r.premio_texto || "").trim();
  if (premio) { l.push(""); l.push(premio); }
  l.push("");
  l.push("Añádelo a tu calendario: " + gcal);
  l.push("(También va adjunto el archivo reserva.ics para Apple Calendar y Outlook.)");
  if (CLUB_MAPS) l.push("Cómo llegar: " + CLUB_MAPS);
  l.push("");
  l.push(CLUB_NAME);
  return l.join("\n");
}

/* Mensaje de WhatsApp listo para wa.me (lo abre la app con un clic). */
function textoWhatsApp(r, gcal, metodo) {
  const nombre = (r.name || "").trim().split(/\s+/)[0] || "";
  if (metodo === "CANCEL") {
    return "Hola " + nombre + ", tu reserva en " + CLUB_NAME + " del " + fechaLarga(r.fecha) +
      " (" + r.startTime + " a " + r.endTime + ") quedó cancelada. Cuando quieras la reprogramamos. 🎾";
  }
  const cab = (metodo === "UPDATE")
    ? "Hola " + nombre + "! Actualizamos tu reserva en " + CLUB_NAME + "."
    : "Hola " + nombre + "! Tu reserva en " + CLUB_NAME + " quedó confirmada.";
  const l = [cab];
  if (r.bookingType === "clase") l.push("Clase con " + (r.trainer || "entrenador"));
  l.push("Cancha: " + (r.court || ""));
  l.push("Fecha: " + fechaLarga(r.fecha));
  l.push("Hora: " + r.startTime + " a " + r.endTime + " (" + duracionTexto(r) + ")");
  const pr = precioTexto(r);
  if (pr) l.push("Valor: " + pr);
  l.push("Pago: en el club");
  if (r.comment) l.push("Nota: " + r.comment);
  if (r.codigo_video) {
    l.push("Código de video: " + r.codigo_video);
    l.push("Tu partido queda grabado en video. Cuando termine, míralo aquí: " + REPLAY_URL + "?codigo=" + r.codigo_video);
  }
  l.push("");
  l.push("Agrégala a tu calendario: " + gcal);
  if (r.email) l.push("También te enviamos la invitación a " + r.email + ".");
  l.push("");
  l.push("Te esperamos en cancha! 🎾");
  // El bloque de premio ganado lo calcula la app (loyalty) y viaja tal cual,
  // para que WhatsApp y el correo digan exactamente lo mismo.
  const premio = String(r.premio_texto || "").trim();
  if (premio) { l.push(""); l.push(premio); }
  return l.join("\n");
}

/* ════════════════ Envío por Resend ════════════════ */
async function enviarCorreo(to, asunto, html, text, ics, metodo) {
  const body = {
    from: MAIL_FROM,
    to: [to],
    subject: asunto,
    html,
    text,
    attachments: [{
      filename: "reserva.ics",
      content: Buffer.from(ics, "utf8").toString("base64"),
      content_type: 'text/calendar; charset=utf-8; method=' + (metodo || "REQUEST"),
    }],
  };
  if (MAIL_REPLY) body.reply_to = MAIL_REPLY;
  if (MAIL_BCC)   body.bcc = [MAIL_BCC];
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error("Resend " + r.status + ": " + txt);
  return txt;
}

/* ════════════════ Validaciones ════════════════ */
function emailValido(e) {
  return typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
}
function reservaValida(r) {
  if (!r || typeof r !== "object") return "Falta la reserva";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.fecha || ""))) return "Fecha inválida";
  if (!/^\d{2}:\d{2}$/.test(String(r.startTime || ""))) return "Hora de inicio inválida";
  if (!/^\d{2}:\d{2}$/.test(String(r.endTime || ""))) return "Hora de fin inválida";
  if (!r.groupId) return "Falta groupId";
  return null;
}

function resp(status, obj) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj),
  };
}

/* ════════════════════════ Handler ════════════════════════ */
exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return resp(405, { error: "Método no permitido" });
  if (!URL_BASE || !SERVICE_KEY || CODES.size === 0) return resp(500, { error: "Faltan variables de entorno" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (_) { return resp(400, { error: "JSON inválido" }); }

  if (!codigoValido(body.code) && !tokenValido(body.token)) return resp(401, { error: "Código incorrecto" });

  const accion = body.action || "crear";           // crear | actualizar | cancelar
  const r = body.reserva || {};
  const err = reservaValida(r);
  if (err) return resp(400, { error: err });

  const metodo = accion === "cancelar" ? "CANCEL" : (accion === "actualizar" ? "UPDATE" : "REQUEST");
  const uid = "bp-" + String(r.groupId).replace(/[^\w.-]/g, "") + "@bahiapadel";

  // Estado previo del evento (para SEQUENCE y para no reenviar el mismo correo).
  let prev = null;
  try { prev = await kvGet("invite:" + r.groupId); } catch (_) { prev = null; }

  if (accion === "crear" && prev && prev.enviado && !body.forzar) {
    // Ya se envió esta confirmación: devolvemos lo mismo sin volver a enviar.
    const evPrev = { fecha: r.fecha, startTime: r.startTime, endTime: r.endTime,
                     titulo: tituloEvento(r), descripcion: descripcionEvento(r) };
    return resp(200, {
      ok: true, repetido: true, correo_enviado: false,
      gcal: linkGoogle(evPrev), outlook: linkOutlook(evPrev),
      wa_text: textoWhatsApp(r, linkGoogle(evPrev), "REQUEST"),
    });
  }

  const seq = accion === "crear" ? 0 : ((prev && Number(prev.seq) || 0) + 1);
  const ev = {
    uid, seq, metodo,
    fecha: r.fecha, startTime: r.startTime, endTime: r.endTime,
    nombre: r.name, email: emailValido(r.email) ? r.email.trim() : null,
    titulo: tituloEvento(r),
    descripcion: descripcionEvento(r),
  };

  const gcal    = linkGoogle(ev);
  const outlook = linkOutlook(ev);
  const wa_text = textoWhatsApp(r, gcal, metodo);

  const salida = {
    ok: true, correo_enviado: false, gcal, outlook, wa_text,
    wa_link: r.phone ? ("https://wa.me/" + String(r.phone).replace(/\D/g, "") + "?text=" + encodeURIComponent(wa_text)) : null,
  };

  // ── Correo con la invitación de calendario ──
  if (!ev.email) {
    salida.aviso = "La reserva no tiene correo válido: solo se generó el mensaje de WhatsApp.";
    return resp(200, salida);
  }
  if (!RESEND_KEY) {
    salida.aviso = "Falta RESEND_API_KEY: no se envió el correo.";
    return resp(200, salida);
  }

  const ics = construirIcs(ev);
  const asunto = accion === "cancelar"
    ? "Reserva cancelada · " + CLUB_NAME + " · " + fechaLarga(r.fecha)
    : (accion === "actualizar" ? "Tu reserva cambió · " : "Reserva confirmada · ") +
      CLUB_NAME + " · " + fechaLarga(r.fecha) + " " + r.startTime;

  try {
    await enviarCorreo(ev.email, asunto, correoHtml(r, ev, gcal, outlook), correoTexto(r, gcal), ics, metodo);
    salida.correo_enviado = true;
    salida.email = ev.email;
    try {
      await kvSet("invite:" + r.groupId, {
        uid, seq, enviado: accion !== "cancelar", email: ev.email,
        estado: accion, ts: Date.now(),
      });
    } catch (_) { /* el correo ya salió; el marcador es best-effort */ }
  } catch (e) {
    salida.ok = false;
    salida.error_correo = e.message;
    return resp(200, salida); // 200: la reserva ya está guardada, esto es un extra
  }

  return resp(200, salida);
};

/* Exporta helpers puros para pruebas locales (no afecta a Netlify). */
if (typeof module !== "undefined") {
  module.exports.__test = { bogotaAUtc, icsStamp, escIcs, plegar, construirIcs, linkGoogle, linkOutlook, fechaLarga, textoWhatsApp, correoHtml, correoTexto, descripcionEvento, precioTexto, duracionTexto };
}
