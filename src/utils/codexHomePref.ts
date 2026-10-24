import { config } from "../../package.json";

const CODEX_HOME_PREF_KEY = `${config.prefsPrefix}.codexHome`;

/**
 * The folder the user set for the Codex App Server runtime; empty means
 * "leave CODEX_HOME as Zotero inherited it". Read by the process launcher and
 * by Codex sign-in lookup, so it lives below both.
 */
export function getCodexHomePref(): string {
  const value = (
    globalThis as {
      Zotero?: {
        Prefs?: { get?: (key: string, global?: boolean) => unknown };
      };
    }
  ).Zotero?.Prefs?.get?.(CODEX_HOME_PREF_KEY, true);
  return typeof value === "string" ? value.trim() : "";
}
