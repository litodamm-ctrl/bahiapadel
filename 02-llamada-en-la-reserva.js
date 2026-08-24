/* ══════════════════════════════════════════════════════════════════════════
   PARCHE 2 de 2 · bahiapadel/index.html

   DÓNDE: buscá esta línea (está cerca de la 796):

       state.lastConfirmation = { phone, message: msg };

   Pegá el bloque de abajo JUSTO ANTES de esa línea — o sea, después de:

       try { msg += await bloquePremioGanado(phone, name); } catch(e){ ... }

   El orden importa: el mensaje de WhatsApp ya está armado con el código de
   video y el premio, y acá le sumamos el enlace de calendario que devuelve
   el servidor, para que el WhatsApp y el correo digan exactamente lo mismo.
   ══════════════════════════════════════════════════════════════════════════ */

  // Correo de confirmación con la invitación de calendario. Sale AHORA, junto
  // con el WhatsApp: el jugador recibe su código de video en el momento de
  // reservar, no a las 9:00 del día siguiente.
  const confirmacion = await enviarConfirmacion(
    Object.assign({}, bookingInfo, { fecha: dateStr }), 'crear');

  if(confirmacion && confirmacion.gcal){
    msg += '\n\nAgrégala a tu calendario: ' + confirmacion.gcal;
  }
  if(confirmacion && confirmacion.correo_enviado){
    msg += '\nTambién te la enviamos por correo a ' + bookingInfo.email + '.';
  }
