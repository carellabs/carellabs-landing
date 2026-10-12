// Política de PR de carellabs-landing (ESM, sin dependencias).
//
// Como módulo: exporta `evaluatePr({ title, body })`, una función pura.
// Como CLI (lo que ejecuta .github/workflows/pr-policy.yml): lee PR_TITLE y
// PR_BODY del entorno, escribe `label=<etiqueta>` en $GITHUB_OUTPUT si existe y
// sale con código 1 (y mensajes) si el PR incumple la política.
//
// Seguridad: el título y el cuerpo son datos NO fiables (los escribe quien abre
// el PR). Por eso nunca se vuelcan a la salida ni a $GITHUB_OUTPUT: la etiqueta
// que se escribe sale siempre de la tabla LABELS, jamás del texto del usuario.

import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Tipos de Conventional Commits admitidos. */
const TYPES = [
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
];

/** Longitud máxima del título del PR, en caracteres. */
const TITLE_MAX_LENGTH = 100;

/**
 * Formato del título: tipo(scope opcional)!opcional: descripción.
 * Tras ": " tiene que venir un carácter visible: ni un espacio ni un espacio de
 * ancho cero (U+200B a U+200D). La marca de orden de bytes (U+FEFF) ya la
 * excluye `\s`, porque ECMAScript la trata como espacio en blanco.
 */
const TITLE_RE = new RegExp(
  `^(?<type>${TYPES.join("|")})(\\([a-z0-9._-]+\\))?(?<bang>!)?: [^\\s\\u200B-\\u200D].*$`,
);

/**
 * Palabras clave de cierre de GitHub seguidas de #número (con o sin los dos
 * puntos, como admite GitHub: `Closes: #12`). El número no puede ser 0 ni
 * empezar por 0.
 */
const CLOSING_RE = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?):?\s+#[1-9]\d*\b/i;

/**
 * Quita los comentarios HTML `<!-- -->` (la plantilla de PR los usa para dar instrucciones):
 * de izquierda a derecha, cada `<!--` hasta el primer `-->` que lo cierra, y uno sin cerrar
 * oculta todo hasta el final. No se repite la pasada: en `<!-<!-- x -->- texto -->` el `<!-`
 * no abre nada y `- texto -->` se ve, también en GitHub.
 *
 * Límites conocidos (es una ayuda para quien abre el PR, no una frontera de seguridad):
 * - Con un `<!--` sin cerrar es más estricta que GitHub, que solo oculta lo que sigue si el
 *   `<!--` abre línea fuera de bloques de código. Escribe `Closes #N` antes de cualquier `<!--`.
 * - No quita otras construcciones que GitHub tampoco pinta (`<?…?>`, `<!X…>`, `<![CDATA[…]]>`,
 *   `[//]: # (…)`): una referencia escondida ahí cuenta como visible.
 */
export function stripHtmlComments(text) {
  let visible = "";
  let from = 0;
  for (let open = text.indexOf("<!--"); open !== -1; open = text.indexOf("<!--", from)) {
    visible += text.slice(from, open);
    // `<!-->` y `<!--->` también son comentarios (vacíos): el cierre puede solaparse con la apertura.
    const close = text.indexOf("-->", open + 2);
    if (close === -1) return visible;
    from = close + 3;
  }
  return visible + text.slice(from);
}

/** Tipos de cambio que exigen issue. */
const ISSUE_REQUIRED = new Set(["feat", "fix"]);

/** Tipo de commit -> etiqueta `type:*` del PR. */
const LABELS = {
  feat: "type:feature",
  fix: "type:bug",
  docs: "type:docs",
  refactor: "type:refactor",
  perf: "type:feature",
  chore: "type:chore",
  style: "type:chore",
  test: "type:chore",
  build: "type:chore",
  ci: "type:chore",
  revert: "type:bug",
};

const BREAKING_LABEL = "type:breaking-change";

const MSG_TITLE_MISSING =
  "No se ha recibido el título del PR (o está vacío).";
const MSG_TITLE_FORMAT =
  "El título del PR debe ser un commit convencional: tipo(scope)!: descripción. " +
  `Tipos: ${TYPES.join(", ")}. El tipo va en minúsculas, el scope (opcional) en ` +
  "minúsculas, dígitos, punto, guion o guion bajo, y tras los dos puntos debe haber " +
  "un espacio y un carácter visible (no un espacio de ancho cero). " +
  'Ejemplo: "feat(landing): añade el selector de idioma".';
const MSG_TITLE_LENGTH =
  `El título del PR no puede superar los ${TITLE_MAX_LENGTH} caracteres.`;
const MSG_ISSUE_REQUIRED =
  "Los PR de tipo feat o fix necesitan una issue: añade al cuerpo del PR una " +
  'línea "Closes #N" (también valen Fixes #N y Resolves #N, con el número real de ' +
  "la issue, mayor que 0). Lo que va dentro de un comentario HTML no cuenta.";

/**
 * Evalúa título y cuerpo de un PR contra la política del repositorio.
 *
 * @param {{ title?: string | null, body?: string | null }} [pr]
 * @returns {{ ok: boolean, errors: string[], label: string | null }}
 *   `label` es la etiqueta `type:*` derivada del título, o `null` si el título
 *   no es válido. Se calcula aunque `ok` sea false por falta de issue.
 */
export function evaluatePr({ title, body } = {}) {
  if (typeof title !== "string" || title === "") {
    return { ok: false, errors: [MSG_TITLE_MISSING], label: null };
  }

  const match = TITLE_RE.exec(title);
  if (!match) {
    return { ok: false, errors: [MSG_TITLE_FORMAT], label: null };
  }

  // Caracteres, no unidades UTF-16: un emoji cuenta como uno.
  if (Array.from(title).length > TITLE_MAX_LENGTH) {
    return { ok: false, errors: [MSG_TITLE_LENGTH], label: null };
  }

  const type = match.groups.type;
  const label = match.groups.bang ? BREAKING_LABEL : LABELS[type];

  // Sin comentarios HTML: las instrucciones de la plantilla no cuentan como referencia.
  const visibleBody = stripHtmlComments(typeof body === "string" ? body : "");

  const errors = [];
  if (ISSUE_REQUIRED.has(type) && !CLOSING_RE.test(visibleBody)) {
    errors.push(MSG_ISSUE_REQUIRED);
  }

  return { ok: errors.length === 0, errors, label };
}

/**
 * Punto de entrada de la CLI. Devuelve el código de salida.
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
function main(env) {
  const { ok, errors, label } = evaluatePr({
    title: env.PR_TITLE,
    body: env.PR_BODY,
  });

  if (label && env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `label=${label}\n`);
  }

  if (ok) {
    console.log(`Política de PR: correcto (${label}).`);
    return 0;
  }

  // Los mensajes son texto estático: nunca se concatena aquí el título ni el
  // cuerpo (un salto de línea seguido de `::comando::` inyectaría comandos de
  // workflow en el log).
  for (const error of errors) {
    if (env.GITHUB_ACTIONS === "true") {
      console.log(`::error title=Política de PR::${error}`);
    } else {
      console.error(`Política de PR: ${error}`);
    }
  }
  return 1;
}

/**
 * ¿Se ha ejecutado este fichero directamente (`node pr-policy.mjs`)?
 * Importarlo nunca debe lanzar: con `node -` (stdin) argv[1] vale "-", y con
 * `-e` no existe; en ambos casos no es la CLI.
 */
function isMainModule() {
  try {
    return (
      realpathSync.native(process.argv[1]) ===
      realpathSync.native(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = main(process.env);
}
