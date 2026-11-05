# Sincronización opcional del Spam de Gmail

La integración viene desactivada. Solo se habilita para una instalación que configure `gmailSync.enabled: true` y sus credenciales de producción. En Ajustes, la pestaña **Gmail** muestra el estado, inicia la conexión, permite sincronizar y desconectar.

```json
"gmailSync": {
  "enabled": true,
  "intervalMinutes": 5
}
```

`intervalMinutes` acepta de 5 a 60 minutos; si se omite, usa 5. La tarea programada despierta cada cinco minutos cuando la función está habilitada y el intervalo limita cuándo puede volver a reclamar una sincronización.

## Acceso y datos

La autorización solicita solo `https://www.googleapis.com/auth/gmail.metadata`. Google clasifica este scope como **restringido**: permite ver etiquetas y cabeceras, pero no cuerpos ni adjuntos. El permiso concedido alcanza los metadatos del buzón Gmail conectado; el Worker aplica una selección más estrecha y busca copias asociadas a las direcciones `mailbox.address` e `identities` de esta instalación. Las cabeceras pueden contener datos personales, aunque esta integración nunca solicita el cuerpo del mensaje.

Las llamadas a Gmail son de lectura (`GET`): perfil, listado, historial y metadatos de mensajes. No marca mensajes como leídos, no mueve ni etiqueta mensajes, no envía correo y no borra originales en Gmail. La autorización usa solicitudes al endpoint OAuth para intercambiar y renovar tokens; esas solicitudes no son cambios en el buzón.

El scope `gmail.metadata` no permite usar el parámetro de búsqueda `q`. Por eso el Worker no ejecuta búsquedas Gmail: enumera la etiqueta `SPAM` con `labelIds=SPAM` e `includeSpamTrash=true`, y solicita metadatos con `format=metadata`. La API limita los elementos de la lista y la sincronización procesa como máximo 20 mensajes de Gmail por ciclo. Se reexaminan los identificadores ya vinculados y luego se sigue el historial incremental; cada ciclo reconcilia hasta 10 copias locales.

Para asociar una copia se exige un único `Message-ID` válido y al menos un destinatario que coincida exactamente con una identidad configurada. Se consideran cabeceras de destinatario `To`, `Cc`, `Delivered-To`, `X-Original-To`, `X-Forwarded-To` y `X-GM-Original-To`. El asunto, remitente, nombre y fecha no sirven como claves. Un wrapper antiguo puede tener su propio `Message-ID` distinto del original, o no tenerlo; esos mensajes no se asocian por aproximación.

El Worker conserva solo observaciones de mensajes que coinciden: el identificador Gmail, `Message-ID`, destinatarios institucionales coincidentes, estado de la etiqueta `SPAM` y fechas de control. No conserva el asunto ni cuerpos recibidos desde Gmail. Cuando llega después una copia local con esa identidad exacta, se aplica la observación vigente. La observación expira según la retención configurada para el buzón. Si Gmail quita la etiqueta `SPAM` o la respuesta de metadatos omite `labelIds`, la observación pasa a «no spam».

Una vez terminado el escaneo inicial, el cursor sigue los cambios recientes de Gmail. Cuando el ciclo vuelve a la fase de historial y han transcurrido más de 24 horas desde el inicio del escaneo anterior, empieza otra exploración de Spam. La exploración completa puede tardar más de un día si hay muchas páginas: solo avanza una página por ciclo programado; el intervalo de 24 horas programa el reinicio, no garantiza que cada exploración termine en 24 horas.

La precedencia de clasificación es **decisión manual > regla de la empresa > remitente bloqueado configurado > Gmail > señal upstream**. Gmail no reemplaza decisiones `manual`, `rule` ni `blocked_sender`; sus observaciones pueden corregir una clasificación automática upstream. Las reglas y las acciones manuales pertenecen a la copia local, no cambian Gmail. Consulta [Spam y recuperación](SPAM.md) y [Etiquetas y reglas de organización](ORGANIZATION.md).

## OAuth y puesta en producción

En Google Cloud habilita Gmail API, crea un cliente OAuth de tipo **Web application** y registra como URI autorizada exacta:

`https://<dominio-del-webmail>/api/gmail/callback`

Conecta desde la pestaña **Ajustes → Gmail** usando la cuenta de archivo configurada en `archiveAddress`. El callback verifica que el perfil Gmail devuelto corresponda a esa cuenta. Una sesión webmail autorizada para el buzón debe iniciar el flujo; la ruta raíz también aplica los controles de autenticación y origen.

El flujo comprueba `state`, una cookie de navegador y PKCE. Guarda hashes de `state` y de la prueba del navegador, y consume cada transacción una sola vez. El token de actualización se cifra con AES-GCM. `GMAIL_TOKEN_KEY` debe ser un secreto base64url sin padding que represente 32 bytes aleatorios (43 caracteres). El cifrado incluye un contexto de instalación —origen de la aplicación, ID del buzón, dirección de archivo e ID del cliente OAuth— para impedir reutilizar el token en otro contexto.

Guarda `GMAIL_CLIENT_SECRET` y `GMAIL_TOKEN_KEY` como secretos del Worker, nunca en `COMPANY_CONFIG`, un manifiesto JSON, el navegador, una URL o logs. `GMAIL_CLIENT_ID` es opcional: si no se establece, se usa `GOOGLE_CLIENT_ID`; `GMAIL_CLIENT_SECRET` también puede reutilizar `GOOGLE_CLIENT_SECRET`. Si usas un cliente Gmail distinto, configura su ID en el despliegue como `GMAIL_CLIENT_ID`. Conserva la misma clave de token entre despliegues; cambiar la clave o el contexto de autorización exige desconectar y volver a conectar.

Google indica que los proyectos OAuth externos en estado **Testing** emiten refresh tokens que caducan a los 7 días cuando solicitan scopes distintos del perfil básico. Volver a conectar cada semana no es una solución para producción: publica el proyecto apropiado y completa las revisiones que correspondan antes de habilitar esta función para usuarios reales.

Después de generar y comprobar el despliegue, `npm run gmail:key` instala una clave aleatoria en el Worker configurado. Conserva una clave existente y nunca muestra ni guarda localmente su valor. El ID público de un cliente separado puede declararse como `gmailClientId` en `deployment.local.json`; el generador lo convierte en `GMAIL_CLIENT_ID`.

Google clasifica `gmail.metadata` como scope restringido. La verificación OAuth restringida y las evaluaciones de seguridad que exija Google son requisitos de lanzamiento para la aplicación que solicita y almacena esos datos. Google contempla una excepción para un uso auténticamente personal y limitado a pocas personas conocidas; no cubre la comercialización de un webmail para varias empresas. No reduzcas ni disfraces la audiencia o el uso para saltar las revisiones.

Esta integración no requiere habilitar facturación ni registrar una tarjeta como paso de configuración. No solicites ampliaciones de cuota de pago para ponerla en marcha; revisa las cuotas y condiciones vigentes de Google antes de aumentar el volumen.

Referencias oficiales:

- [Scopes de Gmail y clasificación de `gmail.metadata`](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Listado de mensajes: `q` no está permitido con `gmail.metadata`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [OAuth web server y acceso offline](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Estado Testing y expiración de refresh tokens](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Sincronización completa e incremental con Gmail](https://developers.google.com/workspace/gmail/api/guides/sync)
- [Cuándo no se necesita verificación](https://support.google.com/cloud/answer/13464323)
- [Scopes restringidos de Google](https://support.google.com/cloud/answer/13464325)
- [Política de datos de Google Workspace y scopes restringidos](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)
- [Requisitos de verificación y evaluación de scopes restringidos](https://support.google.com/cloud/answer/13464321)
- [Evaluación de seguridad de Google](https://support.google.com/cloud/answer/13465431)
- [Cuotas actuales de Gmail API](https://developers.google.com/workspace/gmail/api/reference/quota)

Para ver cómo esta integración encaja en el producto, consulta también el [README](../README.md).

Las copias y decisiones guardadas en el webmail son independientes de Gmail. Desconectar elimina la conexión y los vínculos/observaciones Gmail; conserva los mensajes locales, sus etiquetas y sus decisiones.
