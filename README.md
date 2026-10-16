# White-label Webmail

Aplicación de correo compartida para una empresa sobre Cloudflare Workers. Cada instalación configura una dirección principal, identidades de envío y una allowlist de usuarios.

Incluye recibidos, lectura y descarga de adjuntos, redacción, respuestas, enviados y leído/no leído por usuario. No implementa servidores IMAP ni SMTP.

## Componentes

| Componente | Función |
| --- | --- |
| Cloudflare Email Routing / Email Worker | Recibir correo y entregar una copia al archivo principal. |
| Gmail u otro buzón principal | Conservar el archivo independiente a largo plazo. |
| D1 | Guardar el índice, estados de lectura, envíos y cuotas. |
| Turso | Conservar temporalmente originales y contenido; R2 es un adaptador opcional. |
| Mailjet API | Enviar desde las direcciones verificadas y confirmar estados mediante webhooks. |
| Cloudflare Access o Google OpenID Connect | Restringir la aplicación a los usuarios configurados. |
| React | Mostrar la bandeja y aplicar la marca de cada instalación. |

La copia de archivo incluye un aviso y un botón para responder en el webmail. Los entrantes de hasta 3 MiB pueden conservar el original como `.eml` adjunto; para mensajes mayores se reenvía el original y se intenta enviar el aviso por separado. Los enlaces requieren autenticación y permiten preparar una respuesta aunque la copia temporal haya caducado.

El acceso usa Cloudflare Access por defecto. Cada empresa puede elegir `auth.provider: "google"` para usar Google directamente, con sesiones revocables de seis horas en D1. Esta opción solicita únicamente `openid email` y requiere configurar un proyecto OAuth de Google. Consulta [Acceso con Google](docs/GOOGLE-AUTH.md).

## Cómo funciona

- La bandeja es común a la instalación. Los usuarios autorizados consultan los mensajes y filtran por dirección; el selector From ofrece las identidades configuradas.
- Todas las identidades usan la misma allowlist. Cada usuario autorizado puede leer todos los mensajes y enviar desde cualquiera. No es un sistema de permisos por buzón ni separa empresas dentro de una instalación.
- Declarar una identidad no crea un alias, una regla de entrada ni un remitente verificado. Configura por separado la recepción de cada dirección y autorízala en Mailjet.
- Gmail recibe copias independientes. No se sincronizan carpetas, leído/no leído, enviados ni otras acciones.
- Los límites de destinatarios, almacenamiento y retención son compartidos. Revisa las cuotas y condiciones de cada proveedor; no se promete uso gratuito ilimitado.

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

Sigue [Instalación por empresa](docs/COMPANY-INSTALL.md) para aprovisionar Cloudflare, verificar Mailjet y preparar las migraciones. [Operaciones](docs/OPERATIONS.md) cubre entrega, cuotas y retención.

La migración `migrations/0003_mail_identities.sql` añade soporte para identidades. Aplícala con las migraciones D1 anteriores antes de desplegar código que dependa de ella.
