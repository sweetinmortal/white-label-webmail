# Operaciones

Esta guía aplica a una instalación aprovisionada. `npm run configure` y `npm run doctor` trabajan con archivos locales; no crean recursos ni verifican credenciales remotas.

## Acceso e identidades

La bandeja, el filtro de dirección y las opciones de From usan la configuración común. `allowedUsers` es una allowlist global: cada usuario incluido puede leer todos los mensajes y enviar desde todas las identidades. No es aislamiento entre equipos o empresas.

Agregar una dirección a `identities` no crea aliases, no cambia Email Routing ni verifica un remitente en Mailjet. Coordina esos cambios con los administradores de los servicios externos y prueba entrada y salida antes de anunciar la dirección.

El remitente del resumen (`incomingSummary.from`) es una identidad de servicio independiente. No aparece en el selector From y no debe añadirse a `identities` solo para que el resumen funcione. Debe estar autorizado en el binding de Cloudflare Email Service y verificado por el proveedor.

## Entrada, archivo y resumen

Cada original entrante válido se reenvía inmediatamente al buzón principal con el reenvío nativo del proveedor. El webmail conserva además una copia temporal para lectura, descarga y respuesta. El reenvío original no depende de D1, Turso ni del resumen.

El resumen se calcula por empresa y buzón compartido. Solo incluye entradas válidas y deduplicadas, y excluye enviados, callbacks, alertas y resúmenes. El lote se forma únicamente cuando hay exactamente `batchSize` elementos; no se envían lotes incompletos por tiempo. Con el valor inicial 5:

- 4 entradas: 0 resúmenes, 4 pendientes;
- 5 entradas: 1 resumen;
- 10 entradas: 2 resúmenes;
- 12 entradas: 2 resúmenes y 2 pendientes.

Cada resumen incluye remitente, asunto, dirección institucional receptora, fecha/hora y el botón **Responder en el webmail**. El enlace se genera al enviar el resumen desde un snapshot persistente y sigue funcionando después de borrar la caché temporal.

### Estados y recuperación

- Los elementos usan `pending`, `claimed`, `accepted`, `failed` o `unknown`.
- Los lotes usan `claiming`, `sending`, `accepted`, `failed` o `unknown`.
- Un claim inserta el lote y marca exactamente N elementos. Si el claim queda incompleto, el lote se libera y sus elementos vuelven a `pending`.
- Un lote `sending` obsoleto pasa a `unknown` y no se reintenta automáticamente.
- Un lote `claiming` obsoleto devuelve sus elementos a `pending`.
- Un `failed` de preparación, antes de llamar al proveedor, devuelve sus elementos a `pending` para un máximo de 3 intentos; después quedan `failed`.
- Si el proveedor no confirma el resultado, el lote queda `unknown`; revisa el archivo antes de crear un lote manual.
- Un fallo de D1, Turso o del resumen no convierte al original en fallido ni autoriza a reenviarlo.

El barrido de pendientes se ejecuta al recibir correo y en la tarea programada. La limpieza elimina solo estados terminales antiguos y respeta la retención y el presupuesto configurados.

## Revisar la entrega

Para correo entrante, verifica el enrutamiento externo hacia el Worker, el reenvío inmediato al archivo principal y la copia temporal. Si el reenvío falla pero el original se guarda, no informes que el archivo principal lo recibió. Un fallo del almacenamiento temporal tampoco demuestra que el archivo principal esté disponible.

Para correo saliente, revisa el estado y los callbacks de Mailjet. El proveedor puede aceptar un mensaje sin confirmar su entrega final. Un estado `pending`, `failed` o `unknown` requiere revisar el proveedor y el archivo antes de reintentar; un timeout puede dejar incierto si el proveedor recibió el intento.

Verifica en Mailjet el dominio remitente, las direcciones From y SPF/DKIM. Confirma que el callback use HTTPS en `/api/webhooks/mailjet`, con `MAILJET_WEBHOOK_USER` y `MAILJET_WEBHOOK_PASSWORD` guardados como secretos de Wrangler. Si Cloudflare Access requiere una excepción, limita el bypass a esa ruta exacta; no desactives Access para toda la aplicación.

## Secretos y archivo

Los secretos de producción pueden incluir `MAILJET_API_KEY`, `MAILJET_API_SECRET`, `MAILJET_WEBHOOK_USER`, `MAILJET_WEBHOOK_PASSWORD`, `ARCHIVE_LINK_KEY`, `TURSO_AUTH_TOKEN` y, opcionalmente, `CF_USAGE_API_TOKEN`. Cárgalos como secretos remotos; no los guardes en archivos del repo, logs o tickets.

El binding `ARCHIVE_EMAIL_COPY` se usa para enviar los resúmenes al `archiveAddress`. Las copias de archivo de los envíos salientes viajan en el mismo envío de Mailjet y no consumen este binding. Debe limitar remitente y destino a las direcciones configuradas. El destino es `archiveAddress`; los remitentes permitidos son la dirección principal y `incomingSummary.from.email`. Las alertas opcionales por Cloudflare Email Service usan `USAGE_ALERT_EMAIL`.

`npm run archive:key` crea `ARCHIVE_LINK_KEY` si todavía no existe y conserva la clave existente. Mantén la misma clave por instalación: rotarla invalida enlaces de archivo y de resumen creados anteriormente.

## Cuotas, almacenamiento y retención

Los límites diarios y mensuales de destinatarios se comparten entre usuarios e identidades; incluye las copias de archivo cuando correspondan. El presupuesto temporal y la retención también son compartidos. Revisa el uso y las condiciones actuales de Cloudflare, Mailjet, D1 y R2 o Turso. Los niveles gratuitos pueden cambiar y no equivalen a uso ilimitado.

Los adjuntos añaden presión al límite de 15 MB por mensaje de Mailjet y al de Cloudflare Email Service. La configuración segura por defecto es 5 archivos y 5 MB binarios en total; el mismo contenido se incluye en la copia de archivo. No eleves estos valores sin recalcular base64, cabeceras y duplicado del archivo. La descarga de adjuntos salientes usa el snapshot autenticado del envío y no expone el payload completo.

La purga de mensajes temporales sigue la retención configurada y las condiciones de archivo de la aplicación. Antes de cambiar el período, revisa las cuotas y políticas de conservación. Un cambio no recupera mensajes purgados ni amplía el archivo de Gmail.

Gmail conserva copias independientes. No hay sincronización de leído/no leído, carpetas, enviados, borrados u otras acciones; el estado de un sistema no prueba el estado del otro.

## Redacción y adjuntos

La redacción y las respuestas aceptan archivos por selector o por arrastrar y soltar. Se permiten varios archivos, pero nunca se combinan por encima de `maxAttachments` ni de `maxAttachmentBytes`; también se rechazan archivos vacíos y carpetas. El overlay solo aparece para arrastres de archivos, no captura texto, no provoca navegación y no envía automáticamente. Durante un envío o un reintento bloqueado no se aceptan adjuntos nuevos.

## Migraciones y despliegue

Aplica migraciones D1 en orden antes de desplegar código que las necesite. `migrations/0006_incoming_summary.sql` agrega `incoming_key` y las tablas `mail_summary_items` y `mail_summary_batches`; es necesaria para la deduplicación y los resúmenes. Aplícala en cada base antes de publicar el Worker nuevo. Para Turso, aplica también `turso-migrations/0001_objects.sql` desde su consola SQL. Conserva el token como secreto remoto del Worker.

Tras cambiar configuración, ejecuta `npm run configure -- --company ruta/al/archivo.json` y revisa los manifiestos generados. `npm run deploy:check` ejecuta verificaciones y dry run; `npm run deploy` despliega realmente y debe seguir el proceso de publicación de la empresa.

## Incidentes

Preserva estados y metadatos necesarios para diagnosticar. No publiques cuerpos de correo, adjuntos, tokens ni secretos. Antes de reintentar, determina si el proveedor aceptó el intento original; evita duplicados cuando el resultado sea ambiguo. Escala reconstrucciones de datos o recuperaciones de mensajes purgados mediante el procedimiento interno de la empresa.
