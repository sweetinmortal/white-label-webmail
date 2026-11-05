# Etiquetas y reglas de organización

Las etiquetas y reglas se administran por buzón compartido en **Ajustes → Etiquetas** y **Ajustes → Reglas**. Son datos locales del webmail: no crean etiquetas, filtros ni acciones en el proveedor de correo o en Gmail.

## Etiquetas

Cada buzón admite hasta 100 etiquetas propias, con nombre y color planos (no hay jerarquías). Puedes editar una etiqueta y asignar varias a cualquier mensaje activo del buzón, entrante o enviado. Eliminar una etiqueta quita sus asignaciones locales; no se puede eliminar mientras una regla la utilice. Las etiquetas configuradas mediante `incomingFilters` siguen funcionando en **Archivados** y se muestran como configuración heredada de solo lectura: esta pantalla no las edita ni las convierte en etiquetas propias. Puedes devolver un mensaje heredado a Recibidos; conserva la etiqueta heredada y sigue disponible en Archivados.

## Reglas

Cada buzón admite hasta 50 reglas. Los criterios configurados se combinan con **AND**:

- **De contiene**: busca texto en la dirección o nombre local del remitente.
- **Para contiene**: busca en destinatarios `To`/`Cc` y en la dirección de identidad que recibió la copia.
- **Asunto contiene** y **Asunto excluye**: compara el asunto local.

Las comparaciones son literales y no distinguen mayúsculas de minúsculas. No buscan en el cuerpo ni admiten expresiones regulares, operadores, consultas Gmail o sintaxis de búsqueda.

Una regla puede aplicar una o varias etiquetas, archivar de Recibidos en este webmail, marcar como leído o cambiar la clasificación local a Spam o «No es spam». El cambio de leído se guarda para las personas autorizadas del buzón. Archivar solo quita el mensaje de Recibidos; no borra la copia ni lo archiva en Gmail.

Las reglas activas se aplican solo a nuevos mensajes recibidos. Si coinciden varias, las reglas se evalúan por fecha de creación y luego por ID; para la acción Spam prevalece la última regla coincidente que define esa acción. Guardar o editar una regla no recorre el historial automáticamente. Para aplicar una regla a mensajes existentes, usa **Aplicar a existentes**. El proceso avanza explícitamente por páginas de hasta 100 mensajes recibidos activos; la interfaz envía el cursor de la página siguiente hasta terminar. Esto no busca mensajes en Gmail ni descarga sus cuerpos.

Eliminar una regla elimina su definición, pero no revierte las etiquetas, el archivo, el leído o la clasificación que ya aplicó. Retira esos efectos en los mensajes cuando haga falta. Una acción de regla prevalece sobre la clasificación automática de Gmail o señales upstream, pero una decisión manual de spam/no spam no se reemplaza por la regla. Consulta [Spam y recuperación](SPAM.md) y [Sincronización opcional del Spam de Gmail](GMAIL-SPAM-SYNC.md) para la precedencia completa.

## Alcance y API

Las operaciones requieren una sesión autenticada y el origen del webmail. Las rutas disponibles para integración son:

- `GET /api/organization`
- `POST /api/labels`, `PATCH` o `DELETE /api/labels/:id`
- `POST /api/rules`, `PATCH` o `DELETE /api/rules/:id`
- `POST /api/rules/:id/apply` con cursor opcional
- `PATCH /api/messages/:id/labels` y `PATCH /api/messages/:id/archive`

Los límites de 100 etiquetas, 50 reglas y 100 mensajes por página son por buzón. Las reglas y su aplicación por lotes abarcan solo entrantes activos de ese buzón; la asignación manual de etiquetas también puede aplicarse a enviados. Ninguna de estas acciones afecta otros buzones ni modifica el original en Gmail.

Para ver el alcance general del producto, consulta el [README](../README.md).
