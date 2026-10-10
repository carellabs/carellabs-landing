// Guardas de la configuración del repositorio (workflows, ruleset, plantilla de PR, skill).
// Sin dependencias: se lee el texto de los ficheros. Cada test fija una decisión que, si
// alguien la deshace sin querer, no la detectaría ningún otro test.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluatePr } from "./pr-policy.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const workflows = () =>
  readdirSync(join(ROOT, ".github", "workflows"))
    .filter((f) => f.endsWith(".yml"))
    .sort();

/** Checks que exige el ruleset de `main`. */
const REQUIRED_CHECKS = ["test", "lighthouse", "pr-policy"];

/** Id de la app GitHub Actions (https://api.github.com/apps/github-actions). */
const GITHUB_ACTIONS_APP_ID = 15368;

/**
 * Trocea un workflow en sus jobs: `{ id: texto del bloque }`.
 * @param {string} text
 * @returns {Record<string, string>}
 */
function jobsOf(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === "jobs:");
  assert.ok(start >= 0, "el workflow no tiene `jobs:`");
  const jobs = {};
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (key) {
      current = key[1];
      jobs[current] = "";
    } else if (current) {
      jobs[current] += line + "\n";
    }
  }
  return jobs;
}

/** Nombre visible de un job (su `name:` si lo tiene; si no, su id). */
function checkName(id, block) {
  return /^ {4}name:\s*(.+?)\s*$/m.exec(block)?.[1] ?? id;
}

describe("workflows: acciones", () => {
  test("toda acción de terceros está fijada a un SHA de 40 caracteres, con su versión en un comentario", () => {
    const usos = [];
    for (const file of workflows()) {
      for (const line of read(`.github/workflows/${file}`).split("\n")) {
        const m = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/.exec(line);
        if (m) usos.push({ file, ref: m[1], resto: m[2] });
      }
    }
    // Control positivo: se han encontrado acciones que comprobar.
    assert.ok(usos.length >= 8, `solo ${usos.length} usos de acciones`);
    for (const { file, ref, resto } of usos) {
      assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${file}: ${ref} no está fijada a un SHA`);
      assert.match(resto, /^\s+#\s*v?\d/, `${file}: ${ref} no lleva su versión en un comentario`);
    }
  });

  test("checkout, setup-node y upload-artifact usan la misma versión en todos los workflows", () => {
    const porAccion = new Map();
    for (const file of workflows()) {
      for (const m of read(`.github/workflows/${file}`).matchAll(
        /uses:\s*(actions\/(?:checkout|setup-node|upload-artifact))@([0-9a-f]{40})/g,
      )) {
        if (!porAccion.has(m[1])) porAccion.set(m[1], new Set());
        porAccion.get(m[1]).add(m[2]);
      }
    }
    assert.deepEqual([...porAccion.keys()].sort(), [
      "actions/checkout",
      "actions/setup-node",
      "actions/upload-artifact",
    ]);
    for (const [accion, shas] of porAccion) {
      assert.equal(shas.size, 1, `${accion} aparece con ${shas.size} SHA distintos`);
    }
  });

  test("todos los checkout de los workflows siguen sin persistir credenciales", () => {
    for (const file of workflows()) {
      const text = read(`.github/workflows/${file}`);
      const checkouts = [...text.matchAll(/uses:\s*actions\/checkout@/g)].length;
      const sinPersistir = [...text.matchAll(/persist-credentials:\s*false/g)].length;
      assert.equal(sinPersistir, checkouts, `${file}: algún checkout persiste credenciales`);
    }
  });
});

describe("ci.yml", () => {
  const ci = () => read(".github/workflows/ci.yml");

  test("la concurrencia agrupa por rama solo en PR y por commit en main; solo cancela en PR", () => {
    const text = ci();
    assert.ok(
      text.includes(
        `group: "\${{ github.workflow }}-\${{ github.event_name == 'pull_request' && github.ref || github.sha }}"`,
      ),
      "el grupo de concurrencia no es el esperado",
    );
    assert.ok(
      text.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}"),
      "cancel-in-progress no depende del evento",
    );
  });

  test("el check obligatorio audita solo producción en nivel high", () => {
    const m = [...ci().matchAll(/run:\s*(npm audit.*)$/gm)].map((x) => x[1].trim());
    assert.deepEqual(m, ["npm audit --omit=dev --audit-level=high"]);
  });

  test("el artefacto de fallos se llama como lo que contiene", () => {
    const text = ci();
    assert.match(text, /name:\s*playwright-test-results\b/);
    assert.match(text, /path:\s*test-results\/\s*$/m);
    assert.doesNotMatch(text, /name:\s*playwright-report\b/);
  });

  test("los jobs obligatorios existen con el nombre que exige el ruleset", () => {
    const jobs = jobsOf(ci());
    assert.ok("test" in jobs && "lighthouse" in jobs, Object.keys(jobs).join(", "));
    assert.equal(checkName("test", jobs.test), "test");
    assert.equal(checkName("lighthouse", jobs.lighthouse), "lighthouse");
  });
});

describe("audit.yml", () => {
  const audit = () => read(".github/workflows/audit.yml");

  test("es semanal (lunes) y manual, de solo lectura", () => {
    const text = audit();
    assert.match(text, /schedule:\s*\n\s*-\s*cron:\s*"[^"]*\* \* 1"/);
    assert.match(text, /^\s{2}workflow_dispatch:/m);
    assert.match(text, /^permissions:\s*\n\s{2}contents:\s*read\s*$/m);
    assert.doesNotMatch(text, /:\s*write\b/);
    assert.doesNotMatch(text, /^\s{2}(push|pull_request):/m);
  });

  test("audita todo (producción y desarrollo)", () => {
    const text = audit();
    assert.match(text, /run:\s*npm ci\b/);
    assert.match(text, /run:\s*npm audit --audit-level=high\s*$/m);
    assert.doesNotMatch(text, /--omit/);
  });

  test("ninguno de sus jobs puede confundirse con un check obligatorio", () => {
    const jobs = jobsOf(audit());
    assert.ok(Object.keys(jobs).length >= 1);
    for (const [id, block] of Object.entries(jobs)) {
      assert.ok(!REQUIRED_CHECKS.includes(id), `el job ${id} se llama como un check obligatorio`);
      assert.ok(
        !REQUIRED_CHECKS.includes(checkName(id, block)),
        `el job ${id} se muestra como un check obligatorio`,
      );
    }
  });

  test("usa la versión de Node del repositorio", () => {
    assert.match(audit(), /node-version-file:\s*\.nvmrc/);
  });
});

describe("pr-policy.yml: privilegio mínimo", () => {
  const text = () => read(".github/workflows/pr-policy.yml");

  test("el workflow no concede nada por defecto", () => {
    assert.match(text(), /^permissions:\s*\{\}\s*$/m);
  });

  test("hay dos jobs: el obligatorio `pr-policy` y `label`", () => {
    assert.deepEqual(Object.keys(jobsOf(text())).sort(), ["label", "pr-policy"]);
    const jobs = jobsOf(text());
    assert.equal(checkName("pr-policy", jobs["pr-policy"]), "pr-policy");
  });

  test("`pr-policy` ejecuta el script con un token de solo lectura y expone la etiqueta", () => {
    const job = jobsOf(text())["pr-policy"];
    assert.match(job, /permissions:\s*\n\s+contents:\s*read\s*\n/);
    assert.doesNotMatch(job, /:\s*write\b/);
    assert.match(job, /outputs:\s*\n\s+label:\s*\$\{\{\s*steps\.policy\.outputs\.label\s*\}\}/);
    assert.match(job, /run:\s*node \.github\/scripts\/pr-policy\.mjs/);
  });

  test("`label` es el único con escritura, no hace checkout y depende de `pr-policy`", () => {
    const job = jobsOf(text()).label;
    assert.match(job, /needs:\s*pr-policy\s*$/m);
    assert.match(job, /permissions:\s*\n\s+pull-requests:\s*write\s*\n/);
    assert.doesNotMatch(job, /contents:/);
    assert.doesNotMatch(job, /actions\/checkout/);
    assert.doesNotMatch(job, /actions\/setup-node/);
    assert.doesNotMatch(job, /^\s*(?:-\s*)?run:\s*node\b/m, "no ejecuta código del repositorio");
    // Corre aunque `pr-policy` falle, y conserva las exclusiones de Dependabot y forks.
    // (se mira solo la expresión `if:`, no los comentarios que la explican)
    const condicion = /^\s{4}if:\s*>-\s*\n((?:\s{6}.*\n)+)/m.exec(job)?.[1] ?? "";
    assert.ok(condicion.length > 0, "no se encontró la condición `if:` del job");
    assert.match(condicion, /^\s*\$\{\{\s*!cancelled\(\)/);
    assert.match(condicion, /needs\.pr-policy\.outputs\.label != ''/);
    assert.match(condicion, /github\.actor != 'dependabot\[bot\]'/);
    assert.match(condicion, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  });

  test("`label` recibe etiqueta, número y repositorio solo por `env:`, nunca dentro de `run:`", () => {
    const job = jobsOf(text()).label;
    const run = job.slice(job.indexOf("run: |"));
    assert.ok(run.length > 10, "no se encontró el bloque run");
    assert.doesNotMatch(run, /\$\{\{/, "una expresión ${{ }} dentro de run:");
    assert.match(job, /LABEL:\s*\$\{\{\s*needs\.pr-policy\.outputs\.label\s*\}\}/);
    assert.match(job, /PR_NUMBER:\s*\$\{\{\s*github\.event\.pull_request\.number\s*\}\}/);
  });

  test("el título y el cuerpo del PR solo llegan al script por `env:`", () => {
    const job = jobsOf(text())["pr-policy"];
    const run = job.slice(job.indexOf("run: node"));
    assert.doesNotMatch(run.split("\n")[0], /\$\{\{/);
    assert.match(job, /PR_TITLE:\s*\$\{\{\s*github\.event\.pull_request\.title\s*\}\}/);
    assert.match(job, /PR_BODY:\s*\$\{\{\s*github\.event\.pull_request\.body\s*\}\}/);
  });

  test("la lista cerrada de etiquetas de `label` es exactamente la que produce pr-policy.mjs", () => {
    const job = jobsOf(text()).label;
    const caso = /case "\$LABEL" in\s*\n\s*([^)]+)\)/.exec(job);
    assert.ok(caso, "no hay `case` con la lista cerrada de etiquetas");
    const enWorkflow = caso[1].trim().split("|").sort();

    const tipos = ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"];
    const producidas = new Set();
    for (const tipo of tipos) {
      for (const bang of ["", "!"]) {
        const r = evaluatePr({ title: `${tipo}${bang}: algo`, body: "Closes #1" });
        assert.ok(r.label, `${tipo}${bang} no produjo etiqueta`);
        producidas.add(r.label);
      }
    }
    assert.deepEqual(enWorkflow, [...producidas].sort());
  });
});

describe("ruleset de main", () => {
  const ruleset = () => JSON.parse(read(".claude/skills/carellabs-github/assets/ruleset-main.json"));
  const statusChecks = () =>
    ruleset().rules.find((r) => r.type === "required_status_checks").parameters.required_status_checks;

  test("exige exactamente test, lighthouse y pr-policy", () => {
    assert.deepEqual(statusChecks().map((c) => c.context).sort(), [...REQUIRED_CHECKS].sort());
  });

  test("cada check obligatorio debe publicarlo la app GitHub Actions (integration_id)", () => {
    for (const check of statusChecks()) {
      assert.equal(check.integration_id, GITHUB_ACTIONS_APP_ID, `${check.context} sin integration_id correcto`);
    }
  });

  test("cada contexto exigido es el nombre de un job real de los workflows", () => {
    const nombres = new Set();
    for (const file of workflows()) {
      for (const [id, block] of Object.entries(jobsOf(read(`.github/workflows/${file}`)))) {
        nombres.add(checkName(id, block));
      }
    }
    for (const { context } of statusChecks()) {
      assert.ok(nombres.has(context), `ningún job se llama ${context}`);
    }
  });
});

describe("plantilla de PR y skill de GitHub", () => {
  const plantilla = () => read(".github/PULL_REQUEST_TEMPLATE.md");
  const skill = () => read(".claude/skills/carellabs-github/SKILL.md");

  /** Comandos de la sección "Verificación" de la plantilla, en orden. */
  const comandosPlantilla = () => {
    const seccion = /## Verificación\s*\n([\s\S]*?)\n## /.exec(plantilla());
    assert.ok(seccion, "la plantilla no tiene sección Verificación");
    return [...seccion[1].matchAll(/- \[ \] `([^`]+)`/g)].map((m) => m[1]);
  };

  /** Comandos de la regla "Antes de abrir el PR" de la skill, en orden. */
  const comandosSkill = () => {
    const regla = /Antes de abrir el PR[^\n]*/.exec(skill());
    assert.ok(regla, "la skill no tiene la regla 'Antes de abrir el PR'");
    return [...regla[0].matchAll(/`(npm [^`]+)`/g)].map((m) => m[1]);
  };

  test("la plantilla y la skill piden el mismo conjunto de comprobaciones, en el mismo orden", () => {
    assert.deepEqual(comandosSkill(), comandosPlantilla());
  });

  test("ese conjunto incluye lo que corre el CI (check, test:scripts, test, build, audit de producción)", () => {
    assert.deepEqual(comandosPlantilla(), [
      "npm run check",
      "npm run test:scripts",
      "npm test",
      "npm run build",
      "npm audit --omit=dev --audit-level=high",
    ]);
  });

  test("ambas piden solo fuentes autoalojadas y ninguna petición a Google Fonts", () => {
    for (const [nombre, texto] of [["plantilla", plantilla()], ["skill", skill()]]) {
      assert.match(texto, /solo fuentes autoalojadas \(`@fontsource`\)/i, nombre);
      assert.match(texto, /ninguna petición a Google Fonts/i, nombre);
      assert.doesNotMatch(texto, /familia de Google Fonts/i, nombre);
    }
  });

  test("la skill declara la licencia MIT y no usa rayas largas ni medias", () => {
    assert.match(skill(), /^license:\s*"MIT"\s*$/m);
    // (la raya media y la larga se construyen por código para que este fichero no las contenga)
    assert.doesNotMatch(skill(), new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
  });

  test("la skill recuerda la excepción del primer push y apunta al apartado de la guía", () => {
    assert.match(skill(), /commit y push inicial/i);
    assert.match(skill(), /references\/github-setup\.md`? §1/);
    assert.match(read(".claude/skills/carellabs-github/references/github-setup.md"), /^## 1\. /m);
  });

  test("la plantilla sin rellenar no aporta una referencia de cierre válida (ni dentro de sus comentarios)", () => {
    const sinComentarios = plantilla().replace(/<!--[\s\S]*?-->/g, "");
    assert.doesNotMatch(sinComentarios, /\b(close[sd]?|fix(e[sd])?|resolve[sd]?):?\s+#[1-9]\d*\b/i);
    assert.equal(evaluatePr({ title: "feat: algo", body: plantilla() }).ok, false);
  });
});

describe("playwright.config.ts", () => {
  test("los tests levantan su propio preview en el 4322, nunca en el 4321 de `astro dev`", () => {
    const config = read("playwright.config.ts");
    assert.match(config, /^const port = 4322;$/m);
    assert.doesNotMatch(config, /\bport = 4321\b/);
    // El mismo puerto se usa para arrancar el preview y para la URL base de los tests.
    assert.match(config, /npm run preview -- --port \$\{port\}/);
    assert.match(config, /baseURL: `http:\/\/localhost:\$\{port\}`/);
    assert.match(config, /url: `http:\/\/localhost:\$\{port\}`/);
  });
});

describe("ficheros del repositorio", () => {
  test(".gitignore ignora launch.json de Claude", () => {
    assert.match(read(".gitignore"), /^\.claude\/launch\.json\s*$/m);
  });

  test("la licencia es MIT, a nombre de Fabrizio Carella y de 2026", () => {
    const licencia = read("LICENSE");
    assert.match(licencia, /^MIT License\s*$/m);
    assert.match(licencia, /Copyright \(c\) 2026 Fabrizio Carella/);
  });

  test("SECURITY.md indica el correo y desaconseja las issues públicas", () => {
    const s = read("SECURITY.md");
    assert.match(s, /hola@carellabs\.com/);
    assert.match(s, /no abras una issue pública/i);
  });
});

describe("dependabot.yml", () => {
  const text = read(".github/dependabot.yml");

  /** Por ecosistema: nombre, prefijo del commit y grupos. */
  const ecosystems = () =>
    text
      .split(/\n {2}- package-ecosystem: /)
      .slice(1)
      .map((block) => ({
        ecosystem: /^"?([\w-]+)"?/.exec(block)?.[1],
        prefix: /prefix: "([^"]+)"/.exec(block)?.[1],
        groups: [...block.matchAll(/^ {6}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]),
      }));

  test("npm y github-actions tienen prefijo y grupos", () => {
    const found = ecosystems();
    assert.deepEqual(found.map((e) => e.ecosystem).sort(), ["github-actions", "npm"]);
    for (const e of found) {
      assert.ok(e.prefix, `${e.ecosystem}: sin prefijo`);
      assert.ok(e.groups.length > 0, `${e.ecosystem}: sin grupos`);
    }
  });

  test("el título más largo que puede generar Dependabot pasa la política de PR", () => {
    const pkg = JSON.parse(read("package.json"));
    const npmNames = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const actionNames = workflows().flatMap((f) =>
      [...read(join(".github", "workflows", f)).matchAll(/uses:\s*([\w.-]+\/[\w.-]+)@/g)].map((m) => m[1]),
    );
    const longest = (names) => names.reduce((a, b) => (b.length > a.length ? b : a), "");

    for (const { ecosystem, prefix, groups } of ecosystems()) {
      const name = longest(ecosystem === "npm" ? npmNames : actionNames);
      assert.ok(name, `${ecosystem}: no hay dependencias que actualizar`);
      for (const group of groups) {
        // Peor caso: el grupo trae una sola actualización (Dependabot titula
        // "bump X from A to B in the <grupo> group") y las versiones tienen dos dígitos.
        const title = `${prefix}: bump ${name} from 10.10.10 to 10.10.11 in the ${group} group`;
        assert.ok(evaluatePr({ title, body: "" }).ok, `${title.length} caracteres: ${title}`);
      }
    }
  });
});

describe("workflows: eventos", () => {
  /** Claves de primer nivel del bloque `on:`. */
  function triggersOf(text) {
    const lines = text.split("\n");
    const start = lines.findIndex((l) => /^on:\s*$/.test(l));
    assert.ok(start >= 0, "sin bloque `on:`");
    const keys = [];
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line)) break;
      const key = /^ {2}([a-z_]+):/.exec(line);
      if (key) keys.push(key[1]);
    }
    return keys;
  }

  test("ningún workflow usa eventos que ejecuten código del PR con privilegios (pull_request_target, workflow_run)", () => {
    // El privilegio mínimo de pr-policy.yml y ci.yml descansa en usar `pull_request`.
    const allowed = new Set(["pull_request", "push", "schedule", "workflow_dispatch"]);
    for (const file of workflows()) {
      const keys = triggersOf(read(join(".github", "workflows", file)));
      assert.ok(keys.length > 0, `${file}: sin eventos`);
      for (const key of keys) assert.ok(allowed.has(key), `${file}: evento no permitido «${key}»`);
    }
  });

  test("la auditoría programada no cae en el minuto 0 (la hora en punto es la de más carga en Actions)", () => {
    const cron = /cron:\s*"([^"]+)"/.exec(read(".github/workflows/audit.yml"))?.[1];
    assert.ok(cron, "audit.yml sin cron");
    assert.notEqual(cron.split(/\s+/)[0], "0");
  });
});

describe("ficheros del repositorio: avisos legales y seguridad", () => {
  test("SECURITY.md ofrece también el reporte privado de GitHub (no depende solo del correo)", () => {
    assert.match(read("SECURITY.md"), /Report a vulnerability/);
  });

  test("NOTICE deja fuera de la licencia MIT los textos y la marca", () => {
    const notice = read("NOTICE");
    assert.match(notice, /Carellabs/);
    assert.match(notice, /todos los derechos reservados/i);
    assert.match(notice, /MIT/);
  });
});

describe("wrangler.jsonc: Cloudflare Workers con solo assets estáticos", () => {
  /** wrangler.jsonc admite comentarios de línea y comas finales: se quitan antes de parsear. */
  const config = () =>
    JSON.parse(
      read("wrangler.jsonc")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/,(\s*[}\]])/g, "$1"),
    );

  test("sirve dist/ con la 404 propia (estado 404) y la barra final automática de las rutas", () => {
    const c = config();
    assert.equal(c.name, "carellabs-landing");
    assert.match(c.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(c.assets.directory, "./dist");
    assert.equal(c.assets.not_found_handling, "404-page");
    assert.equal(c.assets.html_handling, "auto-trailing-slash");
  });

  test("no hay código Worker: con `main`, Cloudflare no aplicaría public/_headers (CSP y caché) a sus respuestas", () => {
    const c = config();
    assert.equal("main" in c, false, "wrangler.jsonc no debe declarar `main`");
    assert.equal("binding" in c.assets, false, "sin Worker no hay binding de assets");
  });

  test("wrangler no envía telemetría (coherente con «sin rastreadores»)", () => {
    assert.equal(config().send_metrics, false);
  });

  test("producción se sirve en carellabs.com (Custom Domain) y no en workers.dev", () => {
    const c = config();
    assert.deepEqual(c.routes, [{ pattern: "carellabs.com", custom_domain: true }]);
    assert.equal(c.workers_dev, false);
  });

  test("cada rama de PR tiene su URL de vista previa", () => {
    assert.equal(config().preview_urls, true);
  });

  test("wrangler está en devDependencies (el despliegue usa la versión del lockfile, no la última)", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.ok(pkg.devDependencies?.wrangler, "falta wrangler en devDependencies");
    assert.equal(pkg.dependencies?.wrangler, undefined, "wrangler no debe ir en dependencies");
  });
});
