/* ══════════════════════════════════════════════════════════════════════════
   PARCHE 1 de 2 · bahiapadel/index.html

   DÓNDE: pegar este bloque justo DESPUÉS de la función deleteVideoIndex
   (alrededor de la línea 619), entre las utilidades de storage.

   QUÉ HACE: le pide a la función confirmacion que mande el correo con la
   invitación de calendario en el momento de crear la reserva.
   ══════════════════════════════════════════════════════════════════════════ */

/* ---------- Confirmación inmediata por correo ----------
   Se dispara al crear la reserva, en el mismo momento que el mensaje de
   WhatsApp, para que el jugador reciba su código de video ahora y no al día
   siguiente. Devuelve los enlaces de calendario que armó el servidor.

   Es best-effort a propósito: si el correo falla, la reserva ya quedó
   guardada y la confirmación de WhatsApp sale igual. Nunca rompe la reserva. */
async function enviarConfirmacion(reserva, accion){
  try{
    const r = await fetch('/.netlify/functions/confirmacion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code:  window.__appCode || '',
        token: window.__appToken || undefined,
        action: accion || 'crear',
        reserva: reserva
      })
    });
    const data = await r.json().catch(function(){ return null; });
    if(!r.ok || !data){
      console.warn('Confirmación: respuesta inesperada del servidor', r.status);
      return null;
    }
    if(data.error_correo) console.warn('Confirmación: el correo no salió —', data.error_correo);
    else if(data.aviso)   console.warn('Confirmación:', data.aviso);
    return data;
  }catch(e){
    console.warn('No se pudo enviar la confirmación por correo', e);
    return null;
  }
}
