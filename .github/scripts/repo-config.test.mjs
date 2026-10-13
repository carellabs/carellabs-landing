// Guardas de la configuración del repositorio (workflows, ruleset, plantilla de PR, skill).
// Sin dependencias: se lee el texto de los ficheros. Cada test fija una decisión que, si
// alguien la deshace sin querer, no la detectaría ningún otro test.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluatePr, stripHtmlComments } from "./pr-policy.mjs";

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

/**
 * Claves de primer nivel del bloque `on:` de un workflow.
 * @param {string} text
 * @returns {string[]}
 */
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
    const sinComentarios = stripHtmlComments(plantilla());
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

  test(".gitignore ignora la carpeta local de wrangler (.wrangler/)", () => {
    assert.match(read(".gitignore"), /^\.wrangler\/\s*$/m);
  });

  test(".nvmrc y engines.node (package.json y lockfile) piden la misma versión de Node", () => {
    const nvmrc = read(".nvmrc").trim();
    // Control positivo: .nvmrc es una versión exacta (el CI y Workers Builds la leen tal cual).
    assert.match(nvmrc, /^\d+\.\d+\.\d+$/);
    assert.equal(JSON.parse(read("package.json")).engines?.node, `>=${nvmrc}`);
    assert.equal(JSON.parse(read("package-lock.json")).packages[""].engines?.node, `>=${nvmrc}`);
  });

  test("la licencia es MIT, a nombre de Fabrizio Carella y de 2026", () => {
    const licencia = read("LICENSE");
    assert.match(licencia, /^MIT License\s*$/m);
    assert.match(licencia, /Copyright \(c\) 2026 Fabrizio Carella/);
  });

  test("SECURITY.md indica el correo de seguridad y desaconseja las issues públicas", () => {
    const s = read("SECURITY.md");
    assert.match(s, /security@carellabs\.com/);
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

describe("codeql.yml: análisis de código como workflow (configuración avanzada)", () => {
  const FILE = ".github/workflows/codeql.yml";
  /** El texto del workflow, sin las líneas de comentario (para no confundir una explicación con una regla). */
  const codeql = () => {
    assert.ok(workflows().includes("codeql.yml"), `falta ${FILE}`);
    return read(FILE).replace(/^\s*#.*$/gm, "");
  };
  const cron = (file) => {
    assert.ok(workflows().includes(file.split("/").pop()), `falta ${file}`);
    return /cron:\s*"([^"]+)"/.exec(read(file))?.[1];
  };

  test("analiza actions y javascript-typescript, cada uno con su categoría, sin compilar", () => {
    const text = codeql();
    const lista = /^\s+language:\s*\[([^\]]*)\]\s*$/m.exec(text)?.[1];
    assert.ok(lista, "sin matriz `language`");
    assert.deepEqual(
      lista.split(",").map((l) => l.trim()).sort(),
      ["actions", "javascript-typescript"],
    );
    assert.match(text, /^\s+languages:\s*\$\{\{\s*matrix\.language\s*\}\}\s*$/m);
    assert.match(text, /^\s+build-mode:\s*none\s*$/m);
    assert.match(text, /^\s+category:\s*"\/language:\$\{\{\s*matrix\.language\s*\}\}"\s*$/m);
    // Si un lenguaje falla, el otro termina igualmente su análisis.
    assert.match(text, /^\s+fail-fast:\s*false\s*$/m);
  });

  test("se ejecuta en pull_request y push (a main) y en un cron semanal, y en nada más", () => {
    const text = codeql();
    assert.deepEqual(triggersOf(text).sort(), ["pull_request", "push", "schedule"]);
    assert.match(text, /^ {2}push:\s*\n\s+branches:\s*\[main\]\s*$/m);
    assert.match(text, /^ {2}pull_request:\s*\n\s+branches:\s*\[main\]\s*$/m);
    assert.match(text, /^ {4}-\s*cron:\s*"[^"]+"/m);
  });

  test("el cron no cae en el minuto 0 y no coincide con el de audit.yml", () => {
    const mio = cron(FILE);
    const auditoria = cron(".github/workflows/audit.yml");
    assert.ok(mio, "codeql.yml sin cron");
    assert.ok(auditoria, "audit.yml sin cron");
    assert.match(mio, /^\d+ \d+ \* \* [0-6]$/, "debe ser semanal (un día de la semana)");
    assert.notEqual(mio.split(/\s+/)[0], "0", "el minuto 0 es el de más carga en Actions");
    assert.notEqual(mio, auditoria);
  });

  test("el workflow es de solo lectura y únicamente su job escribe en security-events", () => {
    const text = codeql();
    const nivelWorkflow = /^permissions:\s*\n((?: {2}\S.*\n)+)/m.exec(text)?.[1];
    assert.equal(nivelWorkflow, "  contents: read\n");

    const jobs = jobsOf(text);
    assert.deepEqual(Object.keys(jobs), ["analyze"]);
    assert.match(
      jobs.analyze,
      /^ {4}permissions:\s*\n {6}contents:\s*read\s*\n {6}security-events:\s*write\s*\n(?! {6}\S)/m,
    );
    // Es la única escritura de todo el fichero.
    assert.equal([...text.matchAll(/:\s*write\b/g)].length, 1);
    assert.equal([...text.matchAll(/security-events:\s*write/g)].length, 1);
  });

  test("init y analyze usan la misma versión fijada de codeql-action, en ese orden", () => {
    const usos = [...codeql().matchAll(/uses:\s*github\/codeql-action\/(\w+)@([0-9a-f]{40})\s+#\s*v?(\d[\w.]*)/g)];
    assert.deepEqual(usos.map((m) => m[1]), ["init", "analyze"]);
    assert.equal(new Set(usos.map((m) => m[2])).size, 1, "init y analyze con SHA distintos");
    assert.equal(new Set(usos.map((m) => m[3])).size, 1, "init y analyze con versiones distintas");
  });

  test("tiene la misma concurrencia que ci.yml y un límite de tiempo", () => {
    const bloque = (t) => /^concurrency:\s*\n((?: {2}\S.*\n)+)/m.exec(t)?.[1];
    assert.ok(bloque(codeql()), "sin bloque `concurrency:`");
    assert.equal(bloque(codeql()), bloque(read(".github/workflows/ci.yml").replace(/^\s*#.*$/gm, "")));
    assert.match(jobsOf(codeql()).analyze, /^ {4}timeout-minutes:\s*\d+\s*$/m);
  });

  test("es informativo: ningún job suyo se llama como un check obligatorio y el ruleset no lo exige", () => {
    for (const [id, block] of Object.entries(jobsOf(codeql()))) {
      assert.ok(!REQUIRED_CHECKS.includes(id), `el job ${id} se llama como un check obligatorio`);
      assert.ok(!REQUIRED_CHECKS.includes(checkName(id, block)), `el job ${id} se muestra como un check obligatorio`);
    }
    const ruleset = JSON.parse(read(".claude/skills/carellabs-github/assets/ruleset-main.json"));
    const exigidos = ruleset.rules
      .find((r) => r.type === "required_status_checks")
      .parameters.required_status_checks.map((c) => c.context);
    assert.deepEqual(exigidos.sort(), [...REQUIRED_CHECKS].sort());
    assert.ok(!exigidos.some((c) => /analy|codeql/i.test(c)), "el ruleset exige un check de CodeQL");
  });
});

describe("prod-check.yml: comprobación de producción (informativa, no bloquea la fusión)", () => {
  const FILE = ".github/workflows/prod-check.yml";
  /** El texto del workflow, sin las líneas de comentario (para no confundir una explicación con una regla). */
  const prodCheck = () => {
    assert.ok(workflows().includes("prod-check.yml"), `falta ${FILE}`);
    return read(FILE).replace(/^\s*#.*$/gm, "");
  };
  const cronDe = (file) => {
    assert.ok(workflows().includes(file.split("/").pop()), `falta ${file}`);
    return /cron:\s*"([^"]+)"/.exec(read(file))?.[1];
  };
  /** Los pasos del job, cada uno como su texto (sin el «- » inicial). */
  const pasos = (job) => job.split(/\n {6}- /).slice(1);

  test("el workflow se llama «Producción» y tiene un único job, «produccion»", () => {
    const text = prodCheck();
    assert.match(text, /^name:\s*Producción\s*$/m);
    const jobs = jobsOf(text);
    assert.deepEqual(Object.keys(jobs), ["produccion"]);
    assert.equal(checkName("produccion", jobs.produccion), "produccion");
  });

  test("se ejecuta en push a main, en un cron diario y a mano, y en nada más", () => {
    const text = prodCheck();
    assert.deepEqual(triggersOf(text).sort(), ["push", "schedule", "workflow_dispatch"]);
    assert.match(text, /^ {2}push:\s*\n\s+branches:\s*\[main\]\s*$/m);
    assert.match(text, /^ {4}-\s*cron:\s*"[^"]+"/m);
    assert.match(text, /^ {2}workflow_dispatch:\s*$/m);
    // Sin entradas manuales: nada que interpolar en un `run:`.
    assert.doesNotMatch(text, /^\s+inputs:/m);
  });

  test("el cron es diario, no cae en el minuto 0 y no coincide con los de audit.yml y codeql.yml", () => {
    const mio = cronDe(FILE);
    assert.ok(mio, "prod-check.yml sin cron");
    assert.match(mio, /^\d+ \d+ \* \* \*$/, "debe ser diario (todos los días)");
    assert.notEqual(mio.split(/\s+/)[0], "0", "el minuto 0 es el de más carga en Actions");
    for (const otro of [".github/workflows/audit.yml", ".github/workflows/codeql.yml"]) {
      assert.ok(cronDe(otro), `${otro} sin cron`);
      assert.notEqual(mio, cronDe(otro));
    }
  });

  test("es de solo lectura: contents: read a nivel de workflow, ningún permiso en el job y ninguna escritura", () => {
    const text = prodCheck();
    const nivelWorkflow = /^permissions:\s*\n((?: {2}\S.*\n)+)/m.exec(text)?.[1];
    assert.equal(nivelWorkflow, "  contents: read\n");
    assert.doesNotMatch(jobsOf(text).produccion, /^\s+permissions:/m, "el job no debe tocar los permisos");
    assert.doesNotMatch(text, /:\s*write\b/);
  });

  test("no abre issues ni usa secretos ni la CLI de GitHub: si falla, avisa GitHub por correo", () => {
    const text = prodCheck();
    assert.doesNotMatch(text, /\bgh\s/);
    assert.doesNotMatch(text, /\bissues\b/i);
    assert.doesNotMatch(text, /\bsecrets\./);
    assert.doesNotMatch(text, /GITHUB_TOKEN/);
  });

  test("solo usa checkout y setup-node (fijados por SHA), con la versión de Node del repositorio y sin credenciales persistidas", () => {
    const text = prodCheck();
    const usos = [...text.matchAll(/uses:\s*([\w.-]+\/[\w./-]+)@([0-9a-f]{40})/g)].map((m) => m[1]);
    assert.deepEqual(usos, ["actions/checkout", "actions/setup-node"]);
    assert.match(text, /persist-credentials:\s*false/);
    assert.match(text, /node-version-file:\s*\.nvmrc/);
    assert.match(text, /cache:\s*npm/);
  });

  test("instala, construye y solo entonces comprueba (el build es el del mismo commit)", () => {
    const job = jobsOf(prodCheck()).produccion;
    const posicion = (re) => {
      const i = job.search(re);
      assert.ok(i >= 0, `no se encontró ${re}`);
      return i;
    };
    assert.ok(posicion(/run:\s*npm ci\s*$/m) < posicion(/run:\s*npm run build\s*$/m));
    assert.ok(posicion(/run:\s*npm run build\s*$/m) < posicion(/prod-check\.mjs/));
  });

  test("solo tras un push a main espera el despliegue (--wait 600); el cron y el disparo manual comprueban sin esperar", () => {
    const comprobaciones = pasos(jobsOf(prodCheck()).produccion).filter((p) => /prod-check\.mjs/.test(p));
    assert.equal(comprobaciones.length, 2);

    const conEspera = comprobaciones.filter((p) => /--wait/.test(p));
    assert.equal(conEspera.length, 1);
    assert.match(conEspera[0], /^ {8}run:\s*node \.github\/scripts\/prod-check\.mjs --wait 600\s*$/m);
    assert.match(conEspera[0], /^ {8}if:\s*github\.event_name == 'push'\s*$/m);

    const sinEspera = comprobaciones.filter((p) => !/--wait/.test(p));
    assert.equal(sinEspera.length, 1);
    assert.match(sinEspera[0], /^ {8}run:\s*node \.github\/scripts\/prod-check\.mjs\s*$/m);
    assert.match(sinEspera[0], /^ {8}if:\s*github\.event_name != 'push'\s*$/m);
  });

  test("en producción solo importa el último despliegue: un grupo por evento y rama, y una ejecución nueva cancela la anterior", () => {
    // Propia de este workflow, no la de ci.yml (que agrupa por commit para que ninguno se quede sin CI):
    // dos pushes seguidos no deben dar un falso fallo del primero, que espera un despliegue ya superado.
    // El evento va en el grupo: el cron o un disparo manual no deben cancelar un push que está esperando
    // el despliegue (su sustituto no espera y podría dar un falso fallo).
    const bloque = /^concurrency:\s*\n((?: {2}\S.*\n)+)/m.exec(prodCheck())?.[1];
    assert.ok(bloque, "sin bloque `concurrency:`");
    assert.equal(
      bloque,
      '  group: "${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}"\n  cancel-in-progress: true\n',
    );
  });

  test("tiene un límite de tiempo mayor que la espera de 10 minutos", () => {
    const minutos = Number(/^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(jobsOf(prodCheck()).produccion)?.[1]);
    assert.ok(minutos > 10 && minutos <= 30, `timeout-minutes=${minutos}`);
  });

  test("no es un check obligatorio: el job no se llama como uno y el ruleset no lo exige", () => {
    for (const [id, block] of Object.entries(jobsOf(prodCheck()))) {
      assert.ok(!REQUIRED_CHECKS.includes(id), `el job ${id} se llama como un check obligatorio`);
      assert.ok(!REQUIRED_CHECKS.includes(checkName(id, block)), `el job ${id} se muestra como un check obligatorio`);
    }
    const ruleset = JSON.parse(read(".claude/skills/carellabs-github/assets/ruleset-main.json"));
    const exigidos = ruleset.rules
      .find((r) => r.type === "required_status_checks")
      .parameters.required_status_checks.map((c) => c.context);
    assert.deepEqual([...exigidos].sort(), [...REQUIRED_CHECKS].sort());
    assert.ok(!exigidos.some((c) => /produc/i.test(c)), "el ruleset exige la comprobación de producción");
  });
});

describe("src/ y astro.config.mjs: el build es reproducible (el mismo commit da siempre el mismo HTML)", () => {
  /** Lo que haría depender el HTML de cuándo se construye: `new Date(`, `Date(` (sin `new`) y `Date.now(`. */
  const LEE_LA_FECHA = /\bDate\s*\(|\bDate\s*\.\s*now\s*\(/;

  /** Los ficheros que se compilan al sitio: el código de src/ (componentes, páginas, scripts) y la configuración de Astro. */
  const ficherosQueSeCompilan = () => [
    ...readdirSync(join(ROOT, "src"), { recursive: true })
      .map(String)
      .filter((f) => /\.(astro|[cm]?[jt]sx?)$/.test(f))
      .map((f) => ({ ruta: `src/${f.split("\\").join("/")}`, texto: read(join("src", f)) })),
    { ruta: "astro.config.mjs", texto: read("astro.config.mjs") },
  ];

  /** Rutas de los ficheros que leen la fecha. */
  const culpablesDe = (ficheros) => ficheros.filter((f) => LEE_LA_FECHA.test(f.texto)).map((f) => f.ruta);

  /** Por qué falla la guarda y qué hacer. */
  const explicacion = (culpables) =>
    `${culpables.join(", ")} lee la fecha de construcción. El mismo commit tiene que generar siempre el ` +
    "mismo HTML: prod-check lo compara byte a byte con producción, y un valor sacado de la fecha (el año " +
    "del pie, p. ej.) lo rompería al cambiar de día o de año. Si hace falta una fecha, escríbela en el " +
    "código (el año de publicación, no el de construcción).";

  test("ningún fichero de src/ ni astro.config.mjs lee la fecha: el año del pie, p. ej., sale del código", () => {
    const ficheros = ficherosQueSeCompilan();
    // Control positivo: se están revisando ficheros de verdad, de los tres tipos.
    assert.ok(ficheros.some((f) => f.ruta.startsWith("src/") && f.ruta.endsWith(".astro")));
    assert.ok(ficheros.some((f) => f.ruta.startsWith("src/") && f.ruta.endsWith(".ts")));
    assert.match(ficheros.find((f) => f.ruta === "astro.config.mjs")?.texto ?? "", /defineConfig/);

    const culpables = culpablesDe(ficheros);
    assert.deepEqual(culpables, [], explicacion(culpables));
  });

  test("al fallar, el mensaje nombra los ficheros y explica el motivo y qué hacer", () => {
    const mensaje = explicacion(["src/a.astro", "astro.config.mjs"]);
    assert.ok(mensaje.startsWith("src/a.astro, astro.config.mjs lee la fecha de construcción."), mensaje);
    for (const frase of ["mismo commit", "mismo HTML", "byte a byte", "producción", "año de publicación"]) {
      assert.ok(mensaje.includes(frase), `falta «${frase}»: ${mensaje}`);
    }
  });

  test("señala a los ficheros que la leen, también la configuración de Astro y `Date()` sin `new`", () => {
    const culpables = culpablesDe([
      { ruta: "astro.config.mjs", texto: "export default { define: { AHORA: String(Date()) } };" },
      { ruta: "src/a.astro", texto: "const year = new Date().getFullYear();" },
      { ruta: "src/b.ts", texto: "export const t = Date.now();" },
      { ruta: "src/c.ts", texto: "export const year = 2026;" },
    ]);
    assert.deepEqual(culpables, ["astro.config.mjs", "src/a.astro", "src/b.ts"]);
  });

  test("la regla detecta las tres formas de leer la fecha, con espacios y sin ellos, y no confunde otras cosas", () => {
    for (const texto of [
      "new Date()",
      "new Date().getFullYear()",
      "new  Date (0)",
      "Date()",
      "Date ()",
      "String(Date())",
      "Date.now()",
      "Date . now ()",
      "x = Date.now( )",
    ]) {
      assert.match(texto, LEE_LA_FECHA, texto);
    }
    for (const texto of [
      "const year = 2026;",
      "UpdateDate(",
      "isDate(x)",
      "toDate(x)",
      "new Datepicker()",
      "candidate.now()",
      "// la fecha",
    ]) {
      assert.doesNotMatch(texto, LEE_LA_FECHA, texto);
    }
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

  test("NOTICE cita la fuente que se redistribuye (JetBrains Mono) y su licencia (SIL OFL 1.1)", () => {
    const notice = read("NOTICE");
    // La web sirve los .woff2 de @fontsource-variable/jetbrains-mono: la OFL pide conservar su aviso.
    assert.match(notice, /JetBrains Mono/);
    assert.match(notice, /SIL Open Font License,? (Version )?1\.1/i);
    assert.equal(JSON.parse(read("package.json")).dependencies?.["@fontsource-variable/jetbrains-mono"] !== undefined, true);
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

  test("las ramas de PR pueden crear su Preview (`wrangler preview` exige el bloque, aunque esté vacío)", () => {
    // Vacío: sin bindings ni variables, la Preview solo sirve los assets de su rama.
    assert.deepEqual(config().previews, {});
  });

  test("wrangler está en devDependencies (el despliegue usa la versión del lockfile, no la última)", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.ok(pkg.devDependencies?.wrangler, "falta wrangler en devDependencies");
    assert.equal(pkg.dependencies?.wrangler, undefined, "wrangler no debe ir en dependencies");
  });
});

describe("public/.well-known/security.txt (RFC 9116)", () => {
  const fields = () => {
    const out = {};
    for (const line of read("public/.well-known/security.txt").split("\n")) {
      const m = /^([A-Za-z-]+):\s*(.+)$/.exec(line.trim());
      if (m) (out[m[1].toLowerCase()] ??= []).push(m[2]);
    }
    return out;
  };

  test("da como contacto el correo de seguridad y el reporte privado de GitHub", () => {
    const f = fields();
    // Cada Contact se compara entero (no como subcadena): tiene que ser exactamente esa dirección.
    const hasContact = (value) => (f.contact ?? []).some((contact) => contact === value);
    assert.ok(hasContact("mailto:security@carellabs.com"), "falta Contact: mailto:security@carellabs.com");
    assert.ok(
      hasContact("https://github.com/carellabs/carellabs-landing/security/advisories/new"),
      "falta el reporte privado de GitHub como Contact",
    );
  });

  test("caduca en el futuro y a menos de un año (la RFC lo recomienda; al caducar, este test obliga a renovarlo)", () => {
    const expires = fields().expires;
    assert.equal(expires?.length, 1, "Expires debe aparecer una sola vez");
    const date = new Date(expires[0]);
    assert.ok(!Number.isNaN(date.getTime()), "Expires no es una fecha ISO 8601 válida");
    const days = (date.getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 0, "security.txt ha caducado: renueva Expires");
    assert.ok(days <= 366, "Expires a más de un año vista");
  });

  test("declara su URL canónica, los idiomas y la política", () => {
    const f = fields();
    assert.deepEqual(f.canonical, ["https://carellabs.com/.well-known/security.txt"]);
    assert.match(f["preferred-languages"]?.[0] ?? "", /\bes\b/);
    assert.deepEqual(f.policy, ["https://github.com/carellabs/carellabs-landing/blob/main/SECURITY.md"]);
  });
});
