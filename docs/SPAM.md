# Spam y recuperación

La clasificación del webmail es independiente de Gmail. El reenvío llega a Gmail
después de pasar por el Worker: las etiquetas que Gmail asigne allí no regresan
al webmail. Esta implementación no accede a la API de Gmail ni añade permisos
de Google, proveedores de análisis externos o servicios de pago.

## Qué se clasifica

La protección está activa por defecto para las nuevas entradas. Se consideran:

- remitentes exactos incluidos en `spamProtection.blockedSenders`;
- un resultado DMARC fallido del primer `Authentication-Results` identificado
  como `mx.cloudflare.net`, según el contrato de Cloudflare;
- indicaciones positivas en `X-Spam-Flag`, `X-Spam-Status` o
  `X-CFEmailSecurity-Disposition`. Son pistas recibidas con el mensaje, no prueba
  de autenticidad ni una clasificación de Gmail. Un resultado negativo en una
  de esas cabeceras no anula las demás señales.

No se inventa un umbral para `X-Cf-Spamh-Score`, cuya escala y disponibilidad no
están especificadas en la documentación vigente. Tampoco se considera spam un
mensaje solo por incluir palabras como «urgente» o el nombre de una marca.
El filtro no garantiza detectar todo el spam ni reproducir las decisiones de
Gmail; se puede corregir cada mensaje desde el lector.

## Comportamiento

- Los originales se reenvían al archivo principal sin modificar sus bytes,
  incluso si la copia temporal se clasifica como spam.
- Las copias en Spam no aparecen en Recibidos, Todos, Filtrados, etiquetas ni
  resúmenes. El conteo y el claim de pendientes comprueban esta exclusión.
- La carpeta **Spam** permite revisar y descargar el original. El lector muestra
  texto sin ejecutar enlaces, HTML ni imágenes. **No es spam** recupera la
  presentación normal y la carpeta que corresponda a las reglas de la empresa.
- **Marcar como spam** y **No es spam** afectan a la bandeja compartida y exigen
  la autenticación, el buzón autorizado y el mismo control de origen que las
  demás modificaciones. Solo se pueden aplicar a mensajes recibidos.
- Una restauración queda guardada como decisión manual. El mantenimiento no la
  anula al volver a aplicar la lista de remitentes bloqueados.
- Se conserva la política de retención existente; marcar un mensaje no lo borra
  ni cambia su copia en Gmail.

## Configuración por empresa

```json
"spamProtection": {
  "enabled": true,
  "blockedSenders": ["unwanted@example.net"]
}
```

La lista admite hasta 500 direcciones exactas y se normaliza a minúsculas. No es
una lista global de la plantilla. El mantenimiento horario también aplica esas
reglas a los entrantes activos ya almacenados, por lotes de 50 remitentes, sin
descargar cuerpos y preservando decisiones manuales. No se vuelve a analizar
automáticamente todo el MIME histórico. `enabled: false` desactiva la
clasificación automática, sin borrar decisiones guardadas ni la carpeta Spam.

## Migración

Antes de desplegar, guarda un respaldo D1 y aplica
`migrations/202611040900_message_spam.sql`. Es aditiva y crea
`mail_message_spam`, sin modificar ni eliminar mensajes. Las migraciones
históricas `0007`–`0009` de filtros, borradores y programación conservan sus
nombres al promoverse a la plantilla para no repetir un `ALTER TABLE` ya
aplicado en instalaciones anteriores.

Referencias: [Email Workers API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)
y [Postmaster de Cloudflare](https://developers.cloudflare.com/email-service/reference/postmaster/).
