# Bahía Padel · Manager de reservas

App interna de recepción en **https://padelmanagerb.netlify.app**: reservas de cancha y clases, bloqueos, panel con métricas, premios por recurrencia y confirmaciones por correo (con invitación de calendario) y WhatsApp.

Es una de las cuatro piezas del sistema. El mapa completo está en el repo `padelreplayn` → `docs/ARQUITECTURA.md`. La guía para dejar todo funcionando en el club está en [`docs/PUESTA-EN-MARCHA.md`](docs/PUESTA-EN-MARCHA.md).

## Qué hay en este repositorio

```
index.html                         pantalla de recepción (reservas, clases, panel)
premiosreactivacion.html           pantalla de premios y campañas de reactivación
manifest.webmanifest, icono-*.png  para instalar la app en la tablet
netlify.toml                       cron, redirects y cabeceras de seguridad (CSP)
netlify/functions/
  kv.js            única puerta a Supabase: auth, get/set con versión, mset, listv, dia.get
  confirmacion.js  correo con .ics + texto de WhatsApp al reservar / editar / cancelar
  correo-diario.js cron 09:00 Bogotá: correo del video (solo si existe) + premios
  loyalty.js       premios por hitos y campañas
  loyaltycron.js   cron 01:00 Bogotá: emite y vence premios
supabase/          SQL que hay que correr una vez (control de versiones en kv)
tests/             pruebas (node --test) de kv.js y correo-diario.js
```

## Cómo fluye una reserva

1. Recepción reserva en `index.html`. Se guarda el día en `cancha:<fecha>` con **control de versiones** (si dos personas reservan a la vez, la segunda recibe un aviso y recarga: nadie pisa a nadie).
2. En la misma acción se escriben `video:<codigo>` (para la app de videos) y `pedido:<codigo>` en estado **programado** (para el worker del club).
3. `confirmacion.js` manda el correo con la invitación `.ics` y devuelve el texto de WhatsApp, que incluye el enlace al video.
4. Cuando el partido termina, el **worker** de la PC del club corta el video y marca el pedido como **listo**.
5. A las 09:00 del día siguiente, `correo-diario.js` manda "tu video ya está listo" **solo si lo está**; si no, espera hasta 3 días y luego manda un "gracias por jugar" sin prometer video.
6. El Panel muestra **Grabación OK / sin señal** con el latido que escribe el worker (`worker:heartbeat`).

## Variables de entorno (Netlify → Site configuration → Environment variables)

| Variable | Obligatoria | Para qué |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | sí | Base de datos (solo scope Functions) |
| `ACCESS_CODES` (`david:xxx,sary:yyy`) o `APP_ACCESS_CODE` | sí | Código de entrada del staff |
| `ADMIN_PINS` (`david:1234`) o `ADMIN_PIN` | sí | PIN del Panel |
| `SESSION_SECRET` | recomendada | Token de sesión con caducidad |
| `APP_PEDIDO_CODE` | **sí** | Código del worker y de la app de videos (solo `video:*`, `pedido:*`, `worker:*`) |
| `APP_READ_CODE` | no | Solo lectura de `video:*` |
| `RESEND_API_KEY`, `MAIL_FROM` | sí | Correos. `MAIL_FROM` debe ser un dominio verificado en Resend |
| `MAIL_REPLY_TO`, `MAIL_BCC` | recomendadas | Respuestas del cliente · resumen diario al club |
| `CLUB_ADDRESS`, `CLUB_MAPS_URL`, `WEB_URL`, `WHATSAPP_NUMBER`, `BOOK_URL` | recomendadas | Textos de correos y WhatsApp |
| `REPLAY_URL` | no | Por defecto `https://padelreplay.netlify.app/` |

## Pruebas

```
npm test
```

Corren solas en GitHub Actions en cada PR (`.github/workflows/pruebas.yml`).

## Base de datos

Una sola vez, en Supabase → SQL Editor: [`supabase/2026-08-version-kv.sql`](supabase/2026-08-version-kv.sql). Añade la columna `version` a `kv` y activa RLS en las tres tablas.
