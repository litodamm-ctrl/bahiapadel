# Puesta en marcha en el club · paso a paso

Orden recomendado. Cada paso dice qué hacer, dónde y cómo saber que quedó bien. Tiempo total estimado: 2–3 horas con la cámara ya conectada.

---

## 0. Qué cambió (para saber qué estás activando)

| Repo | Cambio | Efecto |
|---|---|---|
| `bahiapadel` | `kv.js`: versiones (`ifVersion`), `mset`, `listv`, `dia.get`, permisos del worker | Sin dobles reservas; una sola llamada cada 60 s; el worker solo toca lo suyo |
| `bahiapadel` | `index.html`: pedido de video al reservar, consentimiento de grabación, correo opcional, iconos, diálogo propio, chip "Grabación OK", scroll conservado, PWA | Recepción ve si la grabación está viva; la app se instala en la tablet |
| `bahiapadel` | `correo-diario.js`: solo dice "tu video está listo" si lo está; resumen a `MAIL_BCC` | Nadie recibe una promesa vacía |
| `bahiapadel` | `confirmacion.js`: enlace al video y aviso de grabación en WhatsApp y correo | El cliente sabe desde el principio que se graba |
| `bahiapadel` | `premiosreactivacion.html` sin `onclick`, CSP en `netlify.toml`, pruebas + CI, SQL de versiones | Seguridad y calidad |
| `padelreplayn` | `pedir-video.js` lee el pedido (lo crea solo para reservas antiguas); estados programado/pendiente/procesando/listo; URL firmada opcional | La pantalla dice la verdad en cada momento |
| `padelreplayn` | `index.html`: stepper de progreso, Compartir/Copiar, descarga real, tuteo, accesibilidad, PWA, CSP | Experiencia de cliente cuidada |
| `padel-video-worker` | **Nuevo**: graba, corta, sube, late | El video existe |

---

## 1. Supabase (5 min)

1. Entra a Supabase → tu proyecto → **SQL Editor** → **New query**.
2. Pega el contenido de [`supabase/2026-08-version-kv.sql`](../supabase/2026-08-version-kv.sql) y pulsa **Run**.
3. ✅ La última consulta debe devolver una fila con `version`.

> Sin este paso, la app sigue funcionando pero el servidor responde 500 al guardar con `ifVersion`. Hazlo antes de mezclar el PR del manager.

## 2. Netlify · sitio del manager (`padelmanagerb`) (15 min)

**Site configuration → Environment variables.** Crea o revisa (scope *Functions* para las secretas):

| Variable | Valor |
|---|---|
| `APP_PEDIDO_CODE` | Un código largo nuevo, distinto del admin (p. ej. 24 letras y números). **Anótalo: lo usan el worker y padelreplay.** |
| `SESSION_SECRET` | Otro texto largo aleatorio (si aún no existe) |
| `MAIL_FROM` | `Bahía Padel <reservas@TUDOMINIO.com>` con el dominio **verificado en Resend** (Resend → Domains → Add domain → registros DNS SPF/DKIM). Mientras no lo tengas, los correos pueden caer en spam. |
| `MAIL_REPLY_TO` | correo al que responden los clientes |
| `MAIL_BCC` | tu correo: recibe el resumen diario del cron |
| `CLUB_ADDRESS` | dirección real del club (sale en la invitación de calendario) |
| `CLUB_MAPS_URL` | enlace de Google Maps del club |
| `WEB_URL` | web del club (si no existe `bahiapadel.com`, pon la de Instagram) |
| `WHATSAPP_NUMBER` | `573XXXXXXXXX` (solo dígitos) |

Luego, en GitHub, **mezcla el PR "Fase 1"** del repo `bahiapadel`. Netlify publica solo en 1–2 minutos.

✅ Comprobación: abre `padelmanagerb.netlify.app`, entra con tu código; arriba a la derecha debe aparecer el chip **"Grabación: sin datos"** (gris). Reserva una prueba: el formulario ahora tiene tres casillas y el correo es opcional.

## 3. Cloudflare R2 (20 min)

1. Cloudflare → **R2 Object Storage** → *Create bucket* → nombre `bahia-padel-videos`, ubicación automática.
2. En el bucket → **Settings** → *Public access* → **Allow Access** en *R2.dev subdomain*. Copia la URL (`https://pub-xxxx.r2.dev`).
3. **Object lifecycle rules** → *Add rule* → borrar objetos a los **30 días** (esto cumple la política de retención que aceptan los clientes).
4. R2 → **Manage R2 API Tokens** → *Create API token* → permiso **Object Read & Write**, solo para ese bucket. Copia **Access Key ID**, **Secret Access Key** y el **Account ID** (aparece en la misma pantalla).

## 4. Netlify · sitio de videos (`padelreplay`) (5 min)

Environment variables:

| Variable | Valor |
|---|---|
| `KV_URL` | `https://padelmanagerb.netlify.app/.netlify/functions/kv` |
| `KV_CODE` | el `APP_PEDIDO_CODE` del paso 2 (**cámbialo si hoy tiene el código admin**) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | opcional: si los pones, el enlace del video caduca a las 24 h (`R2_URL_HORAS`). Si no, se usa la URL pública del bucket. |

Mezcla el PR "Fase 1" del repo `padelreplayn`.

✅ Comprobación: abre `padelreplay.netlify.app/?codigo=BP-PRUEBA` → "No encontramos ningún partido con ese código" (la función responde). Con el código de la reserva de prueba del paso 2 → "Tu partido todavía no termina" o "en cola".

## 5. La PC del club (45–60 min)

### 5.1 Windows

- **Zona horaria**: Configuración → Hora e idioma → Fecha y hora → zona **(UTC-05:00) Bogotá, Lima, Quito** y *Establecer hora automáticamente* activado. El worker no arranca si no está en Bogotá.
- **Energía**: Configuración → Sistema → Energía → *Nunca* suspender con corriente. En la BIOS, "Power on after power loss" si existe.
- **Actualizaciones**: Configuración → Windows Update → *Horas activas* 6:00–23:00 para que no reinicie en medio de un partido.

### 5.2 Programas

1. **Node.js LTS**: https://nodejs.org → *Windows Installer (.msi)* → siguiente, siguiente (deja marcado "Add to PATH").
2. **ffmpeg**: https://www.gyan.dev/ffmpeg/builds/ → `ffmpeg-release-essentials.zip` → descomprime en `C:\ffmpeg` (debe existir `C:\ffmpeg\bin\ffmpeg.exe`).
3. **Git**: https://git-scm.com/download/win (o descarga el ZIP del repo desde GitHub → *Code → Download ZIP*).

### 5.3 El worker

Abre **PowerShell** y ejecuta:

```powershell
git clone https://github.com/litodamm-ctrl/padel-video-worker.git C:\padel-worker
cd C:\padel-worker
npm install --omit=dev
copy config.example.json config.json
notepad config.json
```

Completa `config.json`:

- `kv.code` → el `APP_PEDIDO_CODE`.
- `camaras[0].rtsp` → la URL RTSP de tu cámara (tabla por marca en el README del worker). La IP la ves en la app de la cámara o en el router. Ejemplo Hikvision: `rtsp://admin:LaClave@192.168.1.64:554/Streaming/Channels/101`.
- `camaras[0].canchas` → `["Cancha 1", "Cancha 2"]` si una sola cámara ve las dos canchas; si hay una cámara por cancha, dos entradas.
- `r2.*` → lo copiado en el paso 3. `publicBaseUrl` = la URL `https://pub-xxxx.r2.dev`.
- `ffmpeg` → `"C:\\ffmpeg\\bin\\ffmpeg.exe"`.

Pruebas, en este orden:

```powershell
node bin\probar-camara.js     # ✔ responde y graba 8 s de prueba → abre el mp4 y confirma que se ve la cancha
node bin\probar-nube.js       # ✔ zona horaria, manager (modo "pedido") y R2
instalar\iniciar.cmd          # arranca en ventana; en 1 min el manager debe mostrar "Grabación OK"
```

Cuando el chip del manager esté en verde, cierra la ventana (Ctrl+C) e instálalo como tarea de Windows. **PowerShell como administrador**:

```powershell
cd C:\padel-worker\instalar
Set-ExecutionPolicy -Scope Process Bypass -Force
.\instalar-tarea.ps1
```

✅ Reinicia la PC. Sin iniciar sesión, en 2 minutos el chip del manager vuelve a "Grabación OK" y en `C:\padel-worker\grabaciones\cam1\` aparece un archivo nuevo cada 5 minutos.

## 6. Ensayo general (30 min)

1. En el manager reserva **Cancha 1**, hoy, el bloque de 30 min que esté por empezar, con tu teléfono y tu correo. Acepta las tres casillas.
2. Llega el correo con `reserva.ics` y el WhatsApp (tócalo, se abre con el texto y el enlace del video).
3. Juega (o deja pasar) esos 30 minutos delante de la cámara.
4. Entre 3 y 15 minutos después del fin: en `C:\padel-worker\logs\worker-*.log` sale `[BP-XXXX] listo`.
5. Abre el enlace del WhatsApp: el video se reproduce; **Descargar** guarda el archivo; **Compartir** abre la hoja del teléfono.
6. Al día siguiente a las 09:00 llega "Tu video de Bahía Padel ya está listo" y, a tu `MAIL_BCC`, el resumen del cron.
7. Prueba de choque: dos personas reservan el mismo horario a la vez desde dos dispositivos → una lo consigue, la otra ve "Otra persona modificó este día hace un momento".
8. Prueba de apagón: apaga la PC 20 minutos → el chip pasa a "sin señal"; enciéndela → vuelve a OK y termina los pedidos pendientes.

## 7. Antes de abrir al público

- [ ] Cartel visible en cada cancha: **"Cancha con grabación de video · Pide tu partido con tu código"**.
- [ ] Guía de una página en recepción (abajo).
- [ ] QR fijo en cada cancha → `https://padelreplay.netlify.app/`.
- [ ] Decidido quién revisa el correo de `MAIL_BCC` cada mañana y quién va a la PC si el chip está en rojo.
- [ ] Netlify → padelmanagerb → *Functions* → revisa `correo-diario` y `loyaltycron` en los logs una mañana.

## 8. Guía de recepción (imprimir)

**Reservar**: pestaña Cancha → toca un bloque "Libre" → Cancha o Clase → duración → datos del cliente (teléfono obligatorio, correo si lo tiene) → marca "El cliente acepta los tres puntos" → Confirmar → **Enviar confirmación por WhatsApp**.

**El código de video** aparece en el WhatsApp y en la lista del Panel. Si el cliente lo pierde: Panel → busca su reserva → botón WhatsApp (reenvía el mensaje con el código).

**Si el video no aparece**: mira el chip de arriba. Verde = espera 15 minutos después del fin del partido. Amarillo/rojo = avisa a quien administra la PC del club. El cliente siempre puede escribir al WhatsApp del club desde la propia pantalla del video.

**Premios**: `padelmanagerb.netlify.app/premiosreactivacion.html` → pestaña Recepción → escribe el código del premio → Marcar como canjeado.

## 9. Si algo falla

| Síntoma | Dónde mirar |
|---|---|
| Chip "Grabación: sin datos" para siempre | El worker no llegó a escribir el latido: `kv.code` mal o PC sin internet. `node bin\probar-nube.js` |
| Chip "Cámara cam1 sin señal" | RTSP caído: cable PoE, IP cambió (pon IP fija en el router), clave. `node bin\probar-camara.js` |
| Video en "error: No hay grabación de …" | A esa hora la PC estaba apagada o la cámara caída. No se recupera; el cliente ve "escríbenos". |
| "Descargar" abre el video en vez de guardarlo | El objeto se subió sin `Content-Disposition`: solo pasa con videos anteriores a esta versión. |
| Correo de la mañana no llega | Netlify → Functions → `correo-diario` → logs. Revisa `RESEND_API_KEY` y que `MAIL_FROM` sea un dominio verificado. |
| "Otra persona modificó este día" sin que nadie más esté | Falta el SQL del paso 1 o dos pestañas del mismo equipo. Recarga. |
| Netlify avisa de límite de funciones | Con 60 s de sondeo son ≈22.000/mes; si se pasa, revisa que no queden pestañas viejas abiertas en varios equipos. |
