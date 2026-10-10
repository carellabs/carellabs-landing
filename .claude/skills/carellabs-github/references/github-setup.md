# Configuración de GitHub de `carellabs-landing` (capa 1)

> **Pasos 0 a 4 ejecutados contra el repositorio real el 10-oct-2026, con todas sus comprobaciones como se esperaba (ver "Verificado en la primera ejecución", al final). Los pasos 6 y 7 (Cloudflare Workers) siguen sin ejecutar.**
> Los puntos que la documentación no deja cerrados (o que dependen de la interfaz) están en "No verificado", al final. Antes de ejecutar un paso, comprueba que la documentación enlazada sigue diciendo lo mismo.

Se ejecuta **una sola vez**, por una persona (no por un agente), cuando:

- la cuenta propietaria existe y tienes control total sobre ella (ver "Propietario" más abajo);
- el repositorio local tiene sus primeros commits, ya en la rama `main`;
- los workflows (`.github/workflows/`) y `.github/dependabot.yml` están en esos commits;
- no quedan placeholders: `TU_USUARIO` está sustituido en `src/i18n/*.json` por la cuenta real (es decir, `$OWNER` ya está decidido). Si no, el check `test` falla en CI desde el primer push y el primer PR no se puede fusionar.

Todos los comandos se lanzan desde la raíz del repositorio, en el orden de esta guía. Cada paso trae su comprobación.

## Variables

```bash
OWNER=carellabs                      # cuenta personal de GitHub (decidido el 10-oct-2026)
REPO="$OWNER/carellabs-landing"
```

Las variables solo existen en la terminal donde las defines: ejecuta toda la guía en la misma sesión, o vuelve a definirlas antes de cada bloque.

**Propietario: cuenta personal `carellabs`** (decidido el 10-oct-2026; la API la devuelve como `"type": "User"`). Donde la guía distingue entre organización y cuenta personal, aplica siempre la rama "Si es cuenta personal". Los comandos siguen usando `$OWNER` y `$REPO`.

## 0. Comprobaciones previas

```bash
gh auth status                      # cuenta carellabs, "Git operations protocol: ssh"
ssh -T git@github.com               # "Hi carellabs! ..." (pide la frase de la clave)
git config --local user.email       # identidad propia del repo definida (si sale vacío, para)
git branch --show-current           # debe ser main
grep -rn "TU_USUARIO" src/          # no debe imprimir nada (si imprime, para)
```

**El push va por SSH**, con la clave de la cuenta carellabs (`~/.ssh/id_ed25519_carellabs`, asignada a `github.com` en `~/.ssh/config`). Si en tu equipo la credencial HTTPS guardada para GitHub es la de **otra** cuenta (la de otro proyecto), este repositorio no debe usar HTTPS: el push saldría con esa cuenta o fallaría. Con SSH, el push no depende del token de `gh` ni de su scope `workflow`; ese scope solo hace falta para hacer push de `.github/workflows/` por HTTPS con el token de `gh`, y aquí no se hace. `gh` se usa solo para la API (crear el repo, etiquetas, ajustes, ruleset) con los scopes por defecto (`repo`, `read:org`, `gist`).

Si la rama se llama `master`: `git branch -M main`.

## 1. Crear el repositorio, las etiquetas y hacer el primer push

El orden importa: las etiquetas tienen que existir **antes** del primer `git push`, porque ese push lleva `dependabot.yml` y sus primeros PR (con `labels: ["type:chore"]`) saldrían sin etiqueta. Y para crear etiquetas el repositorio tiene que existir, así que primero se crea vacío.

### 1.1 Crear el repositorio público (vacío, sin remoto local todavía)

```bash
gh repo create "$REPO" --public \
  --homepage "https://carellabs.com" \
  --description "Landing / portfolio de carellabs.com (Astro, estática, bilingüe ES/EN)"
```

### 1.2 Etiquetas

También las usa el workflow `pr-policy` al etiquetar cada PR. `--force` actualiza la etiqueta si ya existe.

```bash
gh label create "type:feature"         --repo "$REPO" --color 0E8A16 --description "Funcionalidad nueva (feat, perf)" --force
gh label create "type:bug"             --repo "$REPO" --color D73A4A --description "Corrección de un fallo (fix, revert)" --force
gh label create "type:docs"            --repo "$REPO" --color 0075CA --description "Documentación" --force
gh label create "type:refactor"        --repo "$REPO" --color 5319E7 --description "Refactor sin cambio de comportamiento" --force
gh label create "type:chore"           --repo "$REPO" --color CFD3D7 --description "Mantenimiento (chore, style, test, build, ci)" --force
gh label create "type:breaking-change" --repo "$REPO" --color B60205 --description "Cambio incompatible (tipo con !)" --force
```

Comprobación: `gh label list --repo "$REPO" --limit 100 --json name --jq '.[].name' | grep '^type:'` debe listar las seis. No uses `--search "type:"`: es una búsqueda difusa y puede ocultar alguna.

### 1.3 Remoto y primer push

```bash
git remote add origin "git@github.com:$REPO.git"
git push -u origin main
```

Comprobación del remoto: `git remote get-url origin` debe dar `git@github.com:carellabs/carellabs-landing.git` (SSH, no `https://`).

Ese `git push` directo a `main` es la **única excepción** a la regla "nunca push a `main`" (la skill remite a este apartado): el repositorio está vacío y todavía no hay ruleset (sin un primer commit en `main` no existen ni la rama por defecto ni los workflows, y los checks obligatorios no podrían ejecutarse). A partir del paso 3, `main` queda protegida.

Comprobación: `gh repo view "$REPO" --json visibility,defaultBranchRef --jq '.visibility, .defaultBranchRef.name'` debe dar `PUBLIC` y `main`.

## 2. Ajustes del repositorio

Solo squash, con el título del PR como título del commit y los mensajes de los commits de la rama como mensaje; ramas fusionadas se borran; sin wiki.

```bash
gh api -X PATCH "repos/$REPO" \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -f squash_merge_commit_title=PR_TITLE \
  -f squash_merge_commit_message=COMMIT_MESSAGES \
  -F delete_branch_on_merge=true \
  -F allow_update_branch=true \
  -F has_wiki=false
```

`-F` (mayúscula) envía booleanos reales; `-f` los enviaría como texto `"false"`. No los intercambies.

Comprobación:

```bash
gh api "repos/$REPO" --jq '{allow_squash_merge, allow_merge_commit, allow_rebase_merge, squash_merge_commit_title, squash_merge_commit_message, delete_branch_on_merge, allow_update_branch, has_wiki}'
```

Esperado (un objeto JSON en una línea): `{"allow_squash_merge":true,"allow_merge_commit":false,"allow_rebase_merge":false,"squash_merge_commit_title":"PR_TITLE","squash_merge_commit_message":"COMMIT_MESSAGES","delete_branch_on_merge":true,"allow_update_branch":true,"has_wiki":false}`.

`allow_update_branch`: el ruleset exige que la rama del PR esté al día con `main` (`strict_required_status_checks_policy`); con este ajuste el PR muestra el botón *Update branch* en vez de obligar a actualizarla a mano.

Por qué `COMMIT_MESSAGES` (decisión del propietario): el cuerpo del commit en `main` es la lista de los commits convencionales de la rama, uno por unidad de trabajo, en lugar de la plantilla del PR con sus casillas y comentarios. Con `PR_BODY` esa plantilla entera acabaría en el historial.

Validez de la combinación: la [API REST de repositorios](https://docs.github.com/en/rest/repos/repos#update-a-repository) documenta `PR_TITLE` y `COMMIT_OR_PR_TITLE` para el título, y `PR_BODY`, `COMMIT_MESSAGES` y `BLANK` para el mensaje (y exige indicar el título cuando se indica el mensaje). La [guía de la interfaz](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/configuring-commit-squashing-for-pull-requests) ofrece "el título del PR y los detalles de los commits". Si la API respondiera 422 a esta pareja, la comprobación de arriba lo dejaría a la vista; en ese caso, cámbialo desde *Settings > General > Pull Requests*.

## 3. Ruleset de la rama por defecto

El fichero `assets/ruleset-main.json` (en esta misma skill) define, sobre `~DEFAULT_BRANCH`:

| Regla | Efecto |
|---|---|
| `deletion` | `main` no se puede borrar |
| `non_fast_forward` | sin force push |
| `required_linear_history` | historial lineal |
| `pull_request` | PR obligatorio, 0 aprobaciones, hilos resueltos, solo squash |
| `required_status_checks` | `test`, `lighthouse` y `pr-policy`, publicados por la app GitHub Actions (`integration_id` 15368), con política estricta (la rama del PR debe estar al día con `main`) |

`bypass_actors` está vacío: nadie, tampoco el propietario, se salta el ruleset. Para una emergencia, desactívalo a mano en *Settings > Rules > Rulesets*.

El `integration_id` evita que otra app o un estado publicado a mano por la API satisfaga un check con el mismo nombre. 15368 es el identificador de la app GitHub Actions: se puede confirmar con `gh api apps/github-actions --jq .id`.

```bash
gh api -X POST "repos/$REPO/rulesets" \
  --input .claude/skills/carellabs-github/assets/ruleset-main.json
```

Comprobación:

```bash
gh api "repos/$REPO/rulesets" --jq '.[] | {id, name, enforcement}'
gh api "repos/$REPO/rules/branches/main" --jq '.[].type'
```

Esperado: un ruleset `main` con `enforcement: "active"` y los cinco tipos de regla.

Los nombres de los checks (`test`, `lighthouse`, `pr-policy`) son los `name` de los jobs de `ci.yml` y `pr-policy.yml`. El workflow `pr-policy.yml` tiene además un job `label` (pone la etiqueta `type:*`) que **no** es obligatorio, y `audit.yml` (auditoría semanal completa de dependencias) tampoco. Si al abrir el primer PR alguno de los tres obligatorios se queda en "Expected - Waiting for status to be reported", el contexto no coincide con el nombre real del check: corrígelo en el ruleset (ver "No verificado").

Para deshacerlo: `gh api -X DELETE "repos/$REPO/rulesets/<id>"`.

Referencia de los campos: [REST, reglas y rulesets](https://docs.github.com/en/rest/repos/rules).

## 4. Seguridad del repositorio y de Actions

### 4.1 Alertas, actualizaciones de seguridad y escaneo de secretos

```bash
gh api -X PUT "repos/$REPO/vulnerability-alerts"
gh api -X PUT "repos/$REPO/automated-security-fixes"
gh api -X PUT "repos/$REPO/private-vulnerability-reporting"   # canal privado que cita SECURITY.md (Report a vulnerability)

gh api -X PATCH "repos/$REPO" --input - <<'EOF'
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
EOF
```

Precaución, no requisito documentado: se activan primero las alertas (que habilitan el grafo de dependencias) y después las actualizaciones de seguridad automáticas, porque estas últimas se apoyan en ese grafo.

Comprobación:

```bash
gh api "repos/$REPO/vulnerability-alerts" -i | head -n 1     # 204 = activadas, 404 = desactivadas
gh api "repos/$REPO/automated-security-fixes" --jq .enabled   # true
gh api "repos/$REPO/private-vulnerability-reporting" --jq .enabled   # true
gh api "repos/$REPO" --jq .security_and_analysis              # secret_scanning y push protection: enabled
```

### 4.2 Actions: acciones fijadas por SHA y aprobación de forks

```bash
# Exige que toda acción de un workflow esté fijada a un SHA completo (los nuestros ya lo están).
gh api -X PUT "repos/$REPO/actions/permissions" -F enabled=true -F sha_pinning_required=true

# Los PR de colaboradores externos (forks) necesitan aprobación manual para ejecutar workflows.
gh api -X PUT "repos/$REPO/actions/permissions/fork-pr-contributor-approval" \
  -f approval_policy=all_external_contributors
```

Ambos endpoints están en la [referencia REST de permisos de Actions](https://docs.github.com/en/rest/actions/permissions). El primero no toca `allowed_actions` (si no lo envías, no lo cambias). El segundo admite `first_time_contributors_new_to_github`, `first_time_contributors` y `all_external_contributors` (el más estricto, el elegido).

Comprobación:

```bash
gh api "repos/$REPO/actions/permissions" --jq '{enabled, sha_pinning_required}'                 # true, true
gh api "repos/$REPO/actions/permissions/fork-pr-contributor-approval" --jq .approval_policy      # all_external_contributors
```

### Opcional: token de workflows de solo lectura

Es coherente con los `permissions` explícitos de los workflows: el valor por defecto del repositorio también queda en lectura.

```bash
gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read \
  -F can_approve_pull_request_reviews=false
```

## 5. Autenticación en dos factores

### Si `$OWNER` es una organización (interfaz web; no hay un comando `gh` fiable)

1. `github.com` > foto de perfil > **Your organizations** > `$OWNER` > **Settings**.
2. Barra lateral: **Authentication security** (dentro del grupo *Security*).
3. Marca **Require two-factor authentication for everyone in your organization** y guarda.

Tu cuenta debe tener 2FA activado antes. Qué pasa con quien no lo tenga, según la [documentación de GitHub](https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-two-factor-authentication-for-your-organization/requiring-two-factor-authentication-in-your-organization):

- **Miembros y gestores de facturación** sin 2FA: quedan **bloqueados** (no pueden acceder a los recursos de la organización) hasta que lo activen, pero **conservan la membresía** y siguen consumiendo plaza.
- **Colaboradores externos** sin 2FA: **se retiran** de la organización y pierden el acceso a sus repositorios (y a sus forks de los repositorios privados). Se les puede reinstaurar si activan 2FA en los tres meses siguientes. Las cuentas de bots o de servicio que sean colaboradores externos también necesitan 2FA.

### Si `$OWNER` es una cuenta personal

No existe el ajuste de organización. Activa 2FA en tu propia cuenta (*Settings > Password and authentication*); además GitHub exige 2FA a quien contribuye código en github.com desde marzo de 2023.

## 6. Despliegue: Cloudflare Workers con la integración Git (Workers Builds)

Cloudflare recomienda Workers para los proyectos nuevos, en lugar de Pages ([doc](https://developers.cloudflare.com/pages/get-started/)). La web se publica como **assets estáticos** de un Worker sin código. La configuración está en `wrangler.jsonc`: `assets.directory` es `./dist`, la 404 propia responde con estado 404, cada PR tiene su vista previa (`preview_urls` y el bloque `previews`) y `wrangler` no envía telemetría. `public/_headers` (CSP y caché) se aplica a todas las respuestas ([`_headers` en Workers](https://developers.cloudflare.com/workers/static-assets/headers/)). Si algún día se añadiera código Worker (`main`), esas cabeceras no se aplicarían a sus respuestas: un test de `repo-config.test.mjs` lo impide.

Se hace en dos fases, para comprobar la web en Cloudflare antes de tocar el dominio.

### 6.1 Fase 1: conectar el repositorio (la web solo en `*.workers.dev`)

Panel de Cloudflare > **Workers & Pages** > **Create application** > importar un repositorio de Git:

1. Conecta GitHub e instala la app **Cloudflare Workers and Pages** con la sesión de la cuenta propietaria (`$OWNER`). Concédele acceso **solo** a `carellabs-landing` (*Only select repositories*). Si es cuenta personal, ese acceso se revisa después en *Settings > Applications* de GitHub.
2. Selecciona el repositorio. El nombre del Worker debe coincidir con el de `wrangler.jsonc`: `carellabs-landing`.
3. Build command: `npm run build`. Deploy command: `npx wrangler deploy` (usa el `wrangler` fijado en `package.json`). Ruta: la raíz del repositorio.
4. Versión de Node: la imagen de Workers Builds lee `.nvmrc` ([build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)), así que no hace falta `NODE_VERSION`.
5. Rama de producción: `main`. Activa las builds de las ramas que no son de producción, para que cada PR reciba en un comentario su URL de vista previa ([ramas](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/)). Deja su comando de serie, `npx wrangler preview` ([Previews](https://developers.cloudflare.com/workers/previews/)): exige el bloque `previews` de `wrangler.jsonc`, que basta con que esté vacío. **Nunca** pongas ahí `npx wrangler deploy`, porque cada PR desplegaría a producción antes de fusionarse.
6. **No actives Web Analytics** ni nada que inyecte scripts en la web: lo bloquearía la CSP y contradice "sin rastreadores".

Al conectar (y en cada fusión a `main`), Workers Builds construye y despliega. La web queda en `https://carellabs-landing.<subdominio>.workers.dev`: haz con esa URL las comprobaciones del paso 7.

### 6.2 Fase 2: el dominio `carellabs.com`

Con la fase 1 comprobada, un PR añade el dominio en `wrangler.jsonc` (así no depende de clics en el panel) y desactiva `*.workers.dev` para producción:

```jsonc
"routes": [{ "pattern": "carellabs.com", "custom_domain": true }],
"workers_dev": false,
```

Al desplegar, Cloudflare crea el *Custom Domain* en la zona `carellabs.com`, que debe estar en la misma cuenta. Si ya existe un registro A, AAAA o CNAME en el dominio raíz, bórralo antes. Los registros MX y TXT del Email Routing se quedan como están. Las vistas previas de los PR siguen en `workers.dev`.

Opcional: para que `www.carellabs.com` lleve a `carellabs.com`, usa una *Redirect Rule* de la zona (plantilla de redirección de www al dominio raíz) en vez de código.

## 7. Comprobaciones tras cada fase

Primero con la URL `*.workers.dev` (fase 1) y después con `carellabs.com` (fase 2). En los comandos, `HOST` es la que toque:

```bash
HOST="carellabs-landing.<subdominio>.workers.dev"   # fase 1; en la fase 2: HOST="carellabs.com"
```

**Cabeceras reales.** La CSP y el resto tienen que llegar tal cual están en `public/_headers`, también en la 404:

```bash
curl -sI "https://$HOST"
curl -sI "https://$HOST/no-existe"     # 404, con content-security-policy y x-content-type-options
```

Busca `content-security-policy` (con `default-src 'self'`, `img-src 'self'`, `form-action 'none'`...), `x-content-type-options`, `x-frame-options`, `referrer-policy` y `permissions-policy`. Y la caché de un archivo con hash:

```bash
ASSET="$(curl -s "https://$HOST" | grep -o '/_astro/[^"]*\.css' | head -n 1)"
curl -sI "https://$HOST$ASSET" | grep -i cache-control      # public, max-age=31536000, immutable
```

**Consola sin violaciones de CSP.** Abre `/`, `/en/` y una URL inexistente con las herramientas de desarrollo (pestaña *Console*). No debe aparecer ningún mensaje "Refused to ... because it violates the following Content Security Policy directive". Si aparece, una directiva es más estricta de lo que la web necesita, o Cloudflare está inyectando algo (ver el punto 6 del paso 6.1).

**Cloudflare no ofusca el correo** (solo en la fase 2: la ofuscación es un ajuste de la zona `carellabs.com`). El correo (`hola@carellabs.com`) debe llegar en claro en el HTML:

```bash
curl -s https://carellabs.com | grep -c hola@carellabs.com        # 1 o más: correcto
```

Si da `0` y en el HTML aparece `[email protected]`, Cloudflare tiene activa la *Email Address Obfuscation* y la web depende de su script para mostrar el correo. Desactívala **solo para este host** con una *Configuration Rule* (*Rules > Configuration Rules*, ajuste *Email Obfuscation* en off, condición: hostname igual a `carellabs.com`), en vez de en toda la zona ([doc](https://developers.cloudflare.com/waf/tools/scrape-shield/email-address-obfuscation/), [ajustes de Configuration Rules](https://developers.cloudflare.com/rules/configuration-rules/settings/)). Repite la comprobación para `/en/`.

**HSTS: todavía no.** `public/_headers` no envía `Strict-Transport-Security` a propósito. Actívalo (en Cloudflare, *SSL/TLS > Edge Certificates*, o como cabecera) solo cuando **todos los subdominios** (`finanzas.`, `barberia.`, `closet.` y los futuros) sirvan HTTPS: con `includeSubDomains` los que no lo hagan quedan inaccesibles, y con `preload` es difícil dar marcha atrás ([doc](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/)).

## Primer PR de prueba

Con todo configurado, abre un PR `docs: ...` pequeño y comprueba:

- que aparecen los checks `test`, `lighthouse` y `pr-policy` con esos nombres exactos (y que `label` aparece aparte, sin ser obligatorio);
- que el PR recibe la etiqueta `type:docs`;
- que el botón de fusión solo ofrece *Squash and merge*, que el título propuesto es el del PR y que el mensaje son los commits de la rama;
- que un PR `feat: ...` sin `Closes #N` falla en `pr-policy` **y aun así recibe la etiqueta `type:feature`** (es la comprobación del paso de salidas entre los jobs `pr-policy` y `label`).

## Verificado en la primera ejecución (10-oct-2026)

Los pasos 0 a 4 se ejecutaron contra el repositorio real y cada comprobación devolvió lo esperado:

- **Pareja `PR_TITLE` + `COMMIT_MESSAGES`**: GitHub la aceptó (paso 2).
- **Ruleset, `integration_id` 15368 y nombres de los checks**: el primer PR de Dependabot mostró `test`, `lighthouse` y `pr-policy` en verde y el estado de fusión `CLEAN`; ningún check se quedó en "Expected".
- **Etiquetas antes del primer push**: ese mismo PR llegó con `type:chore`, y el job `label` se saltó, como está previsto para Dependabot.
- **`security_and_analysis`**: quedan activados `secret_scanning` y `secret_scanning_push_protection`. `secret_scanning_non_provider_patterns` y `secret_scanning_validity_checks` siguen desactivados: son extras que este repositorio no usa.
- **Actions** (`sha_pinning_required`, aprobación de forks, token de workflows en solo lectura) y **reporte privado de vulnerabilidades**: la API los aceptó y la comprobación de cada uno devolvió el valor esperado.
- **`gh label list --search`** es una búsqueda difusa y llegó a ocultar una de las seis etiquetas: la comprobación del paso 1.2 usa ahora `--limit 100` y `grep`.
- **Fase 1 de Cloudflare Workers** (paso 6.1, comprobada en `*.workers.dev`): `_headers` llega tal cual en `/`, `/en/`, en la redirección `/en` a `/en/` (307) y en la 404, que responde con estado 404 de verdad. `/_astro/*` sale con `max-age=31536000, immutable`, el HTML con `max-age=0, must-revalidate` y `_headers` no se sirve como archivo. El HTML servido es idéntico al build local y un navegador real no muestra violaciones de CSP.
- **DNS antes de la fase 2**: el dominio raíz no tenía registros A, AAAA ni CNAME, así que no hay conflicto con el Custom Domain. Los MX y el TXT de SPF del Email Routing siguen ahí, y `hola@carellabs.com` tiene su regla de reenvío.
- **La primera build de un PR falló** (el de la fase 2): Workers Builds ejecuta `npx wrangler preview` (beta abierta) en las ramas, y sin el bloque `previews` en `wrangler.jsonc` termina con error antes de subir nada. Producción no se tocó. Se añadió `"previews": {}` y un test lo vigila.

## No verificado

Lo que queda de verdad pendiente:

- **Salida de etiqueta entre jobs cuando `pr-policy` falla**: el código del runner evalúa las `outputs` del job al terminar, falle o no un paso, y la documentación solo dice que se evalúan "al final de cada job". Que el job `label` las reciba con el job anterior en rojo se confirma con el PR `feat:` sin issue del apartado "Primer PR de prueba". Si no llegara, el efecto sería solo que ese PR no se etiqueta.
- **`sha_pinning_required`**: todas las acciones están fijadas por SHA (incluida `treosh/lighthouse-ci-action`). Si una ejecución falla por una acción "no fijada", es una acción nueva o un cambio de Dependabot que perdió el SHA.
- **Ruta exacta de los menús de la interfaz**: importación del repositorio en Workers (paso 6.1) y *Configuration Rules* (paso 7). Las interfaces se reorganizan con frecuencia.
- **Custom Domain en el dominio raíz** (fase 2): que Cloudflare lo cree sin conflicto con los registros MX y TXT del Email Routing se confirma al desplegar.
- **El workflow semanal `audit.yml`**: GitHub desactiva los workflows programados de un repositorio público tras 60 días sin actividad; si deja de llegar el aviso, actívalo de nuevo desde la pestaña *Actions*.
