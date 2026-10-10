---
name: carellabs-github
description: "Trigger: rama, commit, PR, issue, push, merge, GitHub, release en carellabs-landing. Aplica el flujo de ramas, commits y PR del repo."
license: "MIT"
metadata:
  author: carellabs
  version: "1.1"
---

## Activation Contract

Carga esta skill antes de crear ramas, commits, PR o issues, hacer push, fusionar o publicar en `carellabs-landing`. Carga también `work-unit-commits` si existe.

## Hard Rules

- Nunca commit ni push a `main`. Única excepción: el commit y push inicial del repo vacío, antes del ruleset (`references/github-setup.md` §1). Ramas `^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)/[a-z0-9._-]+$` desde `main` actualizada.
- ANTES de commitear, `git config --local user.email` definido (identidad propia del repo, no la global). Si no, PARA y pregunta.
- Commits convencionales `tipo(scope)!: descripción`, uno por unidad de trabajo, con sus tests y docs. Sin `Co-Authored-By` ni atribución de IA.
- `feat` y `fix` exigen issue y `Closes #N` en el PR. Título del PR = commit final (squash), máximo 100 caracteres.
- Antes de abrir el PR, como la plantilla: `npm run check`, `npm run test:scripts`, `npm test`, `npm run build`, `npm audit --omit=dev --audit-level=high`.
- Nunca `--no-verify`, force push a `main` ni saltarte checks.
- Web: ES y EN en el mismo cambio; capturas a 320 y 1440 px si es visual; sin cookies, rastreadores ni scripts de terceros; solo fuentes autoalojadas (`@fontsource`), ninguna petición a Google Fonts; selectores de tests intactos o tests actualizados.

## Decision Gates

| Cambio | Commit | ¿Issue? | Etiqueta |
|---|---|---|---|
| Funcionalidad | `feat` | sí | `type:feature` |
| Corrección | `fix` | sí | `type:bug` |
| Documentación | `docs` | no | `type:docs` |
| Refactor | `refactor` | no | `type:refactor` |
| Rendimiento | `perf` | no | `type:feature` |
| Estilo, tests, build, CI, mantenimiento | `style` `test` `build` `ci` `chore` | no | `type:chore` |
| Revertir | `revert` | no | `type:bug` |
| Cualquiera con `!` | `tipo!` | según tipo | `type:breaking-change` |

En `main` → crea rama antes de tocar nada. Un check falla → arréglalo.

## Execution Steps

1. `git switch main && git pull --ff-only && git switch -c <tipo>/<nombre>`.
2. Verifica `user.email` local; implementa con tests.
3. Ejecuta las verificaciones; `git push -u origin <rama>`; abre el PR con la plantilla.
4. Espera `test`, `lighthouse` y `pr-policy`; fusiona con squash.

## Output Contract

Rama, commits, verificaciones, URL del PR y pendientes.

## References

- `references/github-setup.md`, `assets/ruleset-main.json`: configuración única de GitHub y ruleset de `main`.
- `../../../.github/PULL_REQUEST_TEMPLATE.md`, `../../../.github/ISSUE_TEMPLATE/`, `../../../.github/scripts/pr-policy.mjs`: plantillas y política de PR.
