# Instalar para una empresa

Cada instalación tiene una bandeja común para sus direcciones. La configuración no crea cuentas de correo, aliases ni reglas del proveedor. El equipo debe aprovisionar cada dirección y verificar los dominios antes de enrutar tráfico.

## 1. Preparar marca y configuración

Revisa la marca de ejemplo en `public/brand/logo.svg`; reemplázala por el SVG aprobado de la empresa y conserva ese path. Copia `config/companies/example.json` a un archivo de la empresa y completa:

- `mailbox`: dirección principal y nombre de la bandeja;
- `identities`: direcciones disponibles en el selector From y en el filtro;
- `allowedUsers`: direcciones autorizadas para toda la instalación; se comprueban también en el modo Google;
- `auth`: opcional; omítelo para usar Cloudflare Access o configura `{"provider":"google"}` para inicio de sesión Google;
- `archiveAddress`: buzón de archivo independiente;
- `appOrigin`, retención, almacenamiento y límites;
- `maxAttachments` y `maxAttachmentBytes`: máximo de archivos por envío y suma binaria de adjuntos. Los valores seguros para Mailjet Free son 5 archivos y 5 MB; no los aumentes sin revisar el límite total de 15 MB del proveedor, el inflado base64 y la copia de archivo duplicada;
- `incomingSummary`: resumen diario con horario y zona configurables. Si se activa, `from.email` debe ser una dirección autorizada en Cloudflare Email Service;
- `spamProtection`: protección configurable con `enabled` y una lista inicial vacía `blockedSenders`; cada instalación administra su propia lista.
- `gmailSync`: integración opcional de metadatos de Spam Gmail, desactivada si se omite. Revisa primero [Sincronización opcional del Spam de Gmail](GMAIL-SPAM-SYNC.md) por su scope restringido y sus requisitos de publicación.

La dirección principal puede aparecer en `identities`; el Worker la conserva una sola vez. No repitas otras direcciones ni uses el archivo como identidad. Se admiten hasta veinte identidades. El remitente del resumen no se agrega al selector From: es una identidad de servicio y debe configurarse explícitamente.

Todos los usuarios de `allowedUsers` pueden leer todos los mensajes y enviar desde cualquier identidad configurada. No uses una instalación para grupos que necesiten separación de datos.

### Reenvío y resumen

Cada original entrante válido se reenvía inmediatamente con el reenvío nativo del proveedor a `archiveAddress`. No se genera una carátula, no se adjunta `original.eml` y no se envía un aviso separado. El original completo también queda en el almacenamiento temporal para lectura, descarga y respuesta desde el webmail.

El resumen es un flujo independiente:

```json
"incomingSummary": {
  "enabled": true,
  "from": { "name": "Webmail de Mi Empresa", "email": "webmail@empresa.example" },
  "timeZone": "UTC",
  "schedule": { "hour": 8, "minute": 0, "weekdaysOnly": true }
}
```

- Se cuenta por empresa y buzón compartido, no por usuario.
- Solo cuentan entradas válidas y deduplicadas por `recipient + Message-ID`.
- Se excluyen enviados, callbacks, alertas de uso, mensajes Archivados o Spam y los propios resúmenes.
- Se envían los mensajes pendientes en el horario configurado, agrupados en correos de hasta 100 elementos; un día con más entradas puede producir varios correos.
- Cada resumen tiene un único botón general **Ver webmail**.
- El resumen se envía a `archiveAddress` mediante el binding `ARCHIVE_EMAIL_COPY` y el remitente de servicio configurado.
- El estado se guarda en D1. Un fallo de D1, Turso o del resumen no bloquea el reenvío del original.

El estado de un lote distingue `accepted`, `failed` y `unknown`. Un lote marcado como `sending` que queda obsoleto pasa a `unknown` y no se reintenta automáticamente; un `claiming` obsoleto devuelve sus elementos a `pending`. Un `failed` solo representa un fallo definitivo antes de llamar al proveedor: sus elementos vuelven a `pending` para un máximo de 3 intentos y después quedan `failed`. Un `unknown` no se reencola. Un fallo de D1 tampoco se usa como motivo para duplicar el original.

### Filtros, Spam, borradores y envíos programados

`incomingFilters` configura por instalación los mensajes que van a **Archivados**: permanecen disponibles para revisar y responder, pero no aparecen en Recibidos ni en el resumen. Esta carpeta conserva compatibilidad con los filtros heredados antes llamados Filtrados; si restauras uno de esos mensajes a Recibidos, mantiene su etiqueta. La protección de Spam es independiente de esos filtros; clasifica según señales del mensaje y `spamProtection.blockedSenders`. Los originales siempre se reenvían al archivo. Revisa [Spam y recuperación](SPAM.md) para las señales y el procedimiento de corrección. Las [etiquetas y reglas](ORGANIZATION.md) administradas desde Ajustes son locales al webmail y no modifican esos filtros de configuración.

### Gmail opcional

La integración Gmail permanece desactivada salvo que el manifiesto de empresa tenga `"gmailSync": { "enabled": true }`. Configura la cuenta de archivo y el cliente OAuth Web con el callback exacto `https://<dominio-del-webmail>/api/gmail/callback`. Los secretos de cliente y la clave AES-GCM se almacenan en el runtime del Worker, no en el JSON de la empresa o el manifiesto:

```powershell
npx wrangler secret put GMAIL_CLIENT_SECRET --config wrangler.production.jsonc
npx wrangler secret put GMAIL_TOKEN_KEY --config wrangler.production.jsonc
```

Genera `GMAIL_TOKEN_KEY` a partir de 32 bytes aleatorios codificados en base64url sin padding. Si no defines `GMAIL_CLIENT_ID` y `GMAIL_CLIENT_SECRET`, el Worker reutiliza `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` cuando existan. Si usas un cliente separado, configura `gmailClientId` en `deployment.local.json`; el generador lo publica como `GMAIL_CLIENT_ID`, y su secreto va en `GMAIL_CLIENT_SECRET`. Habilitar Gmail requiere además aprobar el uso del scope restringido y las evaluaciones de Google que correspondan. No actives facturación ni agregues tarjeta para configurar esta integración. Consulta la [guía completa de Gmail](GMAIL-SPAM-SYNC.md) antes de publicarla.

Los borradores se guardan automáticamente y son privados del usuario autenticado. Se almacenan en el backend configurado junto con los adjuntos. Los envíos programados se muestran en **Enviados**; la fecha y hora que elige la persona usan la zona local del navegador y se almacenan en UTC.

El Worker usa `* * * * *` para reclamar envíos programados y comprobar el horario configurable del resumen. `15 * * * *` conserva las tareas de mantenimiento y alertas. El horario del resumen se define con `incomingSummary.timeZone` y `incomingSummary.schedule`; no requiere un cron fijo para una zona geográfica concreta.

## 2. Elegir autenticación

Cloudflare Access sigue siendo el modo predeterminado y conserva sus valores de manifiesto y validaciones. Para Google, sigue [Inicio de sesión con Google](GOOGLE-AUTH.md): configura un cliente OAuth web, añade `googleClientId` al manifiesto y deja fuera `accessTeamDomain` y `accessAudience`. En ambos modos `allowedUsers` restringe quién entra.

## 3. Preparar Cloudflare

Aprovisiona un Worker separado, una base D1 y almacenamiento temporal R2 o Turso. Para el modo Access, crea una aplicación Cloudflare Access y restríngela a los usuarios autorizados. Configura por separado la recepción de cada dirección hacia el Worker.

Copia `deployment.example.json` a `deployment.local.json` y completa los identificadores y nombres de recursos. En modo Access, incluye los valores Access requeridos; en modo Google, incluye `googleClientId` y omite `accessTeamDomain` y `accessAudience`. Para R2, completa `r2Bucket`; para Turso, `tursoDatabaseUrl`. El archivo local está excluido de Git: no pongas tokens en él.

Genera manifiestos con `npm run configure -- --company config/companies/empresa.json`. Sin `deployment.local.json`, se generan solo el borrador y la configuración local. Con el manifiesto completo se genera también `wrangler.production.jsonc`; el comando no crea recursos, configura aliases ni despliega.

### Binding del resumen

El binding `ARCHIVE_EMAIL_COPY` se genera si las copias de archivo o el resumen están activos. Debe cumplir:

- `destination_address`: `archiveAddress`;
- `allowed_sender_addresses`: la dirección principal y, si el resumen está activo, `incomingSummary.from.email`.

La dirección del resumen debe estar verificada y autorizada en Cloudflare Email Service para el dominio. Añadirla al manifiesto no la verifica ni crea el remitente en el proveedor. Tampoco la añadas a `identities`.

## 4. Verificar proveedores y preparar secretos

Mailjet sigue siendo el adaptador de correo saliente de producción. Verifica el dominio remitente y cada dirección de `identities` en Mailjet; publica y valida los registros SPF y DKIM que indique el proveedor.

Configura el callback HTTPS `https://<dominio-del-webmail>/api/webhooks/mailjet`. Si Access bloquea ese callback, limita el bypass a la ruta exacta `/api/webhooks/mailjet`; el Worker mantiene Basic Auth. Crea secretos de Wrangler para:

- `MAILJET_API_KEY` y `MAILJET_API_SECRET`;
- `MAILJET_WEBHOOK_USER` y `MAILJET_WEBHOOK_PASSWORD`;
- `TURSO_AUTH_TOKEN` si el almacén es Turso;
- `CF_USAGE_API_TOKEN` si se habilitan alertas de uso;
- `GOOGLE_CLIENT_SECRET` si `auth.provider` es `google`;
- `ARCHIVE_LINK_KEY`, necesaria para los enlaces de respuesta de las copias archivadas.

Ejecuta `npm run archive:key` después de generar la configuración de producción y antes de recibir enlaces de respuesta archivados. La clave es propia de la instalación. El script conserva una clave remota existente; rotarla invalida los enlaces antiguos.

Si Gmail está habilitado, agrega también `GMAIL_CLIENT_SECRET` y `GMAIL_TOKEN_KEY` con los comandos del apartado [Gmail opcional](#gmail-opcional). `GMAIL_CLIENT_ID` es configuración, no secreto; se genera si declaraste `gmailClientId`.

La configuración de `identities` no habilita aliases remotos, rutas de entrada ni remitentes de Mailjet. Completa y prueba esas operaciones en los servicios externos por cada dirección.

## 5. Aplicar migraciones y desplegar

Aplica las migraciones D1 en orden con la configuración de producción antes de desplegar. Conserva los nombres históricos `0001`–`0009`: varias instalaciones ya aplicaron `0007_incoming_filters.sql`, `0008_drafts.sql` y `0009_scheduled_send_and_labels.sql`; no los renombres ni los reapliques con otros nombres, en particular `0009` agrega `scheduled_at`. Las migraciones aditivas `202611040900_message_spam.sql`, `202611041000_organization.sql` y `202611041100_gmail_sync.sql` crean las tablas locales de spam, etiquetas/reglas y vínculo/observación Gmail. Haz un respaldo D1 antes de aplicar migraciones nuevas. Usa como nombre de base el configurado en `deployment.local.json`, por ejemplo:

`npx wrangler d1 migrations apply company-mail --remote --config wrangler.production.jsonc`

Si usas Turso, aplica `turso-migrations/0001_objects.sql` mediante el flujo SQL aprobado por tu proveedor. No guardes el token de Turso en Git ni en el manifiesto.

Ejecuta `npm run deploy:check` para typecheck, pruebas, build, doctor estricto y dry run. Revisa la configuración generada y aplica el procedimiento de publicación de tu empresa; `npm run deploy` realiza el despliegue real.

Comprueba entrada para cada dirección, reenvío inmediato al archivo, remitentes From, filtros, revisión y restauración de Spam, borradores, envíos programados, resumen diario y callback. La aceptación del proveedor no demuestra entrega final.

## Formato, imágenes y adjuntos

- El webmail conserva el HTML del mensaje en un iframe aislado sin scripts ni formularios. Las imágenes CID se resuelven desde el propio MIME; las imágenes remotas quedan bloqueadas hasta que la persona pulse **Mostrar imágenes**.
- El original entrante se reenvía de forma nativa, sin modificar su cuerpo, remitente, asunto ni adjuntos. La copia de archivo de los mensajes salientes conserva el HTML saneado y un pie mínimo con **Responder en el webmail**.
- Los adjuntos se validan en el navegador y de nuevo en el Worker. Se muestran nombre y tamaño antes de enviar, se pueden quitar y quedan disponibles en Enviados, en la descarga y en la copia de archivo.
- En redactar y responder se aceptan uno o varios archivos por selector o arrastrando y soltando. Se respetan 5 archivos, 5 MiB en total y el rechazo de archivos vacíos o carpetas. Soltar un archivo no envía el mensaje y el selector sigue disponible con teclado y en móvil.

## Cuotas y retención

Los límites diarios y mensuales de destinatarios incluyen a todos los usuarios y las copias de archivo cuando corresponda. El presupuesto temporal y la retención también se comparten. Revisa las cuotas, precios y condiciones actuales de Cloudflare, Mailjet y del proveedor de almacenamiento. Los valores de ejemplo no implican capacidad gratuita o ilimitada.

Gmail conserva copias independientes. La integración opcional solo lee metadatos de Spam para clasificar copias locales; los cambios de leído, carpetas, enviados y otras acciones locales no se replican a Gmail. Revisa [Sincronización opcional del Spam de Gmail](GMAIL-SPAM-SYNC.md).
