# Paso 1 · Variables de correo en Netlify

**Esto es lo que desbloquea todo lo demás.** Sin `RESEND_API_KEY` no sale ningún
correo: ni el de confirmación al reservar, ni el de «ya está tu video».
`correo-diario` viene abortando todos los días a las 9:00 desde el 12 de agosto.

Verificado hoy: `padelmanagerb` sigue con solo 6 variables y ninguna de correo.

## Dónde

`https://app.netlify.com/projects/padelmanagerb/configuration/env` → **Add a variable**

Scope: **Functions** en todas.

## Qué cargar

| Variable | Valor |
|---|---|
| `RESEND_API_KEY` | tu key de Resend |
| `MAIL_FROM` | `Bahía Padel <hola@bahiapadel.com>` |
| `MAIL_REPLY_TO` | `reservas@bahiapadel.com` |
| `WEB_URL` | `https://bahiapadel.com` |
| `WHATSAPP_NUMBER` | el WhatsApp del club, solo dígitos con indicativo: `57…` |

Opcionales, pero sin ellas el evento del calendario sale sin dirección:

| Variable | Valor |
|---|---|
| `CLUB_NAME` | `Bahía Padel Social Club` |
| `CLUB_ADDRESS` | la dirección que aparece en el evento |
| `CLUB_MAPS_URL` | el enlace de Google Maps del club |
| `MAIL_BCC` | copia oculta al club, ej. `reservas@bahiapadel.com` |

## Dos cosas que te van a frenar si no las hacés

**1. La key.** La que compartiste en el chat quedó expuesta. Generá una nueva en
Resend → *API Keys* → **Create API Key**, y revocá la vieja.

**2. El dominio.** Resend solo deja enviar desde un dominio verificado. Entrá a
Resend → *Domains* → agregá `bahiapadel.com` y cargá los registros SPF y DKIM
que te da, donde tengas el DNS. **Sin esto los correos solo llegan a tu propia
casilla** — los clientes no reciben nada, y no da error visible.

## Al terminar

*Deploys → Trigger deploy → Deploy site*. Las variables no se aplican hasta
que hay un deploy nuevo.

Para probar sin esperar a mañana: *Logs & metrics → Functions → `correo-diario`
→ **Run now***. Ojo: si hay reservas de ayer con correo, **manda correos de
verdad**.
