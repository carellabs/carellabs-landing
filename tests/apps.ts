import { readFileSync } from "node:fs";

/** Una app de `src/data/apps.json`, con los campos que usan los tests. */
export interface App {
  name: string;
  url: string;
  hidden?: unknown;
}

export const APPS: App[] = JSON.parse(readFileSync("src/data/apps.json", "utf8"));

/** Una app con `"hidden": true` sigue en apps.json, pero la web no la muestra. */
export const VISIBLE_APPS = APPS.filter((app) => app.hidden !== true);
export const HIDDEN_APPS = APPS.filter((app) => app.hidden === true);
