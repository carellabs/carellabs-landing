// Desactiva JavaScript Detections (`enable_js`) en la zona carellabs.com con la API de Cloudflare.
// Uso: node .claude/skills/carellabs-github/assets/cloudflare-disable-jsd.mjs (paso 6.2 de la guía)
// Pide el token sin mostrarlo en pantalla y no lo guarda ni lo pasa por la línea de comandos.
// Token necesario (zona carellabs.com): Zone > Bot Management > Edit y Zone > Zone > Read.
import readline from "node:readline";

const API = "https://api.cloudflare.com/client/v4";
const ZONE_NAME = "carellabs.com";
// Campos de solo lectura que devuelve el GET y no se reenvían en el PUT.
const READ_ONLY = ["stale_zone_configuration", "using_latest_model"];

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Solo se escribe la pregunta; lo que se teclea no aparece.
    rl._writeToOutput = (s) => {
      if (s.includes(question)) rl.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

const token = await askHidden("Token de Cloudflare (no se muestra): ");
if (!token) {
  console.error("Sin token: no hago nada.");
  process.exit(1);
}

async function cf(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const body = await res.json();
  if (!body.success) {
    console.error(`Error en ${init.method ?? "GET"} ${path}:`, JSON.stringify(body.errors));
    process.exit(1);
  }
  return body.result;
}

const zones = await cf(`/zones?name=${ZONE_NAME}`);
if (zones.length !== 1) {
  console.error(`No encuentro la zona ${ZONE_NAME} con este token.`);
  process.exit(1);
}
const path = `/zones/${zones[0].id}/bot_management`;

const before = await cf(path);
console.log(`Antes:   fight_mode=${before.fight_mode}  enable_js=${before.enable_js}`);
if (before.enable_js === false) {
  console.log("JavaScript Detections ya estaba desactivado: no cambio nada.");
  process.exit(0);
}

// Se reenvía la configuración actual completa con solo `enable_js` cambiado, para no resetear nada más.
const body = { ...before, enable_js: false };
for (const k of READ_ONLY) delete body[k];
const after = await cf(path, { method: "PUT", body: JSON.stringify(body) });
console.log(`Después: fight_mode=${after.fight_mode}  enable_js=${after.enable_js}`);

const changed = Object.keys(before).filter(
  (k) => k !== "enable_js" && !READ_ONLY.includes(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]),
);
console.log(changed.length ? `OJO, también cambió: ${changed.join(", ")}` : "Ningún otro ajuste ha cambiado.");
console.log(after.enable_js === false ? "Hecho. Ya puedes borrar el token." : "La API no aplicó el cambio.");
