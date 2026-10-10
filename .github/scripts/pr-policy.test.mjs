import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluatePr } from "./pr-policy.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "pr-policy.mjs");
const WITH_ISSUE = "Closes #12";

describe("evaluatePr: formato del titulo", () => {
  const validos = [
    "docs: actualiza el README",
    "chore: sube dependencias",
    "chore(deps): bump astro from 7.3.5 to 7.3.6",
    "ci(deps): bump actions/checkout from 4.2.1 to 4.2.2",
    "refactor(i18n): extrae helper de idioma",
    "style: formatea el CSS",
    "test(a11y): cubre el selector de idioma",
    "build: ajusta la salida de astro",
    "perf: reduce el CSS critico",
    "revert: deshace el cambio de fuentes",
    "docs(scope.con-puntos_y123): scope con todos los caracteres permitidos",
    "docs!: cambio incompatible en docs",
    "chore(deps)!: sube a una mayor",
  ];
  for (const title of validos) {
    test(`acepta: ${title}`, () => {
      const r = evaluatePr({ title, body: "" });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(r.errors, []);
    });
  }

  const invalidos = [
    ["tipo con mayuscula", "Feat: algo"],
    ["tipo en mayusculas", "DOCS: algo"],
    ["sin espacio tras los dos puntos", "docs:algo"],
    ["con dos espacios nada mas", "docs:  "],
    ["sin descripcion", "docs: "],
    ["tipo desconocido", "feature: algo"],
    ["tipo desconocido (wip)", "wip: algo"],
    ["scope con mayusculas", "docs(Scope): algo"],
    ["scope vacio", "docs(): algo"],
    ["scope con espacio", "docs(mi scope): algo"],
    ["sin dos puntos", "docs algo"],
    ["espacio inicial", " docs: algo"],
    ["cadena vacia", ""],
    ["solo espacios", "   "],
    ["salto de linea final", "docs: algo\n"],
    ["salto de linea intermedio", "docs: algo\nlabel=type:evil"],
    ["exclamacion antes del scope", "docs!(scope): algo"],
    ["solo un espacio de ancho cero (U+200B) tras los dos puntos", "docs: \u200B"],
    ["espacio de ancho cero (U+200B) antes del texto", "docs: \u200Balgo"],
    ["no-joiner de ancho cero (U+200C) antes del texto", "docs: \u200Calgo"],
    ["joiner de ancho cero (U+200D) antes del texto", "docs: \u200Dalgo"],
    ["marca de orden de bytes (U+FEFF) antes del texto", "docs: \uFEFFalgo"],
    ["varios invisibles seguidos", "docs: \u200B\u200C\u200D\uFEFF"],
  ];
  for (const [motivo, title] of invalidos) {
    test(`rechaza (${motivo}): ${JSON.stringify(title)}`, () => {
      const r = evaluatePr({ title, body: WITH_ISSUE });
      assert.equal(r.ok, false);
      assert.equal(r.label, null);
      assert.ok(r.errors.length >= 1);
      assert.match(r.errors[0], /t[ií]tulo/i);
    });
  }

  test("titulo ausente (null, undefined, vacio): error propio de 'no recibido'", () => {
    for (const title of [null, undefined, ""]) {
      const r = evaluatePr({ title, body: "" });
      assert.equal(r.ok, false);
      assert.equal(r.label, null);
      assert.match(r.errors[0], /no se ha recibido/i);
    }
  });

  test("titulo mal formado: error de formato, no el de 'no recibido'", () => {
    const r = evaluatePr({ title: "Feat: algo", body: "" });
    assert.doesNotMatch(r.errors[0], /no se ha recibido/i);
    assert.match(r.errors[0], /commit convencional/i);
  });

  test("un titulo invalido no genera ademas el error de issue", () => {
    const r = evaluatePr({ title: "Feat: algo", body: "" });
    assert.equal(r.errors.length, 1);
  });

  test("un invisible dentro de la descripcion (no al principio) es valido: la descripcion ya empieza con un caracter visible", () => {
    const r = evaluatePr({ title: "docs: a\u200Bb", body: "" });
    assert.equal(r.ok, true, JSON.stringify(r));
  });
});

describe("evaluatePr: longitud del titulo", () => {
  const conLongitud = (n) => "docs: " + "a".repeat(n - "docs: ".length);

  test("100 caracteres exactos: valido", () => {
    const title = conLongitud(100);
    assert.equal(title.length, 100);
    const r = evaluatePr({ title, body: "" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.label, "type:docs");
  });

  test("101 caracteres: invalido, con un error propio de longitud y sin etiqueta", () => {
    const title = conLongitud(101);
    assert.equal(title.length, 101);
    const r = evaluatePr({ title, body: "" });
    assert.equal(r.ok, false);
    assert.equal(r.label, null);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /t[ií]tulo/i);
    assert.match(r.errors[0], /100/);
    assert.doesNotMatch(r.errors[0], /commit convencional/i);
  });

  test("un titulo con formato malo Y demasiado largo informa del formato", () => {
    const r = evaluatePr({ title: "Feat: " + "a".repeat(200), body: "" });
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /commit convencional/i);
  });

  test("la longitud cuenta caracteres, no unidades UTF-16 (un emoji vale 1)", () => {
    const title = "docs: " + "\u{1F600}".repeat(94); // 6 + 94 = 100 caracteres, 194 unidades
    assert.ok(title.length > 100);
    assert.equal(evaluatePr({ title, body: "" }).ok, true);
  });
});

describe("evaluatePr: referencia de cierre en feat y fix", () => {
  const conReferencia = [
    "Closes #12",
    "closes #12",
    "CLOSES #12",
    "Close #12",
    "Closed #12",
    "fixes #3",
    "Fix #3",
    "Fixed #3",
    "Resolves #7",
    "Resolve #7",
    "Resolved #7",
    "## Issue\n\nCloses #12\n\n## Qué cambia\nTodo",
    "Closes\t#12",
    "Closes: #12",
    "closes: #12",
    "Fixes: #3",
    "Resolves: #7",
    "Closes #1",
    "Closes #100",
    "<!-- nota de la plantilla -->\nCloses #12",
    "Closes #12 <!-- ok -->",
    "<!-- uno --> <!-- dos -->\nCloses #12",
    "<!-- uno -->\nCloses #12\n<!-- dos -->",
  ];
  const sinReferencia = [
    ["cuerpo vacio", ""],
    ["cuerpo null", null],
    ["cuerpo undefined", undefined],
    ["solo espacios", "   \n  "],
    ["#12 sin palabra clave", "#12"],
    ["mencion de issue sin palabra clave", "Relacionado con #12"],
    ["palabra clave sin numero (placeholder de la plantilla)", "Closes #"],
    ["palabra clave con letra en lugar de numero", "Closes #N"],
    ["palabra clave sin almohadilla", "Closes 12"],
    ["palabra clave pegada a la almohadilla", "Closes#12"],
    ["palabra clave dentro de otra palabra", "prefix #3"],
    ["numero seguido de letras", "Closes #12abc"],
    ["otra palabra", "Related #12"],
    ["numero cero", "Closes #0"],
    ["numero cero con dos puntos", "Closes: #0"],
    ["numero con cero inicial", "Closes #012"],
    ["solo ceros", "Closes #000"],
    ["referencia valida SOLO dentro de un comentario HTML", "<!-- Closes #12 -->"],
    ["comentario HTML multilinea con referencia", "<!--\nCloses #12\n-->"],
    ["referencia en un comentario y otra palabra clave sin numero fuera", "<!-- Closes #12 -->\nCloses #"],
    ["dos puntos pero sin numero", "Closes: #"],
    ["referencia dentro del SEGUNDO de dos comentarios", "<!-- uno -->\n<!-- Closes #12 -->"],
  ];

  for (const tipo of ["feat", "fix"]) {
    for (const forma of [
      `${tipo}: algo`,
      `${tipo}(landing): algo`,
      `${tipo}!: algo`,
      `${tipo}(landing)!: algo`,
    ]) {
      for (const body of conReferencia) {
        test(`${forma} + ${JSON.stringify(body.slice(0, 22))} pasa`, () => {
          const r = evaluatePr({ title: forma, body });
          assert.equal(r.ok, true, JSON.stringify(r));
          assert.deepEqual(r.errors, []);
        });
      }
      for (const [motivo, body] of sinReferencia) {
        test(`${forma} + ${motivo} falla`, () => {
          const r = evaluatePr({ title: forma, body });
          assert.equal(r.ok, false);
          assert.equal(r.errors.length, 1);
          assert.match(r.errors[0], /Closes #/);
        });
      }
    }
  }

  test("un error de issue no impide calcular la etiqueta", () => {
    const r = evaluatePr({ title: "feat: algo", body: "" });
    assert.equal(r.ok, false);
    assert.equal(r.label, "type:feature");
  });
});

describe("evaluatePr: el resto de tipos no exige issue", () => {
  const tipos = [
    "build",
    "chore",
    "ci",
    "docs",
    "perf",
    "refactor",
    "revert",
    "style",
    "test",
  ];
  for (const tipo of tipos) {
    for (const body of ["", null, undefined, "sin referencia"]) {
      test(`${tipo} con cuerpo ${JSON.stringify(body)} pasa`, () => {
        const r = evaluatePr({ title: `${tipo}: algo`, body });
        assert.equal(r.ok, true, JSON.stringify(r));
      });
    }
  }
});

describe("evaluatePr: etiquetas", () => {
  const casos = [
    ["feat: a", "type:feature"],
    ["feat(x): a", "type:feature"],
    ["fix: a", "type:bug"],
    ["fix(x): a", "type:bug"],
    ["docs: a", "type:docs"],
    ["refactor: a", "type:refactor"],
    ["perf: a", "type:feature"],
    ["chore: a", "type:chore"],
    ["style: a", "type:chore"],
    ["test: a", "type:chore"],
    ["build: a", "type:chore"],
    ["ci: a", "type:chore"],
    ["ci(deps): a", "type:chore"],
    ["revert: a", "type:bug"],
    ["feat!: a", "type:breaking-change"],
    ["fix(x)!: a", "type:breaking-change"],
    ["docs!: a", "type:breaking-change"],
    ["chore(deps)!: a", "type:breaking-change"],
    ["revert!: a", "type:breaking-change"],
  ];
  for (const [title, label] of casos) {
    test(`${title} => ${label}`, () => {
      const r = evaluatePr({ title, body: WITH_ISSUE });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.label, label);
    });
  }

  test("la etiqueta solo puede ser una de las del mapa, nunca texto del usuario", () => {
    const permitidas = new Set([
      "type:feature",
      "type:bug",
      "type:docs",
      "type:refactor",
      "type:chore",
      "type:breaking-change",
    ]);
    const titulos = [
      "docs(label=evil): a",
      "feat(x)!: label=type:evil",
      "chore: $(rm -rf)",
    ];
    for (const title of titulos) {
      const r = evaluatePr({ title, body: WITH_ISSUE });
      assert.ok(permitidas.has(r.label) || r.label === null, String(r.label));
    }
  });
});

describe("evaluatePr: contrato", () => {
  test("devuelve siempre { ok, errors, label }", () => {
    const r = evaluatePr({ title: "docs: a", body: "" });
    assert.deepEqual(Object.keys(r).sort(), ["errors", "label", "ok"]);
    assert.ok(Array.isArray(r.errors));
  });

  test("no lanza con entrada vacia o ausente", () => {
    assert.equal(evaluatePr({}).ok, false);
    assert.equal(evaluatePr().ok, false);
  });

  test("es pura: la misma entrada da el mismo resultado", () => {
    const entrada = { title: "feat: a", body: "" };
    assert.deepEqual(evaluatePr(entrada), evaluatePr(entrada));
    assert.deepEqual(entrada, { title: "feat: a", body: "" });
  });
});

describe("plantilla de PR", () => {
  const plantilla = () =>
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "PULL_REQUEST_TEMPLATE.md"),
      "utf8",
    );

  test("sin rellenar, un PR docs/chore pasa la politica", () => {
    for (const title of ["docs: algo", "chore: algo"]) {
      assert.equal(evaluatePr({ title, body: plantilla() }).ok, true, title);
    }
  });

  test("sin rellenar, un PR feat/fix NO pasa: el 'Closes #' de la plantilla no cuenta como referencia", () => {
    for (const title of ["feat: algo", "fix: algo"]) {
      assert.equal(evaluatePr({ title, body: plantilla() }).ok, false, title);
    }
  });

  test("rellenando la linea de issue, un feat pasa", () => {
    // (?=\r?$): tolera finales de linea CRLF (git con autocrlf en Windows).
    const body = plantilla().replace(/^Closes #(?=\r?$)/m, "Closes #12");
    assert.notEqual(body, plantilla(), "la plantilla debe tener una linea 'Closes #' sola");
    assert.equal(evaluatePr({ title: "feat: algo", body }).ok, true);
  });
});

describe("CLI", () => {
  /**
   * Ejecuta el script como lo hace el workflow: título y cuerpo por entorno.
   * @param {Record<string, string | undefined>} overrides
   */
  function ejecutar(overrides) {
    const dir = mkdtempSync(join(tmpdir(), "pr-policy-"));
    const output = join(dir, "github_output");
    const env = { ...process.env };
    for (const k of ["PR_TITLE", "PR_BODY", "GITHUB_OUTPUT", "GITHUB_ACTIONS"]) {
      delete env[k];
    }
    const conOutput = !("noOutput" in overrides);
    delete overrides.noOutput;
    Object.assign(env, overrides);
    if (conOutput) env.GITHUB_OUTPUT = output;
    const r = spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8" });
    const salida = existsSync(output) ? readFileSync(output, "utf8") : null;
    rmSync(dir, { recursive: true, force: true });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, salida };
  }

  test("importar el modulo no ejecuta la CLI ni cambia el codigo de salida", () => {
    const env = { ...process.env };
    delete env.PR_TITLE; // sin titulo la CLI saldria con 1 si se ejecutara
    const modulo = JSON.stringify(new URL("./pr-policy.mjs", import.meta.url).href);
    const r = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `import ${modulo}; console.log("importado")`],
      { env, encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /importado/);
    assert.doesNotMatch(r.stdout + r.stderr, /Pol[ií]tica de PR/);
  });

  test("importar el modulo desde stdin (argv[1] = '-') no lanza", () => {
    // Regresion: realpathSync('-') lanzaba ENOENT al detectar si es la CLI.
    const modulo = JSON.stringify(new URL("./pr-policy.mjs", import.meta.url).href);
    const r = spawnSync(process.execPath, ["--input-type=module", "-"], {
      input: `import ${modulo}; console.log("importado")`,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /importado/);
  });

  test("titulo valido: exit 0 y escribe label en GITHUB_OUTPUT", () => {
    const r = ejecutar({ PR_TITLE: "feat(landing): algo", PR_BODY: "Closes #12" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.salida, "label=type:feature\n");
  });

  test("titulo invalido: exit 1, mensaje claro en stderr y sin label", () => {
    const r = ejecutar({ PR_TITLE: "Feat: algo", PR_BODY: "" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /t[ií]tulo/i);
    assert.match(r.stderr, /feat\(scope\)|tipo/i);
    assert.ok(r.salida === null || !/label=/.test(r.salida));
  });

  test("feat sin issue: exit 1, pide Closes #N y deja la etiqueta calculada", () => {
    const r = ejecutar({ PR_TITLE: "feat: algo", PR_BODY: "" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Closes #/);
    assert.equal(r.salida, "label=type:feature\n");
  });

  test("sin GITHUB_OUTPUT funciona igual (ejecucion local)", () => {
    const r = ejecutar({ PR_TITLE: "docs: algo", noOutput: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.salida, null);
  });

  test("sin PR_TITLE: exit 1", () => {
    const r = ejecutar({});
    assert.equal(r.status, 1);
    assert.match(r.stderr, /t[ií]tulo/i);
  });

  test("PR_BODY ausente equivale a cuerpo vacio", () => {
    const ok = ejecutar({ PR_TITLE: "docs: algo" });
    assert.equal(ok.status, 0, ok.stderr);
    const ko = ejecutar({ PR_TITLE: "fix: algo" });
    assert.equal(ko.status, 1);
  });

  test("GITHUB_ACTIONS=true emite anotaciones ::error; fuera de Actions, texto plano", () => {
    const enActions = ejecutar({ PR_TITLE: "nope", GITHUB_ACTIONS: "true" });
    assert.match(enActions.stdout + enActions.stderr, /^::error/m);
    const local = ejecutar({ PR_TITLE: "nope" });
    assert.doesNotMatch(local.stdout + local.stderr, /^::error/m);
    assert.match(local.stderr, /t[ií]tulo/i);
  });

  // Se prueba dentro y fuera de Actions: son dos ramas de salida distintas.
  for (const [modo, extra] of [
    ["en Actions", { GITHUB_ACTIONS: "true" }],
    ["en local", {}],
  ]) {
    test(`inyeccion (${modo}): un titulo con saltos de linea no escribe en GITHUB_OUTPUT ni inyecta comandos`, () => {
      const r = ejecutar({
        PR_TITLE: "docs: ok\nlabel=type:evil\n::add-mask::secreto",
        PR_BODY: "",
        ...extra,
      });
      assert.equal(r.status, 1);
      assert.ok(r.salida === null || !/evil/.test(r.salida));
      const todo = r.stdout + r.stderr;
      assert.doesNotMatch(todo, /^::add-mask/m);
      assert.doesNotMatch(todo, /evil/);
    });

    test(`el cuerpo nunca se vuelca a la salida (${modo})`, () => {
      const r = ejecutar({
        PR_TITLE: "feat: algo",
        PR_BODY: "::stop-commands::x\nTEXTO-DEL-CUERPO",
        ...extra,
      });
      assert.equal(r.status, 1);
      assert.doesNotMatch(r.stdout + r.stderr, /TEXTO-DEL-CUERPO|stop-commands/);
    });
  }
});
