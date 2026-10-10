import { readdirSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { enforceCsp, headersFor, parseCsp, readHeaders, siteCsp } from "./headers";

// Lo que Cloudflare Pages va a servir (public/_headers) y si la web funciona con esas cabeceras.

test("public/_headers sets the baseline security headers on every path", () => {
  const all = headersFor("/*");
  expect(all["x-content-type-options"]).toBe("nosniff");
  expect(all["x-frame-options"]).toBe("DENY");
  expect(all["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(all["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
});

test("the CSP is exactly as strict as this static site needs", () => {
  // Control positivo: se ha leído una política con contenido.
  const csp = parseCsp(siteCsp());
  expect(Object.keys(csp).length).toBeGreaterThan(5);

  // Imágenes solo propias (sin `data:`: la web no usa ninguna) y ningún formulario puede enviarse.
  expect(csp["img-src"]).toEqual(["'self'"]);
  expect(csp["form-action"]).toEqual(["'none'"]);

  // La política completa, fijada: ampliarla es una decisión de seguridad y debe verse en el diff.
  expect(csp).toEqual({
    "default-src": ["'self'"],
    "style-src": ["'self'"],
    "font-src": ["'self'"],
    "img-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'none'"],
    "frame-ancestors": ["'none'"],
  });
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
// comprueba que el navegador no bloquea nada (estilos, fuente y favicon, que se pide a mano).
for (const path of ["/", "/en/", "/no-existe"]) {
  test(`${path}: loads without CSP violations under the real public/_headers policy`, async ({ page }) => {
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
    expect(state.background).not.toBe("rgba(0, 0, 0, 0)");
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
  });
}
