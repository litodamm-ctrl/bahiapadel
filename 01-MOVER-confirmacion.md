# Paso 2 · Mover `confirmacion.js` a donde Netlify la ve

Verificado hoy:

- `padelmanagerb.netlify.app/.netlify/functions/confirmacion` → **404** (la
  función no existe)
- `padelmanagerb.netlify.app/confirmacion.js` → **200** (el código de servidor
  se lee entero desde internet)

Las dos cosas se arreglan con el mismo movimiento: Netlify solo despliega lo que
está en `netlify/functions/`, y solo publica como archivo estático lo que está
fuera de ahí.

## Cómo

1. Abrí `https://github.com/litodamm-ctrl/bahiapadel/blob/main/confirmacion.js`
2. Botón **Edit** (el lápiz, arriba a la derecha)
3. En la casilla del **nombre del archivo**, arriba del editor, borrá
   `confirmacion.js` y escribí:

   ```
   netlify/functions/confirmacion.js
   ```

   GitHub entiende la barra como carpeta y mueve el archivo.
4. **Commit changes**

> Movelo con el renombrado, **no** copiando y pegando el contenido en un archivo
> nuevo: así queda idéntico byte por byte y no se cuela ningún error de copiado.

## Cómo saber que salió bien

Después del deploy (un par de minutos):

- `padelmanagerb.netlify.app/confirmacion.js` → **404**
- En Netlify → *Logs & metrics → Functions* aparece **confirmacion** en la lista,
  al lado de `correo-diario`, `kv`, `loyalty` y `loyaltycron`.
