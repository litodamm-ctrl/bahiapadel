const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL = "https://x.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "srv";
process.env.RESEND_API_KEY = "re_x";

const { __test } = require("../netlify/functions/correo-diario.js");
const { decidirCorreo, construirCorreo } = __test;

const reserva = { name: "Laura Gómez", codigo_video: "BP-K7QWMZ", court: "Cancha 1", startTime: "18:00", endTime: "19:30", bookingType: "cancha" };

test("con el video listo se manda el correo de video", () => {
  assert.equal(decidirCorreo(reserva, { estado: "listo", url: "https://v/x.mp4" }, 1), "video");
});

test("sin video todavía y partido reciente, se espera (se reintenta mañana)", () => {
  assert.equal(decidirCorreo(reserva, { estado: "programado" }, 1), "esperar");
  assert.equal(decidirCorreo(reserva, null, 1), "esperar");
});

test("si el worker dio error definitivo se manda el correo de gracias sin prometer video", () => {
  assert.equal(decidirCorreo(reserva, { estado: "error", intentos: 3 }, 1), "gracias");
});

test("pasados tres días sin video se manda el correo de gracias y se cierra", () => {
  assert.equal(decidirCorreo(reserva, { estado: "programado" }, 3), "gracias");
});

test("una reserva sin código de video recibe el correo de gracias", () => {
  assert.equal(decidirCorreo(Object.assign({}, reserva, { codigo_video: "" }), null, 1), "gracias");
});

test("el correo de video enlaza al código y el de gracias no promete ningún video", () => {
  const v = construirCorreo(reserva, "2026-08-27", null, "video");
  assert.match(v.subject, /ya está listo/);
  assert.match(v.html, /padelreplay\.netlify\.app\/\?codigo=BP-K7QWMZ/);
  const g = construirCorreo(reserva, "2026-08-27", null, "gracias");
  assert.doesNotMatch(g.subject, /video/i);
  assert.doesNotMatch(g.html, /ya está tu video/i);
  assert.match(g.html, /Gracias por jugar/);
});

test("los correos usan los colores de marca", () => {
  const v = construirCorreo(reserva, "2026-08-27", null, "video");
  assert.match(v.html, /#0E3B43/);
  assert.doesNotMatch(v.html, /#0b3d2e|#12b76a/);
});
