/* Pruebas de la función kv con Supabase simulado (fetch falso). */
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL = "https://x.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "srv";
process.env.APP_ACCESS_CODE = "admin123";
process.env.APP_PEDIDO_CODE = "pedido123";
process.env.APP_READ_CODE = "lectura123";

const { handler } = require("../netlify/functions/kv.js");

/* fetch falso: guarda las llamadas y responde según la tabla `respuestas` (por método+fragmento de URL). */
function simular(respuestas) {
  const llamadas = [];
  globalThis.fetch = async (url, opts) => {
    const metodo = (opts && opts.method) || "GET";
    llamadas.push({ url: String(url), metodo, body: opts && opts.body ? JSON.parse(opts.body) : null, headers: (opts && opts.headers) || {} });
    for (const r of respuestas) {
      if (r.metodo === metodo && String(url).includes(r.incluye)) {
        return { ok: r.status ? r.status < 400 : true, status: r.status || 200, text: async () => JSON.stringify(r.json), json: async () => r.json };
      }
    }
    return { ok: true, status: 200, text: async () => "[]", json: async () => [] };
  };
  return llamadas;
}
async function llamar(body, ip) {
  const r = await handler({ httpMethod: "POST", headers: { "x-nf-client-connection-ip": ip || "1.1.1.1" }, body: JSON.stringify(body) });
  return { status: r.statusCode, json: JSON.parse(r.body) };
}
const sinBloqueo = { metodo: "GET", incluye: "key=eq.rl%3A", json: [] };

test("get devuelve la versión del documento junto con el valor", async () => {
  simular([sinBloqueo, { metodo: "GET", incluye: "key=eq.cancha%3A2026-08-28", json: [{ key: "cancha:2026-08-28", value: "{}", version: 7 }] }]);
  const r = await llamar({ action: "get", code: "admin123", key: "cancha:2026-08-28" });
  assert.equal(r.status, 200);
  assert.equal(r.json.version, 7);
});

test("set con ifVersion distinta a la guardada responde 409 y no escribe", async () => {
  const llamadas = simular([sinBloqueo, { metodo: "PATCH", incluye: "version=eq.3", json: [] }]);
  const r = await llamar({ action: "set", code: "admin123", key: "cancha:2026-08-28", value: "{}", ifVersion: 3 });
  assert.equal(r.status, 409);
  assert.ok(!llamadas.some(l => l.metodo === "POST"), "no debe hacer upsert");
});

test("set con ifVersion correcta escribe y devuelve la versión nueva", async () => {
  simular([sinBloqueo, { metodo: "PATCH", incluye: "version=eq.3", json: [{ key: "cancha:2026-08-28", version: 4 }] }]);
  const r = await llamar({ action: "set", code: "admin123", key: "cancha:2026-08-28", value: "{}", ifVersion: 3 });
  assert.equal(r.status, 200);
  assert.equal(r.json.version, 4);
});

test("el código de pedidos no puede escribir reservas pero sí worker:* y pedido:*", async () => {
  simular([sinBloqueo]);
  const a = await llamar({ action: "set", code: "pedido123", key: "cancha:2026-08-28", value: "{}" });
  assert.equal(a.status, 403);
  const b = await llamar({ action: "set", code: "pedido123", key: "worker:heartbeat", value: "{}" });
  assert.equal(b.status, 200);
  const c = await llamar({ action: "set", code: "pedido123", key: "pedido:BP-X", value: "{}" });
  assert.equal(c.status, 200);
});

test("listv devuelve claves y valores del prefijo, y el código de pedidos solo puede listar pedido:*", async () => {
  simular([sinBloqueo, { metodo: "GET", incluye: "key=like.pedido%3A%25", json: [{ key: "pedido:BP-A", value: "{\"estado\":\"listo\"}" }] }]);
  const r = await llamar({ action: "listv", code: "pedido123", prefix: "pedido:" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items, [{ key: "pedido:BP-A", value: "{\"estado\":\"listo\"}" }]);
  const p = await llamar({ action: "listv", code: "pedido123", prefix: "cancha:" });
  assert.equal(p.status, 403);
});

test("mset escribe varias claves en una sola llamada a Supabase", async () => {
  const llamadas = simular([sinBloqueo, { metodo: "POST", incluye: "/kv", json: [] }]);
  const r = await llamar({ action: "mset", code: "admin123", items: [{ key: "video:BP-A", value: "{}" }, { key: "pedido:BP-A", value: "{}" }] });
  assert.equal(r.status, 200);
  const posts = llamadas.filter(l => l.metodo === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.length, 2);
});

test("dia.get trae reservas, historial y latido del worker con sus versiones en una llamada", async () => {
  const llamadas = simular([sinBloqueo, { metodo: "GET", incluye: "key=in.", json: [
    { key: "cancha:2026-08-28", value: "{\"a\":1}", version: 2 },
    { key: "worker:heartbeat", value: "{\"ts\":1}", version: 0 },
  ] }]);
  const r = await llamar({ action: "dia.get", code: "admin123", fecha: "2026-08-28" });
  assert.equal(r.status, 200);
  assert.equal(r.json.cancha.value, "{\"a\":1}");
  assert.equal(r.json.cancha.version, 2);
  assert.equal(r.json.historial, null);
  assert.equal(r.json.heartbeat.value, "{\"ts\":1}");
  assert.equal(llamadas.filter(l => l.url.includes("key=in.")).length, 1);
  const p = await llamar({ action: "dia.get", code: "pedido123", fecha: "2026-08-28" });
  assert.equal(p.status, 403);
});

test("dia.get rechaza fechas con formato inválido", async () => {
  simular([sinBloqueo]);
  const r = await llamar({ action: "dia.get", code: "admin123", fecha: "28/08/2026" });
  assert.equal(r.status, 400);
});
