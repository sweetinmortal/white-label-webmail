import type { MailConfig } from './types';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Public product disclosure; no archive addresses, users or credentials. */
export function privacyPage(config: MailConfig, head = false): Response {
  const name = escape(config.brand.name);
  const address = escape(config.mailbox.address);
  const body = `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacidad del webmail · ${name}</title>
<style>body{font:16px/1.65 system-ui,sans-serif;color:#243247;background:#f7f9fc;margin:0}main{max-width:760px;margin:40px auto;padding:32px;background:white;border:1px solid #e2e8f0;border-radius:16px}h1{line-height:1.2}h2{font-size:20px;margin-top:28px}a{color:#2457c5}@media(max-width:800px){main{margin:0;padding:24px;border:0;border-radius:0}}</style><main>
<p>${name}</p><h1>Privacidad del webmail</h1><p>Esta página explica qué datos utiliza esta instalación de correo y para qué se utilizan.</p>
<h2>Correo institucional</h2><p>Cloudflare recibe el correo de las direcciones institucionales configuradas y reenvía los originales al buzón de archivo principal. El webmail conserva una copia temporal del mensaje, sus cabeceras y adjuntos para permitir su lectura y respuesta. Las copias temporales se almacenan en Turso o R2 según la instalación; D1 guarda el índice, la organización y los estados del correo. Los envíos utilizan el proveedor de correo configurado, inicialmente Mailjet.</p>
<h2>Conexión opcional con Gmail</h2><p>La conexión con Gmail solicita acceso a metadatos de mensajes: cabeceras y etiquetas. Ese permiso alcanza el buzón conectado, pero esta instalación conserva únicamente metadatos asociados a sus direcciones institucionales y utiliza coincidencias exactas para reflejar la clasificación de Spam en las copias del webmail. La integración no descarga cuerpos ni adjuntos desde la API de Gmail y no envía, modifica ni elimina mensajes en Gmail.</p>
<h2>Uso y proveedores</h2><p>Los datos se utilizan para prestar las funciones del webmail y sincronizar la clasificación de Spam. Se procesan en los servicios configurados de Cloudflare, almacenamiento y entrega de correo, y en Google cuando se conecta Gmail. Esta aplicación no incorpora funciones de venta de datos, publicidad personalizada ni entrenamiento de modelos con el correo.</p>
<h2>Acceso y conservación</h2><p>La aplicación permite el acceso al buzón solo a usuarios autorizados por su administrador. Los tokens de actualización de Gmail se cifran antes de guardarse y la clave se conserva como secreto del Worker. La retención configurada de las copias es de ${config.retentionDays} días. La limpieza conserva las copias cuyo archivo o envío sigue pendiente o no confirmado. El archivo principal mantiene su propia conservación, independiente del webmail.</p>
<h2>Control de la conexión</h2><p>Desde Ajustes se puede desconectar Gmail: se eliminan la conexión cifrada y los metadatos de sincronización asociados, conservando las copias y decisiones locales existentes. También se puede revocar el acceso desde la configuración de la Cuenta de Google. El administrador gestiona los usuarios autorizados y la conservación de esta instalación.</p>
<h2>Contacto</h2><p>Para consultas sobre esta instalación o solicitudes relacionadas con sus datos, contacta con <a href="mailto:${address}">${address}</a>.</p>
<p><a href="${escape(config.appOrigin)}">Abrir el webmail</a> · <a href="https://developers.google.com/terms/api-services-user-data-policy">Política de datos de las APIs de Google</a></p></main></html>`;
  return new Response(head ? null : body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
