import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { personJsonLd, serializeJsonLd } from "../src/lib/jsonld";
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
      "@id": `${SITE}/#person`,
      name: t.hero.name,
      jobTitle: t.meta.jobTitle,
      url: lang === "es" ? `${SITE}/` : `${SITE}/en/`,
      sameAs: t.contact.links.map((link: { href: string }) => link.href),
      address: { "@type": "PostalAddress", addressLocality: t.meta.locality, addressCountry: "ES" },
      knowsAbout: t.hero.note,
    });

    // Anclas que no dependen de los JSON de i18n: lo que de verdad se quiere publicar.
    expect(data["@id"]).toBe("https://carellabs.com/#person");
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

// El layout no monta ni serializa el JSON-LD a mano: llama a `personJsonLd`, que ya devuelve el texto
// escapado. Así ningún cambio en la plantilla puede saltarse el escape de `<`.
test("personJsonLd escapes hostile texts in every field: no `<` in the output and the texts come back intact", () => {
  const hostile = {
    hero: { name: "</script><b>Eve</b>", note: ["<!-- a", "</SCRIPT >", "ok"] },
    meta: { jobTitle: "<!--", locality: "</ScRiPt ><script>alert(1)</script>" },
    contact: { links: [{ href: "https://a.test/</script>" }, { href: "https://b.test/<!--x" }] },
  };
  const out = personJsonLd(hostile, new URL("https://example.test/en/"));
  expect(out).not.toContain("<");

  const data = JSON.parse(out);
  expect(data.name).toBe(hostile.hero.name);
  expect(data.knowsAbout).toEqual(hostile.hero.note);
  expect(data.jobTitle).toBe(hostile.meta.jobTitle);
  expect(data.address.addressLocality).toBe(hostile.meta.locality);
  expect(data.sameAs).toEqual(hostile.contact.links.map((link) => link.href));
  // Control positivo: es un Person completo, no un objeto vacío, y la URL es la de la página que se le pasa.
  expect(data["@type"]).toBe("Person");
  expect(data.url).toBe("https://example.test/en/");
});

// Las dos páginas describen a la misma persona: comparten `@id` (el origen del sitio + /#person), que no
// es la URL de ninguna de ellas, para que un buscador las una en una sola entidad.
test("personJsonLd gives the same @id, built from the site origin, to the page of each language", () => {
  const es = JSON.parse(personJsonLd(messages("es"), new URL("https://example.test/")));
  const en = JSON.parse(personJsonLd(messages("en"), new URL("https://example.test/en/")));
  expect(es["@id"]).toBe("https://example.test/#person");
  expect(en["@id"]).toBe(es["@id"]);
  // Control positivo: sí cambia lo que debe cambiar (la URL de cada página) y @id no es ninguna de ellas.
  expect([es.url, en.url]).toEqual(["https://example.test/", "https://example.test/en/"]);
  expect([es.url, en.url]).not.toContain(es["@id"]);
});

for (const lang of ["es", "en"] as const) {
  const [file, canonical] = lang === "es" ? ["index.html", `${SITE}/`] : ["en/index.html", `${SITE}/en/`];

  test(`dist/${file}: the JSON-LD is byte for byte what personJsonLd returns`, () => {
    const html = readFileSync(`dist/${file}`, "utf8");
    const open = '<script type="application/ld+json">';
    const start = html.indexOf(open);
    expect(start, "no hay JSON-LD en el HTML publicado").toBeGreaterThan(-1);
    const end = html.indexOf("</script>", start);
    expect(html.slice(start + open.length, end)).toBe(personJsonLd(messages(lang), new URL(canonical)));
  });
}

test("the templates inject raw HTML only through personJsonLd, never through their own JSON.stringify", () => {
  const files = readdirSync("src", { recursive: true })
    .map((file) => `src/${String(file).replaceAll("\\", "/")}`)
    .filter((file) => file.endsWith(".astro"));
  // Control positivo: se han leído las plantillas y alguna usa `set:html`.
  expect(files.length).toBeGreaterThan(5);
  const injected = files.flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/set:html=[{]([^}]*)[}]/g)].map((m) => ({ file, expression: m[1]!.trim() })),
  );
  expect(injected.length, "ninguna plantilla usa set:html").toBeGreaterThan(0);

  // Todo `set:html` es una llamada a `personJsonLd(...)`: el escape no se puede saltar desde la plantilla.
  for (const { file, expression } of injected) {
    expect(expression, `${file}: set:html debe recibir el resultado de personJsonLd(...)`).toMatch(/^personJsonLd[(]/);
  }
  for (const file of files) {
    expect(readFileSync(file, "utf8"), `${file}: no debe serializar JSON a mano`).not.toContain("JSON.stringify");
  }
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

// Icono para iOS (apple-touch-icon): iOS rellena la transparencia con negro, así que es un PNG de
// 180x180 opaco, con el favicon centrado sobre el fondo oscuro de la marca. Lo genera `npm run icons`.
const ICON = "public/apple-touch-icon.png";
const hex = (color: string) => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
/** El fondo oscuro de la marca: el primer `--bg` de global.css (el de `:root`; el claro va más abajo). */
const brandBackground = () =>
  /--bg:\s*(#[0-9a-f]{6})/i.exec(readFileSync("src/styles/global.css", "utf8"))![1]!.toLowerCase();

for (const path of ["/", "/en/", "/no-existe"]) {
  test(`${path}: links the apple-touch-icon and the site serves it as a PNG`, async ({ page, request }) => {
    await page.goto(path);
    const links = page.locator('link[rel="apple-touch-icon"]');
    await expect(links).toHaveCount(1);
    await expect(links).toHaveAttribute("href", "/apple-touch-icon.png");

    const res = await request.get("/apple-touch-icon.png");
    expect(res.status(), "GET /apple-touch-icon.png").toBe(200);
    expect(res.headers()["content-type"], "GET /apple-touch-icon.png").toMatch(/^image\/png\b/);
  });
}

test("public/apple-touch-icon.png is a 180x180 PNG without an alpha channel", () => {
  const png = readFileSync(ICON);
  expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
  // 8 bits por canal y tipo de color 2 (RGB): los tipos 4 y 6 llevan canal alfa, y iOS lo rellenaría de negro.
  expect(png[24]).toBe(8);
  expect(png[25]).toBe(2);
  // Control positivo: un PNG con canal alfa (aquí uno RGBA de 1x1) tiene otro tipo de color, y el criterio lo distingue.
  const rgba = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  expect(rgba[25], "el PNG de control debería ser RGBA").toBe(6);
});

test("the icon is the favicon centred on an opaque brand background", async ({ page }) => {
  const [r, g, b] = hex(brandBackground());
  await page.goto("/");
  const icon = await page.evaluate(async () => {
    const blob = await (await fetch("/apple-touch-icon.png")).blob();
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none" });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { data: Array.from(data), width, height };
  });
  expect([icon.width, icon.height]).toEqual([180, 180]);
  const at = (x: number, y: number) => (y * icon.width + x) * 4;
  const pixel = (x: number, y: number) => icon.data.slice(at(x, y), at(x, y) + 4);

  // Opaco de punta a punta, y las cuatro esquinas (donde iOS recorta) del fondo de la marca.
  expect(icon.data.filter((_, i) => i % 4 === 3).every((alpha) => alpha === 255), "hay píxeles transparentes").toBe(
    true,
  );
  for (const [x, y] of [[0, 0], [179, 0], [0, 179], [179, 179]] as const) {
    expect(pixel(x, y), `esquina (${x}, ${y})`).toEqual([r, g, b, 255]);
  }

  // Lo dibujado es la marca: el trazo claro y la barra ámbar del favicon están, con sus colores exactos.
  const has = (color: number[]) => {
    for (let i = 0; i < icon.data.length; i += 4) if (color.every((c, k) => icon.data[i + k] === c)) return true;
    return false;
  };
  expect(has(hex("#f2b13a")), "falta el ámbar de la marca").toBe(true);
  expect(has(hex("#ededea")), "falta el trazo claro de la marca").toBe(true);

  // Centrada y con margen: la marca (todo lo que no es fondo) ocupa entre el 40 % y el 50 % del ancho
  // y del alto, y sus márgenes izquierdo/derecho y superior/inferior no difieren en más de 8 px
  // (el favicon, tal cual, deja la marca unas 0,75 de sus 32 unidades a la derecha del centro).
  // Se cuenta como fondo lo que difiere de él en 4 niveles o menos por canal: el favicon lleva su propio
  // cuadrado redondeado del mismo color y el suavizado de sus esquinas deja píxeles 1 nivel más oscuros.
  let [x0, y0, x1, y1] = [icon.width, icon.height, -1, -1];
  for (let y = 0; y < icon.height; y++) {
    for (let x = 0; x < icon.width; x++) {
      const p = pixel(x, y);
      if (Math.max(Math.abs(p[0]! - r!), Math.abs(p[1]! - g!), Math.abs(p[2]! - b!)) > 4) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    }
  }
  const [width, height] = [x1 - x0 + 1, y1 - y0 + 1];
  expect(width / icon.width, "ancho de la marca").toBeGreaterThanOrEqual(0.4);
  expect(width / icon.width, "ancho de la marca").toBeLessThanOrEqual(0.5);
  expect(height / icon.height, "alto de la marca").toBeGreaterThanOrEqual(0.4);
  expect(height / icon.height, "alto de la marca").toBeLessThanOrEqual(0.5);
  expect(Math.abs(x0 - (icon.width - 1 - x1)), "margen izquierdo frente al derecho").toBeLessThanOrEqual(8);
  expect(Math.abs(y0 - (icon.height - 1 - y1)), "margen superior frente al inferior").toBeLessThanOrEqual(8);
});

test("the apple-touch-icon was rendered from the current favicon and brand background (run `npm run icons` after changing them)", () => {
  // Mismo hash que scripts/icons/render.mjs: sha-256 del SVG con los saltos de línea normalizados.
  const svg = readFileSync("public/favicon.svg", "utf8").replaceAll("\r\n", "\n");
  const rendered = JSON.parse(readFileSync("scripts/icons/rendered-from.json", "utf8"));
  expect(rendered, "public/apple-touch-icon.png no refleja public/favicon.svg ni el fondo de src/styles/global.css").toEqual({
    favicon: createHash("sha256").update(svg).digest("hex"),
    background: brandBackground(),
  });
});

test("the build publishes /.well-known/security.txt", () => {
  const txt = readFileSync("dist/.well-known/security.txt", "utf8");
  expect(txt).toContain("Contact: mailto:security@carellabs.com");
});
