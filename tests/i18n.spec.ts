import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";

// Lógica pura sobre ficheros: no abre el navegador. Fija la regla "los textos de interfaz salen
// de src/i18n/*.json, con las mismas claves en es y en en".

const messages = (lang: "es" | "en"): unknown =>
  JSON.parse(readFileSync(join("src", "i18n", `${lang}.json`), "utf8"));

/** Rutas de todas las hojas del JSON: objetos por clave y listas por índice (`a.b[0]`). */
function leafPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => leafPaths(v, `${prefix}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
  }
  return [prefix];
}

/** Todos los .astro de una carpeta, de forma recursiva. */
function astroFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return astroFiles(path);
    return entry.name.endsWith(".astro") ? [path] : [];
  });
}

/** La parte de marcado de un .astro: sin el frontmatter (`---`), ni <style> ni <script>. */
function templateOf(source: string): string {
  const body = source.startsWith("---") ? source.slice(source.indexOf("\n---", 3) + 4) : source;
  return body.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "");
}

test("es.json and en.json have exactly the same keys", () => {
  const es = leafPaths(messages("es"));
  const en = leafPaths(messages("en"));
  // Control positivo: se han leído claves de verdad (incluidas las de listas).
  expect(es.length).toBeGreaterThan(50);
  expect(es.some((p) => p.includes("["))).toBe(true);
  expect(en).toEqual(es);
});

// Una clave cuenta como usada si alguna plantilla escribe `t.<ruta>` (p. ej. `t.lab.title`; `t`,
// `es` o `en` son los objetos de textos), o usa un padre suyo como un todo (`t.lab.status[app.status]`,
// `t.hero.note.map(...)`). La ruta tiene que empezar justo tras el objeto: `t.nav.lab` no usa `lab.*`.
const ARRAY_METHODS = "map|filter|find|some|every|forEach|join|slice|length|at";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const usageOf = (path: string[]) =>
  new RegExp(
    `(?<![\\w.])(?:t|es|en)\\.${path.map(escapeRe).join("\\.")}(?![\\w-])(?!\\.(?!(?:${ARRAY_METHODS})\\b)[A-Za-z_])`,
  );

test("every i18n key is used by some template", () => {
  const source = astroFiles("src")
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const keys = new Set(leafPaths(messages("es")).map((p) => p.replace(/\[\d+\]/g, "")));
  expect(keys.size).toBeGreaterThan(40);

  const unused = [...keys].filter((key) => {
    const parts = key.split(".");
    return !parts.some((_, i) => usageOf(parts.slice(0, i + 1)).test(source));
  });
  expect(unused, "claves de i18n que ninguna plantilla usa").toEqual([]);
});

/** Contenido de las llaves de `attr={ ... }`, con las llaves anidadas bien emparejadas. */
function expressionAttributes(template: string, attr: string): string[] {
  const found: string[] = [];
  const start = new RegExp(`\\b${attr}=\\{`, "g");
  for (let m = start.exec(template); m; m = start.exec(template)) {
    let depth = 1;
    let i = start.lastIndex;
    while (i < template.length && depth > 0) {
      const c = template[i++];
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    found.push(template.slice(start.lastIndex, i - 1));
  }
  return found;
}

const WORD = /[A-Za-zÁÉÍÓÚÜáéíóúüÑñ]{3,}/;
const TEXT_ATTRIBUTES = ["aria-label", "title", "alt", "placeholder", "description"];

test("templates contain no hard-coded interface text (it lives in src/i18n)", () => {
  const offenders: string[] = [];
  let attributesSeen = 0;
  for (const file of astroFiles("src")) {
    const template = templateOf(readFileSync(file, "utf8"));

    for (const attr of TEXT_ATTRIBUTES) {
      // Valor literal: aria-label="Stack"
      for (const m of template.matchAll(new RegExp(`\\b${attr}="([^"]*)"`, "g"))) {
        attributesSeen++;
        if (WORD.test(m[1])) offenders.push(`${file}: ${attr}="${m[1]}"`);
      }
      // Expresión con cadenas literales: aria-label={lang === "es" ? "Secciones" : "Sections"}
      for (const expr of expressionAttributes(template, attr)) {
        attributesSeen++;
        const literals = [...expr.replace(/\$\{[^}]*\}/g, "").matchAll(/(["'`])((?:(?!\1).)*)\1/g)];
        for (const [, , text] of literals) {
          if (WORD.test(text)) offenders.push(`${file}: ${attr}={... "${text}" ...}`);
        }
      }
    }

    // Texto entre etiquetas sin ninguna expresión: <h1>Esta página no existe.</h1>
    for (const m of template.matchAll(/>([^<>{}]+)</g)) {
      if (WORD.test(m[1])) offenders.push(`${file}: texto "${m[1].trim()}"`);
    }
  }
  // Control positivo: el rastreo ve atributos de texto (hay varios aria-label y title en las plantillas).
  expect(attributesSeen).toBeGreaterThan(3);
  expect(offenders, "textos de interfaz escritos a mano en las plantillas").toEqual([]);
});
