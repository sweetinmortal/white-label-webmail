# White-label Webmail

Aplicación de correo compartida para una empresa sobre Cloudflare Workers. Cada instalación configura una dirección principal, identidades de envío y una allowlist de usuarios.

Incluye recibidos, lectura HTML aislada, descarga y envío de adjuntos, redacción, respuestas, enviados y leído/no leído por usuario. No implementa servidores IMAP ni SMTP.

## Componentes

| Componente | Función |
| --- | --- |
| Cloudflare Email Routing / Email Worker | Recibir correo y reenviar cada original al archivo principal. |
| Gmail u otro buzón principal | Conservar el archivo independiente a largo plazo. |
| D1 | Guardar el índice, estados de lectura, envíos, cuotas y la cola de resúmenes. |
| Turso | Conservar temporalmente originales y contenido; R2 es un adaptador opcional. |
| Mailjet API | Enviar desde las direcciones verificadas y confirmar estados mediante webhooks. |
| Cloudflare Email Service | Enviar el resumen periódico desde el remitente de servicio configurado. |
| Cloudflare Access o Google OpenID Connect | Restringir la aplicación a los usuarios configurados. |
| React | Mostrar la bandeja y aplicar la marca de cada instalación. |

## Reenvío y resúmenes

Cada original entrante válido se reenvía inmediatamente al buzón de archivo con el reenvío nativo del proveedor. Se conservan remitente, asunto, cuerpo, adjuntos y bytes originales; no se añade una carátula, un aviso separado ni `original.eml`. El original también queda en el almacenamiento temporal para lectura y respuesta en el webmail.

El resumen es un flujo independiente, configurado en `incomingSummary`:

```json
"incomingSummary": {
  "enabled": true,
  "batchSize": 5,
  "from": { "name": "Webmail de Mi Empresa", "email": "webmail@empresa.example" },
  "timeZone": "America/Guayaquil"
}
```

Se forma un lote por empresa y buzón compartido cada `batchSize` entradas válidas y deduplicadas. No se envían lotes incompletos por tiempo. Cada elemento incluye remitente, asunto, dirección institucional receptora, fecha/hora y el botón **Responder en el webmail**. Los enlaces cifrados siguen funcionando después de que caduque la copia temporal.

El resumen se envía a `archiveAddress` mediante el binding `ARCHIVE_EMAIL_COPY`, no mediante Mailjet Bcc ni insertando filas en `mail_messages`. El remitente de servicio se configura explícitamente y no se agrega al selector From. Un fallo de D1, Turso o del resumen no bloquea el reenvío del original.

Los totales de referencia con lote de 5 son: 4 entradas dejan 0 resúmenes y 4 pendientes; 5 dejan 1; 10 dejan 2; 12 dejan 2 y 2 pendientes. Un fallo definitivo antes de llamar al proveedor devuelve los elementos a `pending` hasta 3 intentos; un resultado `unknown` nunca se reencola automáticamente. El ejemplo trae el resumen desactivado; actívalo después de autorizar su remitente en Cloudflare Email Service.

El acceso usa Cloudflare Access por defecto. Cada empresa puede elegir `auth.provider: "google"` para usar Google directamente, con sesiones revocables de seis horas en D1. Esta opción solicita únicamente `openid email` y requiere configurar un proyecto OAuth de Google. Consulta [Acceso con Google](docs/GOOGLE-AUTH.md).

## Cómo funciona

- La bandeja es común a la instalación. Los usuarios autorizados consultan los mensajes y filtran por dirección; el selector From ofrece las identidades configuradas.
- Todas las identidades usan la misma allowlist. Cada usuario autorizado puede leer todos los mensajes y enviar desde cualquiera. No es un sistema de permisos por buzón ni separa empresas dentro de una instalación.
- Declarar una identidad no crea un alias, una regla de entrada ni un remitente verificado. Configura por separado la recepción de cada dirección y autorízala en Mailjet.
- Gmail recibe copias independientes. No se sincronizan carpetas, leído/no leído, enviados ni otras acciones.
- Los límites de destinatarios, almacenamiento y retención son compartidos. Revisa las cuotas y condiciones de cada proveedor; no se promete uso gratuito ilimitado.
- La redacción y las respuestas aceptan adjuntos por selector o arrastrando y soltando. Se respetan 5 archivos, 5 MiB en total, el rechazo de archivos vacíos y carpetas, y el bloqueo durante el envío.

## Desarrollo local

El entorno de CI usa Node.js 24. Consulta `engines.node` en `package.json` para las versiones compatibles.

1. Instala dependencias con `npm ci`.
2. Revisa `config/companies/example.json` y sustituye los valores de ejemplo.
3. Ejecuta `npm run configure` para generar el borrador y la configuración local.
4. Ejecuta `npm run dev`.

El entorno local usa un proveedor de correo simulado y almacenamiento local. No envía correo real ni crea recursos remotos. `npm run doctor` valida configuración estática.

## Instalación

En GitHub, selecciona **Use this template** para crear el repositorio de una empresa. Cada copia tiene su propia configuración, recursos y secretos; las futuras mejoras del motor no se incorporan automáticamente a las copias.

Edita una copia de `config/companies/example.json`. `mailbox` define la dirección principal, `identities` las direcciones disponibles en From y en el filtro, y `allowedUsers` la allowlist común. El ejemplo usa `contacto@empresa.example`, `ventas@empresa.example` y `admin@empresa.example`.

Sigue [Instalación por empresa](docs/COMPANY-INSTALL.md) para aprovisionar Cloudflare, verificar Mailjet, autorizar el remitente del resumen y preparar las migraciones. [Operaciones](docs/OPERATIONS.md) cubre entrega, resúmenes, recuperación de lotes, cuotas y retención.

La migración `migrations/0006_incoming_summary.sql` añade la deduplicación de entrantes y las tablas del resumen. Aplícala con las migraciones D1 anteriores antes de desplegar código que dependa de ella.
