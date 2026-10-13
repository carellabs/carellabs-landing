// Tests de prod-check.mjs (la comprobación de producción). Sin red ni navegador: se inyecta
// un `fetch` falso que devuelve la respuesta correcta (la comprobación pasa) o una incorrecta
// (falla, con su mensaje), y un reloj falso para el modo espera y para la caducidad.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Import de espacio de nombres: si falta una exportación falla solo su test, no todo el fichero.
import * as prod from "./prod-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// ---------------------------------------------------------------------------------------------
// Un «mundo» de prueba: lo que el build y public/ dicen que hay (EXPECTED) y las respuestas
// correctas de producción (goodTable). Cada test estropea una sola cosa.
// ---------------------------------------------------------------------------------------------

const SITE = "https://carellabs.com";
const enc = (text) => Buffer.from(text, "utf8");

const HEADERS_FILE = [
  "/*",
  "  X-Content-Type-Options: nosniff",
  "  X-Frame-Options: DENY",
  "  Content-Security-Policy: default-src 'none'; style-src 'self'",
  "",
  "/_astro/*",
  "  Cache-Control: public, max-age=31536000, immutable",
  "",
].join("\n");
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'self'",
};

const HOME = '<html><head><link rel="stylesheet" href="/_astro/index.AbC123.css"></head><body>es</body></html>';
const EN = "<html><body>en</body></html>";
const NOT_FOUND = "<html><body>404</body></html>";
const ROBOTS = "User-agent: *\nAllow: /\n";
const SECURITY_TXT = "Contact: mailto:security@example.test\nExpires: 2027-09-30T00:00:00.000Z\n";

/** «Ahora» de los tests: faltan 352 días para el Expires de SECURITY_TXT. */
const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const DAY = 86_400_000;

/** Lo que dicen el build local y public/ (lo que `loadExpected` lee del disco). */
const EXPECTED = {
  headers: prod.parseHeadersFile(HEADERS_FILE)["/*"],
  html: { "/": enc(HOME), "/en/": enc(EN), "/no-existe": enc(NOT_FOUND) },
  robots: enc(ROBOTS),
  securityTxt: enc(SECURITY_TXT),
};

/** Respuestas correctas de producción, por URL completa. */
function goodTable() {
  // (un objeto de cabeceras por página: cada test estropea una sin tocar las demás)
  const html = () => ({ "content-type": "text/html", ...SECURITY_HEADERS });
  return {
    "https://carellabs.com/": { status: 200, headers: html(), body: HOME },
    "https://carellabs.com/en/": { status: 200, headers: html(), body: EN },
    "https://carellabs.com/no-existe": { status: 404, headers: html(), body: NOT_FOUND },
    "https://carellabs.com/en": { status: 307, headers: { location: "/en/", ...SECURITY_HEADERS } },
    "https://carellabs.com/_astro/index.AbC123.css": {
      status: 200,
      headers: { "content-type": "text/css", "cache-control": "public, max-age=31536000, immutable" },
      body: "body{}",
    },
    "https://carellabs.com/robots.txt": { status: 200, headers: { "content-type": "text/plain" }, body: ROBOTS },
    "https://carellabs.com/.well-known/security.txt": {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: SECURITY_TXT,
    },
    "https://www.carellabs.com/en/?x=1": { status: 301, headers: { location: "https://carellabs.com/en/?x=1" } },
  };
}

/**
 * Un `fetch` falso. Una URL sin entrada en la tabla falla como una red caída; una entrada que
 * es un Error se lanza. Para las peticiones con consulta única (modo espera) vale la entrada
 * de la misma URL sin consulta. Guarda las peticiones en `.calls`.
 */
function fakeFetch(table) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const entry = table[String(url)] ?? table[String(url).split("?")[0]];
    if (entry === undefined) throw new TypeError("fetch failed");
    if (entry instanceof Error) throw entry;
    // (un cuerpo de texto haría que Response añadiera su propio Content-Type: se pasa como bytes)
    const body = typeof entry.body === "string" ? Buffer.from(entry.body) : (entry.body ?? null);
    return new Response(body, { status: entry.status ?? 200, headers: entry.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
}

/** Un reloj falso: `sleep` no espera, solo adelanta la hora y apunta cuánto se pidió. */
function relojFalso(inicio = 1_000_000) {
  let t = inicio;
  const sleeps = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

/** Un `fetch` de un servidor que no contesta: solo termina cuando se aborta la señal que recibe. */
const fetchMudo = (url, init) =>
  new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));

const run = (table, extra = {}) =>
  prod.runChecks({ site: SITE, fetch: fakeFetch(table), expected: EXPECTED, now: () => NOW, ...extra });

/** El resultado cuyo nombre casa con `re` (y falla el test si no hay exactamente uno). */
function find(results, re) {
  const found = results.filter((r) => re.test(r.name));
  assert.equal(found.length, 1, `${found.length} resultados para ${re}: ${results.map((r) => r.name).join(" | ")}`);
  return found[0];
}

describe("parseHeadersFile", () => {
  test("agrupa las cabeceras por ruta: línea sin sangría = ruta, con sangría = «Nombre: valor»", () => {
    const parsed = prod.parseHeadersFile(
      "/*\n  X-A: uno\n  X-B: dos: con dos puntos\n\n/_astro/*\n  Cache-Control: public, max-age=1\n",
    );
    assert.deepEqual(parsed, {
      "/*": [
        { name: "X-A", value: "uno" },
        { name: "X-B", value: "dos: con dos puntos" },
      ],
      "/_astro/*": [{ name: "Cache-Control", value: "public, max-age=1" }],
    });
  });

  test("ignora comentarios y líneas vacías, y admite finales de línea CRLF", () => {
    const parsed = prod.parseHeadersFile("# comentario\r\n/*\r\n  # otro\r\n  X-A: uno\r\n\r\n");
    assert.deepEqual(parsed, { "/*": [{ name: "X-A", value: "uno" }] });
  });

  test("una ruta que aparece dos veces acumula sus cabeceras", () => {
    const parsed = prod.parseHeadersFile("/*\n  X-A: uno\n\n/otra\n  X-C: tres\n\n/*\n  X-B: dos\n");
    assert.deepEqual(parsed["/*"], [
      { name: "X-A", value: "uno" },
      { name: "X-B", value: "dos" },
    ]);
    assert.deepEqual(parsed["/otra"], [{ name: "X-C", value: "tres" }]);
  });

  test("ignora una cabecera con sangría antes de cualquier ruta y una línea con sangría sin «:»", () => {
    const parsed = prod.parseHeadersFile("  X-Huerfana: uno\n/*\n  texto sin dos puntos\n  X-A: uno\n");
    assert.deepEqual(parsed, { "/*": [{ name: "X-A", value: "uno" }] });
  });

  test("lee el public/_headers real: el bloque /* trae las seis cabeceras de seguridad, con la CSP entera", () => {
    const bloque = prod.parseHeadersFile(read("public/_headers"))["/*"];
    assert.ok(bloque, "public/_headers no tiene el bloque /*");
    const nombres = bloque.map((h) => h.name.toLowerCase());
    for (const esperado of [
      "x-content-type-options",
      "x-frame-options",
      "referrer-policy",
      "permissions-policy",
      "strict-transport-security",
      "content-security-policy",
    ]) {
      assert.ok(nombres.includes(esperado), `falta ${esperado}`);
    }
    const csp = bloque.find((h) => h.name.toLowerCase() === "content-security-policy").value;
    assert.match(csp, /^default-src 'none'; .*frame-ancestors 'none'$/);
  });
});

describe("parseExpires", () => {
  test("devuelve la fecha del campo Expires", () => {
    const fecha = prod.parseExpires("Contact: mailto:a@b.c\nExpires: 2027-09-30T00:00:00.000Z\nCanonical: x\n");
    assert.equal(fecha?.toISOString(), "2027-09-30T00:00:00.000Z");
  });

  test("el nombre del campo no distingue mayúsculas y admite CRLF", () => {
    const fecha = prod.parseExpires("Contact: x\r\nexpires: 2027-09-30T00:00:00.000Z\r\nCanonical: y\r\n");
    assert.equal(fecha?.toISOString(), "2027-09-30T00:00:00.000Z");
  });

  test("devuelve null si no hay Expires o si no es una fecha", () => {
    assert.equal(prod.parseExpires("Contact: mailto:a@b.c\n"), null);
    assert.equal(prod.parseExpires("Expires: mañana\n"), null);
  });
});

describe("safe: lo que llega de la red no puede falsear el log del workflow", () => {
  test("sustituye saltos de línea y caracteres de control", () => {
    const sucio = "a\n::error::pwn\r\u0000\u001b[31m" + String.fromCharCode(0x2028, 0x2029);
    const limpio = prod.safe(sucio);
    assert.doesNotMatch(limpio, /[\p{Cc}\p{Zl}\p{Zp}]/u);
    assert.match(limpio, /^a\?::error::pwn/);
  });

  test("recorta lo muy largo y deja intacto lo corto", () => {
    assert.equal(prod.safe("normal"), "normal");
    const largo = prod.safe("x".repeat(1000));
    assert.ok(largo.length < 400, `${largo.length} caracteres`);
    assert.ok(largo.endsWith("…"));
  });

  test("el límite por defecto son 300 caracteres: 300 pasan enteros, 301 se recortan", () => {
    assert.equal(prod.safe("y".repeat(300)), "y".repeat(300));
    assert.equal(prod.safe("y".repeat(301)), `${"y".repeat(300)}…`);
    assert.equal(prod.safe("abcdef", 3), "abc…");
  });

  test("admite valores que no son texto", () => {
    assert.equal(prod.safe(null), "null");
    assert.equal(prod.safe(42), "42");
  });
});

describe("runChecks: estados y redirección", () => {
  test("pasan con 200 en /, 200 en /en/, 404 en /no-existe y 307 de /en a /en/", async () => {
    const results = await run(goodTable());
    for (const re of [/^estado de \/$/, /^estado de \/en\/$/, /^estado de \/no-existe$/, /^redirección de \/en$/]) {
      const r = find(results, re);
      assert.equal(r.ok, true, `${r.name}: ${r.detail}`);
    }
  });

  test("fallan con su motivo cuando el estado no es el esperado", async () => {
    const table = goodTable();
    table["https://carellabs.com/"].status = 503;
    table["https://carellabs.com/en/"].status = 404;
    table["https://carellabs.com/no-existe"].status = 200;
    const results = await run(table);

    const home = find(results, /^estado de \/$/);
    assert.equal(home.ok, false);
    assert.match(home.detail, /503/);
    assert.match(home.detail, /200/);
    assert.equal(find(results, /^estado de \/en\/$/).ok, false);
    const notFound = find(results, /^estado de \/no-existe$/);
    assert.equal(notFound.ok, false);
    assert.match(notFound.detail, /404/);
  });

  test("/en acepta el Location relativo y el absoluto, y falla si no es un 307 hacia /en/", async () => {
    const absoluto = goodTable();
    absoluto["https://carellabs.com/en"].headers.location = "https://carellabs.com/en/";
    assert.equal(find(await run(absoluto), /^redirección de \/en$/).ok, true);

    const sinRedireccion = goodTable();
    sinRedireccion["https://carellabs.com/en"] = { status: 200, body: "x" };
    const a = find(await run(sinRedireccion), /^redirección de \/en$/);
    assert.equal(a.ok, false);
    assert.match(a.detail, /200/);
    assert.match(a.detail, /307/);

    const permanente = goodTable();
    permanente["https://carellabs.com/en"].status = 301;
    assert.equal(find(await run(permanente), /^redirección de \/en$/).ok, false);

    const otroDestino = goodTable();
    otroDestino["https://carellabs.com/en"].headers.location = "/otra/";
    const b = find(await run(otroDestino), /^redirección de \/en$/);
    assert.equal(b.ok, false);
    assert.match(b.detail, /\/otra\//);

    // Un Location que no es una URL no rompe la comprobación: es un fallo más.
    const invalida = goodTable();
    invalida["https://carellabs.com/en"].headers.location = "http://[";
    const d = find(await run(invalida), /^redirección de \/en$/);
    assert.equal(d.ok, false);
    assert.match(d.detail, /«http:\/\/\[»/);

    const sinLocation = goodTable();
    delete sinLocation["https://carellabs.com/en"].headers.location;
    const c = find(await run(sinLocation), /^redirección de \/en$/);
    assert.equal(c.ok, false);
    assert.match(c.detail, /sin cabecera Location/);
  });

  test("una URL que no responde falla con «sin respuesta» y no impide las demás comprobaciones", async () => {
    const table = goodTable();
    table["https://carellabs.com/en/"] = new TypeError("fetch failed");
    const results = await run(table);
    const caida = find(results, /^estado de \/en\/$/);
    assert.equal(caida.ok, false);
    assert.match(caida.detail, /sin respuesta/);
    assert.equal(find(results, /^estado de \/$/).ok, true);
  });

  test("el motivo de un fallo de red incluye el código de la causa y llega saneado", async () => {
    const causa = Object.assign(new Error("getaddrinfo ENOTFOUND carellabs.com"), { code: "ENOTFOUND" });
    const table = goodTable();
    table["https://carellabs.com/en/"] = new TypeError("fetch failed", { cause: causa });
    table["https://carellabs.com/"] = new TypeError("roto\n::error::falso");
    const results = await run(table);

    const conCausa = find(results, /^estado de \/en\/$/);
    assert.ok(conCausa.detail.endsWith("fetch failed (ENOTFOUND)"), conCausa.detail);

    const conSalto = find(results, /^estado de \/$/);
    assert.doesNotMatch(conSalto.detail, /[\p{Cc}]/u);
    assert.ok(conSalto.detail.endsWith("roto?::error::falso"), conSalto.detail);

    // Una causa sin código aporta su mensaje.
    const sinCodigo = goodTable();
    sinCodigo["https://carellabs.com/no-existe"] = new TypeError("fetch failed", { cause: new Error("socket hang up") });
    assert.ok(find(await run(sinCodigo), /^estado de \/no-existe$/).detail.endsWith("fetch failed (socket hang up)"));
  });

  test("ninguna petición sigue redirecciones: una redirección a otro dominio no genera tráfico hacia allí", async () => {
    const table = goodTable();
    table["https://carellabs.com/"] = { status: 302, headers: { location: "https://evil.example/" } };
    const fetchFalso = fakeFetch(table);
    const results = await prod.runChecks({ site: SITE, fetch: fetchFalso, expected: EXPECTED, now: () => NOW });

    // Control positivo: sí hubo peticiones, y la redirección se vio como un fallo.
    assert.ok(fetchFalso.calls.length >= 4, `${fetchFalso.calls.length} peticiones`);
    assert.equal(find(results, /^estado de \/$/).ok, false);
    for (const { url, init } of fetchFalso.calls) {
      assert.equal(init.redirect, "manual", `${url} sigue redirecciones`);
      assert.ok(["carellabs.com", "www.carellabs.com"].includes(new URL(url).hostname), `petición a ${url}`);
    }
  });

  test("un servidor que no contesta no cuelga la comprobación: cada petición se corta en su límite y todo falla", async () => {
    const inicio = Date.now();
    const results = await prod.runChecks({ site: SITE, fetch: fetchMudo, expected: EXPECTED, now: () => NOW, timeoutMs: 40 });
    assert.ok(Date.now() - inicio < 5000, `tardó ${Date.now() - inicio} ms`);
    assert.equal(results.length, 16);
    const bien = results.filter((r) => r.ok || !/sin respuesta/.test(r.detail));
    assert.deepEqual(bien, [], "todas las comprobaciones deben fallar con «sin respuesta»");
  });

  test("cada petición lleva un límite de tiempo y se identifica", async () => {
    const fetchFalso = fakeFetch(goodTable());
    await prod.runChecks({ site: SITE, fetch: fetchFalso, expected: EXPECTED, now: () => NOW });
    assert.ok(fetchFalso.calls.length > 0);
    for (const { url, init } of fetchFalso.calls) {
      assert.ok(init.signal instanceof AbortSignal, `${url} sin límite de tiempo`);
      assert.match(init.headers["user-agent"], /^carellabs-prod-check\//, url);
    }
  });
});

describe("runChecks: cabeceras de _headers y caché de /_astro", () => {
  const paginas = ["/", "/en/", "/no-existe"];
  const url = (ruta) => `https://carellabs.com${ruta}`;

  test("pasan cuando las tres páginas (también la 404) traen las cabeceras del bloque /* con su valor exacto", async () => {
    const results = await run(goodTable());
    for (const ruta of paginas) {
      const r = find(results, { test: (nombre) => nombre === `cabeceras de ${ruta}` });
      assert.equal(r.ok, true, `${r.name}: ${r.detail}`);
    }
  });

  test("falla, nombrándola, la página a la que le falta una cabecera (y solo esa)", async () => {
    const table = goodTable();
    delete table[url("/no-existe")].headers["x-frame-options"];
    const results = await run(table);
    const rota = find(results, /^cabeceras de \/no-existe$/);
    assert.equal(rota.ok, false);
    assert.match(rota.detail, /falta X-Frame-Options/);
    assert.equal(find(results, /^cabeceras de \/$/).ok, true);
    assert.equal(find(results, /^cabeceras de \/en\/$/).ok, true);
  });

  test("falla si el valor no es exactamente el del fichero, y muestra los dos", async () => {
    const table = goodTable();
    table[url("/en/")].headers["content-security-policy"] = "default-src 'none'";
    const r = find(await run(table), /^cabeceras de \/en\/$/);
    assert.equal(r.ok, false);
    assert.match(r.detail, /content-security-policy/i);
    assert.match(r.detail, /«default-src 'none'»/);
    assert.match(r.detail, /«default-src 'none'; style-src 'self'»/);

    // Ni siquiera una diferencia de mayúsculas en el valor pasa.
    const mayusculas = goodTable();
    mayusculas[url("/")].headers["x-frame-options"] = "deny";
    assert.equal(find(await run(mayusculas), /^cabeceras de \/$/).ok, false);
  });

  test("lista todos los problemas de la página, no solo el primero", async () => {
    const table = goodTable();
    delete table[url("/")].headers["x-frame-options"];
    table[url("/")].headers["x-content-type-options"] = "otra cosa";
    const r = find(await run(table), /^cabeceras de \/$/);
    assert.match(r.detail, /falta X-Frame-Options/);
    assert.match(r.detail, /X-Content-Type-Options/);
  });

  test("lo que llega de la red se sanea antes de entrar en el mensaje", async () => {
    const table = goodTable();
    // Un valor remoto larguísimo no desborda el mensaje.
    table[url("/")].headers["x-frame-options"] = "SAMEORIGIN" + "x".repeat(2000);
    const r = find(await run(table), /^cabeceras de \/$/);
    assert.equal(r.ok, false);
    assert.ok(r.detail.length < 1200, `${r.detail.length} caracteres`);
  });

  test("caché: el CSS que enlaza el HTML de / llega con Cache-Control public, max-age=31536000, immutable", async () => {
    const r = find(await run(goodTable()), /^caché de \/_astro\//);
    assert.equal(r.ok, true, r.detail);
    assert.match(r.name, /index\.AbC123\.css/);
  });

  test("caché: falla si el Cache-Control es otro, falta, o el CSS no responde 200", async () => {
    const css = url("/_astro/index.AbC123.css");

    const otro = goodTable();
    otro[css].headers["cache-control"] = "public, max-age=0, must-revalidate";
    const a = find(await run(otro), /^caché de \/_astro\//);
    assert.equal(a.ok, false);
    assert.match(a.detail, /max-age=0, must-revalidate/);

    const sin = goodTable();
    delete sin[css].headers["cache-control"];
    assert.equal(find(await run(sin), /^caché de \/_astro\//).ok, false);

    const noEsta = goodTable();
    noEsta[css].status = 404;
    const b = find(await run(noEsta), /^caché de \/_astro\//);
    assert.equal(b.ok, false);
    assert.match(b.detail, /404/);

    const sinRed = goodTable();
    sinRed[css] = new TypeError("fetch failed");
    assert.match(find(await run(sinRed), /^caché de \/_astro\//).detail, /sin respuesta/);
  });

  test("caché: falla si el HTML de / no enlaza ningún CSS, o si / no responde", async () => {
    const sinCss = goodTable();
    sinCss[url("/")].body = "<html><body>sin estilos</body></html>";
    const a = find(await run(sinCss), /^caché de \/_astro\//);
    assert.equal(a.ok, false);
    assert.match(a.detail, /ningún CSS/);

    const caida = goodTable();
    caida[url("/")] = new TypeError("fetch failed");
    assert.equal(find(await run(caida), /^caché de \/_astro\//).ok, false);
  });

  test("caché: de lo que cuelga de /_astro/ se pide el CSS, aunque antes haya otro fichero", async () => {
    const table = goodTable();
    table[url("/")].body = '<link rel="preload" href="/_astro/fuente.woff2"><link rel="stylesheet" href="/_astro/index.AbC123.css">';
    const r = find(await run(table), /^caché de \/_astro\//);
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.name, "caché de /_astro/index.AbC123.css");
  });

  test("caché: solo se toma la ruta /_astro/... del HTML; un enlace a otro dominio no genera tráfico hacia allí", async () => {
    const table = goodTable();
    table[url("/")].body = '<link rel="stylesheet" href="https://evil.example/_astro/robado.css">';
    table[url("/_astro/robado.css")] = {
      status: 200,
      headers: { "cache-control": "public, max-age=31536000, immutable" },
      body: "x",
    };
    const fetchFalso = fakeFetch(table);
    const results = await prod.runChecks({ site: SITE, fetch: fetchFalso, expected: EXPECTED, now: () => NOW });

    const r = find(results, /^caché de \/_astro\//);
    assert.equal(r.ok, true, r.detail);
    assert.ok(fetchFalso.calls.some((c) => c.url === "https://carellabs.com/_astro/robado.css"));
    assert.ok(!fetchFalso.calls.some((c) => c.url.includes("evil.example")));
  });
});

describe("runChecks: contenido idéntico al build y a public/", () => {
  const url = (ruta) => `https://carellabs.com${ruta}`;
  const NOMBRES = {
    home: /^HTML de \/ idéntico al build$/,
    english: /^HTML de \/en\/ idéntico al build$/,
    notFound: /^HTML de \/no-existe idéntico al build$/,
    robots: /^robots\.txt idéntico al de public\/$/,
    securityTxt: /^security\.txt idéntico al de public\/\.well-known\/$/,
    plain: /^security\.txt como text\/plain$/,
  };

  test("pasan cuando el HTML (las tres páginas), robots.txt y security.txt son idénticos y security.txt es text/plain", async () => {
    const results = await run(goodTable());
    for (const [clave, re] of Object.entries(NOMBRES)) {
      const r = find(results, re);
      assert.equal(r.ok, true, `${clave}: ${r.detail}`);
    }
  });

  test("falla el HTML de / si Cloudflare inyecta algo, y dice dónde está la diferencia y qué se sirve", async () => {
    const table = goodTable();
    table[url("/")].body = HOME.replace("<body>", "<script>x()</script><body>");
    const results = await run(table);
    const r = find(results, NOMBRES.home);
    assert.equal(r.ok, false);
    const servidos = HOME.length + "<script>x()</script>".length;
    assert.ok(r.detail.startsWith(`sirve ${servidos} bytes y el build tiene ${HOME.length};`), r.detail);
    // (el «<» de «<body>» y de «<script>» coincide: la primera diferencia es el byte siguiente)
    assert.ok(r.detail.includes(`desde el byte ${HOME.indexOf("<body>") + 1}:`), r.detail);
    assert.match(r.detail, /<script>x\(\)<\/script>/);
    assert.match(r.detail, /Cloudflare inyecta o transforma algo, o el despliegue de este commit no ha llegado$/);
    // Control positivo: las otras dos páginas no se ven afectadas.
    assert.equal(find(results, NOMBRES.english).ok, true);
    assert.equal(find(results, NOMBRES.notFound).ok, true);
  });

  test("algo añadido al final (un script que Cloudflare inyecta tras el HTML) también falla", async () => {
    const table = goodTable();
    table[url("/")].body = HOME + "<script>x()</script>";
    const r = find(await run(table), NOMBRES.home);
    assert.equal(r.ok, false);
    assert.ok(r.detail.includes(`desde el byte ${HOME.length}:`), r.detail);
    assert.match(r.detail, /<script>x\(\)<\/script>/);
  });

  test("el fragmento servido que sale en el mensaje va saneado (sin saltos de línea ni comandos de workflow)", async () => {
    const table = goodTable();
    table[url("/")].body = HOME.replace("<body>", "<body>\n::error::falso\u001b[31m");
    const r = find(await run(table), NOMBRES.home);
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.detail, /[\p{Cc}]/u);
    assert.match(r.detail, /\?::error::falso\?/);
  });

  test("el mensaje nombra con qué se compara: el build, public/robots.txt o public/.well-known/security.txt", async () => {
    const table = goodTable();
    table[url("/")].body = "x";
    table[url("/robots.txt")].body = "x";
    table[url("/.well-known/security.txt")].body = "x";
    const results = await run(table);
    assert.match(find(results, NOMBRES.home).detail, /el build tiene \d+/);
    assert.match(find(results, NOMBRES.robots).detail, /public\/robots\.txt tiene \d+/);
    assert.match(find(results, NOMBRES.securityTxt).detail, /public\/\.well-known\/security\.txt tiene \d+/);
  });

  test("un solo byte de diferencia basta (misma longitud)", async () => {
    const table = goodTable();
    table[url("/en/")].body = EN.replace("en</body>", "ez</body>");
    assert.equal(EN.replace("en</body>", "ez</body>").length, EN.length);
    assert.equal(find(await run(table), NOMBRES.english).ok, false);
  });

  test("compara bytes, no texto: dos secuencias UTF-8 inválidas distintas no son iguales", async () => {
    const esperado = { ...EXPECTED, html: { ...EXPECTED.html, "/": Buffer.from([0x3c, 0xe9, 0x3e]) } };
    const table = goodTable();
    table[url("/")].body = Buffer.from([0x3c, 0xe8, 0x3e]);
    const results = await prod.runChecks({ site: SITE, fetch: fakeFetch(table), expected: esperado, now: () => NOW });
    assert.equal(find(results, NOMBRES.home).ok, false);

    table[url("/")].body = Buffer.from([0x3c, 0xe9, 0x3e]);
    const iguales = await prod.runChecks({ site: SITE, fetch: fakeFetch(table), expected: esperado, now: () => NOW });
    assert.equal(find(iguales, NOMBRES.home).ok, true);
  });

  test("un HTML más corto (o vacío) que el del build también falla: el despliegue anterior o una página de error", async () => {
    const corto = goodTable();
    corto[url("/")].body = HOME.slice(0, 20);
    const a = find(await run(corto), NOMBRES.home);
    assert.equal(a.ok, false);
    assert.match(a.detail, /byte 20\b/);

    const vacio = goodTable();
    vacio[url("/no-existe")].body = "";
    assert.equal(find(await run(vacio), NOMBRES.notFound).ok, false);
  });

  test("la 404 se compara con dist/404.html, no con el HTML de /", async () => {
    const table = goodTable();
    table[url("/no-existe")].body = HOME;
    assert.equal(find(await run(table), NOMBRES.notFound).ok, false);
  });

  test("robots.txt: falla si Cloudflare antepone su bloque gestionado, y apunta a Bot Preference Sync", async () => {
    const table = goodTable();
    table[url("/robots.txt")].body = "# BEGIN Cloudflare Managed content\nUser-agent: *\nContent-Signal: search=yes\n# END\n" + ROBOTS;
    const r = find(await run(table), NOMBRES.robots);
    assert.equal(r.ok, false);
    assert.match(r.detail, /Bot Preference Sync/);
  });

  test("security.txt: falla si difiere del de public/, y falla como text/plain si llega con otro tipo", async () => {
    const distinto = goodTable();
    distinto[url("/.well-known/security.txt")].body = SECURITY_TXT.replace("example.test", "otro.test");
    const results = await run(distinto);
    assert.equal(find(results, NOMBRES.securityTxt).ok, false);
    assert.equal(find(results, NOMBRES.plain).ok, true);

    const html = goodTable();
    html[url("/.well-known/security.txt")].headers["content-type"] = "text/html";
    const r = find(await run(html), NOMBRES.plain);
    assert.equal(r.ok, false);
    assert.match(r.detail, /text\/html/);
    assert.equal(find(await run(html), NOMBRES.securityTxt).ok, true);

    const sin = goodTable();
    delete sin[url("/.well-known/security.txt")].headers["content-type"];
    assert.equal(find(await run(sin), NOMBRES.plain).ok, false);
  });

  test("text/plain admite parámetros y mayúsculas, pero no un tipo que solo lo contenga", async () => {
    const conCharset = goodTable();
    conCharset[url("/.well-known/security.txt")].headers["content-type"] = "Text/Plain; charset=utf-8";
    assert.equal(find(await run(conCharset), NOMBRES.plain).ok, true);

    const parecido = goodTable();
    parecido[url("/.well-known/security.txt")].headers["content-type"] = "application/x-text/plain-no";
    assert.equal(find(await run(parecido), NOMBRES.plain).ok, false);
  });

  test("sin respuesta: cada comprobación de contenido lo dice con su URL", async () => {
    const table = goodTable();
    table[url("/robots.txt")] = new TypeError("fetch failed");
    table[url("/.well-known/security.txt")] = new TypeError("fetch failed");
    table[url("/en/")] = new TypeError("fetch failed");
    const results = await run(table);
    for (const re of [NOMBRES.robots, NOMBRES.securityTxt, NOMBRES.plain, NOMBRES.english]) {
      const r = find(results, re);
      assert.equal(r.ok, false);
      assert.match(r.detail, /sin respuesta de https:\/\/carellabs\.com\//);
    }
  });
});

describe("runChecks: caducidad de security.txt (más de 60 días)", () => {
  const NOMBRE = /^security\.txt caduca en más de 60 días$/;
  const url = "https://carellabs.com/.well-known/security.txt";

  /** Producción sirviendo un security.txt que caduca en la fecha dada. */
  const conExpires = (iso) => {
    const table = goodTable();
    table[url].body = `Contact: mailto:security@example.test\nExpires: ${iso}\n`;
    return table;
  };
  const enDias = (dias, extraMs = 0) => new Date(NOW + dias * DAY + extraMs).toISOString();

  test("pasa con el security.txt de prueba (caduca en 351 días) y dice cuántos quedan", async () => {
    const r = find(await run(goodTable()), NOMBRE);
    assert.equal(r.ok, true, r.detail);
    assert.match(r.detail, /2027-09-30/);
    assert.match(r.detail, /351 días/);
  });

  test("el umbral es estricto: con 60 días justos o menos falla; con algo más de 60, pasa", async () => {
    assert.equal(find(await run(conExpires(enDias(59))), NOMBRE).ok, false);
    assert.equal(find(await run(conExpires(enDias(60))), NOMBRE).ok, false, "60 días justos deben fallar");
    assert.equal(find(await run(conExpires(enDias(60, 1000))), NOMBRE).ok, true, "60 días y un segundo deben pasar");
    assert.equal(find(await run(conExpires(enDias(61))), NOMBRE).ok, true);
  });

  test("al fallar explica cómo renovarlo: Expires en public/.well-known/security.txt, máximo un año", async () => {
    const r = find(await run(conExpires(enDias(30, DAY / 2))), NOMBRE); // 30,5 días: se muestran 30
    assert.equal(r.ok, false);
    assert.match(r.detail, /quedan 30 días/);
    assert.match(r.detail, /Expires/);
    assert.match(r.detail, /public\/\.well-known\/security\.txt/);
    assert.match(r.detail, /un año/);
  });

  test("ya caducado: falla y lo dice", async () => {
    const r = find(await run(conExpires(enDias(-3))), NOMBRE);
    assert.equal(r.ok, false);
    assert.match(r.detail, /ha caducado/);
    assert.match(r.detail, /public\/\.well-known\/security\.txt/);
  });

  test("usa el reloj inyectado, no la fecha real", async () => {
    const table = goodTable(); // Expires 2027-09-30
    const lejos = await run(table, { now: () => Date.parse("2027-08-15T00:00:00.000Z") });
    assert.equal(find(lejos, NOMBRE).ok, false, "a 46 días debe fallar");
    const cerca = await run(table, { now: () => Date.parse("2020-01-01T00:00:00.000Z") });
    assert.equal(find(cerca, NOMBRE).ok, true);
  });

  test("falla si no hay Expires, si no es una fecha, o si no hay respuesta", async () => {
    const sin = goodTable();
    sin[url].body = "Contact: mailto:security@example.test\n";
    const a = find(await run(sin), NOMBRE);
    assert.equal(a.ok, false);
    assert.match(a.detail, /Expires/);

    const mala = conExpires("mañana");
    assert.equal(find(await run(mala), NOMBRE).ok, false);

    const caida = goodTable();
    caida[url] = new TypeError("fetch failed");
    assert.match(find(await run(caida), NOMBRE).detail, /sin respuesta/);
  });
});

describe("runChecks: www redirige al dominio raíz", () => {
  const NOMBRE = /^www redirige al dominio raíz$/;
  const wwwUrl = "https://www.carellabs.com/en/?x=1";

  test("pasa con un 301 a https://carellabs.com/en/?x=1, y la petición conserva ruta y consulta", async () => {
    const fetchFalso = fakeFetch(goodTable());
    const results = await prod.runChecks({ site: SITE, fetch: fetchFalso, expected: EXPECTED, now: () => NOW });
    const r = find(results, NOMBRE);
    assert.equal(r.ok, true, r.detail);
    assert.ok(fetchFalso.calls.some((c) => c.url === wwwUrl), "no se pidió https://www.carellabs.com/en/?x=1");
  });

  test("falla si no es un 301, si pierde la consulta o si va a otro sitio", async () => {
    const temporal = goodTable();
    temporal[wwwUrl].status = 302;
    const a = find(await run(temporal), NOMBRE);
    assert.equal(a.ok, false);
    assert.match(a.detail, /302/);
    assert.match(a.detail, /301/);

    const sinConsulta = goodTable();
    sinConsulta[wwwUrl].headers.location = "https://carellabs.com/en/";
    const b = find(await run(sinConsulta), NOMBRE);
    assert.equal(b.ok, false);
    assert.match(b.detail, /«https:\/\/carellabs\.com\/en\/»/);

    const otroDominio = goodTable();
    otroDominio[wwwUrl].headers.location = "https://evil.example/en/?x=1";
    assert.equal(find(await run(otroDominio), NOMBRE).ok, false);

    const sinRedireccion = goodTable();
    sinRedireccion[wwwUrl] = { status: 200, body: "<html></html>" };
    assert.equal(find(await run(sinRedireccion), NOMBRE).ok, false);

    const sinLocation = goodTable();
    delete sinLocation[wwwUrl].headers.location;
    const c = find(await run(sinLocation), NOMBRE);
    assert.equal(c.ok, false);
    assert.match(c.detail, /sin cabecera Location/);
  });

  test("falla con «sin respuesta» si www no contesta, sin afectar a las demás", async () => {
    const table = goodTable();
    table[wwwUrl] = new TypeError("fetch failed");
    const results = await run(table);
    assert.match(find(results, NOMBRE).detail, /sin respuesta de https:\/\/www\.carellabs\.com\//);
    assert.equal(find(results, /^estado de \/$/).ok, true);
  });

  test("el host de www sale del site que se comprueba", async () => {
    const fetchFalso = fakeFetch({});
    await prod.runChecks({ site: "https://ejemplo.test", fetch: fetchFalso, expected: EXPECTED, now: () => NOW });
    assert.ok(fetchFalso.calls.some((c) => c.url === "https://www.ejemplo.test/en/?x=1"));
    assert.ok(fetchFalso.calls.every((c) => new URL(c.url).hostname.endsWith("ejemplo.test")));
  });
});

describe("waitForDeploy: modo espera (--wait)", () => {
  const NOMBRE = "despliegue en producción";
  /** Lo que sirve producción mientras el despliegue no ha llegado. */
  const VIEJO = { body: "<html>la versión anterior</html>" };
  /** Lo que sirve producción cuando el despliegue ya ha llegado, por ruta. */
  const BUENO = {
    "/": { body: HOME },
    "/en/": { body: EN },
    "/no-existe": { status: 404, body: NOT_FOUND },
    "/robots.txt": { body: ROBOTS },
    "/.well-known/security.txt": { body: SECURITY_TXT },
  };
  const RUTAS = Object.keys(BUENO);

  /**
   * Un `fetch` que, para cada ruta, devuelve en orden las respuestas dadas (la última se repite).
   * Las rutas que no se mencionan sirven siempre lo correcto.
   */
  function porRuta(spec = {}) {
    const calls = [];
    const vueltas = {};
    const fn = async (url, init) => {
      const ruta = new URL(url).pathname;
      calls.push({ url: String(url), ruta, init });
      const lista = spec[ruta] ?? [BUENO[ruta]];
      vueltas[ruta] = (vueltas[ruta] ?? 0) + 1;
      const r = lista[Math.min(vueltas[ruta] - 1, lista.length - 1)];
      if (r === undefined) throw new TypeError("fetch failed");
      if (r instanceof Error) throw r;
      return new Response(Buffer.from(r.body ?? ""), { status: r.status ?? 200 });
    };
    fn.calls = calls;
    fn.de = (ruta) => calls.filter((c) => c.ruta === ruta).length;
    return fn;
  }

  const esperar = (fetchFalso, reloj, extra = {}) =>
    prod.waitForDeploy({ site: SITE, fetch: fetchFalso, expected: EXPECTED, waitSeconds: 60, ...reloj, ...extra });

  test("si producción ya sirve todo lo del build, pasa a la primera: una vuelta de peticiones y ninguna espera", async () => {
    const reloj = relojFalso();
    const fetchFalso = porRuta();
    const r = await esperar(fetchFalso, reloj);
    assert.equal(r.name, NOMBRE);
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(fetchFalso.calls.map((c) => c.ruta).sort(), [...RUTAS].sort());
    assert.deepEqual(reloj.sleeps, []);
    assert.match(r.detail, /tras 0 s/);
  });

  test("/ ya coincide pero /en/ aún no: sigue esperando, y acaba en OK cuando /en/ llega", async () => {
    const reloj = relojFalso();
    const fetchFalso = porRuta({ "/en/": [VIEJO, VIEJO, BUENO["/en/"]] });
    const r = await esperar(fetchFalso, reloj);
    assert.equal(r.ok, true, r.detail);
    assert.equal(fetchFalso.de("/"), 3, "en cada vuelta se vuelve a mirar todo");
    assert.equal(fetchFalso.de("/en/"), 3);
    assert.deepEqual(reloj.sleeps, [20_000, 20_000]);
    assert.match(r.detail, /tras 40 s/);
  });

  test("cada contenido retrasa la espera por sí solo: /, /en/, la 404, robots.txt y security.txt", async () => {
    for (const ruta of RUTAS) {
      const reloj = relojFalso();
      const fetchFalso = porRuta({ [ruta]: [VIEJO, BUENO[ruta]] });
      const r = await esperar(fetchFalso, reloj);
      assert.equal(r.ok, true, `${ruta}: ${r.detail}`);
      assert.deepEqual(reloj.sleeps, [20_000], `${ruta} no hizo esperar`);
      assert.equal(fetchFalso.calls.length, RUTAS.length * 2, ruta);
    }
  });

  test("si /en/ nunca llega, falla diciendo que el despliegue no ha llegado y nombrando /en/ (y solo lo que no coincide)", async () => {
    const reloj = relojFalso();
    const fetchFalso = porRuta({ "/en/": [VIEJO] });
    const r = await esperar(fetchFalso, reloj);
    assert.equal(r.name, NOMBRE);
    assert.equal(r.ok, false);
    assert.match(r.detail, /el despliegue no ha llegado en 60 s/);
    assert.match(r.detail, /siguen sin coincidir con el build o con public\/: \/en\/ \(sirve \d+ bytes y el build tiene \d+;/);
    for (const noDebe of ["/no-existe", "robots.txt", "security.txt"]) {
      assert.ok(!r.detail.includes(noDebe), `${noDebe} coincide y no debería aparecer: ${r.detail}`);
    }
    assert.ok(!r.detail.includes(": / ("), "/ coincide y no debería aparecer");
    assert.match(r.detail, /Workers Builds/);
    assert.match(r.detail, /historial de builds/);
    // Intentos en 0, 20, 40 y 60 s: cuatro vueltas de cinco peticiones y tres esperas, ninguna tras el último intento.
    assert.equal(fetchFalso.calls.length, 4 * RUTAS.length);
    assert.deepEqual(reloj.sleeps, [20_000, 20_000, 20_000]);
  });

  test("si no llegan varios contenidos, los nombra todos, cada uno con su diferencia y contra lo que se compara", async () => {
    const viejo404 = { status: 404, body: VIEJO.body };
    const r = await esperar(porRuta({ "/": [VIEJO], "/robots.txt": [VIEJO], "/no-existe": [viejo404] }), relojFalso());
    assert.equal(r.ok, false);
    assert.ok(r.detail.includes("/ (sirve "), r.detail);
    assert.ok(r.detail.includes("/no-existe (sirve "), r.detail);
    assert.ok(r.detail.includes("/robots.txt (sirve "), r.detail);
    assert.match(r.detail, /el build tiene \d+/);
    assert.match(r.detail, /public\/robots\.txt tiene \d+/);
    assert.equal((r.detail.match(/difieren desde el byte/g) ?? []).length, 3);
    assert.ok(!r.detail.includes("/en/ ("), "/en/ coincide y no debería aparecer");
  });

  test("el estado también cuenta: la 404 tiene que responder 404 y el resto 200", async () => {
    const home404 = await esperar(porRuta({ "/": [{ status: 404, body: HOME }] }), relojFalso());
    assert.equal(home404.ok, false);
    assert.match(home404.detail, /\/ \(responde 404, se esperaba 200\)/);

    const notFound200 = await esperar(porRuta({ "/no-existe": [{ status: 200, body: NOT_FOUND }] }), relojFalso());
    assert.equal(notFound200.ok, false);
    assert.match(notFound200.detail, /\/no-existe \(responde 200, se esperaba 404\)/);
  });

  test("sigue intentando ante errores de red o estados que no son 200, y acaba pasando", async () => {
    const reloj = relojFalso();
    const fetchFalso = porRuta({
      "/robots.txt": [new TypeError("fetch failed"), { status: 503, body: "caído" }, BUENO["/robots.txt"]],
    });
    const r = await esperar(fetchFalso, reloj);
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(reloj.sleeps, [20_000, 20_000]);
  });

  test("con la red caída del todo, al agotarse nombra todo lo que falta con «sin respuesta»", async () => {
    const caida = Object.fromEntries(RUTAS.map((ruta) => [ruta, [new TypeError("fetch failed")]]));
    const r = await esperar(porRuta(caida), relojFalso());
    assert.equal(r.ok, false);
    assert.equal((r.detail.match(/sin respuesta/g) ?? []).length, RUTAS.length, r.detail);
  });

  test("con --wait 0 hace una sola vuelta", async () => {
    const reloj = relojFalso();
    const fetchFalso = porRuta({ "/en/": [VIEJO] });
    const r = await esperar(fetchFalso, reloj, { waitSeconds: 0 });
    assert.equal(r.ok, false);
    assert.equal(fetchFalso.calls.length, RUTAS.length);
    assert.deepEqual(reloj.sleeps, []);
  });

  test("el intervalo por defecto es de 20 s y se puede cambiar", async () => {
    assert.equal(prod.WAIT_INTERVAL_MS, 20_000);
    const reloj = relojFalso();
    await esperar(porRuta({ "/en/": [VIEJO] }), reloj, { waitSeconds: 10, intervalMs: 5_000 });
    assert.deepEqual(reloj.sleeps, [5_000, 5_000]);
  });

  test("un contenido del mismo tamaño pero distinto no cuenta como llegado", async () => {
    const mismoTamano = { body: EN.replace("en</body>", "ez</body>") };
    assert.equal(mismoTamano.body.length, EN.length);
    const r = await esperar(porRuta({ "/en/": [mismoTamano] }), relojFalso());
    assert.equal(r.ok, false);
    assert.ok(r.detail.includes("/en/ (sirve "), r.detail);
  });

  test("las peticiones van al site que se comprueba, no a carellabs.com", async () => {
    const fetchFalso = porRuta({ "/en/": [VIEJO] });
    await esperar(fetchFalso, relojFalso(), { site: "https://ejemplo.test" });
    assert.ok(fetchFalso.calls.length > 0);
    for (const { url } of fetchFalso.calls) assert.equal(new URL(url).origin, "https://ejemplo.test", url);
  });

  test("solo se piden esas cinco URL, en el origen que se comprueba (ni /en, ni /_astro, ni www)", async () => {
    const fetchFalso = porRuta({ "/en/": [VIEJO] });
    await esperar(fetchFalso, relojFalso());
    assert.deepEqual([...new Set(fetchFalso.calls.map((c) => c.ruta))].sort(), [...RUTAS].sort());
    for (const { url } of fetchFalso.calls) assert.equal(new URL(url).origin, SITE, url);
  });

  test("cada petición lleva una consulta única (para saltarse cachés)", async () => {
    const fetchFalso = porRuta({ "/en/": [VIEJO] });
    await esperar(fetchFalso, relojFalso());
    const urls = fetchFalso.calls.map((c) => c.url);
    assert.equal(new Set(urls).size, urls.length, "URLs repetidas dentro de una ejecución");
    for (const url of urls) assert.equal([...new URL(url).searchParams.keys()].length, 1, url);
  });

  test("dos ejecuciones distintas no comparten consulta (una caché de la anterior no sirve)", async () => {
    const a = porRuta({ "/en/": [VIEJO] });
    const b = porRuta({ "/en/": [VIEJO] });
    await esperar(a, relojFalso(1_000_000));
    await esperar(b, relojFalso(2_000_000));
    const urls = [...a.calls, ...b.calls].map((c) => c.url);
    assert.equal(new Set(urls).size, urls.length);
  });

  test("el límite de tiempo de cada petición rige también en el modo espera", async () => {
    const inicio = Date.now();
    const r = await esperar(fetchMudo, relojFalso(), { waitSeconds: 0, timeoutMs: 40 });
    assert.ok(Date.now() - inicio < 5000, `tardó ${Date.now() - inicio} ms`);
    assert.equal(r.ok, false);
    assert.match(r.detail, /sin respuesta/);
  });

  test("las peticiones no siguen redirecciones y llevan límite de tiempo", async () => {
    const fetchFalso = porRuta({ "/en/": [VIEJO] });
    await esperar(fetchFalso, relojFalso());
    assert.ok(fetchFalso.calls.length > 0);
    for (const { init } of fetchFalso.calls) {
      assert.equal(init.redirect, "manual");
      assert.ok(init.signal instanceof AbortSignal);
    }
  });
});

describe("waitForDeploy: argumentos inválidos", () => {
  test("rechaza un tiempo que no sea un número finito y no negativo (no puede quedarse esperando para siempre)", async () => {
    for (const waitSeconds of [Number.NaN, -1, Number.POSITIVE_INFINITY, undefined]) {
      await assert.rejects(
        prod.waitForDeploy({ site: SITE, fetch: fakeFetch(goodTable()), expected: EXPECTED, waitSeconds, ...relojFalso() }),
        RangeError,
        `waitSeconds=${waitSeconds}`,
      );
    }
  });
});

describe("loadExpected: lo que dicen el build y public/", () => {
  const publicDir = resolve("/repo/public");
  const distDir = resolve("/repo/dist");
  const FICHEROS = {
    [join(publicDir, "_headers")]: HEADERS_FILE,
    [join(publicDir, "robots.txt")]: ROBOTS,
    [join(publicDir, ".well-known", "security.txt")]: SECURITY_TXT,
    [join(distDir, "index.html")]: HOME,
    [join(distDir, "en", "index.html")]: EN,
    [join(distDir, "404.html")]: NOT_FOUND,
  };
  const lector = (ficheros) => (ruta) => {
    if (!(ruta in ficheros)) throw Object.assign(new Error(`ENOENT: ${ruta}`), { code: "ENOENT" });
    return Buffer.from(ficheros[ruta]);
  };

  test("lee las cabeceras del bloque /*, las tres páginas de dist/, robots.txt y security.txt", () => {
    const e = prod.loadExpected({ publicDir, distDir, readFile: lector(FICHEROS) });
    assert.deepEqual(e.headers, EXPECTED.headers);
    assert.deepEqual(e.html, EXPECTED.html);
    assert.deepEqual(e.robots, EXPECTED.robots);
    assert.deepEqual(e.securityTxt, EXPECTED.securityTxt);
  });

  test("sin build (falta dist/index.html) falla con un error de configuración que manda ejecutar `npm run build`", () => {
    const sinBuild = { ...FICHEROS };
    delete sinBuild[join(distDir, "index.html")];
    assert.throws(
      () => prod.loadExpected({ publicDir, distDir, readFile: lector(sinBuild) }),
      (error) => {
        assert.ok(error instanceof prod.CheckSetupError);
        assert.match(error.message, /index\.html/);
        assert.match(error.message, /npm run build/);
        return true;
      },
    );
  });

  test("falla si falta cualquiera de los ficheros de public/ o de dist/", () => {
    for (const ruta of [
      join(publicDir, "_headers"),
      join(publicDir, "robots.txt"),
      join(publicDir, ".well-known", "security.txt"),
      join(distDir, "index.html"),
      join(distDir, "en", "index.html"),
      join(distDir, "404.html"),
    ]) {
      const incompleto = { ...FICHEROS };
      delete incompleto[ruta];
      assert.throws(
        () => prod.loadExpected({ publicDir, distDir, readFile: lector(incompleto) }),
        prod.CheckSetupError,
        ruta,
      );
    }
  });

  test("falla si public/_headers no tiene un bloque /* con cabeceras (si no, no se comprobaría nada)", () => {
    for (const texto of ["", "/*\n", "/_astro/*\n  Cache-Control: x\n"]) {
      const ficheros = { ...FICHEROS, [join(publicDir, "_headers")]: texto };
      assert.throws(
        () => prod.loadExpected({ publicDir, distDir, readFile: lector(ficheros) }),
        (error) => error instanceof prod.CheckSetupError && /_headers/.test(error.message),
        JSON.stringify(texto),
      );
    }
  });

  test("con los ficheros reales de public/ (y un dist/ falso) obtiene cabeceras, robots y security.txt de verdad", () => {
    const real = (ruta) => (ruta.startsWith(distDir) ? Buffer.from("<html></html>") : readFileSync(ruta));
    const e = prod.loadExpected({ publicDir: join(ROOT, "public"), distDir, readFile: real });
    assert.ok(e.headers.length >= 6);
    assert.match(e.robots.toString("utf8"), /^User-agent: \*/m);
    assert.match(e.securityTxt.toString("utf8"), /^Expires: /m);
  });
});

describe("parseCliArgs", () => {
  test("sin argumentos: carellabs.com, sin espera y dist por defecto", () => {
    assert.deepEqual(prod.parseCliArgs([]), {
      help: false,
      site: "https://carellabs.com",
      dist: undefined,
      wait: undefined,
    });
  });

  test("lee --site (solo el origen), --dist y --wait", () => {
    const args = ["--site", "https://ejemplo.test/ruta?q=1", "--dist", "build", "--wait", "600"];
    assert.deepEqual(prod.parseCliArgs(args), {
      help: false,
      site: "https://ejemplo.test",
      dist: "build",
      wait: 600,
    });
  });

  test("--help y -h piden la ayuda", () => {
    assert.equal(prod.parseCliArgs(["--help"]).help, true);
    assert.equal(prod.parseCliArgs(["-h"]).help, true);
  });

  test("rechaza lo que no entiende, con un error de configuración", () => {
    for (const args of [
      ["--wait", "abc"],
      ["--wait", "-5"],
      ["--wait", "1.5"],
      ["--wait"],
      ["--site", "no es una url"],
      ["--site", "ftp://ejemplo.test"],
      ["--site", "file:///etc/passwd"],
      ["--desconocida"],
      ["sobra"],
    ]) {
      assert.throws(() => prod.parseCliArgs(args), prod.CheckSetupError, args.join(" "));
    }
  });
});

describe("formatResult", () => {
  test("una línea por comprobación: OK con su detalle entre paréntesis, FALLO con el motivo tras los dos puntos", () => {
    assert.equal(prod.formatResult({ name: "estado de /", ok: true, detail: "200" }), "OK     estado de / (200)");
    assert.equal(prod.formatResult({ name: "estado de /", ok: true, detail: "" }), "OK     estado de /");
    assert.equal(
      prod.formatResult({ name: "estado de /", ok: false, detail: "responde 503, se esperaba 200" }),
      "FALLO  estado de /: responde 503, se esperaba 200",
    );
  });
});

describe("main: la CLI", () => {
  const root = resolve("/repo");
  const cwd = resolve("/trabajo");
  const ficheros = (dist) => ({
    [join(root, "public", "_headers")]: HEADERS_FILE,
    [join(root, "public", "robots.txt")]: ROBOTS,
    [join(root, "public", ".well-known", "security.txt")]: SECURITY_TXT,
    [join(dist, "index.html")]: HOME,
    [join(dist, "en", "index.html")]: EN,
    [join(dist, "404.html")]: NOT_FOUND,
  });

  /** Dependencias falsas de `main`: sin red, sin disco, sin esperas ni consola. */
  function entorno({
    fetchFalso = fakeFetch(goodTable()),
    files = ficheros(join(root, "dist")),
    reloj = relojFalso(NOW),
  } = {}) {
    const out = [];
    const err = [];
    return {
      out,
      err,
      fetchFalso,
      reloj,
      deps: {
        fetch: fetchFalso,
        readFile: (ruta) => {
          if (!(ruta in files)) throw Object.assign(new Error(`ENOENT: ${ruta}`), { code: "ENOENT" });
          return Buffer.from(files[ruta]);
        },
        now: reloj.now,
        sleep: reloj.sleep,
        log: (linea) => out.push(linea),
        error: (linea) => err.push(linea),
        root,
        cwd,
      },
    };
  }
  const lineas = (out, prefijo) => out.filter((l) => l.startsWith(prefijo));

  test("con producción correcta: 16 comprobaciones en OK, ningún FALLO y código 0", async () => {
    const { deps, out, err } = entorno();
    const code = await prod.main([], deps);
    assert.equal(code, 0, out.join("\n"));
    assert.equal(lineas(out, "OK     ").length, 16);
    assert.equal(lineas(out, "FALLO").length, 0);
    assert.deepEqual(err, []);
    assert.match(out.at(-1), /16 comprobaciones/);
  });

  test("con una comprobación rota: código 1, su línea FALLO con el motivo, y las demás siguen en OK", async () => {
    const table = goodTable();
    table["https://carellabs.com/robots.txt"].body = "User-agent: *\nDisallow: /\n";
    const { deps, out } = entorno({ fetchFalso: fakeFetch(table) });
    const code = await prod.main([], deps);
    assert.equal(code, 1);
    const fallos = lineas(out, "FALLO");
    assert.equal(fallos.length, 1);
    assert.match(fallos[0], /^FALLO {2}robots\.txt idéntico al de public\/: sirve /);
    assert.equal(lineas(out, "OK     ").length, 15);
    assert.match(out.at(-1), /1 de 16/);
  });

  test("--site cambia el origen que se comprueba (y el de www)", async () => {
    const { deps, fetchFalso } = entorno({ fetchFalso: fakeFetch({}) });
    const code = await prod.main(["--site", "https://ejemplo.test"], deps);
    assert.equal(code, 1);
    assert.ok(fetchFalso.calls.length > 0);
    assert.ok(fetchFalso.calls.every((c) => /^(www\.)?ejemplo\.test$/.test(new URL(c.url).hostname)));
  });

  test("--dist se resuelve desde el directorio de trabajo", async () => {
    const { deps, out } = entorno({ files: ficheros(join(cwd, "salida", "build")) });
    const code = await prod.main(["--dist", join("salida", "build")], deps);
    assert.equal(code, 0, out.join("\n"));
  });

  test("sin build: código 2, el motivo por stderr y ninguna petición", async () => {
    const { deps, out, err, fetchFalso } = entorno({ files: {} });
    const code = await prod.main([], deps);
    assert.equal(code, 2);
    assert.deepEqual(out, []);
    assert.match(err.join("\n"), /npm run build/);
    assert.equal(fetchFalso.calls.length, 0);
  });

  test("argumentos inválidos: código 2, el motivo y el uso por stderr, y ninguna petición", async () => {
    const { deps, out, err, fetchFalso } = entorno();
    const code = await prod.main(["--wait", "abc"], deps);
    assert.equal(code, 2);
    assert.deepEqual(out, []);
    assert.match(err.join("\n"), /--wait/);
    assert.match(err.join("\n"), /Uso:/);
    assert.equal(fetchFalso.calls.length, 0);
  });

  test("--help imprime el uso por stdout y sale con 0 sin hacer nada más", async () => {
    const { deps, out, fetchFalso } = entorno();
    const code = await prod.main(["--help"], deps);
    assert.equal(code, 0);
    assert.match(out.join("\n"), /Uso:/);
    for (const opcion of ["--site", "--dist", "--wait"]) assert.ok(out.join("\n").includes(opcion), opcion);
    assert.equal(fetchFalso.calls.length, 0);
  });

  test("--wait espera primero a que llegue el despliegue y después hace todas las comprobaciones", async () => {
    // /en/ tarda dos vueltas en llegar; el resto ya está publicado desde el principio.
    const base = fakeFetch(goodTable());
    let pendientes = 2;
    const conRetraso = async (url, init) => {
      if (new URL(url).pathname === "/en/" && pendientes-- > 0) {
        return new Response(Buffer.from("<html>la versión anterior</html>"));
      }
      return base(url, init);
    };
    const { deps, out, reloj } = entorno({ fetchFalso: conRetraso });
    const code = await prod.main(["--wait", "600"], deps);
    assert.equal(code, 0, out.join("\n"));
    assert.equal(
      lineas(out, "OK     ")[0],
      "OK     despliegue en producción (todo lo servido ya es el del build y el de public/ (tras 40 s))",
    );
    assert.equal(lineas(out, "OK     ").length, 17);
    assert.deepEqual(reloj.sleeps, [20_000, 20_000]);
  });

  test("--wait agotado: código 1, solo la línea del despliegue y el aviso, y no se piden las demás URL", async () => {
    const table = goodTable();
    table["https://carellabs.com/"].body = "<html>la versión anterior</html>";
    const { deps, out, fetchFalso } = entorno({ fetchFalso: fakeFetch(table) });
    const code = await prod.main(["--wait", "60"], deps);
    assert.equal(code, 1);
    const fallos = lineas(out, "FALLO");
    assert.equal(fallos.length, 1);
    assert.match(fallos[0], /^FALLO {2}despliegue en producción: el despliegue no ha llegado en 60 s/);
    assert.match(out.join("\n"), /Se omiten las demás comprobaciones/);
    assert.ok(fetchFalso.calls.length > 0);
    const delContenido = ["/", "/en/", "/no-existe", "/robots.txt", "/.well-known/security.txt"];
    for (const { url } of fetchFalso.calls) {
      const u = new URL(url);
      assert.ok(
        u.hostname === "carellabs.com" && delContenido.includes(u.pathname),
        `se pidió algo más que la espera: ${url}`,
      );
    }
  });

  test("sin --wait no hay fase de espera: cada URL se pide una sola vez y no se duerme", async () => {
    const { deps, fetchFalso, reloj } = entorno();
    await prod.main([], deps);
    const pedidas = fetchFalso.calls.map((c) => c.url);
    assert.ok(pedidas.length > 0);
    assert.equal(new Set(pedidas).size, pedidas.length, "alguna URL se pidió más de una vez");
    assert.deepEqual(reloj.sleeps, []);
  });
});

describe("request con el fetch real: las redirecciones no se siguen", () => {
  /** Un servidor local que apunta qué se le pide. */
  async function servidor(manejador) {
    const visitas = [];
    const server = createServer((req, res) => {
      visitas.push(req.url);
      manejador(req, res);
    });
    await new Promise((listo) => server.listen(0, "127.0.0.1", listo));
    return {
      visitas,
      origen: `http://127.0.0.1:${server.address().port}`,
      cerrar: () => {
        server.closeAllConnections();
        return new Promise((listo) => server.close(listo));
      },
    };
  }

  test("un 307 se devuelve tal cual (estado y Location) y una redirección a otro servidor no genera tráfico hacia él", async () => {
    const otro = await servidor((req, res) => res.end("no deberías estar aquí"));
    const nuestro = await servidor((req, res) => {
      if (req.url === "/en") res.writeHead(307, { location: "/en/" }).end();
      else if (req.url === "/fuera") res.writeHead(302, { location: `${otro.origen}/robado` }).end();
      else res.writeHead(200, { "content-type": "text/plain" }).end("hola");
    });
    try {
      const interna = await prod.request(fetch, `${nuestro.origen}/en`);
      assert.equal(interna.ok, true);
      assert.equal(interna.status, 307);
      assert.equal(interna.headers.get("location"), "/en/");

      const externa = await prod.request(fetch, `${nuestro.origen}/fuera`);
      assert.equal(externa.ok, true);
      assert.equal(externa.status, 302);
      assert.deepEqual(otro.visitas, [], "se siguió la redirección hacia otro servidor");

      // Control positivo: una petición normal sí llega, con su cuerpo en bytes.
      const normal = await prod.request(fetch, `${nuestro.origen}/`);
      assert.equal(normal.status, 200);
      assert.equal(normal.body.toString("utf8"), "hola");
    } finally {
      await nuestro.cerrar();
      await otro.cerrar();
    }
  });

  test("un servidor que no responde da una Reply con ok:false (sin lanzar) pasado el límite de tiempo", async () => {
    const mudo = await servidor(() => {});
    try {
      const r = await prod.request(fetch, `${mudo.origen}/`, 150);
      assert.equal(r.ok, false);
      assert.ok(r.error.length > 0);
    } finally {
      await mudo.cerrar();
    }
  });
});

describe("el fichero como programa", () => {
  const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "prod-check.mjs");

  test("importar el módulo no ejecuta la CLI", () => {
    const modulo = JSON.stringify(new URL("./prod-check.mjs", import.meta.url).href);
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import ${modulo}; console.log("importado")`], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "importado");
  });

  test("importarlo desde stdin (argv[1] = '-') no lanza", () => {
    const modulo = JSON.stringify(new URL("./prod-check.mjs", import.meta.url).href);
    const r = spawnSync(process.execPath, ["--input-type=module", "-"], {
      input: `import ${modulo}; console.log("importado")`,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /importado/);
  });

  test("`node prod-check.mjs --help` sale con 0 y muestra el uso", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Uso:/);
  });

  test("`node prod-check.mjs --wait abc` sale con 2 y no toca la red", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--wait", "abc"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--wait/);
  });
});

describe("package.json", () => {
  test("`npm run check:prod` lanza el script (y el script existe)", () => {
    const scripts = JSON.parse(read("package.json")).scripts;
    assert.equal(scripts["check:prod"], "node .github/scripts/prod-check.mjs");
    assert.ok(read(".github/scripts/prod-check.mjs").length > 0);
  });
});
