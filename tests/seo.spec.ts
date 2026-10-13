import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

// Lo que se publica para los buscadores (dist/ lo deja `astro build` antes de lanzar los tests).
const SITE = "https://carellabs.com";

/** Atributos de una etiqueta `<xhtml:link .../>`, sin depender del orden. */
function attributes(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

test("the sitemap lists both languages and each URL declares the alternates of the other", () => {
  const xml = readFileSync("dist/sitemap-0.xml", "utf8");
  expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');

  const entries = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
  // Control positivo: están las dos páginas, y solo esas (la 404 no se lista).
  const locs = entries.map((e) => /<loc>([^<]*)<\/loc>/.exec(e)?.[1]);
  expect(locs.sort()).toEqual([`${SITE}/`, `${SITE}/en/`]);

  // Alternates ES y EN en cada URL, con los mismos códigos que los <link hreflang> del HTML.
  for (const entry of entries) {
    const links = [...entry.matchAll(/<xhtml:link\b[^>]*>/g)].map((m) => attributes(m[0]));
    expect(links, entry).toHaveLength(2);
    for (const link of links) expect(link.rel).toBe("alternate");
    expect(Object.fromEntries(links.map((l) => [l.hreflang, l.href]))).toEqual({
      es: `${SITE}/`,
      en: `${SITE}/en/`,
    });
  }
});

/** Grupos de robots.txt: líneas `User-agent` seguidas y las reglas que vienen detrás. */
function robotsGroups(text: string): { agents: string[]; rules: string[] }[] {
  const groups: { agents: string[]; rules: string[] }[] = [];
  let current: { agents: string[]; rules: string[] } | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (key!.toLowerCase() === "user-agent") {
      if (!current || current.rules.length > 0) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
    } else if (current && key!.toLowerCase() !== "sitemap") {
      current.rules.push(`${key!.toLowerCase()}: ${value}`);
    }
  }
  return groups;
}

// Rastreadores que recogen contenido para entrenar modelos de IA (los textos tienen todos los
// derechos reservados, ver NOTICE). Los buscadores y los de búsqueda con IA siguen entrando.
const AI_TRAINING_CRAWLERS = [
  "GPTBot",
  "ClaudeBot",
  "anthropic-ai",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
  "Bytespider",
  "meta-externalagent",
  "cohere-training-data-crawler",
  "Diffbot",
  "MistralAI-Training",
  "cohere-ai",
  "omgili",
  "Claude-Web",
];

test("robots.txt keeps search engines in and AI training crawlers out", () => {
  const groups = robotsGroups(readFileSync("dist/robots.txt", "utf8"));
  const groupOf = (agent: string) => groups.find((g) => g.agents.includes(agent.toLowerCase()));

  // Control positivo: hay un grupo general, y deja entrar a todos.
  const all = groupOf("*");
  expect(all, "falta el grupo `User-agent: *`").toBeDefined();
  expect(all!.rules).toContain("allow: /");
  expect(all!.rules).not.toContain("disallow: /");

  for (const crawler of AI_TRAINING_CRAWLERS) {
    expect(groupOf(crawler)?.rules, `${crawler} no tiene \`Disallow: /\``).toContain("disallow: /");
  }
  // Los buscadores no tienen grupo propio: usan el general, que los deja entrar.
  for (const engine of ["Googlebot", "Bingbot"]) {
    expect(groupOf(engine), `${engine} no debe tener un grupo que lo bloquee`).toBeUndefined();
  }
});

// Lighthouse (check obligatorio del CI) da el robots.txt por no válido ante una directiva que no
// conoce, como `Content-Signal`, y la nota de SEO baja de 1. Solo las directivas estándar.
test("robots.txt only uses standard directives (Lighthouse rejects unknown ones)", () => {
  const directives = readFileSync("dist/robots.txt", "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean)
    .map((line) => line.split(":")[0]!.trim().toLowerCase());
  // Control positivo: se han leído directivas de verdad.
  expect(directives).toContain("user-agent");
  expect(directives.filter((d) => !["user-agent", "allow", "disallow", "sitemap"].includes(d))).toEqual([]);
});

test("robots.txt points to the sitemap index, which points to the sitemap", () => {
  const robots = readFileSync("dist/robots.txt", "utf8");
  expect(robots).toMatch(new RegExp(`^Sitemap: ${SITE}/sitemap-index\\.xml\\s*$`, "m"));
  const index = readFileSync("dist/sitemap-index.xml", "utf8");
  expect(index).toContain(`<loc>${SITE}/sitemap-0.xml</loc>`);
});

// Imagen de previsualización en redes: una por idioma, con el titular de cada uno
// (las genera `npm run og` a partir de src/i18n/*.json).
for (const lang of ["es", "en"] as const) {
  const path = lang === "es" ? "/" : "/en/";

  test(`${path}: og:image is the ${lang} preview with its size and alt text`, async ({ page }) => {
    await page.goto(path);
    const meta = (property: string) => page.locator(`meta[property="${property}"]`).getAttribute("content");
    expect(await meta("og:image")).toBe(`${SITE}/og-${lang}.png`);
    expect(await meta("og:image:width")).toBe("1200");
    expect(await meta("og:image:height")).toBe("630");
    expect(await meta("og:image:alt")).toMatch(/.{20,}/);
  });

  test(`public/og-${lang}.png is a 1200x630 PNG`, () => {
    const png = readFileSync(`public/og-${lang}.png`);
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  });
}

test("the OG images were rendered from the current hero texts (run `npm run og` after changing them)", () => {
  const rendered = JSON.parse(readFileSync("scripts/og/rendered-from.json", "utf8"));
  for (const lang of ["es", "en"]) {
    const t = JSON.parse(readFileSync(`src/i18n/${lang}.json`, "utf8"));
    expect(rendered[lang], `public/og-${lang}.png no refleja los textos actuales`).toEqual({
      brand: t.site.brand,
      headline: t.hero.headline,
      name: t.hero.name,
      role: t.hero.role,
    });
  }
});

test("the build publishes /.well-known/security.txt", () => {
  const txt = readFileSync("dist/.well-known/security.txt", "utf8");
  expect(txt).toContain("Contact: mailto:security@carellabs.com");
});
