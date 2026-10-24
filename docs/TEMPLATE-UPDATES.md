# Actualizaciones de la plantilla

La plantilla es pública y cada instalación es un repositorio independiente. Una copia creada con **Use this template** no recibe cambios automáticamente: el workflow `Update from template` es el canal opt-in para recibirlos como pull request.

## Cómo funciona

Cada instalación guarda en `.template-version` el último tag de la plantilla que sirvió como base:

```text
v0.1.0
```

El workflow consulta los tags `vX.Y.Z` de la plantilla. Cuando aparece uno nuevo:

1. Descarga el tag base y el tag nuevo.
2. Compara la versión base, la copia local y la versión nueva archivo por archivo.
3. Aplica los cambios que no entren en conflicto.
4. Actualiza `.template-version`.
5. Ejecuta `npm run configure` y `npm run verify`, salvo que haya conflictos.
6. Publica un pull request en la instalación.

El merge es de tres vías por archivo. No depende de que los historiales de Git estén relacionados. Si la instalación y la plantilla modificaron el mismo archivo, el script deja marcadores de conflicto y abre el PR como borrador.

## Qué se actualiza y qué no

Se actualizan el código del Worker, la interfaz, los tests, las migraciones, `package.json` y los archivos compartidos.

`package.json` se mergea por claves: la plantilla puede añadir dependencias, scripts o cambiar `version`, mientras la instalación conserva su `name`, sus scripts propios y sus dependencias locales. Un cambio en la misma clave por ambos lados se reporta como conflicto, sin dejar el JSON inválido.

No se tocan:

- `config/companies/*` (salvo `example.json`);
- `public/brand/*`;
- `wrangler.production.jsonc`;
- `deployment.local.json`;
- secretos, `.dev.vars`, `.env`;
- `README.md`, `docs/`, licencia y archivos de gobernanza;
- `package-lock.json` (se regenera cuando cambia `package.json`).

## Activar el workflow en una instalación

El repositorio de la instalación debe tener:

```text
.template-version
scripts/update-from-template.mjs
.github/workflows/update-template.yml
```

El workflow se ejecuta a diario y también manualmente:

```bash
gh workflow run update-template.yml
```

Si el repositorio es privado, el token de `GITHUB_TOKEN` puede crear la rama y el PR, pero GitHub no ejecuta workflows nuevos para eventos causados por ese token. Para que el CI del PR se ejecute, crea un token de bot:

1. Crea un **fine-grained personal access token** limitado al repositorio de la instalación.
2. Dale permisos de **Contents: read and write** y **Pull requests: read and write**.
3. Guárdalo como secreto `UPDATE_BOT_TOKEN` en el repositorio de la instalación.

También puedes usar un GitHub App instalado solo en ese repositorio. El workflow usa `secrets.UPDATE_BOT_TOKEN` si existe y cae en `github.token` si no.

La plantilla debe ser pública para que las instalaciones puedan leer sus tags sin credenciales. Mientras siga privada, configura `TEMPLATE_TOKEN` en la instalación con un token de solo lectura sobre la plantilla. El script lo usa para `git ls-remote` y `git clone`, sin escribirlo en la URL.

## Publicar una actualización

En el repositorio de la plantilla:

```bash
git tag -a v0.1.1 -m "v0.1.1"
git push origin v0.1.1
```

El workflow `Release` verifica la etiqueta y crea el GitHub Release. Los tags son la fuente de verdad para las instalaciones; el Release es para las personas.

Las instalaciones reciben el cambio en la siguiente ejecución programada o cuando alguien lanza el workflow manualmente. También pueden recibir un `repository_dispatch` con tipo `template-release` si se configura un notificador central.

## Resolver conflictos

Si el PR llega como borrador:

1. Haz checkout de la rama `automation/template-vX.Y.Z`.
2. Resuelve los archivos listados en el cuerpo del PR.
3. Ejecuta:

   ```bash
   npm install
   npm run configure
   npm run verify
   ```

4. Commitea con firma y sube la rama:

   ```bash
   git commit -s -m "Resolve template update conflicts"
   git push
   ```

El workflow no vuelve a tocar un PR abierto de la misma versión. Si cierras el PR sin mergear, borra la rama antes de relanzar el workflow.

## Migraciones

Las migraciones históricas usan `0001`–`0006`. Para migraciones nuevas usa un prefijo de fecha UTC:

```text
migrations/202610231530_add_example.sql
```

Así no chocan con migraciones locales como `0007`, `0008` o `0009`. El script rechaza prefijos numéricos duplicados y marca el PR como conflictivo.

Las migraciones no se aplican automáticamente en producción. Después de mergear, revisa el SQL, haz respaldo y aplica las migraciones D1 antes de desplegar el código que las necesita.

## Despliegue

El PR actualiza el código, no la infraestructura. El despliegue sigue siendo manual porque `wrangler.production.jsonc` y `deployment.local.json` no se guardan en el repositorio.

Después de mergear y aplicar migraciones:

```bash
npm run deploy:check
npm run deploy
```

Para clientes que quieran despliegue automático, se puede añadir un workflow con un entorno protegido, un token de Cloudflare con alcance mínimo y el manifiesto de producción guardado como secreto. No lo actives sin revisar antes el aislamiento de la cuenta y los respaldos.
