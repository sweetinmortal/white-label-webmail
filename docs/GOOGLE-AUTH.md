# Inicio de sesión con Google

Google es un proveedor de autenticación opcional por instalación. La omisión de `auth` conserva Cloudflare Access; para Google, agrega a la configuración de empresa:

```json
"auth": { "provider": "google" }
```

`allowedUsers` sigue siendo la lista de correos autorizados y también se aplica a las cuentas de Google. El Worker compara el correo verificado con esa lista antes de abrir la bandeja.

## Proyecto OAuth

En Google Cloud crea un cliente OAuth de tipo **Web application**. Configura como URI de redirección autorizada la URL exacta `https://<dominio-del-webmail>/api/auth/google/callback`. El flujo solicita únicamente los scopes `openid email`: autentica la identidad y obtiene el correo verificado. No habilita Gmail API, no lee el buzón de Google ni solicita permisos para enviar correo. El transporte de mensajes sigue usando el proveedor de correo configurado para esta instalación.

Este acceso no requiere tarjeta ni habilitar billing. No habilites billing ni APIs de pago para el inicio de sesión. Google puede presentar avisos de verificación o límites de usuarios según el estado y la audiencia configurados para el proyecto; revisa la [guía de OpenID Connect de Google](https://developers.google.com/identity/openid-connect/openid-connect) y la [configuración de clientes web](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid).

El cliente y los secretos se guardan por separado:

- `deployment.local.json`: `accountId`, `d1DatabaseId` y `googleClientId`. El identificador debe tener el formato `1234567890-abcd.apps.googleusercontent.com`. En modo Google no incluyas `accessTeamDomain` ni `accessAudience`.
- `wrangler.production.jsonc`: `GOOGLE_CLIENT_ID` generado desde el manifiesto; es configuración pública, no un secreto.
- Secreto runtime del Worker: `GOOGLE_CLIENT_SECRET`. No lo guardes en el manifiesto, en variables versionadas ni en el navegador.

En modo Access se mantienen los campos `accessTeamDomain` y `accessAudience`, y sus validaciones actuales. El `doctor` lista los secretos runtime requeridos, pero no consulta Cloudflare ni comprueba sus valores.

## Sesión y retorno

La interfaz obtiene `GET /api/auth/options`; solo presenta el acceso de Google cuando el proveedor devuelto es `google`. `POST /api/auth/google/start` recibe `returnTo` como ruta, query y fragmento actuales y devuelve una URL de Google. El navegador usa la redirección sin cargar SDK ni scripts remotos de Google.

El inicio está limitado globalmente a 10 intentos por minuto. No se conserva la dirección IP para aplicar este límite. Las transacciones OAuth duran 10 minutos y las sesiones de autenticación duran 6 horas; ambas tienen su propio ciclo de vida y no heredan la retención configurada para los mensajes del buzón.

El callback valida la transacción OAuth, el ID token y el correo autorizado antes de crear una sesión. La migración `0004_auth.sql` creó `mail_auth_transactions` y `mail_auth_sessions`; el servidor guarda hashes de tokens opacos de sesión, revocables y con duración de 6 horas. La migración `0005_auth_consumption.sql` añade `consumed_at`; el callback consume cada transacción una sola vez y conserva su fila hasta que expire, de modo que los inicios completados o fallidos sigan dentro del límite de 10 por minuto. La cookie de sesión usa prefijo `__Host-`, `HttpOnly`, `Secure` y `SameSite=Lax`. El cierre de sesión usa `POST /api/auth/logout`; no redirige al logout de Cloudflare.

El intercambio del código usa `fetch` con `redirect: "manual"`, que workerd admite junto con `"follow"`; cualquier respuesta no exitosa, incluidos los `3xx`, se rechaza sin seguir su `Location`. Los diagnósticos de fallos técnicos del callback registran solo un evento y una etapa de una lista fija (`browser_proof`, `transaction`, `authorization_code`, `token_exchange`, `id_token`, `verify_token`, `claims` o `session`), además del estado HTTP cuando hay respuesta. No incluyen URL, query, cabeceras, cookies, código OAuth, cuerpo del proveedor, tokens ni datos de usuario.

Si el callback falla, la aplicación recibe `authError=denied` o `authError=failed`. La interfaz muestra un mensaje fijo, elimina solo ese parámetro y conserva el resto del retorno, incluido `reply`. Una sesión expirada devuelve la interfaz al login y limpia el estado de mensajes que estaba en memoria.
