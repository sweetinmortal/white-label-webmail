# White-label Webmail

Aplicación de correo compartida para una empresa sobre Cloudflare Workers. Cada instalación configura una dirección principal, identidades de envío y una allowlist de usuarios.

Incluye Recibidos, Filtrados, Spam, Todos y Enviados; lectura HTML aislada; filtros; borradores privados; respuestas con citas; adjuntos; y envíos programados. Los usuarios pueden corregir la clasificación desde el lector. No implementa servidores IMAP ni SMTP.

Desde Ajustes puedes gestionar [etiquetas y reglas](docs/ORGANIZATION.md): varias etiquetas por mensaje, colores, archivo manual y reglas por remitente, destinatario y asunto. La [sincronización opcional de Spam con Gmail](docs/GMAIL-SPAM-SYNC.md) consulta únicamente cabeceras y etiquetas, con una conexión independiente por empresa. Está desactivada de fábrica y requiere autorización adicional de Google.

En escritorio usa una barra lateral compacta y dos paneles: al abrir un mensaje, el lector sustituye la lista y se vuelve con una flecha. En las listas, los mensajes del día actual muestran solo la hora; los anteriores conservan la fecha corta.

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
| React | Mostrar las carpetas, filtros, borradores y programación con la marca de cada instalación. |

## Reenvío, spam y resúmenes

Cada original entrante válido se reenvía inmediatamente al buzón de archivo con el reenvío nativo del proveedor. Se conservan remitente, asunto, cuerpo, adjuntos y bytes originales; no se añade una carátula, un aviso separado ni `original.eml`. El original también queda en el almacenamiento temporal para lectura y respuesta en el webmail, incluso si se clasifica en Spam.

El resumen diario es un flujo independiente configurado en `incomingSummary`. Incluye hasta 100 mensajes por correo y un botón general **Ver webmail**. Excluye los mensajes clasificados en Spam o Filtrados. El horario usa `timeZone`, `schedule.hour`, `schedule.minute` y `schedule.weekdaysOnly`:

```json
"incomingSummary": {
  "enabled": true,
  "from": { "name": "Webmail de Mi Empresa", "email": "webmail@empresa.example" },
  "timeZone": "UTC",
  "schedule": { "hour": 8, "minute": 0, "weekdaysOnly": true }
}
```

La protección de Spam clasifica con señales del mensaje y la lista opcional de remitentes bloqueados; no consulta Gmail ni envía datos a servicios de análisis externos. La carpeta permite revisar el original y restaurarlo. Consulta [Spam y recuperación](docs/SPAM.md) para las señales, configuración y migración.

El resumen se envía a `archiveAddress` mediante el binding `ARCHIVE_EMAIL_COPY`, no mediante Mailjet Bcc ni insertando filas en `mail_messages`. El remitente de servicio se configura explícitamente y no se agrega al selector From. Un fallo de D1, Turso o del resumen no bloquea el reenvío del original.

El acceso usa Cloudflare Access por defecto. Cada empresa puede elegir `auth.provider: "google"` para usar Google directamente, con sesiones revocables de seis horas en D1. Esta opción solicita únicamente `openid email` y requiere configurar un proyecto OAuth de Google. Consulta [Acceso con Google](docs/GOOGLE-AUTH.md).

## Cómo funciona

- La bandeja es común a la instalación. Los usuarios autorizados consultan los mensajes y filtran por dirección; el selector From ofrece las identidades configuradas.
- Los filtros de entrada se configuran por instalación. Los mensajes filtrados se conservan en **Filtrados** y quedan fuera de Recibidos y de los resúmenes.
- Todas las identidades usan la misma allowlist. Cada usuario autorizado puede leer todos los mensajes y enviar desde cualquiera. No es un sistema de permisos por buzón ni separa empresas dentro de una instalación.
- Declarar una identidad no crea un alias, una regla de entrada ni un remitente verificado. Configura por separado la recepción de cada dirección y autorízala en Mailjet.
- Los borradores son privados por usuario y se guardan automáticamente. Los envíos programados muestran la hora local del navegador y se almacenan en UTC.
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

En GitHub, selecciona **Use this template** para crear el repositorio de una empresa. Cada copia tiene su propia configuración, recursos y secretos. La copia puede activar el workflow `Update from template` para recibir las mejoras del motor como pull requests; sin ese workflow, las mejoras no se incorporan automáticamente. Consulta [Actualizaciones de la plantilla](docs/TEMPLATE-UPDATES.md).

Edita una copia de `config/companies/example.json`. `mailbox` define la dirección principal, `identities` las direcciones disponibles en From y en el filtro, y `allowedUsers` la allowlist común. El ejemplo usa `contacto@empresa.example`, `ventas@empresa.example` y `admin@empresa.example`.

Sigue [Instalación por empresa](docs/COMPANY-INSTALL.md) para aprovisionar Cloudflare, verificar Mailjet, autorizar el remitente del resumen y preparar las migraciones. [Operaciones](docs/OPERATIONS.md) cubre entrega, resúmenes, recuperación de lotes, cuotas y retención.

Aplica las migraciones D1 en orden antes de desplegar. Conserva `0007`–`0009` con sus nombres históricos: algunas instalaciones ya las aplicaron y renombrarlas podría repetir cambios de esquema. La migración nueva de Spam usa el prefijo de fecha `202611040900_message_spam.sql`. Consulta [Instalación por empresa](docs/COMPANY-INSTALL.md) para los pasos y respaldos.

## Actualizaciones

La plantilla publica tags `vX.Y.Z`. Una instalación puede ejecutar el workflow `Update from template` para recibir los cambios como un pull request revisable. El flujo no sobrescribe la configuración de la empresa y no despliega automáticamente. Consulta [Actualizaciones de la plantilla](docs/TEMPLATE-UPDATES.md).

## Licencia y contribuciones

El proyecto usa la licencia [MIT](LICENSE). Las contribuciones se aceptan con el [Developer Certificate of Origin 1.1](DCO): cada commit debe incluir `Signed-off-by`. Consulta [CONTRIBUTING.md](CONTRIBUTING.md) antes de abrir un pull request.

No publiques vulnerabilidades en issues; sigue [SECURITY.md](SECURITY.md).
