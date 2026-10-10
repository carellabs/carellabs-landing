// Genera las imágenes Open Graph (1200x630) de cada idioma a partir de los textos
// de src/i18n/*.json. Uso: `npm run og` (requiere el Chromium de Playwright).
// Deja en scripts/og/rendered-from.json los textos usados: un test avisa si cambian
// los del hero y las imágenes no se han regenerado.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const WIDTH = 1200;
const HEIGHT = 630;
const LANGS = ["es", "en"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const template = read("scripts/og/template.html");
const font = readFileSync(
  join(root, "node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2"),
).toString("base64");
const mark = read("public/favicon.svg");

const escapeHtml = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Una sola pasada: un valor que contenga `{{x}}` no se vuelve a expandir, y una
// clave de la plantilla sin valor es un error (no se cuela en la imagen).
const fill = (html, values) =>
  html.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`La plantilla usa {{${key}}} y no hay valor para esa clave`);
    return values[key];
  });

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const renderedFrom = {};
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  // Sin red: todo (fuente incluida) va dentro de la plantilla.
  await page.route("**/*", (route) => {
    const url = route.request().url();
    return url.startsWith("data:") || url === "about:blank" ? route.continue() : route.abort();
  });

  for (const lang of LANGS) {
    const t = JSON.parse(read(`src/i18n/${lang}.json`));
    const texts = { brand: t.site.brand, headline: t.hero.headline, name: t.hero.name, role: t.hero.role };
    const html = fill(template, {
      lang,
      font,
      mark,
      brand: escapeHtml(texts.brand),
      headline: escapeHtml(texts.headline),
      name: escapeHtml(texts.name),
      role: escapeHtml(texts.role),
    });

    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);

    const check = await page.evaluate(() => ({
      fontLoaded: [...document.fonts].some((f) => f.family.includes("JetBrains") && f.status === "loaded"),
      overflow: document.body.scrollHeight > window.innerHeight || document.body.scrollWidth > window.innerWidth,
    }));
    if (!check.fontLoaded) throw new Error(`[${lang}] JetBrains Mono no ha cargado`);
    if (check.overflow) throw new Error(`[${lang}] el contenido no cabe en ${WIDTH}x${HEIGHT}`);

    const out = `public/og-${lang}.png`;
    await page.screenshot({ path: join(root, out), type: "png" });
    renderedFrom[lang] = texts;
    console.log(out);
  }
} finally {
  await browser.close();
}

writeFileSync(join(root, "scripts/og/rendered-from.json"), `${JSON.stringify(renderedFrom, null, 2)}\n`);
console.log("scripts/og/rendered-from.json");
