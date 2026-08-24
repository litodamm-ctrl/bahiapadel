# Correo de confirmación en el momento de la reserva

Hoy el jugador recibe su código de video **a las 9:00 del día siguiente**, por
`correo-diario`. Con este cambio lo recibe **al reservar**, en el mismo momento
en que sale la confirmación de WhatsApp — y con la invitación de calendario
adjunta.

La función que hace todo eso ya estaba escrita (`confirmacion.js`): manda el
correo con un `.ics`, botones de Google Calendar y Outlook, y devuelve el enlace
de calendario para pegarlo en el WhatsApp. Lo único que faltaba era desplegarla
y llamarla.

## Los tres pasos

### 1. Mover la función a donde Netlify la ve

`confirmacion.js` está en la **raíz** del repo. Netlify solo despliega lo que
está en `netlify/functions/`, así que hoy no existe como función — y encima el
archivo se lee entero desde `padelmanagerb.netlify.app/confirmacion.js`.

En GitHub: abrí el archivo → botón **Edit** (lápiz) → en la casilla del nombre,
arriba, escribí `netlify/functions/confirmacion.js` → **Commit**.

> Movelo con el renombrado de GitHub, no copiando y pegando: así el contenido
> queda idéntico, byte por byte.

### 2. Pegar los dos parches en `index.html`

| Archivo | Dónde va |
|---|---|
| `01-helper-enviarConfirmacion.js` | después de `deleteVideoIndex`, cerca de la línea 619 |
| `02-llamada-en-la-reserva.js` | justo antes de `state.lastConfirmation = { phone, message: msg };`, cerca de la 796 |

El orden importa: el mensaje de WhatsApp ya viene armado con el código de video
y el bloque de premio; el parche 2 le suma el enlace de calendario que devuelve
el servidor. Así el WhatsApp y el correo dicen lo mismo.

### 3. Cargar las variables que faltan

Además de las de correo de la fase 1, `confirmacion.js` usa estas —todas
opcionales, pero sin ellas el evento de calendario sale sin dirección:

| Variable | Ejemplo |
|---|---|
| `CLUB_NAME` | `Bahía Padel Social Club` |
| `CLUB_ADDRESS` | la dirección que aparece en el evento del calendario |
| `CLUB_MAPS_URL` | el enlace de Google Maps del club |
| `MAIL_BCC` | copia oculta al club, ej. `reservas@bahiapadel.com` |

## Qué recibe el jugador ahora

**Al reservar**, en el momento:

- **WhatsApp** — cancha, fecha, hora, pago, código de video, premio si le
  corresponde, y el enlace para agregarlo al calendario.
- **Correo** — lo mismo, más el archivo `reserva.ics` adjunto (Apple Calendar,
  Outlook, Google), botones de "añadir a calendario" y una alarma automática
  2 horas antes del partido.

**Al día siguiente a las 9:00**, `correo-diario` sigue mandando el correo de
"ya está tu video". Ahora son dos correos con dos propósitos distintos: uno
confirma la reserva, el otro avisa que la grabación está lista. No se pisan
—usan marcadores separados en la base (`invite:` y `mailsent:`)— pero si
preferís uno solo, decime y ajusto.

## Detalles que conviene saber

- **No rompe nada si falla.** La reserva se guarda antes de intentar el correo.
  Si Resend está caído o el cliente no dejó email, la reserva queda igual y el
  WhatsApp sale igual; solo se pierde el correo, y queda anotado en la consola.
- **No manda dos veces.** La función guarda `invite:<groupId>`; si se vuelve a
  confirmar la misma reserva, devuelve los mismos enlaces sin reenviar.
- **Sin email no pasa nada malo.** Si la reserva no tiene correo válido,
  devuelve solo el texto de WhatsApp con un aviso.
- **Horarios verificados.** Comprobé la conversión Bogotá → UTC de la invitación
  con cuatro casos, incluidos los que cruzan medianoche y fin de año. Cae bien:
  19:00 en Bogotá llega al calendario como 19:00.

## Lo que queda a mano para después

`confirmacion.js` ya sabe mandar **actualizaciones** y **cancelaciones** del
mismo evento (`action: "actualizar"` / `"cancelar"`), y el calendario del
jugador se corrige solo. Con una línea en el flujo de cancelar reserva queda
andando — avisame y lo agrego.
