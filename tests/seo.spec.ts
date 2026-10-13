import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { serializeJsonLd } from "../src/lib/jsonld";
import { HERO_FOCUS } from "./viewports";

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

/** Los textos de un idioma, tal como están en src/i18n (la fuente de todo lo que se publica). */
const messages = (lang: "es" | "en") => JSON.parse(readFileSync(`src/i18n/${lang}.json`, "utf8"));

/** `og:locale` de cada idioma: el de la página y, como alternativo, el del otro. */
const OG_LOCALE = { es: "es_ES", en: "en_GB" } as const;

// Título y metadatos para redes: el rol en el título, el nombre del sitio, el idioma alternativo y
// la imagen también para Twitter/X, con un texto alternativo que describe la imagen (no la página).
for (const lang of ["es", "en"] as const) {
  const path = lang === "es" ? "/" : "/en/";
  const other = lang === "es" ? "en" : "es";

  test(`${path}: the title carries the role and og:title repeats it`, async ({ page }) => {
    await page.goto(path);
    const title = "Fabrizio Carella · Full Stack Developer · Carellabs";
    await expect(page).toHaveTitle(title);
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", title);
  });

  test(`${path}: og:site_name, the alternate locale and the Twitter image are published`, async ({ page }) => {
    const t = messages(lang);
    await page.goto(path);
    const content = (selector: string) => page.locator(selector).evaluateAll((els) => els.map((e) => e.getAttribute("content")));

    // Una sola etiqueta de cada, con el valor exacto.
    expect(await content('meta[property="og:site_name"]')).toEqual([t.site.brand]);
    expect(await content('meta[property="og:locale"]')).toEqual([OG_LOCALE[lang]]);
    expect(await content('meta[property="og:locale:alternate"]'), "og:locale:alternate: el del otro idioma").toEqual([
      OG_LOCALE[other],
    ]);
    // La imagen de Twitter/X es la misma URL absoluta que og:image.
    expect(await content('meta[name="twitter:image"]')).toEqual([`${SITE}/og-${lang}.png`]);
    expect(await content('meta[name="twitter:image"]')).toEqual(await content('meta[property="og:image"]'));
    expect(await content('meta[name="twitter:card"]')).toEqual(["summary_large_image"]);
  });

  test(`${path}: the image alt text describes the card, not the page, and is the same for Open Graph and Twitter`, async ({
    page,
  }) => {
    const t = messages(lang);
    await page.goto(path);
    const content = (selector: string) => page.locator(selector).evaluateAll((els) => els.map((e) => e.getAttribute("content")));

    expect(await content('meta[property="og:image:alt"]')).toEqual([t.meta.ogImageAlt]);
    expect(await content('meta[name="twitter:image:alt"]')).toEqual([t.meta.ogImageAlt]);
    // No repite la descripción de la página y sí nombra lo que la imagen enseña (nombre y marca).
    expect(t.meta.ogImageAlt).not.toBe(t.meta.description);
    expect(t.meta.ogImageAlt).toContain(t.hero.name);
    expect(t.meta.ogImageAlt).toContain(t.site.brand);
    expect(t.meta.ogImageAlt.length).toBeGreaterThanOrEqual(20);
  });
}

// Datos estructurados: un JSON-LD de schema.org `Person` por página indexable, con los textos de su
// idioma. No es código: la CSP (`default-src 'none'`) no lo bloquea ni hace falta tocarla.
const JSON_LD = 'script[type="application/ld+json"]';
for (const lang of ["es", "en"] as const) {
  const path = lang === "es" ? "/" : "/en/";

  test(`${path}: one JSON-LD Person block, with the texts of the page's language`, async ({ page }) => {
    const t = messages(lang);
    await page.goto(path);
    const blocks = page.locator(JSON_LD);
    await expect(blocks).toHaveCount(1);
    const data = JSON.parse((await blocks.textContent())!);

    // Todos los campos, ni uno más ni uno menos, con los textos de i18n de este idioma.
    expect(data).toEqual({
      "@context": "https://schema.org",
      "@type": "Person",
      name: t.hero.name,
      jobTitle: t.meta.jobTitle,
      url: lang === "es" ? `${SITE}/` : `${SITE}/en/`,
      sameAs: t.contact.links.map((link: { href: string }) => link.href),
      address: { "@type": "PostalAddress", addressLocality: t.meta.locality, addressCountry: "ES" },
      knowsAbout: t.hero.note,
    });

    // Anclas que no dependen de los JSON de i18n: lo que de verdad se quiere publicar.
    expect(data.name).toBe("Fabrizio Carella");
    expect(data.jobTitle).toBe("Full Stack Developer");
    expect(data.sameAs).toEqual(["https://www.linkedin.com/in/fabriziocarella", "https://github.com/carellabs"]);
    expect(data.address).toEqual({ "@type": "PostalAddress", addressLocality: "Madrid", addressCountry: "ES" });
    expect(data.knowsAbout).toEqual([...HERO_FOCUS[lang].items]);

    // La URL es la canónica de la página, y los perfiles, los enlaces de contacto que se ven.
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", data.url);
    const visible = await page.locator("#contacto .links a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    expect(visible).toEqual(data.sameAs);
  });
}

test("the 404 page has no JSON-LD", async ({ page }) => {
  // Control positivo: el mismo selector sí encuentra el bloque en una página indexable.
  await page.goto("/");
  await expect(page.locator(JSON_LD)).toHaveCount(1);

  const res = await page.goto("/no-existe");
  expect(res?.status()).toBe(404);
  await expect(page.locator(JSON_LD)).toHaveCount(0);
  await expect(page.locator("script")).toHaveCount(0);
});

test("serializeJsonLd escapes `<` so that no text can close the <script> tag", () => {
  const data = { name: "</script><script>alert(1)</script>", note: "<!-- x", list: ["a<b", "ok"] };
  const out = serializeJsonLd(data);
  expect(out).not.toContain("<");
  expect(out).toContain("\\u003c/script>");
  // El navegador lo lee de vuelta tal cual: el escape no cambia los datos.
  expect(JSON.parse(out)).toEqual(data);
  // Control positivo: sin `<` la salida es exactamente `JSON.stringify`.
  expect(serializeJsonLd({ a: ["b", 1], c: { d: null } })).toBe('{"a":["b",1],"c":{"d":null}}');
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
