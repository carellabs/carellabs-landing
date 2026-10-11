import { readdirSync, readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { enforceCsp, headersFor, parseCsp, readHeaders, siteCsp } from "./headers";
import { SCHEMES } from "./viewports";

// Lo que Cloudflare Pages va a servir (public/_headers) y si la web funciona con esas cabeceras.

test("public/_headers sets the baseline security headers on every path", () => {
  const all = headersFor("/*");
  expect(all["x-content-type-options"]).toBe("nosniff");
  expect(all["x-frame-options"]).toBe("DENY");
  expect(all["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(all["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
});

test("HSTS is sent for carellabs.com for at least a year, without includeSubDomains or preload", () => {
  const hsts = headersFor("/*")["strict-transport-security"];
  expect(hsts, "public/_headers no envía Strict-Transport-Security en /*").toBeDefined();
  const directives = hsts!.split(";").map((d) => d.trim().toLowerCase());

  // Control positivo: la directiva `max-age` está, se lee bien y dura al menos un año.
  const maxAge = directives.find((d) => d.startsWith("max-age="));
  expect(maxAge, "Strict-Transport-Security sin max-age").toBeDefined();
  expect(Number(maxAge!.slice("max-age=".length))).toBeGreaterThanOrEqual(31_536_000);

  // Ausencias. Los subdominios futuros (finanzas., barberia., closet.) quizá no sirvan HTTPS:
  // con `includeSubDomains` quedarían inaccesibles, y `preload` es muy difícil de deshacer.
  // Se añaden solo cuando todos los subdominios sirvan HTTPS.
  expect(directives, "includeSubDomains dejaría inaccesibles los subdominios que no sirvan HTTPS").not.toContain(
    "includesubdomains",
  );
  expect(directives, "preload es muy difícil de deshacer: no antes de que todos los subdominios sirvan HTTPS").not.toContain(
    "preload",
  );
});

test("the CSP is exactly as strict as this static site needs", () => {
  // Control positivo: se ha leído una política con contenido.
  const csp = parseCsp(siteCsp());
  expect(Object.keys(csp).length).toBeGreaterThan(5);

  // Todo prohibido por defecto: `default-src 'none'` (lo que no se nombre abajo, no se carga).
  expect(csp["default-src"]).toEqual(["'none'"]);

  // Estilos, fuentes e imágenes siguen permitidos, pero solo propios (sin `data:`: la web no usa
  // ninguno) y ningún formulario puede enviarse.
  expect(csp["style-src"]).toEqual(["'self'"]);
  expect(csp["font-src"]).toEqual(["'self'"]);
  expect(csp["img-src"]).toEqual(["'self'"]);
  expect(csp["form-action"]).toEqual(["'none'"]);

  // La política completa, fijada: ampliarla es una decisión de seguridad y debe verse en el diff.
  // (`object-src` no hace falta: hereda `'none'` de `default-src`.)
  expect(csp).toEqual({
    "default-src": ["'none'"],
    "style-src": ["'self'"],
    "font-src": ["'self'"],
    "img-src": ["'self'"],
    "base-uri": ["'none'"],
    "form-action": ["'none'"],
    "frame-ancestors": ["'none'"],
  });
});

test("the CSP lets nothing run or connect: scripts, connections, frames, workers, objects and media stay blocked", () => {
  const csp = parseCsp(siteCsp());
  // Control positivo: se ha leído una política con contenido y su base es `'none'`.
  expect(csp["default-src"]).toEqual(["'none'"]);

  // Cada directiva de carga que no sea de estilos, fuentes o imágenes: o no se declara (y hereda
  // `default-src 'none'`) o se declara como `'none'`. Una `script-src 'self'` o `connect-src` con
  // cualquier origen abriría la puerta a código o a peticiones que esta web no necesita.
  for (const directive of [
    "script-src",
    "script-src-elem",
    "script-src-attr",
    "connect-src",
    "frame-src",
    "child-src",
    "worker-src",
    "object-src",
    "media-src",
    "manifest-src",
  ]) {
    expect(csp[directive] ?? csp["default-src"], `${directive} permitiría algo`).toEqual(["'none'"]);
  }
});

// Sin <script> en el HTML publicado: es lo que hace correcta una CSP que no permite scripts.
test("the built HTML has no <script>, because the CSP does not allow scripts", () => {
  const pages = readdirSync("dist", { recursive: true })
    .map((file) => String(file).replaceAll("\\", "/"))
    .filter((file) => file.endsWith(".html"))
    .sort();
  // Control positivo 1: se han encontrado las páginas del build (ES, EN y la 404).
  expect(pages, "dist/ sin HTML: ¿se ha construido la web?").toEqual(
    expect.arrayContaining(["404.html", "en/index.html", "index.html"]),
  );

  // Control positivo 2: el detector ve un <script> (en línea, con src, con atributos y con otra capitalización).
  const hasScript = (html: string) => /<script\b/i.test(html);
  for (const sample of ["<script>1</script>", '<script src="/a.js"></script>', '<SCRIPT type="module">']) {
    expect(hasScript(sample), `el detector no ve ${sample}`).toBe(true);
  }

  const withScript = pages.filter((file) => hasScript(readFileSync(`dist/${file}`, "utf8")));
  expect(
    withScript,
    "La CSP de public/_headers no permite scripts (default-src 'none' y sin script-src). Si se añade un " +
      "<script>, hay que revisar la CSP a la vez, o el navegador lo bloqueará.",
  ).toEqual([]);
});

test("hashed assets under /_astro/ are cached for a year as immutable, and nothing else is", () => {
  const blocks = readHeaders();
  const astro = blocks.find((b) => b.path === "/_astro/*");
  expect(astro, "no hay bloque para /_astro/*").toBeDefined();
  expect(astro!.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

  // Ningún otro bloque cachea: el HTML (y el favicon, sin hash) tienen que poder revalidarse.
  const others = blocks.filter((b) => b.path !== "/_astro/*");
  expect(others.length).toBeGreaterThan(0);
  expect(others.filter((b) => "cache-control" in b.headers).map((b) => b.path)).toEqual([]);

  // `immutable` solo es seguro con nombres con hash: todo lo que hay en dist/_astro lo tiene.
  const files = readdirSync("dist/_astro");
  expect(files.length, "dist/_astro vacío: ¿se ha construido la web?").toBeGreaterThan(0);
  for (const file of files) {
    expect(file, `${file} sin hash en el nombre`).toMatch(/\.[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/);
  }
});

// `astro preview` no sirve `_headers`: se añade la CSP real a la respuesta del documento y se
// comprueba que el navegador no bloquea nada (estilos, fuente y favicon, que se pide a mano),
// con el esquema de color oscuro y con el claro.
const CASES = SCHEMES.flatMap((scheme) => ["/", "/en/", "/no-existe"].map((path) => ({ scheme, path })));
for (const { scheme, path } of CASES) {
  test(`${path}: loads without CSP violations under the real public/_headers policy (${scheme.name} scheme)`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme.name });
    const csp = siteCsp();
    const report = await enforceCsp(page, csp);

    const response = await page.goto(path);
    // Control positivo 1: la política viaja de verdad en la respuesta.
    expect(response?.headers()["content-security-policy"]).toBe(csp);
    await page.evaluate(() => document.fonts.ready);

    // Control positivo 2: con la política activa la web sigue funcionando (hoja de estilos y fuente).
    const state = await page.evaluate(() => ({
      background: getComputedStyle(document.body).backgroundColor,
      fonts: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
    }));
    expect(state.background).toBe(scheme.bg);
    expect(state.fonts.join(" ")).toContain("JetBrains Mono");

    // Chromium headless no pide el favicon por sí solo: se carga a mano para ejercitar img-src.
    const faviconLoaded = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(true);
          img.onerror = () => resolve(false);
          img.src = "/favicon.svg";
        }),
    );
    expect(faviconLoaded, "el favicon no carga con la CSP real").toBe(true);

    expect(report.violations, "eventos securitypolicyviolation").toEqual([]);
    expect(report.consoleErrors, "errores de consola de CSP").toEqual([]);

    // Control positivo 3: el detector funciona. Un <style> en línea, que la política prohíbe,
    // tiene que aparecer como violación; si no, los dos `toEqual([])` de arriba no probarían nada.
    await page.evaluate(() => {
      const style = document.createElement("style");
      style.textContent = "body { margin: 0 }";
      document.head.append(style);
    });
    await expect.poll(() => report.violations.length).toBeGreaterThan(0);
    expect(report.violations[0]).toContain("style-src");

    // Control positivo 4: ni siquiera un <script> propio (mismo origen) se carga. Sin `script-src`,
    // la política hereda `default-src 'none'`; con el antiguo `default-src 'self'` este script se habría permitido.
    const seen = report.violations.length;
    await page.evaluate(() => {
      const script = document.createElement("script");
      script.src = "/favicon.svg";
      document.head.append(script);
    });
    await expect.poll(() => report.violations.length).toBeGreaterThan(seen);
    expect(report.violations.at(-1)).toContain("script-src");
  });
}
