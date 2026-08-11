/* Scheduled Function de Netlify — emisión + expiración diaria de premios.
   Corre server-to-server (no requiere código de staff).
   La programación se define en netlify.toml (ver README). */
const { __jobs } = require("./loyalty.js");

exports.handler = async function () {
  const out = {};
  try { out.recompute = await __jobs.premiosRecompute(); } catch (e) { out.recompute_error = e.message; }
  try { out.expirar   = await __jobs.premiosExpirar();   } catch (e) { out.expirar_error   = e.message; }
  return { statusCode: 200, body: JSON.stringify(out) };
};
