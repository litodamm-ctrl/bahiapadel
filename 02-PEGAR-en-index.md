# Paso 3 · Los dos parches en `index.html` del manager

Son dos bloques, en dos lugares distintos del mismo archivo. Los dos van dentro
del `<script>` grande, al nivel de las otras funciones.

## Parche 1 — el helper

**Archivo:** `01-helper-enviarConfirmacion.js`

**Dónde:** buscá con `Ctrl+F` esta línea (está cerca de la 614):

```js
async function deleteVideoIndex(codigo){
```

Pegá el bloque **después de que esa función cierre** — o sea, después de su
`}`, antes de lo que siga. Cerca de la línea 619.

> Si te resulta más cómodo, este bloque puede ir en cualquier lugar del mismo
> `<script>` mientras esté al nivel de las otras funciones: las declaraciones
> `async function` se registran antes de que corra nada.

## Parche 2 — la llamada

**Archivo:** `02-llamada-en-la-reserva.js`

**Dónde:** buscá con `Ctrl+F` esta línea exacta (cerca de la 796):

```js
  state.lastConfirmation = { phone, message: msg };
```

Pegá el bloque **justo antes** de esa línea.

Arriba de ese punto ya quedó armado el mensaje de WhatsApp con el código de
video y el bloque de premio; el parche le suma el enlace de calendario que
devuelve el servidor. Por eso va ahí y no antes: si lo ponés más arriba, el
enlace se pierde.

## Cómo saber que salió bien

Hacé una reserva de prueba **con tu propio correo** y mirá tres cosas:

1. El mensaje de WhatsApp termina con `Agrégala a tu calendario: https://…`
2. Te llega el correo con el adjunto `reserva.ics`
3. Al abrir el `.ics`, el evento cae en el **horario correcto** de la reserva

Si el WhatsApp sale sin el enlace de calendario, abrí la consola del navegador
(F12): el helper deja anotado ahí qué pasó, sin romper la reserva.

## Paso 4 — reemplazar `netlify.toml`

El archivo `netlify.toml` de esta carpeta va tal cual, reemplazando el actual.
Agrega una regla que devuelve 404 en `/confirmacion.js` por si queda algún
deploy viejo cacheado.
