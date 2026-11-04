# Operaciones

Esta guía aplica a una instalación aprovisionada. `npm run configure` y `npm run doctor` trabajan con archivos locales; no crean recursos ni verifican credenciales remotas.

## Acceso e identidades

La bandeja, el filtro de dirección y las opciones de From usan la configuración común. `allowedUsers` es una allowlist global: cada usuario incluido puede leer todos los mensajes y enviar desde todas las identidades. No es aislamiento entre equipos o empresas.

Agregar una dirección a `identities` no crea aliases, no cambia Email Routing ni verifica un remitente en Mailjet. Coordina esos cambios con los administradores de los servicios externos y prueba entrada y salida antes de anunciar la dirección.

El remitente del resumen (`incomingSummary.from`) es una identidad de servicio independiente. No aparece en el selector From y no debe añadirse a `identities` solo para que el resumen funcione. Debe estar autorizado en el binding de Cloudflare Email Service y verificado por el proveedor.

## Entrada, archivo y resumen

Cada original entrante válido se reenvía inmediatamente al buzón principal con el reenvío nativo del proveedor. El webmail conserva además una copia temporal para lectura, descarga y respuesta. El reenvío original no depende de D1, Turso ni del resumen.

El resumen se calcula por buzón compartido. Solo incluye entradas válidas y deduplicadas, y excluye enviados, callbacks, alertas, resúmenes y mensajes con etiqueta de **Filtrados**. `receiveEmail` solo encola; no se envía nada al recibir. La tarea agrupa los pendientes según `incomingSummary.schedule` y `incomingSummary.timeZone`, hasta 100 por correo.

El cron `* * * * *` entrega los envíos programados y comprueba si el resumen está dentro de su horario configurado. El manejador acepta una ventana de cinco minutos y puede limitarlo a días laborables. El cron `15 * * * *` conserva el mantenimiento horario, la limpieza de autenticación y las alertas de uso.

Cada resumen incluye remitente, asunto, dirección institucional receptora, fecha/hora y un solo botón general **Ver webmail**. No se generan enlaces de respuesta por mensaje. Las copias archivadas de los envíos salientes conservan su propio enlace cifrado, que sigue funcionando después de borrar la caché temporal.

### Envíos programados

La programación se guarda en UTC en `mail_outbox.scheduled_at`; la interfaz interpreta y muestra las horas según la zona local del navegador. El mensaje queda en **Enviados** con `send_status='scheduled'` y el cron cada minuto reclama las filas vencidas con una actualización condicional e idempotente. La ventana personalizada exige 2 minutos de margen en el cliente y 60 segundos en el servidor, con un máximo de un año. Si el proceso muere después de reclamar la fila, la recuperación la marca `unknown` a los 15 minutos; no se reintenta automáticamente para evitar duplicados. Los envíos programados respetan cuotas, copia de archivo y la misma idempotencia que los envíos inmediatos.

### Filtros de entrada

`incomingFilters` debe contener únicamente las reglas de Gmail que **Omitir Recibidos**. Un mensaje coincidente se conserva y se marca en `mail_message_filters`; se muestra en **Filtrados** y se excluye de **Recibidos** y del resumen. No se borra ni se vuelve a reenviar. Las reglas que solo etiquetan en Gmail no se copian aquí.

El matcher normaliza remitentes y asuntos, exige que coincidan todos los criterios presentes en una regla y usa la primera regla en el orden configurado. Después de aplicar `0007_incoming_filters.sql`, rellena solo los mensajes ya guardados que coincidan, con inserciones idempotentes en `mail_message_filters`. No modifiques `mail_messages` ni el archivo de Gmail para ocultar esos mensajes. Para auditar, compara el recuento de **Recibidos** y **Filtrados** con las etiquetas de la regla, no con la bandeja de Gmail, porque Gmail conserva sus propias etiquetas y reglas. Las etiquetas también se muestran en la barra lateral y **Todos** reúne entrantes y salientes, sin borradores, con filtro por nombre de etiqueta; dos reglas con el mismo nombre se agrupan.

### Borradores

Los borradores se guardan automáticamente y al cerrar la ventana. Son privados del usuario autenticado por `mailbox_id` y `user_email`; D1 guarda solo los metadatos y el objeto completo —incluidos adjuntos— vive en el almacenamiento configurado bajo una clave derivada del propietario. El límite es de 100 borradores y 25 MB por usuario; no consume el contador de la caché de mensajes.

Si un guardado falla, la ventana muestra el error y permite reintentar. No cierres ni descartes si el usuario necesita conservar el texto. Un envío aceptado elimina el borrador en el Worker y el cliente hace un borrado de respaldo; si el borrado remoto falla, el borrador puede reaparecer y debe descartarse manualmente. No intentes recuperar un borrador eliminado desde el archivo de Gmail: Gmail no recibe los borradores del webmail.

### Estados y recuperación

- Los elementos usan `pending`, `claimed`, `accepted`, `failed` o `unknown`.
- Los lotes usan `claiming`, `sending`, `accepted`, `failed` o `unknown`.
- Un claim inserta el lote y marca hasta 100 elementos. Si el claim queda incompleto, el lote se libera y sus elementos vuelven a `pending`.
- Un lote `sending` obsoleto pasa a `unknown` y no se reintenta automáticamente.
- Un lote `claiming` obsoleto devuelve sus elementos a `pending`.
- Un `failed` de preparación, antes de llamar al proveedor, devuelve sus elementos a `pending` para un máximo de 3 intentos; después quedan `failed`.
- Si el proveedor no confirma el resultado, el lote queda `unknown`; revisa el archivo antes de crear un lote manual.
- Un fallo de D1, Turso o del resumen no convierte al original en fallido ni autoriza a reenviarlo.

El barrido de pendientes se ejecuta al recibir correo y en la tarea programada. La limpieza elimina solo estados terminales antiguos y respeta la retención y el presupuesto configurados.

## Revisar la entrega

Para correo entrante, verifica el enrutamiento externo hacia el Worker, el reenvío inmediato al archivo principal y la copia temporal. Si el reenvío falla pero el original se guarda, no informes que el archivo principal lo recibió. Un fallo del almacenamiento temporal tampoco demuestra que el archivo principal esté disponible.

Para correo saliente, revisa el estado y los callbacks de Mailjet. El proveedor puede aceptar un mensaje sin confirmar su entrega final. Un estado `pending`, `scheduled`, `failed` o `unknown` requiere revisar el proveedor y el archivo antes de reintentar; un timeout puede dejar incierto si el proveedor recibió el intento. Para un envío programado, confirma `scheduled_at` en UTC y que el cron cada minuto esté activo antes de diagnosticar un fallo de entrega.

Verifica en Mailjet el dominio remitente, las direcciones From y SPF/DKIM. Confirma que el callback use HTTPS en `/api/webhooks/mailjet`, con `MAILJET_WEBHOOK_USER` y `MAILJET_WEBHOOK_PASSWORD` guardados como secretos de Wrangler. Si Cloudflare Access requiere una excepción, limita el bypass a esa ruta exacta; no desactives Access para toda la aplicación.

## Secretos y archivo

Los secretos de producción pueden incluir `MAILJET_API_KEY`, `MAILJET_API_SECRET`, `MAILJET_WEBHOOK_USER`, `MAILJET_WEBHOOK_PASSWORD`, `ARCHIVE_LINK_KEY`, `TURSO_AUTH_TOKEN` y, opcionalmente, `CF_USAGE_API_TOKEN`. Cárgalos como secretos remotos; no los guardes en archivos del repo, logs o tickets.

El binding `ARCHIVE_EMAIL_COPY` se usa para enviar los resúmenes al `archiveAddress`. Las copias de archivo de los envíos salientes viajan en el mismo envío de Mailjet y no consumen este binding. Debe limitar remitente y destino a las direcciones configuradas. El destino es `archiveAddress`; los remitentes permitidos son la dirección principal y `incomingSummary.from.email`. Las alertas opcionales por Cloudflare Email Service usan `USAGE_ALERT_EMAIL`.

`npm run archive:key` crea `ARCHIVE_LINK_KEY` si todavía no existe y conserva la clave existente. Mantén la misma clave por instalación: rotarla invalida los enlaces de respuesta de las copias archivadas creados anteriormente.

## Cuotas, almacenamiento y retención

Los límites diarios y mensuales de destinatarios se comparten entre usuarios e identidades; incluye las copias de archivo cuando correspondan. El presupuesto temporal y la retención también son compartidos. Revisa el uso y las condiciones actuales de Cloudflare, Mailjet, D1 y R2 o Turso. Los niveles gratuitos pueden cambiar y no equivalen a uso ilimitado.

Los adjuntos añaden presión al límite de 15 MB por mensaje de Mailjet y al de Cloudflare Email Service. La configuración segura por defecto es 5 archivos y 5 MB binarios en total; el mismo contenido se incluye en la copia de archivo. No eleves estos valores sin recalcular base64, cabeceras y duplicado del archivo. La descarga de adjuntos salientes usa el snapshot autenticado del envío y no expone el payload completo.

La purga de mensajes temporales sigue la retención configurada y las condiciones de archivo de la aplicación. Antes de cambiar el período, revisa las cuotas y políticas de conservación. Un cambio no recupera mensajes purgados ni amplía el archivo de Gmail.

Gmail conserva copias independientes. No hay sincronización de leído/no leído, carpetas, enviados, borrados u otras acciones; el estado de un sistema no prueba el estado del otro.

## Redacción y adjuntos

La redacción y las respuestas aceptan archivos por selector o por arrastrar y soltar. Se permiten varios archivos, pero nunca se combinan por encima de `maxAttachments` ni de `maxAttachmentBytes`; también se rechazan archivos vacíos y carpetas. El overlay solo aparece para arrastres de archivos, no captura texto, no provoca navegación y no envía automáticamente. Durante un envío o un reintento bloqueado no se aceptan adjuntos nuevos.

La redacción guarda un borrador tras 1,2 segundos de inactividad y al cerrar. **Borradores** permite reabrir, continuar o descartar. La ventana muestra `Guardando…`, `Borrador guardado` o `No se pudo guardar`, con un botón para reintentar. Los borradores son privados por usuario y no se comparten entre usuarios autorizados de la instalación.

Las respuestas usan el encabezado `El <día>, <fecha> a la(s) <hora>, <remitente> (<correo>) escribió:` y conservan el original debajo sin prefijos `>`. En la redacción, el original queda cerrado detrás de un control de tres puntos; en el lector, las citas de texto y HTML también quedan cerradas y se muestran al pulsar el control. El envío incluye una parte HTML con la cita estándar de Gmail (`class="gmail_quote"`) y un `blockquote type="cite"` con una tarjeta basada en tabla: fondo claro, borde suave y barra del color de la marca. Gmail pliega la cita; los clientes sin ese comportamiento muestran la tarjeta. El texto plano conserva el mensaje completo como respaldo. No elimines el bloque citado del HTML saneado: es la fuente para el plegado y para la respuesta.

## Migraciones y despliegue

Aplica migraciones D1 en orden antes de desplegar código que las necesite. `migrations/0006_incoming_summary.sql` agrega `incoming_key` y las tablas `mail_summary_items` y `mail_summary_batches`; `0007_incoming_filters.sql` agrega `mail_message_filters`; `0008_drafts.sql` agrega `mail_drafts`; `0009_scheduled_send_and_labels.sql` agrega `mail_outbox.scheduled_at` y los índices de programación y de **Todos**. Todas deben estar aplicadas antes de publicar el Worker actual. Para Turso, aplica también `turso-migrations/0001_objects.sql` desde su consola SQL. Conserva el token como secreto remoto del Worker.

Tras cambiar configuración, ejecuta `npm run configure -- --company ruta/al/archivo.json` y revisa los manifiestos generados. `npm run deploy:check` ejecuta verificaciones y dry run; `npm run deploy` despliega realmente y debe seguir el proceso de publicación de la empresa.

## Incidentes

Preserva estados y metadatos necesarios para diagnosticar. No publiques cuerpos de correo, adjuntos, tokens ni secretos. Antes de reintentar, determina si el proveedor aceptó el intento original; evita duplicados cuando el resultado sea ambiguo. Escala reconstrucciones de datos o recuperaciones de mensajes purgados mediante el procedimiento interno de la empresa.
