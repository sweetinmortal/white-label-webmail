# Operaciones

Esta guía aplica a una instalación aprovisionada. `npm run configure` y `npm run doctor` trabajan con archivos locales; no crean recursos ni verifican credenciales remotas.

## Acceso e identidades

La bandeja, el filtro de dirección y las opciones de From usan la configuración común. `allowedUsers` es una allowlist global: cada usuario incluido puede leer todos los mensajes y enviar desde todas las identidades. No es aislamiento entre equipos o empresas.

Agregar una dirección a `identities` no crea aliases, no cambia Email Routing ni verifica un remitente en Mailjet. Coordina esos cambios con los administradores de los servicios externos y prueba entrada y salida antes de anunciar la dirección.

## Revisar la entrega

Para correo entrante, verifica el enrutamiento externo hacia el Worker, el estado del archivo principal y la copia temporal. Si el archivo principal falla, no informes que Gmail la recibió. Un fallo del almacenamiento temporal tampoco demuestra que el archivo principal esté disponible.

Para correo saliente, revisa el estado y los callbacks de Mailjet. El proveedor puede aceptar un mensaje sin confirmar su entrega final. Un estado `pending`, `failed` o `unknown` requiere revisar el proveedor y el archivo antes de reintentar; un timeout puede dejar incierto si el proveedor recibió el intento.

Verifica en Mailjet el dominio remitente, las direcciones From y SPF/DKIM. Confirma que el callback use HTTPS en `/api/webhooks/mailjet`, con `MAILJET_WEBHOOK_USER` y `MAILJET_WEBHOOK_PASSWORD` guardados como secretos de Wrangler. Si Cloudflare Access requiere una excepción, limítala a esa ruta exacta; no desactives Access para toda la aplicación.

## Secretos y archivo

Los secretos de producción pueden incluir `MAILJET_API_KEY`, `MAILJET_API_SECRET`, `MAILJET_WEBHOOK_USER`, `MAILJET_WEBHOOK_PASSWORD`, `ARCHIVE_LINK_KEY`, `TURSO_AUTH_TOKEN` y, opcionalmente, `CF_USAGE_API_TOKEN`. Cárgalos como secretos remotos; no los guardes en archivos del repo, logs o tickets.

El binding `ARCHIVE_EMAIL_COPY` permite las copias de archivo previstas por la configuración. El binding debe limitar remitente y destino a las direcciones configuradas. Las alertas opcionales por Cloudflare Email Service usan `USAGE_ALERT_EMAIL`.

`npm run archive:key` crea `ARCHIVE_LINK_KEY` si todavía no existe y conserva la clave existente. Mantén la misma clave por instalación: rotarla invalida enlaces de archivo creados anteriormente.

## Cuotas, almacenamiento y retención

Los límites diarios y mensuales de destinatarios se comparten entre usuarios e identidades; incluye las copias de archivo cuando correspondan. El presupuesto temporal y la retención también son compartidos. Revisa el uso y las condiciones actuales de Cloudflare, Mailjet, D1 y R2 o Turso. Los niveles gratuitos pueden cambiar y no equivalen a uso ilimitado.

Los adjuntos añaden presión al límite de 15 MB por mensaje de Mailjet y al de Cloudflare Email Service. La configuración segura por defecto es 5 archivos y 5 MB binarios en total; el mismo contenido se incluye en la copia de archivo. No eleves estos valores sin recalcular base64, cabeceras y duplicado del archivo. La descarga de adjuntos salientes usa el snapshot autenticado del envío y no expone el payload completo.

La purga de mensajes temporales sigue la retención configurada y las condiciones de archivo de la aplicación. Antes de cambiar el período, revisa las cuotas y políticas de conservación. Un cambio no recupera mensajes purgados ni amplía el archivo de Gmail.

Gmail conserva copias independientes. No hay sincronización de leído/no leído, carpetas, enviados, borrados u otras acciones; el estado de un sistema no prueba el estado del otro.

## Migraciones y despliegue

Aplica migraciones D1 en orden antes de desplegar código que las necesite. `migrations/0003_mail_identities.sql` agrega soporte de identidades y debe aplicarse a cada base. Para Turso, aplica también `turso-migrations/0001_objects.sql` desde su consola SQL. Conserva el token como secreto remoto del Worker.

Tras cambiar configuración, ejecuta `npm run configure -- --company ruta/al/archivo.json` y revisa los manifiestos generados. `npm run deploy:check` ejecuta verificaciones y dry run; `npm run deploy` despliega realmente y debe seguir el proceso de publicación de la empresa.

## Incidentes

Preserva estados y metadatos necesarios para diagnosticar. No publiques cuerpos de correo, adjuntos, tokens ni secretos. Antes de reintentar, determina si el proveedor aceptó el intento original; evita duplicados cuando el resultado sea ambiguo. Escala reconstrucciones de datos o recuperaciones de mensajes purgados mediante el procedimiento interno de la empresa.
