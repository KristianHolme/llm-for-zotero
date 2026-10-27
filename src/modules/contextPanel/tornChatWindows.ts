/**
 * Torn-off chat windows: extra instances of the standalone window document
 * that each keep their own paper and do not follow the PDF reader.
 *
 * Each window has its own selection surface "torn:<id>" (see
 * conversationSelection.ts) and is listed here while it is open. The
 * standalone window is not listed here; it stays the one window in
 * `addon.data.standaloneWindow`.
 */
import type { ConversationSystem } from "../../shared/types";
import type { TornSurface } from "./conversationSelection";

/** The chat a torn-off window opens on. */
export type TornChatIdentity = {
  system: ConversationSystem;
  conversationKey: number;
  kind: "paper" | "global";
  libraryID: number;
  paperItemID?: number;
};

let lastTornWindowID = 0;
const tornWindows = new Map<TornSurface, Window>();

/** A surface name no open or earlier window of this session has used. */
export function allocateTornSurface(): TornSurface {
  lastTornWindowID += 1;
  return `torn:${lastTornWindowID}`;
}

/**
 * Lists `win` under `surface` until the returned disposer runs (on unload).
 * The disposer leaves a later window registered under the same surface.
 */
export function registerTornChatWindow(
  win: Window,
  surface: TornSurface,
): () => void {
  tornWindows.set(surface, win);
  return () => {
    if (tornWindows.get(surface) === win) tornWindows.delete(surface);
  };
}

/** The open torn-off windows, oldest first. */
export function getTornChatWindows(): Window[] {
  const open: Window[] = [];
  for (const [surface, win] of tornWindows) {
    if (!win || win.closed) {
      tornWindows.delete(surface);
      continue;
    }
    open.push(win);
  }
  return open;
}

/** Closes every torn-off window; each one cleans up in its unload. */
export function closeAllTornChatWindows(): void {
  for (const win of getTornChatWindows()) {
    try {
      win.close();
    } catch {
      // The window is already going away.
    }
  }
}
