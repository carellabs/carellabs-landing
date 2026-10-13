# carellabs-landing

Landing / portfolio de carellabs.com. Astro, estático, bilingüe (ES en `/`, EN en `/en/`).

## Arrancar en local

Requiere Node `>=24.21.0`. La versión exacta del proyecto está en `.nvmrc` (la usan también el CI y Cloudflare Workers).

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # genera dist/
npm run preview    # sirve dist/ en local
```

## Dónde se edita cada cosa

| Qué | Archivo |
|---|---|
| Textos en español | `src/i18n/es.json` |
| Textos en inglés | `src/i18n/en.json` |
| Apps del laboratorio (nombre, estado, URL, stack) | `src/data/apps.json` |
| Estilos / tokens de color y tipografía (oscuro por defecto, claro con `prefers-color-scheme`) | `src/styles/global.css` |
| Estructura de la página (compone cabecera, secciones y pie) | `src/components/Landing.astro` |
| Dominio, idiomas y sitemap | `astro.config.mjs` |
| Qué pueden rastrear los bots (buscadores sí; los que entrenan modelos de IA, no) | `public/robots.txt` |
| Una sección | `src/components/sections/` (`Hero`, `Profile`, `Lab`, `Experience`, `Contact`) |
| Cabecera y pie | `src/components/SiteHeader.astro`, `src/components/SiteFooter.astro` |
| `<head>`, SEO, fuente, esquema de color | `src/layouts/BaseLayout.astro` |
| Cabeceras de seguridad (Cloudflare las aplica a todos los assets) | `public/_headers` |
| Despliegue en Cloudflare Workers (dominio, assets estáticos, 404, vistas previas) | `wrangler.jsonc` |
| Contacto de seguridad publicado (RFC 9116) | `public/.well-known/security.txt` |
| Análisis de código con CodeQL (workflows y JavaScript/TypeScript; informativo, no bloquea la fusión) | `.github/workflows/codeql.yml` |
| Comprobación automática de producción (a diario y tras cada push a `main`; informativa, no bloquea la fusión) | `.github/workflows/prod-check.yml` y `.github/scripts/prod-check.mjs` |
| Imágenes de previsualización en redes (`og:image`) | `scripts/og/template.html`; se generan con `npm run og` en `public/og-{es,en}.png` |

La fuente (JetBrains Mono) se aloja en la propia web con `@fontsource-variable/jetbrains-mono`: no se carga nada de Google Fonts y la CSP solo admite `font-src 'self'`.

La web no lleva JavaScript y la CSP lo refleja: `default-src 'none'` y solo estilos, fuentes e imágenes propios. Si algún día se añade un `<script>` o un manejador en línea (`onclick=`…), hay que revisar la CSP de `public/_headers` a la vez; un test que recorre el HTML de `dist/` avisa.

### Trayectoria

Cada puesto de `experience.items` (en `es.json` y `en.json`) lleva `"group": "software"` o `"before"`. El primer puesto de `software` se marca como actual (clase `now`).

### Estados de una app en `apps.json`

- `in-progress` → se muestra sin enlace
- `beta` / `live` → el nombre enlaza a `url`

Además, con `"hidden": true` la app sigue en el fichero, pero la web no la muestra (para ocultarla de momento sin borrarla). Para volver a mostrarla, quita esa línea. Ojo: el repositorio es público, así que su nombre y su descripción siguen visibles en GitHub.

En cada app se muestra el subdominio, derivado del hostname de `url`.

## Tests

```bash
npm test              # build + preview + suite completa (Playwright)
npm run test:ui       # modo interactivo
npm run test:scripts  # tests de .github/scripts y de la configuración del repo (node:test, sin navegador)
npm run check         # comprobación de tipos (astro check)
```

La primera vez: `npx playwright install chromium`.

Los tests levantan su propio `astro preview` en el puerto **4322** (el `npm run dev` usa el 4321, así que nunca se mezclan).

| Suite | Qué comprueba |
|---|---|
| `tests/responsive.spec.ts` | Sin scroll horizontal ni elementos fuera del viewport en 320/390/768/1024/1440 px; contenido clave visible; tamaño de letra y longitud de línea legibles; objetivos táctiles ≥ 44 px en móvil; en el mosaico del laboratorio, la tarjeta destacada termina a la altura del resto |
| `tests/a11y.spec.ts` | Cero violaciones WCAG 2.1 AA (axe-core) en móvil y escritorio, ambos idiomas y ambos esquemas de color (oscuro y claro); además falla si axe no puede evaluar un contraste (`incomplete`), salvo los textos de la tarjeta FinApp, que se comprueban a mano en `theme.spec.ts` |
| `tests/content.spec.ts` | Idioma correcto por ruta, año del pie fijo en 2026 (el build no depende de la fecha), selector de idioma (URL exacta y `lang`, en cabecera y pie), canonical y `hreflang` con su valor exacto, `og:url`, anclas internas, apps en desarrollo sin enlace, apps ocultas (`hidden`) sin rastro en la página, subdominio de cada app, trayectoria en dos grupos con un único puesto actual, sin raya larga (U+2014) ni media (U+2013), enlace «saltar al contenido», 404 (textos y no indexable: `noindex` y sin canonical, `hreflang` ni `og:*`); en CI además bloquea placeholders (`TU_USUARIO`, `lorem ipsum`, `TODO`) y exige que `og:image` sea un PNG que el sitio sirve |
| `tests/theme.spec.ts` | `color-scheme` y `theme-color` por esquema, fondo según `prefers-color-scheme`, contraste del botón principal (reposo y hover), de los rellenos ámbar (WCAG 1.4.11) y de los textos de la tarjeta FinApp sobre su fondo de puntos |
| `tests/semantics.spec.ts` | El enlace de salto mueve el foco a `main`, el anillo de foco sigue visible en enlaces y no rodea todo `main`, todas las listas conservan `role="list"`, y el separador `/` de las especialidades no se anuncia |
| `tests/i18n.spec.ts` | `es.json` y `en.json` con las mismas claves, ninguna clave sin uso, ningún texto de interfaz escrito a mano en las plantillas (sin contar sus bloques `<style>` y `<script>`, en mayúsculas o minúsculas) |
| `tests/headers.spec.ts` | `public/_headers`: cabeceras de seguridad, HSTS de un año sin `includeSubDomains` ni `preload`, CSP exacta (`default-src 'none'`, sin `script-src` ni `connect-src`, sin `data:`, con `form-action 'none'`), ningún `<script>` en el HTML de `dist/`, caché inmutable solo para `/_astro/*`, y las páginas (`/`, `/en/` y la 404) cargan sin violaciones de CSP, en esquema oscuro y claro, con esa política aplicada de verdad (un `<script>` propio inyectado a mano se bloquea) |
| `tests/seo.spec.ts` | `sitemap-0.xml` con las dos URL y sus alternates `es`/`en`; `robots.txt` apunta al índice del sitemap |
| `tests/fonts.spec.ts` | Fuente alojada en la web (sin peticiones a Google, una descarga por archivo, sin `data:`) y CSP de `public/_headers` sin dominios externos |
| `.github/scripts/pr-policy.test.mjs` | Política de PR: título como commit convencional (de hasta 100 caracteres, con un carácter visible tras los dos puntos), `Closes #N` obligatorio en `feat`/`fix` (con `Closes: #N` admitido, sin `#0` y sin contar lo que va dentro de comentarios HTML `<!-- -->`, ni lo que sigue a uno sin cerrar), etiqueta `type:*` derivada del título, la plantilla de PR, y que la CLI no inyecta nada en `$GITHUB_OUTPUT` ni en el log |
| `.github/scripts/repo-config.test.mjs` | Configuración del repositorio: acciones fijadas por SHA, concurrencia de `ci.yml`, privilegios separados en `pr-policy.yml`, `codeql.yml` (lenguajes, eventos, cron y permisos mínimos, sin entrar en el ruleset), `prod-check.yml` (eventos, cron diario, solo lectura, la espera solo tras un push, concurrencia propia: una ejecución nueva del mismo evento cancela la anterior, sin entrar en el ruleset), que nada de `src/` lea la fecha de construcción (build reproducible), ruleset con `integration_id`, plantilla de PR y skill alineadas, puerto de Playwright |
| `.github/scripts/prod-check.test.mjs` | Comprobación de producción, con un `fetch` falso (y un servidor local para las redirecciones): estados y redirección de `/en`, cabeceras de `_headers` con su valor exacto, caché de `/_astro`, HTML, `robots.txt` y `security.txt` idénticos byte a byte, margen de 60 días de `security.txt` (con reloj inyectado), `www` al dominio raíz, modo espera (sin esperar de verdad), que ninguna petición sigue redirecciones y que lo que llega de la red se sanea antes del log |

En CI (`.github/workflows/ci.yml`) corre además `npm audit --omit=dev --audit-level=high` (dependencias de producción), `npm run check`, `npm run test:scripts` y Lighthouse con umbrales: performance ≥ 95, accesibilidad 100, buenas prácticas ≥ 95, SEO 100 (`lighthouserc.json`). El workflow `.github/workflows/pr-policy.yml` valida cada PR (check `pr-policy`, solo lectura) y, en un segundo job sin checkout (`label`), le pone la etiqueta `type:*`. `.github/workflows/audit.yml` hace cada lunes una auditoría completa (también de desarrollo) y se puede lanzar a mano; no es obligatorio para fusionar. `.github/workflows/codeql.yml` analiza con CodeQL los workflows (`actions`) y el JavaScript/TypeScript en cada PR a `main`, en cada push a `main` y cada miércoles; es informativo (resultados en *Security > Code scanning*), tampoco es obligatorio, y exige tener desactivada la «default setup» de CodeQL de GitHub (apartado 4.3 de la guía). `.github/workflows/prod-check.yml` (workflow `Producción`, job `produccion`) construye `main` y comprueba lo que sirve https://carellabs.com: estados, cabeceras de `public/_headers`, HTML idéntico al build, `robots.txt` y `security.txt` idénticos a los de `public/` (con margen de más de 60 días antes de que caduque), y la redirección de `www`. Corre cada día (si algo falla, repite una vez a los 60 s y solo falla si persiste), tras cada push a `main` (espera hasta 10 minutos a que Cloudflare publique ese commit) y a mano con `gh workflow run prod-check.yml`; en local, `npm run build` y `npm run check:prod`. Es de solo lectura, no abre issues (si falla, GitHub avisa por correo) y tampoco es obligatorio para fusionar.

## Flujo de trabajo

rama → PR → checks → squash. Nunca se hace commit ni push directo a `main`, salvo el primer push del repositorio, antes de activar el ruleset (apartado 1 de la [guía de configuración](.claude/skills/carellabs-github/references/github-setup.md)).

1. Crea una rama desde `main` actualizada: `feat/…`, `fix/…`, `chore/…`, `docs/…` (y el resto de tipos de commit convencional).
2. Haz commits convencionales (`feat(landing): añade el selector de idioma`), uno por unidad de trabajo, con sus tests y su documentación.
3. Abre un PR con la plantilla. El título del PR es el commit convencional final, porque se fusiona con **squash**.
4. Tienen que pasar los checks obligatorios: `test`, `lighthouse` y `pr-policy`.
5. Se fusiona con squash y la rama se borra.

La issue es obligatoria **solo** para `feat` y `fix` (con `Closes #N` en el cuerpo del PR). La etiqueta `type:*` se pone sola a partir del título. Dependabot propone actualizaciones los lunes (`.github/dependabot.yml`).

- Skill del flujo (para humanos y agentes): [`.claude/skills/carellabs-github/SKILL.md`](.claude/skills/carellabs-github/SKILL.md)
- Plantillas: [`PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) e [`ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/)
- Configuración única de GitHub (repo, ruleset, etiquetas, seguridad, Cloudflare): [`github-setup.md`](.claude/skills/carellabs-github/references/github-setup.md)

## Despliegue

Cloudflare Workers con la integración Git (Workers Builds): la web se publica como assets estáticos de un Worker sin código, configurado en `wrangler.jsonc` (`dist/`, 404 propia, una vista previa por PR, sin telemetría). Build command: `npm run build`. Deploy command: `npx wrangler deploy`. Las ramas de los PR usan el comando de serie, `npx wrangler preview`. Se hace en dos fases: primero solo en `*.workers.dev`, para comprobar cabeceras y CSP en Cloudflare, y después con el dominio `carellabs.com` en `wrangler.jsonc`. Pasos en el apartado 6 de la [guía de configuración](.claude/skills/carellabs-github/references/github-setup.md) y comprobaciones en su apartado 7, (el workflow `Producción` automatiza casi todas, cada día y tras cada push a `main`).

## Seguridad

Para reportar una vulnerabilidad, mira [`SECURITY.md`](SECURITY.md): por correo, sin abrir una issue pública.

## Licencia

- **Código** (todo lo que hay en este repositorio, salvo lo que se indica a continuación): licencia [MIT](LICENSE), © 2026 Fabrizio Carella.
- **Textos del CV y del portfolio** (los de `src/i18n/*.json`, `src/data/apps.json` y todo el contenido de la web publicada) y la **marca «Carellabs»** (nombre y elementos gráficos asociados): **todos los derechos reservados**. La licencia MIT no los cubre: no se pueden copiar, reutilizar ni redistribuir sin permiso. El detalle está en [`NOTICE`](NOTICE).
