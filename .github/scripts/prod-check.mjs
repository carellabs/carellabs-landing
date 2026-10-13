// Comprobación de producción de carellabs-landing (ESM, Node 24, sin dependencias).
//
// Hace sola lo que el paso 7 de .claude/skills/carellabs-github/references/github-setup.md
// pedía comprobar a mano: compara lo que sirve https://carellabs.com con el build local del
// mismo commit (dist/) y con los ficheros de public/. Lo lanza .github/workflows/prod-check.yml
// (a diario y tras cada push a main) y se puede ejecutar a mano: `npm run build` y
// `npm run check:prod`.
//
// Como módulo exporta funciones puras (con `fetch`, reloj y lectura de ficheros inyectables
// para poder testearlas). Como CLI imprime una línea por comprobación y sale con código 1 si
// alguna falla (2 si los argumentos o el build local no son válidos).
//
// Seguridad: lo que responde el servidor es dato NO fiable. Ninguna petición sigue
// redirecciones (no se llega a otro dominio aunque una respuesta lo pida), ningún valor
// remoto llega al log sin pasar por `safe()` y no se usan secretos.

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/**
 * Una comprobación hecha.
 * @typedef {{ name: string, ok: boolean, detail: string }} CheckResult
 */

/**
 * Una cabecera de `public/_headers`.
 * @typedef {{ name: string, value: string }} HeaderLine
 */

/**
 * Parsea `public/_headers`: una línea sin sangría es una ruta; las líneas con sangría son
 * `Nombre: valor` de esa ruta. Se ignoran los comentarios (`#`) y las líneas vacías.
 *
 * @param {string} text
 * @returns {Record<string, HeaderLine[]>} cabeceras por ruta, en el orden del fichero
 */
export function parseHeadersFile(text) {
  /** @type {Record<string, HeaderLine[]>} */
  const routes = {};
  let current = null;
  // (los «\r» de un fichero con finales CRLF los quitan los `trim()`)
  for (const raw of text.split("\n")) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    if (/^\S/.test(raw)) {
      current = raw.trim();
      routes[current] ??= [];
      continue;
    }
    const colon = raw.indexOf(":");
    if (current === null || colon === -1) continue;
    routes[current].push({ name: raw.slice(0, colon).trim(), value: raw.slice(colon + 1).trim() });
  }
  return routes;
}

/**
 * Fecha del campo `Expires` de un `security.txt` (RFC 9116), o `null` si falta o no es una fecha.
 *
 * @param {string} text
 * @returns {Date | null}
 */
export function parseExpires(text) {
  const match = /^Expires:[ \t]*(.+?)[ \t]*$/im.exec(text);
  if (!match) return null;
  const date = new Date(match[1]);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Longitud máxima de un valor remoto en una línea del log. */
const SAFE_MAX_LENGTH = 300;

/**
 * Hace seguro para el log un valor que viene de la red: sin saltos de línea ni caracteres de
 * control (con ellos, un servidor hostil fingiría otra línea o un comando de workflow `::...::`)
 * y recortado.
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function safe(value, max = SAFE_MAX_LENGTH) {
  const text = String(value).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, "?");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Tiempo máximo de cada petición, en milisegundos. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** Cómo se presenta la comprobación ante el servidor. */
export const USER_AGENT = "carellabs-prod-check/1.0 (+https://github.com/carellabs/carellabs-landing)";

/**
 * Respuesta de una petición, o el motivo por el que no la hubo.
 * @typedef {{ ok: true, url: string, status: number, headers: Headers, body: Buffer }
 *   | { ok: false, url: string, error: string }} Reply
 */

/** @param {unknown} error */
function describeError(error) {
  const base = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
  const code = cause && "code" in cause ? cause.code : cause?.message;
  return safe(code ? `${base} (${code})` : base);
}

/**
 * Pide una URL sin seguir redirecciones (una respuesta hostil no puede llevarnos a otro
 * dominio) y con un límite de tiempo. Nunca lanza: un fallo de red es una `Reply` con `ok: false`.
 *
 * @param {typeof fetch} fetchFn
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<Reply>}
 */
export async function request(fetchFn, url, timeoutMs = REQUEST_TIMEOUT_MS) {
  try {
    const res = await fetchFn(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": USER_AGENT },
    });
    return { ok: true, url, status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
  } catch (error) {
    return { ok: false, url, error: describeError(error) };
  }
}

/** @returns {CheckResult} */
const pass = (/** @type {string} */ name, detail = "") => ({ name, ok: true, detail });
/** @returns {CheckResult} */
const fail = (/** @type {string} */ name, /** @type {string} */ detail) => ({ name, ok: false, detail });

/** @param {Extract<Reply, { ok: false }>} reply */
const unreachable = (reply) => `sin respuesta de ${reply.url}: ${reply.error}`;

/**
 * Resuelve un `Location` (relativo o absoluto) contra la URL pedida; `null` si no es una URL.
 * @param {string} location
 * @param {string} base
 * @returns {string | null}
 */
function resolveLocation(location, base) {
  try {
    return new URL(location, base).href;
  } catch {
    return null;
  }
}

/**
 * @param {string} path
 * @param {Reply} reply
 * @param {number} want
 * @returns {CheckResult}
 */
function checkStatus(path, reply, want) {
  const name = `estado de ${path}`;
  if (!reply.ok) return fail(name, unreachable(reply));
  return reply.status === want
    ? pass(name, String(want))
    : fail(name, `responde ${reply.status}, se esperaba ${want}`);
}

/**
 * `/en` (sin barra final) debe redirigir con un 307 a `/en/`.
 * @param {Reply} reply
 * @param {string} origin
 * @returns {CheckResult}
 */
function checkRedirectToEnglish(reply, origin) {
  const name = "redirección de /en";
  if (!reply.ok) return fail(name, unreachable(reply));
  if (reply.status !== 307) return fail(name, `responde ${reply.status}, se esperaba 307 hacia /en/`);
  const location = reply.headers.get("location");
  if (location === null) return fail(name, "responde 307 sin cabecera Location, se esperaba /en/");
  return resolveLocation(location, reply.url) === new URL("/en/", origin).href
    ? pass(name, "307 hacia /en/")
    : fail(name, `redirige a «${safe(location)}», se esperaba /en/`);
}

/**
 * Qué cabeceras de las esperadas no llegan, o llegan con otro valor (el valor tiene que ser exacto).
 * Lo usan las comprobaciones y el modo espera.
 *
 * @param {{ get(name: string): string | null }} headers cabeceras de la respuesta
 * @param {HeaderLine[]} wanted las del bloque `/*` de `public/_headers`
 * @returns {string[]} un problema por cabecera, en el orden del fichero; vacío si todo llega
 */
export function headerProblems(headers, wanted) {
  const problems = [];
  for (const { name, value } of wanted) {
    const got = headers.get(name);
    if (got === null) problems.push(`falta ${name}`);
    else if (got !== value) problems.push(`${name} llega como «${safe(got)}» y debería ser «${safe(value)}»`);
  }
  return problems;
}

/**
 * Las cabeceras de `public/_headers` (bloque `/*`) tienen que llegar con su valor exacto.
 * @param {string} path
 * @param {Reply} reply
 * @param {HeaderLine[]} wanted
 * @returns {CheckResult}
 */
function checkHeaders(path, reply, wanted) {
  const name = `cabeceras de ${path}`;
  if (!reply.ok) return fail(name, unreachable(reply));
  const problems = headerProblems(reply.headers, wanted);
  return problems.length === 0
    ? pass(name, `${wanted.length} cabeceras con su valor exacto`)
    : fail(name, problems.join("; "));
}

/** Caché de los ficheros con hash de `/_astro/` (el bloque `/_astro/*` de `public/_headers`). */
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Un CSS de `/_astro/` enlazado en el HTML. Solo se toma la ruta: el dominio lo pone `site`. */
const CSS_LINK_RE = /\/_astro\/[A-Za-z0-9._-]+\.css/;

/**
 * Pide un CSS de `/_astro/` (el primero que enlaza el HTML de `/`) y comprueba su caché.
 * @param {Reply} home
 * @param {(path: string) => Promise<Reply>} get
 * @returns {Promise<CheckResult>}
 */
async function checkAssetCache(home, get) {
  if (!home.ok) return fail("caché de /_astro/*", `no se sabe qué CSS pedir: ${unreachable(home)}`);
  const path = CSS_LINK_RE.exec(home.body.toString("utf8"))?.[0];
  if (path === undefined) return fail("caché de /_astro/*", "el HTML de / no enlaza ningún CSS de /_astro/");
  const name = `caché de ${path}`;
  const reply = await get(path);
  if (!reply.ok) return fail(name, unreachable(reply));
  if (reply.status !== 200) return fail(name, `responde ${reply.status}, se esperaba 200`);
  const got = reply.headers.get("cache-control");
  return got === ASSET_CACHE_CONTROL
    ? pass(name, ASSET_CACHE_CONTROL)
    : fail(name, `Cache-Control llega como «${safe(got)}» y debería ser «${ASSET_CACHE_CONTROL}»`);
}

/**
 * Dónde empiezan a diferir dos contenidos, con un fragmento de cada uno (el servido va saneado).
 * @param {Buffer} served
 * @param {Buffer} built
 * @param {string} reference cómo se llama lo que se esperaba («el build», «public/robots.txt»…)
 * @returns {string}
 */
function describeDifference(served, built, reference) {
  let at = 0;
  const shortest = Math.min(served.length, built.length);
  while (at < shortest && served[at] === built[at]) at++;
  const around = (/** @type {Buffer} */ buffer) =>
    safe(buffer.subarray(Math.max(0, at - 20), at + 60).toString("utf8"));
  return (
    `sirve ${served.length} bytes y ${reference} tiene ${built.length}; difieren desde el byte ${at}: ` +
    `sirve «${around(served)}» y ${reference} «${around(built)}»`
  );
}

/**
 * El cuerpo servido tiene que ser idéntico, byte a byte, al esperado.
 * @param {string} name
 * @param {Reply} reply
 * @param {Buffer} built
 * @param {string} reference cómo se llama lo que se esperaba («el build», «public/robots.txt»…)
 * @param {string} hint qué suele significar la diferencia
 * @returns {CheckResult}
 */
function checkIdentical(name, reply, built, reference, hint) {
  if (!reply.ok) return fail(name, unreachable(reply));
  return reply.body.equals(built)
    ? pass(name, `${built.length} bytes`)
    : fail(name, `${describeDifference(reply.body, built, reference)}. ${hint}`);
}

const HINT_HTML = "Cloudflare inyecta o transforma algo, o el despliegue de este commit no ha llegado";
const HINT_ROBOTS = "Cloudflare reescribe el robots.txt (¿Bot Preference Sync encendido?) o el despliegue no ha llegado";
const HINT_SECURITY_TXT = "Cloudflare reescribe el fichero o el despliegue no ha llegado";

/**
 * El tipo de contenido (sin parámetros como `charset`) tiene que ser `text/plain`.
 * @param {string} name
 * @param {Reply} reply
 * @returns {CheckResult}
 */
function checkPlainText(name, reply) {
  if (!reply.ok) return fail(name, unreachable(reply));
  const header = reply.headers.get("content-type");
  const type = header?.split(";")[0].trim().toLowerCase();
  return type === "text/plain"
    ? pass(name, "text/plain")
    : fail(name, `Content-Type llega como «${safe(header)}» y debería ser text/plain`);
}

/** Días de margen mínimos antes de que caduque `security.txt`. */
export const EXPIRY_MARGIN_DAYS = 60;

const DAY_MS = 86_400_000;

const HOW_TO_RENEW =
  "Renuévalo: cambia Expires en public/.well-known/security.txt (como máximo, un año vista; RFC 9116) y despliega";

/**
 * `security.txt` debe caducar dentro de más de `EXPIRY_MARGIN_DAYS` días.
 * @param {Reply} reply
 * @param {number} nowMs
 * @returns {CheckResult}
 */
function checkSecurityTxtExpiry(reply, nowMs) {
  const name = `security.txt caduca en más de ${EXPIRY_MARGIN_DAYS} días`;
  if (!reply.ok) return fail(name, unreachable(reply));
  const expires = parseExpires(reply.body.toString("utf8"));
  if (expires === null) return fail(name, "no tiene un campo Expires con una fecha válida (la RFC 9116 lo exige)");
  const days = (expires.getTime() - nowMs) / DAY_MS;
  const date = expires.toISOString().slice(0, 10);
  if (days <= 0) return fail(name, `ha caducado el ${date}. ${HOW_TO_RENEW}`);
  if (days <= EXPIRY_MARGIN_DAYS) {
    return fail(name, `caduca el ${date} (quedan ${Math.floor(days)} días). ${HOW_TO_RENEW}`);
  }
  return pass(name, `caduca el ${date} (quedan ${Math.floor(days)} días)`);
}

/** Ruta y consulta con las que se pide `www`: se comprueba que la redirección las conserva. */
const WWW_PROBE = "/en/?x=1";

/**
 * `www.<dominio>` debe redirigir con un 301 al dominio raíz, conservando ruta y consulta.
 * @param {Reply} reply
 * @param {string} origin
 * @returns {CheckResult}
 */
function checkWwwRedirect(reply, origin) {
  const name = "www redirige al dominio raíz";
  if (!reply.ok) return fail(name, unreachable(reply));
  const want = new URL(WWW_PROBE, origin).href;
  if (reply.status !== 301) return fail(name, `responde ${reply.status}, se esperaba 301 hacia ${want}`);
  const location = reply.headers.get("location");
  if (location === null) return fail(name, `responde 301 sin cabecera Location, se esperaba ${want}`);
  return resolveLocation(location, reply.url) === want
    ? pass(name, `301 hacia ${want}`)
    : fail(name, `redirige a «${safe(location)}», se esperaba ${want}`);
}

/**
 * Lo que dicen el build local y `public/`, contra lo que se compara producción.
 * @typedef {object} Expected
 * @property {HeaderLine[]} headers cabeceras del bloque `/*` de `public/_headers`
 * @property {Record<string, Buffer>} html HTML del build por ruta (`/`, `/en/`, `/no-existe`)
 * @property {Buffer} robots `public/robots.txt`
 * @property {Buffer} securityTxt `public/.well-known/security.txt`
 */

/**
 * El contenido que cambia con cada despliegue y se compara byte a byte con el build o con
 * `public/`. Lo usan a la vez las comprobaciones y el modo espera (`--wait`), para que esperen
 * exactamente a lo que después comparan.
 * @type {{ path: string, name: string, status: number, reference: string, hint: string,
 *   built: (expected: Expected) => Buffer }[]}
 */
const CONTENT = [
  { path: "/", name: "HTML de / idéntico al build", status: 200, reference: "el build", hint: HINT_HTML, built: (e) => e.html["/"] },
  { path: "/en/", name: "HTML de /en/ idéntico al build", status: 200, reference: "el build", hint: HINT_HTML, built: (e) => e.html["/en/"] },
  { path: "/no-existe", name: "HTML de /no-existe idéntico al build", status: 404, reference: "el build", hint: HINT_HTML, built: (e) => e.html["/no-existe"] },
  { path: "/robots.txt", name: "robots.txt idéntico al de public/", status: 200, reference: "public/robots.txt", hint: HINT_ROBOTS, built: (e) => e.robots },
  {
    path: "/.well-known/security.txt",
    name: "security.txt idéntico al de public/.well-known/",
    status: 200,
    reference: "public/.well-known/security.txt",
    hint: HINT_SECURITY_TXT,
    built: (e) => e.securityTxt,
  },
];

/**
 * Pide las páginas de `site` y las compara con lo esperado. Una línea por comprobación.
 *
 * @param {object} options
 * @param {string} options.site origen de producción, p. ej. `https://carellabs.com`
 * @param {typeof fetch} [options.fetch]
 * @param {Expected} options.expected
 * @param {() => number} [options.now] reloj en milisegundos (para la caducidad)
 * @param {number} [options.timeoutMs]
 * @returns {Promise<CheckResult[]>}
 */
export async function runChecks({ site, fetch: fetchFn = globalThis.fetch, expected, now = Date.now, timeoutMs }) {
  const origin = new URL(site).origin;
  const get = (/** @type {string} */ path) => request(fetchFn, new URL(path, origin).href, timeoutMs);

  const wwwUrl = new URL(WWW_PROBE, origin);
  wwwUrl.hostname = `www.${wwwUrl.hostname}`;

  const [englishNoSlash, www, ...contentReplies] = await Promise.all([
    get("/en"),
    request(fetchFn, wwwUrl.href, timeoutMs),
    ...CONTENT.map((item) => get(item.path)),
  ]);
  /** @type {Record<string, Reply>} */
  const served = Object.fromEntries(CONTENT.map((item, i) => [item.path, contentReplies[i]]));
  const home = served["/"];
  const english = served["/en/"];
  const notFound = served["/no-existe"];
  const securityTxt = served["/.well-known/security.txt"];

  return [
    checkStatus("/", home, 200),
    checkStatus("/en/", english, 200),
    checkStatus("/no-existe", notFound, 404),
    checkRedirectToEnglish(englishNoSlash, origin),
    checkHeaders("/", home, expected.headers),
    checkHeaders("/en/", english, expected.headers),
    checkHeaders("/no-existe", notFound, expected.headers),
    await checkAssetCache(home, get),
    ...CONTENT.map((item) =>
      checkIdentical(item.name, served[item.path], item.built(expected), item.reference, item.hint),
    ),
    checkPlainText("security.txt como text/plain", securityTxt),
    checkSecurityTxtExpiry(securityTxt, now()),
    checkWwwRedirect(www, origin),
  ];
}

/** Cada cuánto se repite la comparación en el modo espera, en milisegundos. */
export const WAIT_INTERVAL_MS = 20_000;

/** @param {number} ms */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Por qué una respuesta todavía no es la del despliegue esperado, o `null` si ya lo es.
 * @param {Reply} reply
 * @param {(typeof CONTENT)[number]} item
 * @param {Expected} expected
 * @returns {string | null}
 */
function whyNotDeployed(reply, item, expected) {
  if (!reply.ok) return unreachable(reply);
  if (reply.status !== item.status) return `responde ${reply.status}, se esperaba ${item.status}`;
  const built = item.built(expected);
  return reply.body.equals(built) ? null : describeDifference(reply.body, built, item.reference);
}

/**
 * Modo espera (`--wait`): tras un push a `main`, Cloudflare tarda un rato en publicar. Compara todo
 * el contenido que cambia con un despliegue (el HTML de `/`, `/en/` y la 404, `robots.txt` y
 * `security.txt`) y las cabeceras de `/` (las del bloque `/*` de `public/_headers`) con el build y
 * `public/`, y repite cada `intervalMs` hasta que TODO coincida o se agote `waitSeconds`; si se agota,
 * dice qué sigue sin coincidir. Las cabeceras cuentan porque un push que solo cambia `_headers` no
 * cambia ningún contenido.
 *
 * @param {object} options
 * @param {string} options.site
 * @param {typeof fetch} [options.fetch]
 * @param {Expected} options.expected
 * @param {number} options.waitSeconds
 * @param {number} [options.intervalMs]
 * @param {() => number} [options.now] reloj en milisegundos
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<CheckResult>}
 */
export async function waitForDeploy({
  site,
  fetch: fetchFn = globalThis.fetch,
  expected,
  waitSeconds,
  intervalMs = WAIT_INTERVAL_MS,
  now = Date.now,
  sleep = defaultSleep,
  timeoutMs,
}) {
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
    throw new RangeError(`waitSeconds debe ser un número finito y no negativo, no ${waitSeconds}`);
  }
  const name = "despliegue en producción";
  const origin = new URL(site).origin;
  const start = now();
  const deadline = start + waitSeconds * 1000;

  for (;;) {
    const replies = await Promise.all(
      CONTENT.map((item) => request(fetchFn, new URL(item.path, origin).href, timeoutMs)),
    );
    const pending = CONTENT.flatMap((item, i) => {
      const reason = whyNotDeployed(replies[i], item, expected);
      return reason === null ? [] : [`${item.path} (${reason})`];
    });
    // (si / no responde, ya consta arriba como «sin respuesta»)
    const home = replies[CONTENT.findIndex((item) => item.path === "/")];
    if (home.ok) {
      const problems = headerProblems(home.headers, expected.headers);
      if (problems.length > 0) pending.push(`cabeceras de / (${problems.join("; ")})`);
    }
    if (pending.length === 0) {
      return pass(name, `todo lo servido ya es el del build y el de public/ (tras ${Math.round((now() - start) / 1000)} s)`);
    }
    if (now() + intervalMs > deadline) {
      return fail(
        name,
        `el despliegue no ha llegado en ${waitSeconds} s: siguen sin coincidir con el build o con public/: ` +
          `${pending.join("; ")}. ` +
          "Mira el historial de builds de Workers Builds en el panel de Cloudflare (Deployments > View build history).",
      );
    }
    await sleep(intervalMs);
  }
}

/** Un problema de uso (argumentos) o de entorno (falta el build): se sale con código 2, no con 1. */
export class CheckSetupError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "CheckSetupError";
  }
}

/**
 * Lee lo que producción debe servir: `public/` y el build de `dist/`.
 *
 * @param {object} options
 * @param {string} options.publicDir
 * @param {string} options.distDir
 * @param {(path: string) => Buffer | string} [options.readFile]
 * @returns {Expected}
 * @throws {CheckSetupError} si falta un fichero (sin build, p. ej.) o `_headers` no trae el bloque `/*`
 */
export function loadExpected({ publicDir, distDir, readFile = readFileSync }) {
  const read = (/** @type {string} */ path) => {
    try {
      return Buffer.from(readFile(path));
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : "error";
      throw new CheckSetupError(`No se puede leer ${path} (${code}). ¿Has ejecutado \`npm run build\`?`);
    }
  };

  const headers = parseHeadersFile(read(join(publicDir, "_headers")).toString("utf8"))["/*"];
  if (headers === undefined || headers.length === 0) {
    throw new CheckSetupError("public/_headers no tiene un bloque /* con cabeceras: no habría nada que comprobar.");
  }

  return {
    headers,
    html: {
      "/": read(join(distDir, "index.html")),
      "/en/": read(join(distDir, "en", "index.html")),
      "/no-existe": read(join(distDir, "404.html")),
    },
    robots: read(join(publicDir, "robots.txt")),
    securityTxt: read(join(publicDir, ".well-known", "security.txt")),
  };
}

/** Producción, salvo que `--site` diga otra cosa. */
export const DEFAULT_SITE = "https://carellabs.com";

const USAGE = `Uso: node .github/scripts/prod-check.mjs [--site <url>] [--dist <carpeta>] [--wait <segundos>]

Compara lo que sirve producción con el build local (dist/) y con public/. Ejecuta antes \`npm run build\`.

  --site <url>        origen que se comprueba (por defecto ${DEFAULT_SITE}). Pensado para el dominio de
                      producción: también pide https://www.<dominio>/.
  --dist <carpeta>    build con el que se compara (por defecto, dist/ del repositorio).
  --wait <segundos>   tras un push a main: espera, como máximo ese tiempo, a que todo lo servido (HTML de /,
                      /en/ y la 404, robots.txt, security.txt y las cabeceras de /) sea el del build y el de public/.
  -h, --help          muestra esta ayuda.

Código de salida: 0 todo correcto; 1 alguna comprobación falla; 2 argumentos o build local no válidos.`;

/**
 * Opciones de la línea de órdenes.
 * @typedef {object} CliOptions
 * @property {boolean} help
 * @property {string} site origen (esquema, host y puerto) de producción
 * @property {string | undefined} dist carpeta del build, tal como se escribió
 * @property {number | undefined} wait segundos de espera, si se pidió
 */

/**
 * @param {string[]} argv argumentos sin `node` ni el script
 * @returns {CliOptions}
 * @throws {CheckSetupError} si algo no es válido
 */
export function parseCliArgs(argv) {
  /** @type {Record<string, string | boolean | undefined>} */
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        site: { type: "string" },
        dist: { type: "string" },
        wait: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new CheckSetupError(`Argumento no válido: ${error instanceof Error ? error.message : error}`);
  }

  const site = String(values.site ?? DEFAULT_SITE);
  let origin;
  try {
    const url = new URL(site);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError("esquema no admitido");
    origin = url.origin;
  } catch {
    throw new CheckSetupError(`--site debe ser una URL http(s), no «${safe(site)}».`);
  }

  let wait;
  if (values.wait !== undefined) {
    if (!/^\d+$/.test(String(values.wait))) {
      throw new CheckSetupError(`--wait debe ser un número entero de segundos (0 o más), no «${safe(values.wait)}».`);
    }
    wait = Number(values.wait);
  }

  return {
    help: values.help === true,
    site: origin,
    dist: values.dist === undefined ? undefined : String(values.dist),
    wait,
  };
}

/**
 * Una línea de salida: `OK     nombre (detalle)` o `FALLO  nombre: motivo`.
 * @param {CheckResult} result
 * @returns {string}
 */
export function formatResult({ name, ok, detail }) {
  if (ok) return `OK     ${name}${detail ? ` (${detail})` : ""}`;
  return `FALLO  ${name}: ${detail}`;
}

/** @param {CheckResult[]} results */
function summarize(results) {
  const failed = results.filter((result) => !result.ok).length;
  return failed === 0
    ? `Producción: ${results.length} comprobaciones, todas correctas.`
    : `Producción: ${failed} de ${results.length} comprobaciones con fallo.`;
}

/** Raíz del repositorio (este fichero está en `.github/scripts/`). */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Punto de entrada de la CLI. Devuelve el código de salida: 0 todo correcto, 1 alguna
 * comprobación falla, 2 argumentos o build local no válidos.
 *
 * @param {string[]} argv argumentos sin `node` ni el script
 * @param {object} [deps] lo que los tests sustituyen
 * @param {typeof fetch} [deps.fetch]
 * @param {(path: string) => Buffer | string} [deps.readFile]
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {(line: string) => void} [deps.log]
 * @param {(line: string) => void} [deps.error]
 * @param {string} [deps.root] raíz del repositorio
 * @param {string} [deps.cwd] directorio desde el que se resuelve `--dist`
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const {
    fetch: fetchFn = globalThis.fetch,
    readFile = readFileSync,
    now = Date.now,
    sleep = defaultSleep,
    log = console.log,
    error = console.error,
    root = ROOT,
    cwd = process.cwd(),
  } = deps;

  /** @type {CliOptions | undefined} */
  let options;
  /** @type {Expected} */
  let expected;
  let distDir = join(root, "dist");
  try {
    options = parseCliArgs(argv);
    if (options.help) {
      log(USAGE);
      return 0;
    }
    if (options.dist !== undefined) distDir = resolve(cwd, options.dist);
    expected = loadExpected({ publicDir: join(root, "public"), distDir, readFile });
  } catch (cause) {
    if (!(cause instanceof CheckSetupError)) throw cause;
    error(`Error: ${cause.message}`);
    if (options === undefined) error(USAGE);
    return 2;
  }

  log(`Comprobando ${options.site} contra ${distDir} y public/`);
  /** @type {CheckResult[]} */
  const results = [];

  if (options.wait !== undefined) {
    const waited = await waitForDeploy({
      site: options.site,
      fetch: fetchFn,
      expected,
      waitSeconds: options.wait,
      now,
      sleep,
    });
    results.push(waited);
    log(formatResult(waited));
    if (!waited.ok) {
      log("Se omiten las demás comprobaciones: comparan con un despliegue que no ha llegado.");
      log(summarize(results));
      return 1;
    }
  }

  for (const result of await runChecks({ site: options.site, fetch: fetchFn, expected, now })) {
    results.push(result);
    log(formatResult(result));
  }
  log(summarize(results));
  return results.every((result) => result.ok) ? 0 : 1;
}

/**
 * ¿Se ha ejecutado este fichero directamente (`node prod-check.mjs`)? Importarlo nunca debe
 * lanzar: con `node -` (stdin) argv[1] vale "-", y con `-e` no existe; en ambos casos no es la CLI.
 */
function isMainModule() {
  try {
    return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await main(process.argv.slice(2));
}
