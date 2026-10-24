# Contribuir

Gracias por querer mejorar White-label Webmail. El proyecto usa la licencia MIT y el [Developer Certificate of Origin 1.1](DCO).

## Antes de empezar

- Abre un issue para cambios grandes o que alteren datos, migraciones o seguridad.
- No incluyas secretos, tokens, contraseñas, correos reales de clientes ni archivos `wrangler.production.jsonc`.
- Para cambios de interfaz, adjunta una captura o describe la verificación en escritorio y móvil.

## Licencia de las contribuciones

Al enviar una contribución aceptas que se publique bajo la licencia MIT del proyecto y certificas el DCO 1.1. No se requiere cesión de copyright.

Cada commit debe incluir la línea de firma:

```text
Signed-off-by: Nombre <correo@ejemplo.com>
```

Puedes añadirla automáticamente con:

```bash
git commit -s -m "Describe el cambio"
```

El CI rechaza pull requests con commits sin firma. No se aceptan commits generados por terceros sin la certificación correspondiente.

## Flujo de trabajo

1. Haz un fork y crea una rama desde `main`.
2. Instala y valida:

   ```bash
   npm ci
   npm run configure
   npm run verify
   ```

3. Haz commits pequeños y firmados.
4. Abre un pull request completando la plantilla.
5. Atiende la revisión y mantén la rama actualizada.

## Migraciones

Las migraciones existentes usan el prefijo numérico histórico `0001`–`0006`. Para migraciones nuevas usa un prefijo con fecha UTC:

```text
migrations/202610231530_add_example.sql
```

Así una instalación que ya tiene migraciones locales `0007`, `0008` o posteriores no choca con una migración nueva de la plantilla. No renombres migraciones ya publicadas y no apliques migraciones destructivas sin una estrategia de respaldo.

## Actualizaciones en instalaciones

Las instalaciones creadas desde la plantilla pueden activar el workflow `Update from template`. Consulta [Actualizaciones de la plantilla](docs/TEMPLATE-UPDATES.md). Los cambios de código llegan como un pull request; nunca se sobrescribe la configuración de una empresa ni sus secretos.

## Seguridad

No publiques vulnerabilidades en un issue. Sigue [SECURITY.md](SECURITY.md).
