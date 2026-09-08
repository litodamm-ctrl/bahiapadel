/* ════════════════════════════════════════════════════════════════
   Bahía Padel · /.netlify/functions/correo-diario
   Correo AUTOMÁTICO después de cada reserva jugada.

   · Corre a las 09:00 Bogotá como Scheduled Function (ver netlify.toml).
   · Mira las reservas de los últimos 3 días que aún no recibieron correo.
   · Solo dice "ya está tu video" si el worker marcó pedido:<codigo> como
     LISTO. Si todavía no, espera y reintenta al día siguiente. Pasados 3
     días sin video (o si el worker dio error definitivo), manda un correo de
     "gracias por jugar" sin prometer nada.
   · Incluye estado de premiación (visitas del mes y próximo premio).
   · Escribe "mailsent:<fecha>:<groupId>" para no enviar dos veces.
   · Si MAIL_BCC está definido, envía un resumen de la corrida al club.

   Variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY,
     MAIL_FROM (remitente con dominio verificado), MAIL_REPLY_TO (opc.),
     MAIL_BCC (opc., recibe el resumen), WEB_URL, WHATSAPP_NUMBER, BOOK_URL,
     REPLAY_URL (opc., por defecto https://padelreplay.netlify.app/)
──────────────────────────────────────────────────────────────── */

const URL_BASE    = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY  = process.env.RESEND_API_KEY;
const MAIL_FROM   = process.env.MAIL_FROM || "Bahía Padel <onboarding@resend.dev>";
const MAIL_REPLY  = process.env.MAIL_REPLY_TO || "";
const MAIL_BCC    = process.env.MAIL_BCC || "";

const REPLAY_URL = (process.env.REPLAY_URL || "https://padelreplay.netlify.app/").replace(/\/?$/, "/");
const WEB_URL    = process.env.WEB_URL || "https://bahiapadel.com";
const WA_NUMBER  = process.env.WHATSAPP_NUMBER || "573233884528";
const WA_TEXT    = "Hola, quiero reservar en Bahía Padel 🎾";
const BOOK_URL   = process.env.BOOK_URL || ("https://wa.me/" + WA_NUMBER + "?text=" + encodeURIComponent(WA_TEXT));

const DIAS_ATRAS = 3;          // cuántos días hacia atrás se revisan
const DIAS_SIN_VIDEO = 3;      // a partir de aquí se manda "gracias" sin video
const LATIDO_MAX_MIN = 15;     // sin latido del worker por más de esto → aviso

/* ── Marca ── */
const C = { deep: "#0E3B43", teal: "#1F9E92", coral: "#FF6A4D", sand: "#F3E9D2", sandLight: "#FAF5E8", ink: "#14282B", inkSoft: "#4B6167", mute: "#7C8A8D" };

/* ── Zona horaria Bogotá (UTC-5 fijo) ── */
const BOGOTA_MS = 5 * 3600 * 1000;
function ahoraBogota() { return new Date(Date.now() - BOGOTA_MS); }
function ymd(d) { return d.toISOString().slice(0, 10); }
function mesDe(s) { return String(s || "").slice(0, 7); }

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

const HITOS = [
  { n: 2,  premio: "Botella de agua" },
  { n: 4,  premio: "Coca-Cola" },
  { n: 7,  premio: "½ tarro de bolas" },
  { n: 9,  premio: "¼ de cancha en hora valle" },
  { n: 11, premio: "¼ de cancha gratis" },
  { n: 13, premio: "½ cancha gratis en hora valle" },
];

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const DIAS  = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
function fechaLarga(fecha) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fecha || ""));
  if (!m) return String(fecha || "");
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return DIAS[dt.getUTCDay()] + " " + (+m[3]) + " de " + MESES[+m[2] - 1];
}

/* ════════════════ Supabase ════════════════ */
function headers(extra) {
  return Object.assign({ apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json" }, extra || {});
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

/* ════════════════ Lógica pura ════════════════ */
function conteoCanchaDelMes(docsMes, hoyStr) {
  const map = new Map();
  const vistos = new Set();
  for (const fecha of Object.keys(docsMes)) {
    if (!(fecha < hoyStr)) continue;
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
function reservasDelDia(doc) {
  const out = [];
  const vistos = new Set();
  for (const slotKey of Object.keys(doc || {})) {
    const b = doc[slotKey];
    if (!b) continue;
    if ((b.bookingType || "cancha") === "bloqueo") continue;
    const gid = b.groupId || slotKey;
    if (vistos.has(gid)) continue;
    vistos.add(gid);
    out.push(Object.assign({ _slot: slotKey, _gid: gid }, b));
  }
  return out;
}

/* ¿Qué correo toca? "video" (está listo), "gracias" (no habrá video) o "esperar" (reintentar mañana). */
function decidirCorreo(reserva, pedido, diasDesde) {
  if (!reserva || !reserva.codigo_video) return "gracias";
  if (pedido && pedido.estado === "listo" && pedido.url) return "video";
  if (pedido && pedido.estado === "error" && (pedido.intentos || 0) >= 3) return "gracias";
  if (pedido && pedido.estado === "cancelado") return "gracias";
  if (diasDesde >= DIAS_SIN_VIDEO) return "gracias";
  return "esperar";
}

/* ════════════════ Plantilla ════════════════ */
function boton(href, texto, fondo, color) {
  return '<a href="' + esc(href) + '" style="display:inline-block;background:' + fondo + ';color:' + (color || "#fff") +
    ';text-decoration:none;font-size:16px;font-weight:bold;padding:14px 30px;border-radius:10px;">' + texto + '</a>';
}
function bloquePremios(prem) {
  if (!prem) return { html: "", txt: "" };
  let html = "", txt = "";
  if (prem.proximo) {
    const faltan = prem.proximo.n - prem.visitas;
    html = '<p style="margin:0 0 6px;font-size:15px;color:' + C.deep + ';"><strong>🎾 Vas por ' + prem.visitas + ' ' + (prem.visitas === 1 ? "visita" : "visitas") + ' este mes.</strong></p>' +
      '<p style="margin:0;font-size:15px;color:' + C.ink + ';">Te falta' + (faltan === 1 ? "" : "n") + ' <strong>' + faltan + '</strong> para ganar <strong>' + esc(prem.proximo.premio) + '</strong>. ¡Reserva otra y reclámalo!</p>';
    txt = "Vas por " + prem.visitas + " visitas este mes. Te faltan " + faltan + " para ganar " + prem.proximo.premio + ".";
  } else {
    html = '<p style="margin:0;font-size:15px;color:' + C.deep + ';"><strong>🏆 ¡Máximo nivel! ' + prem.visitas + ' visitas este mes. Eres leyenda de Bahía Padel.</strong></p>';
    txt = "¡" + prem.visitas + " visitas este mes! Máximo nivel.";
  }
  if (prem.ultimo) {
    html += '<p style="margin:8px 0 0;font-size:13px;color:' + C.inkSoft + ';">Ya te ganaste: ' + esc(prem.ultimo.premio) + '. Reclámalo en el club.</p>';
  }
  return { html, txt };
}

function construirCorreo(b, fecha, prem, tipo) {
  const nombre = (b.name || "").trim().split(/\s+/)[0] || "crack";
  const esClase = (b.bookingType || "cancha") === "clase";
  const tipoTxt = esClase ? ("Clase con " + esc(b.trainer || "tu profe")) : "Reserva de cancha";
  const codigo = b.codigo_video || "";
  const linkVideo = REPLAY_URL + "?codigo=" + encodeURIComponent(codigo);
  const conVideo = tipo === "video";
  const p = bloquePremios(prem);

  const titulo = conVideo ? "¡" + esc(nombre) + ", tu video ya está listo! 🎬" : "¡Gracias por jugar, " + esc(nombre) + "! 🎾";
  const intro = conVideo
    ? "Revive tu partido, guárdalo y comparte los mejores puntos."
    : "Nos encantó verte en la cancha. Aquí va el resumen de tu partido.";

  const html =
'<!doctype html><html><body style="margin:0;padding:0;background:' + C.sand + ';font-family:Arial,Helvetica,sans-serif;">' +
'<table width="100%" cellpadding="0" cellspacing="0" style="background:' + C.sand + ';padding:24px 0;"><tr><td align="center">' +
'<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;">' +
  '<tr><td style="background:' + C.deep + ';padding:22px 28px;">' +
    '<span style="color:#ffffff;font-size:20px;font-weight:bold;letter-spacing:1px;">BAHÍA PADEL</span>' +
  '</td></tr>' +
  '<tr><td style="padding:28px 28px 8px;">' +
    '<h1 style="margin:0;font-size:22px;color:' + C.deep + ';">' + titulo + '</h1>' +
    '<p style="margin:10px 0 0;font-size:15px;color:' + C.inkSoft + ';line-height:1.5;">' + intro + '</p>' +
  '</td></tr>' +
  (conVideo ?
  '<tr><td align="center" style="padding:20px 28px 6px;">' +
    boton(linkVideo, "▶ Ver mi video", C.coral) +
    '<p style="margin:12px 0 0;font-size:13px;color:' + C.mute + ';">Código de video: <strong style="color:' + C.ink + ';letter-spacing:1px;">' + esc(codigo) + '</strong></p>' +
  '</td></tr>' : "") +
  '<tr><td style="padding:16px 28px 4px;">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:' + C.sandLight + ';border-radius:10px;">' +
      '<tr><td style="padding:16px 18px;font-size:14px;color:' + C.ink + ';line-height:1.7;">' +
        '<strong style="color:' + C.deep + ';">' + tipoTxt + '</strong><br>' +
        '📅 ' + esc(fechaLarga(fecha)) + '<br>' +
        '🕐 ' + esc(b.startTime || "") + (b.endTime ? " – " + esc(b.endTime) : "") + '<br>' +
        '🎾 ' + esc(b.court || "") +
        (esClase && b.players ? '<br>👥 ' + esc(b.players) + ' jugadores' : "") +
      '</td></tr>' +
    '</table>' +
  '</td></tr>' +
  (p.html ? '<tr><td style="padding:14px 28px 4px;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#DCEFEC;border-radius:10px;"><tr><td style="padding:16px 18px;">' + p.html + '</td></tr></table></td></tr>' : "") +
  '<tr><td align="center" style="padding:22px 28px 4px;">' +
    '<p style="margin:0 0 12px;font-size:15px;color:' + C.inkSoft + ';">¿Listos para la revancha? Reserva tu cancha por WhatsApp:</p>' +
    boton(BOOK_URL, "Reservar por WhatsApp", "#25D366", C.deep) +
  '</td></tr>' +
  '<tr><td align="center" style="padding:8px 28px 20px;">' +
    '<p style="margin:0 0 10px;font-size:14px;color:' + C.inkSoft + ';">Torneos, clases y novedades en nuestra web</p>' +
    '<a href="' + esc(WEB_URL) + '" style="display:inline-block;border:2px solid ' + C.deep + ';color:' + C.deep + ';text-decoration:none;font-size:14px;font-weight:bold;padding:10px 26px;border-radius:10px;">Visitar la web →</a>' +
  '</td></tr>' +
  '<tr><td style="padding:22px 28px 26px;border-top:1px solid #eee;">' +
    '<p style="margin:0;font-size:12px;color:' + C.mute + ';line-height:1.5;">Bahía Padel · Recibes este correo porque tienes una reserva registrada con nosotros. Si no deseas recibir estos mensajes, responde con la palabra <strong>BAJA</strong>.</p>' +
  '</td></tr>' +
'</table></td></tr></table></body></html>';

  const text =
(conVideo ? '¡' + nombre + ', tu video ya está listo!\n\nRevive tu partido: ' + linkVideo + '\nCódigo de video: ' + codigo + '\n\n'
          : '¡Gracias por jugar, ' + nombre + '!\n\n') +
'Tu partido:\n' + tipoTxt.replace(/<[^>]+>/g, "") + '\n' + fechaLarga(fecha) + ' · ' + (b.startTime || "") + (b.endTime ? " - " + b.endTime : "") + ' · ' + (b.court || "") + '\n\n' +
(p.txt ? p.txt + '\n\n' : '') +
'¿Listos para la revancha? Reserva por WhatsApp: ' + BOOK_URL + '\n' +
'Torneos, clases y novedades: ' + WEB_URL + '\n\n' +
'Bahía Padel · Si no deseas recibir estos correos, responde BAJA.';

  const subject = conVideo
    ? "🎬 Tu video de Bahía Padel ya está listo, " + nombre + " (" + codigo + ")"
    : "🎾 Gracias por jugar en Bahía Padel, " + nombre;

  return { subject, html, text };
}

/* ════════════════ Resend ════════════════ */
async function enviarResend(to, correo) {
  const body = { from: MAIL_FROM, to: [to], subject: correo.subject, html: correo.html, text: correo.text };
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

/* ════════════════ Handler ════════════════ */
exports.handler = async function () {
  const out = { desde: null, hasta: null, encontradas: 0, video: 0, gracias: 0, esperando: 0, saltados: 0, sin_email: 0, avisos: [], errores: [] };
  try {
    if (!URL_BASE || !SERVICE_KEY) throw new Error("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    if (!RESEND_KEY) throw new Error("Falta RESEND_API_KEY");
    if (/onboarding@resend\.dev/.test(MAIL_FROM)) out.avisos.push("MAIL_FROM sigue siendo el remitente de prueba de Resend: los correos pueden caer en spam. Configura un dominio verificado.");

    const hoyB = ahoraBogota();
    const hoyStr = ymd(hoyB);

    // Latido del worker
    try {
      const hb = await kvGet("worker:heartbeat");
      if (!hb || !hb.ts) out.avisos.push("El worker de video nunca ha reportado señal.");
      else if (Date.now() - hb.ts > LATIDO_MAX_MIN * 60000) {
        out.avisos.push("El worker de video no da señal desde " + new Date(hb.ts - BOGOTA_MS).toISOString().replace("T", " ").slice(0, 16) + " (Bogotá). ¿La PC del club está encendida?");
      }
    } catch (e) { out.avisos.push("No pude leer worker:heartbeat: " + e.message); }

    // Directorio (email por teléfono)
    const dirPorTel = new Map();
    try {
      const dir = await kvGet("clientes-directorio");
      if (Array.isArray(dir)) for (const c of dir) { const p = normPhone(c.phone); if (p && emailValido(c.email)) dirPorTel.set(p, c.email.trim()); }
    } catch (_) {}

    const conteoPorMes = new Map();
    async function conteoDe(mes) {
      if (!conteoPorMes.has(mes)) {
        try { conteoPorMes.set(mes, conteoCanchaDelMes(await traerCancha(mes), hoyStr)); }
        catch (e) { out.errores.push("conteoMes " + mes + ": " + e.message); conteoPorMes.set(mes, new Map()); }
      }
      return conteoPorMes.get(mes);
    }

    for (let d = 1; d <= DIAS_ATRAS; d++) {
      const fechaStr = ymd(new Date(hoyB.getTime() - d * 86400000));
      if (d === 1) out.hasta = fechaStr;
      out.desde = fechaStr;
      let doc = null;
      try { doc = await kvGet("cancha:" + fechaStr); } catch (e) { out.errores.push(fechaStr + ": " + e.message); continue; }
      if (!doc) continue;
      const reservas = reservasDelDia(doc);
      out.encontradas += reservas.length;

      for (const b of reservas) {
        try {
          const marca = "mailsent:" + fechaStr + ":" + b._gid;
          if (await kvGet(marca)) { out.saltados++; continue; }

          let email = emailValido(b.email) ? b.email.trim() : null;
          const phone = normPhone(b.phone);
          if (!email && phone && dirPorTel.has(phone)) email = dirPorTel.get(phone);
          if (!email) { out.sin_email++; await kvSet(marca, { ts: Date.now(), sin_email: true }); continue; }

          const pedido = b.codigo_video ? await kvGet("pedido:" + b.codigo_video) : null;
          const tipo = decidirCorreo(b, pedido, d);
          if (tipo === "esperar") { out.esperando++; continue; }

          let prem = null;
          if (phone) {
            const n = (await conteoDe(mesDe(fechaStr))).get(phone) || 0;
            if (n >= 1) { const est = estadoPremios(n); prem = { visitas: n, proximo: est.proximo, ultimo: est.ultimo }; }
          }

          const correo = construirCorreo(b, fechaStr, prem, tipo);
          await enviarResend(email, correo);
          await kvSet(marca, { ts: Date.now(), email, tipo, codigo: b.codigo_video || null });
          out[tipo]++;
        } catch (e) {
          out.errores.push((b._gid || "?") + ": " + e.message);
        }
      }
    }

    if (MAIL_BCC && emailValido(MAIL_BCC)) {
      const lineas = [
        "Correos de video: " + out.video, "Correos de gracias: " + out.gracias, "Esperando video: " + out.esperando,
        "Ya enviados antes: " + out.saltados, "Sin correo: " + out.sin_email,
      ];
      if (out.avisos.length) lineas.push("", "AVISOS:", ...out.avisos.map(a => "• " + a));
      if (out.errores.length) lineas.push("", "ERRORES:", ...out.errores.map(a => "• " + a));
      try {
        await enviarResend(MAIL_BCC, {
          subject: (out.avisos.length || out.errores.length ? "⚠️ " : "✅ ") + "Correo diario Bahía Padel · " + hoyStr + " · " + out.video + " videos, " + out.esperando + " esperando",
          html: "<pre style=\"font-family:Menlo,Consolas,monospace;font-size:13px\">" + esc(lineas.join("\n")) + "</pre>",
          text: lineas.join("\n"),
        });
      } catch (e) { out.errores.push("resumen: " + e.message); }
    }

    return { statusCode: 200, body: JSON.stringify(out) };
  } catch (e) {
    out.errores.push("fatal: " + e.message);
    return { statusCode: 500, body: JSON.stringify(out) };
  }
};

if (typeof module !== "undefined") {
  module.exports.__test = { decidirCorreo, construirCorreo, conteoCanchaDelMes, estadoPremios, normPhone, reservasDelDia, fechaLarga };
}
