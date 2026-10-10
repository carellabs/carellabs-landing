import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { PAGES } from "./viewports";

for (const pg of PAGES) {
  test(`${pg.path}: JetBrains Mono is self-hosted and loads without Google`, async ({ page }) => {
    const requests: { url: string; type: string }[] = [];
    page.on("request", (r) => requests.push({ url: r.url(), type: r.resourceType() }));

    await page.goto(pg.path);
    await page.evaluate(() => document.fonts.ready);

    // Ausencia: ninguna petición a los dominios de Google Fonts.
    const google = requests.filter((r) => /fonts\.(googleapis|gstatic)\.com/.test(r.url));
    expect(google, "peticiones a Google Fonts").toEqual([]);

    // Control positivo de lo anterior: el listener ve las peticiones y la fuente
    // se descarga del propio origen, una sola vez por archivo (sin precarga duplicada).
    const origin = new URL(page.url()).origin;
    const fontRequests = requests.filter((r) => r.type === "font");
    expect(fontRequests.length, "no se pidió ninguna fuente").toBeGreaterThan(0);
    for (const r of fontRequests) expect(new URL(r.url).origin, r.url).toBe(origin);
    const urls = fontRequests.map((r) => r.url);
    expect(new Set(urls).size, `fuente descargada más de una vez: ${urls.join(", ")}`).toBe(urls.length);

    // La familia está declarada y termina cargada (ninguna cara en error).
    const faces = await page.evaluate(() =>
      [...document.fonts].map((f) => ({ family: f.family.replace(/["']/g, ""), status: f.status })),
    );
    const mono = faces.filter((f) => f.family.includes("JetBrains Mono"));
    expect(mono.length, "JetBrains Mono no está declarada").toBeGreaterThan(0);
    expect(mono.filter((f) => f.status === "error")).toEqual([]);
    expect(mono.some((f) => f.status === "loaded"), JSON.stringify(mono)).toBe(true);
  });
}

test("the font is not inlined as data: (the CSP only allows font-src 'self')", async ({ page }) => {
  await page.goto("/");
  const { sources, unreadable } = await page.evaluate(() => {
    const out: string[] = [];
    const blocked: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (rule instanceof CSSFontFaceRule) out.push(rule.style.getPropertyValue("src"));
        }
      } catch {
        // Una hoja de otro origen no deja leer sus reglas: ya es una regresión.
        blocked.push(sheet.href ?? "(inline)");
      }
    }
    return { sources: out, unreadable: blocked };
  });
  expect(unreadable, "hojas de estilo de otro origen").toEqual([]);
  // Control positivo: hay reglas @font-face y apuntan a archivos .woff2.
  expect(sources.length, "no hay reglas @font-face").toBeGreaterThan(0);
  for (const src of sources) {
    expect(src).toMatch(/\.woff2/);
    expect(src).not.toMatch(/data:/);
  }
});

test("the CSP does not allow Google font hosts and serves fonts from 'self'", () => {
  const headers = readFileSync("public/_headers", "utf8");
  const csp = headers.match(/Content-Security-Policy:\s*(.+)/)?.[1] ?? "";
  const directive = (name: string) =>
    csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith(`${name} `));

  // Control positivo: la política se ha leído y tiene contenido.
  expect(csp).toContain("default-src 'self'");

  expect(csp).not.toMatch(/google|gstatic/i);
  expect(directive("font-src")).toBe("font-src 'self'");
  // style-src solo admite hojas de estilo propias: nada externo ni en línea.
  expect(directive("style-src")?.split(" ").slice(1)).toEqual(["'self'"]);
});
