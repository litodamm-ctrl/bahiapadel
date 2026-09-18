const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

let handler, validateClient, normalizePhone, calls, rpcResponse;
const originalFetch = global.fetch;
const originalNetlify = global.Netlify;
const values = {
  SUPABASE_URL: 'https://client-test.invalid', SUPABASE_SERVICE_ROLE_KEY: 'unit-test-key',
  APP_ACCESS_CODE: 'client-test-staff', APP_READ_CODE: 'client-test-reader',
  APP_PEDIDO_CODE: 'client-test-worker', SESSION_SECRET: 'client-test-session-secret'
};
const oldEnv = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
const original = { nombre: 'Ana', apellido: 'Prueba', phone: '573001234567', email: 'ana@example.invalid' };
const client = { ...original, nombre: 'Ana María', phone: '300 123 4567' };

before(async () => {
  Object.assign(process.env, values);
  global.Netlify = { env: { get: name => process.env[name] } };
  ({ default: handler, validateClient, normalizePhone } = await import('../netlify/functions/clientes.mjs'));
});
beforeEach(() => {
  calls = [];
  rpcResponse = { status: 200, data: { ok: true, client: { ...client, phone: original.phone }, reservas: 2, premios: 1 } };
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/rpc/bahia_update_client')) return new Response(JSON.stringify(rpcResponse.data), { status: rpcResponse.status });
    if (String(url).startsWith(values.SUPABASE_URL + '/rest/v1/kv')) return new Response('[]', { status: 200 });
    throw new Error('Unexpected external request: ' + url);
  };
});
after(() => {
  global.fetch = originalFetch;
  if (originalNetlify === undefined) delete global.Netlify; else global.Netlify = originalNetlify;
  for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
function request(body, headers = {}) {
  return new Request('https://manager.invalid/.netlify/functions/clientes', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
  });
}
function payload(extra = {}) { return { action: 'update', code: values.APP_ACCESS_CODE, original, client, staffName: 'Prueba', ...extra }; }
const rpcCalls = () => calls.filter(call => call.url.includes('/rpc/'));

test('normalizes Colombian and international phone numbers without merging identities', () => {
  assert.equal(normalizePhone('300 123 4567'), '573001234567');
  assert.equal(normalizePhone('+57 (300) 1234567'), '573001234567');
  assert.equal(normalizePhone('00 1 202 555 0131'), '12025550131');
});
test('validates contact data, preserves accents and permits an empty optional email', () => {
  assert.equal(validateClient(client).nombre, 'Ana María');
  assert.equal(validateClient({ ...client, email: '' }).email, '');
  assert.throws(() => validateClient({ ...client, nombre: ' ' }));
  assert.throws(() => validateClient({ ...client, phone: '123' }));
  assert.throws(() => validateClient({ ...client, phone: '11111111111' }));
  assert.throws(() => validateClient({ ...client, email: 'incorrecto' }));
  assert.throws(() => validateClient({ ...client, nombre: { value: 'x' } }));
});
test('rejects GET and cross-origin requests without accessing client data', async () => {
  assert.equal((await handler(new Request('https://manager.invalid/.netlify/functions/clientes'), { ip: 'test' })).status, 405);
  assert.equal((await handler(request(payload(), { origin: 'https://other.invalid' }), { ip: 'test' })).status, 403);
  assert.equal(calls.length, 0);
});
test('rejects missing credentials and restricted video credentials', async () => {
  assert.equal((await handler(request(payload({ code: '' })), { ip: 'test' })).status, 401);
  assert.equal((await handler(request(payload({ code: values.APP_READ_CODE })), { ip: 'test' })).status, 403);
  assert.equal((await handler(request(payload({ code: values.APP_PEDIDO_CODE })), { ip: 'test' })).status, 403);
  assert.equal(rpcCalls().length, 0);
});
test('staff update invokes one atomic RPC and sends the original snapshot', async () => {
  const response = await handler(request(payload()), { ip: 'test' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(rpcCalls().length, 1);
  const sent = JSON.parse(rpcCalls()[0].options.body);
  assert.deepEqual(sent.p_original, original);
  assert.equal(sent.p_client.phone, '573001234567');
  assert.equal(sent.p_actor, 'Prueba');
});
test('accepts a signed, unexpired staff session without retaining the access code', async () => {
  const part = Buffer.from(JSON.stringify({ u: '_staff', exp: Date.now() + 60000 })).toString('base64url');
  const token = part + '.' + crypto.createHmac('sha256', values.SESSION_SECRET).update(part).digest('base64url');
  assert.equal((await handler(request(payload({ code: '', token })), { ip: 'test' })).status, 200);
});
test('returns a conflict instead of accepting a duplicate or stale profile', async () => {
  rpcResponse = { status: 409, data: { code: 'PT409', message: 'El cliente cambió. Actualiza la lista.' } };
  const response = await handler(request(payload()), { ip: 'test' });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, rpcResponse.data.message);
});
test('rejects invalid input before calling the update RPC', async () => {
  const response = await handler(request(payload({ client: { ...client, email: 'bad' } })), { ip: 'test' });
  assert.equal(response.status, 400);
  assert.equal(rpcCalls().length, 0);
});
test('does not expose internal database details in a server error', async () => {
  rpcResponse = { status: 500, data: { code: 'INTERNAL', message: 'sensitive database details' } };
  const response = await handler(request(payload()), { ip: 'test' });
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('sensitive database details'));
});
test('client editor compiles and exposes editing through the existing staff navigation', () => {
  const source = fs.readFileSync(require.resolve('../client-editor.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(source));
  assert.ok(source.includes('clients-manager-button'));
  assert.ok(source.includes('Guardar cambios'));
  assert.ok(source.includes("window.__appToken || ''"));
});
