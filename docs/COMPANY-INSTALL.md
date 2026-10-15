# Instalar para una empresa

Cada instalación tiene una bandeja común para sus direcciones. La configuración no crea cuentas de correo, aliases ni reglas del proveedor. El equipo debe aprovisionar cada dirección y verificar los dominios antes de enrutar tráfico.

## 1. Preparar marca y configuración

Revisa la marca de ejemplo en `public/brand/logo.svg`; reemplázala por el SVG aprobado de la empresa y conserva ese path. Copia `config/companies/example.json` a un archivo de la empresa y completa:

- `mailbox`: dirección principal y nombre de la bandeja;
- `identities`: direcciones disponibles en el selector From y en el filtro;
- `allowedUsers`: usuarios de Cloudflare Access autorizados para toda la instalación;
- `archiveAddress`: buzón de archivo independiente;
- `appOrigin`, retención, almacenamiento y límites.

La dirección principal puede aparecer en `identities`; el Worker la conserva una sola vez. No repitas otras direcciones ni uses el archivo como identidad. Se admiten hasta veinte identidades.

Todos los usuarios de `allowedUsers` pueden leer todos los mensajes y enviar desde cualquier identidad configurada. No uses una instalación para grupos que necesiten separación de datos.

## 2. Preparar Cloudflare

Aprovisiona un Worker separado, una base D1, almacenamiento temporal R2 o Turso y una aplicación Cloudflare Access. Restringe Access a los usuarios autorizados y configura por separado la recepción de cada dirección hacia el Worker.

Copia `deployment.example.json` a `deployment.local.json` y completa identificadores, nombres de recursos y valores de Access de la cuenta real. Para R2, completa `r2Bucket`; para Turso, `tursoDatabaseUrl`. El archivo local está excluido de Git: no pongas tokens en él.

Genera manifiestos con `npm run configure -- --company config/companies/empresa.json`. Sin `deployment.local.json`, se generan solo el borrador y la configuración local. Con el manifiesto completo se genera también `wrangler.production.jsonc`; el comando no crea recursos, configura aliases ni despliega.

## 3. Verificar Mailjet y preparar secretos

Mailjet es el único adaptador de correo de producción implementado. Verifica el dominio remitente y cada dirección de `identities` en Mailjet; publica y valida los registros SPF y DKIM que indique el proveedor.

Configura el callback HTTPS `https://<dominio-del-webmail>/api/webhooks/mailjet`. Si Access bloquea ese callback, limita el bypass a la ruta exacta `/api/webhooks/mailjet`; el Worker mantiene Basic Auth. Crea secretos de Wrangler para:

- `MAILJET_API_KEY` y `MAILJET_API_SECRET`;
- `MAILJET_WEBHOOK_USER` y `MAILJET_WEBHOOK_PASSWORD`;
- `TURSO_AUTH_TOKEN` si el almacén es Turso;
- `CF_USAGE_API_TOKEN` si se habilitan alertas de uso.

El script de configuración genera el binding `ARCHIVE_EMAIL_COPY` cuando están activadas las copias. Comprueba que exista en la configuración de producción y que sus restricciones sigan limitadas a la dirección de archivo y al remitente permitido. Las alertas por Cloudflare Email Service pueden generar además `USAGE_ALERT_EMAIL` si se habilitan en la configuración.

Ejecuta `npm run archive:key` después de generar la configuración de producción y antes de recibir enlaces de archivo. La clave `ARCHIVE_LINK_KEY` es propia de la instalación. El script conserva una clave remota existente; rotarla invalida los enlaces antiguos.

La configuración de `identities` no habilita aliases remotos, rutas de entrada ni remitentes de Mailjet. Completa y prueba esas operaciones en los servicios externos por cada dirección.

## 4. Aplicar migraciones y desplegar

Aplica las migraciones D1 en orden con la configuración de producción antes de desplegar; incluye `migrations/0003_mail_identities.sql`. Usa como nombre de base el configurado en `deployment.local.json`, por ejemplo:

`npx wrangler d1 migrations apply company-mail --remote --config wrangler.production.jsonc`

Si usas Turso, aplica `turso-migrations/0001_objects.sql` mediante el flujo SQL aprobado por tu proveedor. No guardes el token de Turso en Git ni en el manifiesto.

Ejecuta `npm run deploy:check` para typecheck, pruebas, build, doctor estricto y dry run. Revisa la configuración generada y aplica el procedimiento de publicación de tu empresa; `npm run deploy` realiza el despliegue real.

Comprueba entrada para cada dirección, remitentes From, filtro de bandeja, archivo en Gmail, envío y callback. La aceptación del proveedor no demuestra entrega final.

## Cuotas y retención

Los límites diarios y mensuales de destinatarios incluyen a todos los usuarios y las copias de archivo cuando corresponda. El presupuesto temporal y la retención también se comparten. Revisa las cuotas, precios y condiciones actuales de Cloudflare, Mailjet y del proveedor de almacenamiento. Los valores de ejemplo no implican capacidad gratuita o ilimitada.

Gmail conserva copias independientes y no se sincroniza con el webmail. Los cambios de leído, carpetas, enviados y otras acciones no se replican.