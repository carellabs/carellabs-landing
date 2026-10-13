// Genera el icono para iOS (public/apple-touch-icon.png, 180x180) a partir de public/favicon.svg.
// Uso: `npm run icons` (requiere el Chromium de Playwright; no usa la red).
// iOS rellena la transparencia con negro u otro color, así que el icono lleva un fondo opaco: el
// oscuro de la marca (el `--bg` de `:root` en src/styles/global.css) con el favicon centrado. El favicon
// se dibuja más grande que el lienzo (DRAW > SIZE, scripts/icons/params.mjs) y se recorta por los bordes:
// lo que se recorta es su propio fondo oscuro, y la marca llena en torno al 60 % del lado. Deja en
// scripts/icons/rendered-from.json un hash del favicon, el fondo y las dos medidas usados: un test avisa
// si cambian y el icono no se ha regenerado.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { DRAW, SIZE } from "./params.mjs";

// Desplazamiento (negativo) con el que el favicon, de lado DRAW, queda centrado en el lienzo de lado SIZE.
const OFFSET = (SIZE - DRAW) / 2;

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const favicon = read("public/favicon.svg");
const background = /--bg:\s*(#[0-9a-f]{6})/i.exec(read("src/styles/global.css"))?.[1]?.toLowerCase();
if (!background) throw new Error("No encuentro el color `--bg` en src/styles/global.css");

// Con los saltos de línea normalizados: el mismo hash en Windows y en Linux.
const fingerprint = (svg) => createHash("sha256").update(svg.replaceAll("\r\n", "\n")).digest("hex");

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: ${SIZE}px; height: ${SIZE}px; overflow: hidden; background: ${background}; }
  .mark { position: absolute; left: ${OFFSET}px; top: ${OFFSET}px; width: ${DRAW}px; height: ${DRAW}px; }
  .mark svg { display: block; width: 100%; height: 100%; }
</style>
<div class="mark">${favicon}</div>`;

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
try {
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
  // Sin red: todo va dentro de la página.
  await page.route("**/*", (route) => {
    const url = route.request().url();
    return url.startsWith("data:") || url === "about:blank" ? route.continue() : route.abort();
  });
  await page.setContent(html, { waitUntil: "load" });

  const out = "public/apple-touch-icon.png";
  await page.screenshot({ path: join(root, out), type: "png" });
  console.log(out);
} finally {
  await browser.close();
}

writeFileSync(
  join(root, "scripts/icons/rendered-from.json"),
  `${JSON.stringify({ favicon: fingerprint(favicon), background, size: SIZE, draw: DRAW }, null, 2)}\n`,
);
console.log("scripts/icons/rendered-from.json");
