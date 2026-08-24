# Lo que falta · Bahía Padel

`padelreplayn` ya está completo y verificado en vivo: los docs devuelven 404, el
`index.html` nuevo está publicado y el freno de fuerza bruta de `pedir-video`
funciona (probé 26 consultas seguidas: 19 pasaron, 7 devolvieron 429).

Todo lo de esta carpeta es del manager (`bahiapadel`). En orden:

| | Paso | Archivo | Cuánto |
|---|---|---|---|
| 1 | Variables de correo en Netlify | `00-VARIABLES-NETLIFY.md` | 5 min |
| 2 | Mover `confirmacion.js` | `01-MOVER-confirmacion.md` | 1 min |
| 3 | Pegar los dos parches en `index.html` | `02-PEGAR-en-index.md` | 10 min |
| 4 | Reemplazar `netlify.toml` | `netlify.toml` | 1 min |

El paso 1 es el que desbloquea todo: sin `RESEND_API_KEY` no sale ningún correo.

Los pasos 2, 3 y 4 se pueden hacer antes que el 1 sin romper nada — la
confirmación devuelve «falta la key», el WhatsApp sale igual y la reserva se
guarda igual. Pero el correo no va a salir hasta que cargues la variable.

## Después de esto quedan dos frentes que no puedo ver desde acá

- **Cloudflare R2** — el bucket, el token y la regla de borrado a 90 días.
- **La PC HP y la cámara** — está todo en el `README.md` del worker.

Los dos están en el checklist: fases 2 y 3.
