import { readFileSync } from "node:fs";

/** Una app de `src/data/apps.json`, con los campos que usan los tests. */
export interface App {
  id: string;
  name: string;
  status: "in-progress" | "beta" | "live";
  /** Solo las apps en beta o disponibles la necesitan; las demás pueden no tenerla aún. */
  url?: string;
  hidden?: unknown;
}

export const APPS: App[] = JSON.parse(readFileSync("src/data/apps.json", "utf8"));

/** Una app con `"hidden": true` sigue en apps.json, pero la web no la muestra. */
export const VISIBLE_APPS = APPS.filter((app) => app.hidden !== true);
export const HIDDEN_APPS = APPS.filter((app) => app.hidden === true);

/** Solo las apps en beta o disponibles enlazan y enseñan su dirección bajo el nombre. */
export const isLinked = (app: App): boolean => app.status === "live" || app.status === "beta";
