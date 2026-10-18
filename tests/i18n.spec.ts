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

/** Las hojas de texto del JSON con su ruta (`a.b[0]`). */
function leafTexts(value: unknown, prefix = ""): { path: string; text: string }[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => leafTexts(v, `${prefix}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => leafTexts(v, prefix ? `${prefix}.${k}` : k));
  }
  return typeof value === "string" ? [{ path: prefix, text: value }] : [];
}

/** Todos los .astro de una carpeta, de forma recursiva. */
function astroFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return astroFiles(path);
    return entry.name.endsWith(".astro") ? [path] : [];
  });
}

/** Los .ts de una carpeta (src/lib): la lógica que monta datos con textos de i18n. */
const tsFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(dir, entry.name));

/** La parte de marcado de un .astro: sin el frontmatter (`---`), ni <style> ni <script>. */
function templateOf(source: string): string {
  let body = source.startsWith("---") ? source.slice(source.indexOf("\n---", 3) + 4) : source;
  // En mayúsculas o minúsculas y con lo que sea dentro de la etiqueta de cierre (`</script >`).
  // Se repite hasta que no quede ninguno: al quitar un bloque, los restos podrían formar otro.
  const blocks = /<(style|script)\b[\s\S]*?<\/\1\b[^>]*>/gi;
  for (let previous = ""; previous !== body; ) {
    previous = body;
    body = body.replace(blocks, "");
  }
  return body;
}

test("templateOf drops <style> and <script> blocks in any case and with spaces in the closing tag", () => {
  expect(templateOf('<p>a</p><SCRIPT>x()</SCRIPT ><style media="print">p{}</style>b')).toBe("<p>a</p>b");
  // Un bloque dentro de otro no deja restos.
  expect(templateOf("a<scr<script>1</script>ipt>2</script>b")).toBe("ab");
});

test("es.json and en.json have exactly the same keys", () => {
  const es = leafPaths(messages("es"));
  const en = leafPaths(messages("en"));
  // Control positivo: se han leído claves de verdad (incluidas las de listas).
  expect(es.length).toBeGreaterThan(50);
  expect(es.some((p) => p.includes("["))).toBe(true);
  expect(en).toEqual(es);
});

// `highlights` es opcional por puesto, pero si está tiene que ser una lista con algo dentro: una lista vacía
// pintaría un <ul> sin elementos y un logro en blanco, una viñeta vacía.
for (const lang of ["es", "en"] as const) {
  test(`${lang}: each job's highlights, when present, are a non-empty list of non-blank texts`, () => {
    const { items } = (messages(lang) as { experience: { items: Record<string, unknown>[] } }).experience;
    // Control positivo: se han leído puestos y al menos uno lleva `highlights`.
    expect(items.length).toBeGreaterThan(3);
    expect(items.some((job) => "highlights" in job)).toBe(true);

    for (const job of items) {
      if (!("highlights" in job)) continue;
      const highlights = job.highlights;
      expect(Array.isArray(highlights), `${String(job.company)}: highlights debe ser una lista`).toBe(true);
      expect((highlights as unknown[]).length, `${String(job.company)}: highlights vacío`).toBeGreaterThan(0);
      for (const text of highlights as unknown[]) {
        expect(typeof text === "string" && text.trim().length > 0, `${String(job.company)}: logro en blanco`).toBe(true);
      }
    }
  });
}

// Un porcentaje no se parte entre dos líneas: en español, el espacio entre la cifra y «%» es un espacio de
// no separación (U+00A0); en inglés, el «%» va pegado a la cifra.
test("es: a percentage keeps its number and % together with a no-break space", () => {
  const texts = leafTexts(messages("es"));
  // Control positivo: hay porcentajes escritos con el espacio de no separación.
  expect(texts.filter(({ text }) => /\d\xA0%/.test(text)).length).toBeGreaterThan(0);
  expect(
    texts.filter(({ text }) => /\d[ \t]%/.test(text)).map(({ path }) => path),
    "porcentaje con espacio normal: usa U+00A0 entre la cifra y %",
  ).toEqual([]);
});

test("en: a percentage is written without a space between the number and %", () => {
  const texts = leafTexts(messages("en"));
  // Control positivo: hay porcentajes escritos así.
  expect(texts.filter(({ text }) => /\d%/.test(text)).length).toBeGreaterThan(0);
  expect(
    texts.filter(({ text }) => /\d\s%/.test(text)).map(({ path }) => path),
    "en inglés el % va pegado a la cifra",
  ).toEqual([]);
});

// El rol y la ciudad están escritos una vez (`meta.jobTitle`, `meta.locality`, que usan los datos
// estructurados) y repetidos a mano en otros textos: si cambian, esos textos no pueden quedarse con el
// valor viejo.
for (const lang of ["es", "en"] as const) {
  test(`${lang}: hero.role is «jobTitle · locality» and the image alt text names both`, () => {
    const t = messages(lang) as {
      hero: { role: string };
      meta: { jobTitle: string; locality: string; ogImageAlt: string };
    };
    // Control positivo: se han leído un rol y una ciudad de verdad.
    expect(t.meta.jobTitle.length).toBeGreaterThan(3);
    expect(t.meta.locality.length).toBeGreaterThan(3);

    expect(t.hero.role, "hero.role debe ser `${meta.jobTitle} · ${meta.locality}`").toBe(
      `${t.meta.jobTitle} · ${t.meta.locality}`,
    );
    expect(t.meta.ogImageAlt, "meta.ogImageAlt debe nombrar el rol (meta.jobTitle)").toContain(t.meta.jobTitle);
    expect(t.meta.ogImageAlt, "meta.ogImageAlt debe nombrar la ciudad (meta.locality)").toContain(t.meta.locality);
  });
}

// Una clave cuenta como usada si alguna plantilla (o módulo de src/lib) escribe `t.<ruta>` (p. ej. `t.lab.title`; `t`,
// `es` o `en` son los objetos de textos), o usa un padre suyo como un todo (`t.lab.status[app.status]`,
// `t.hero.note.map(...)`). La ruta tiene que empezar justo tras el objeto: `t.nav.lab` no usa `lab.*`.
const ARRAY_METHODS = "map|filter|find|some|every|forEach|join|slice|length|at";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const usageOf = (path: string[]) =>
  new RegExp(
    `(?<![\\w.])(?:t|es|en)\\.${path.map(escapeRe).join("\\.")}(?![\\w-])(?!\\.(?!(?:${ARRAY_METHODS})\\b)[A-Za-z_])`,
  );

test("every i18n key is used by some template or src/lib module", () => {
  const source = [...astroFiles("src"), ...tsFiles(join("src", "lib"))]
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const keys = new Set(leafPaths(messages("es")).map((p) => p.replace(/\[\d+\]/g, "")));
  expect(keys.size).toBeGreaterThan(40);

  const unused = [...keys].filter((key) => {
    const parts = key.split(".");
    return !parts.some((_, i) => usageOf(parts.slice(0, i + 1)).test(source));
  });
  expect(unused, "claves de i18n que ninguna plantilla ni módulo de src/lib usa").toEqual([]);
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
