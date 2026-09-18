import kv from './kv.js';

function reply(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

export function normalizePhone(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (/^3\d{9}$/.test(digits)) digits = '57' + digits;
  return digits;
}

export function validateClient(client) {
  if (!client || typeof client !== 'object' || Array.isArray(client)) throw new Error('Datos de cliente inválidos');
  for (const field of ['nombre', 'apellido', 'phone', 'email']) {
    if (typeof client[field] !== 'string') throw new Error('Revisa los datos del cliente');
  }
  const clean = {
    nombre: client.nombre.trim(), apellido: client.apellido.trim(),
    phone: normalizePhone(client.phone), email: client.email.trim().toLowerCase()
  };
  if (!clean.nombre || clean.nombre.length > 100 || clean.apellido.length > 100) {
    throw new Error('Escribe el nombre y revisa que cada campo tenga máximo 100 caracteres');
  }
  if (!/^[1-9]\d{7,14}$/.test(clean.phone) || /^(\d)\1+$/.test(clean.phone)) {
    throw new Error('Escribe un teléfono válido con indicativo de país');
  }
  if (clean.email.length > 254 || (clean.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email))) {
    throw new Error('El correo electrónico no es válido');
  }
  return clean;
}

export default async function handler(request, context) {
  if (request.method !== 'POST') return reply(405, { error: 'Método no permitido' });
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return reply(403, { error: 'Origen no permitido' });
  let body;
  try {
    const text = await request.text();
    if (text.length > 16384) return reply(413, { error: 'Solicitud demasiado grande' });
    body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
  } catch (_) { return reply(400, { error: 'Solicitud inválida' }); }

  // Reuse the manager's authentication and failed-attempt rate limiting.
  // Video readers and the video worker cannot read or update client profiles.
  let auth;
  try {
    auth = await kv.handler({
      httpMethod: 'POST',
      headers: { 'x-nf-client-connection-ip': context?.ip || 'unknown' },
      body: JSON.stringify({ action: 'auth', code: body.code, token: body.token })
    });
    if (auth.statusCode !== 200) {
      return new Response(auth.body, { status: auth.statusCode, headers: auth.headers });
    }
    if (JSON.parse(auth.body).modo !== 'admin') return reply(403, { error: 'Solo el personal del club puede editar clientes' });
  } catch (_) { return reply(503, { error: 'No se pudo validar la sesión. Intenta nuevamente' }); }

  if (body.action !== 'update') return reply(400, { error: 'Acción desconocida' });
  let client;
  try {
    client = validateClient(body.client);
    if (!body.original || typeof body.original !== 'object' || Array.isArray(body.original)) throw new Error('Actualiza la lista y selecciona un cliente');
  } catch (error) { return reply(400, { error: error.message }); }

  const url = Netlify.env.get('SUPABASE_URL');
  const key = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return reply(503, { error: 'Falta la configuración del directorio' });
  try {
    const response = await fetch(url.replace(/\/+$/, '') + '/rest/v1/rpc/bahia_update_client', {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ p_original: body.original, p_client: client, p_actor: String(body.staffName || 'Staff').slice(0, 100) })
    });
    const data = await response.json();
    if (!response.ok) {
      if (['PT400', 'PT404', 'PT409'].includes(data.code)) return reply(Number(data.code.slice(2)), { error: data.message });
      if (data.code === '23505') return reply(409, { error: 'Existe otro registro con ese teléfono. No se modificó ningún dato' });
      if (['55P03', '57014', '40P01'].includes(data.code)) return reply(409, { error: 'Hay otra operación en curso. Actualiza la lista e intenta nuevamente' });
      console.error('Client update failed', { status: response.status, code: data.code });
      return reply(503, { error: 'No se pudo guardar el cliente. No se aplicaron cambios parciales' });
    }
    return reply(200, data);
  } catch (_) {
    return reply(503, { error: 'No se pudo confirmar el guardado. Actualiza la lista antes de volver a intentar' });
  }
}
