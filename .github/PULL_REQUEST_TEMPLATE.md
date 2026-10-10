## Issue

<!-- Obligatoria en `feat` y `fix`: sustituye la línea de abajo por "Closes #N" con el número real de la issue.
     En el resto de tipos (docs, chore, refactor, ci...) puedes dejarla tal cual o borrarla.
     Lo que va dentro de un comentario HTML (como este) no cuenta como referencia. -->

Closes #

## Qué cambia y por qué

<!-- El título del PR es el commit convencional que quedará en `main` (se fusiona con squash):
     tipo(scope): descripción, de 100 caracteres como máximo. Ejemplo: feat(landing): añade el selector de idioma -->

## Verificación

- [ ] `npm run check`
- [ ] `npm run test:scripts`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm audit --omit=dev --audit-level=high`

## Checklist de esta web

- [ ] ES y EN actualizados en el mismo cambio (`src/i18n/es.json` y `src/i18n/en.json`)
- [ ] Capturas a 320 y 1440 px adjuntas, si el cambio es visual
- [ ] Sin cookies, rastreadores ni scripts de terceros
- [ ] Solo fuentes autoalojadas (`@fontsource`); ninguna petición a Google Fonts
- [ ] Los selectores que usan los tests siguen intactos, o los tests están actualizados
- [ ] Commits convencionales y sin atribución de IA
