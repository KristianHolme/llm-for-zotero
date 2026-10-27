/**
 * Tearing a chat off a chat window: drag a list row (or the chat title) out
 * of every Zotero window and a torn-off window opens on that chat where the
 * drag ended.
 *
 * Pure: no Zotero or DOM access, so the decision runs under node. The window
 * code reads the drag, the open windows and the screen, and passes them in.
 */
import type { ConversationSystem } from "../../shared/types";
import type { TornChatIdentity } from "./tornChatWindows";

/** The only data a tear-off drag carries (no text or URL: no desktop files). */
export const TEAR_OFF_MIME = "application/x-llmforzotero-chat";

/** A rectangle in screen pixels. */
export type ScreenRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type TearOffDragEndInput = {
  /** The drag's dropEffect at dragend: "none" when no target accepted it. */
  dropEffect: string;
  /** True when the user cancelled the drag (Escape). */
  userCancelled: boolean;
  /** Where the drag ended, in screen pixels. */
  screenX: number;
  screenY: number;
  /** Every open Zotero or plugin window. */
  appWindowRects: ScreenRect[];
  /** The available area of the screen the drag ended on. */
  dropScreen: ScreenRect;
  /** The size the torn-off window opens at. */
  windowSize: { width: number; height: number };
};

export type TearOffDragEndDecision =
  | { kind: "ignore" }
  | { kind: "open"; screenX: number; screenY: number };

const CONVERSATION_SYSTEMS: readonly ConversationSystem[] = [
  "upstream",
  "claude_code",
  "codex",
];

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  );
}

export function encodeTornChatIdentity(identity: TornChatIdentity): string {
  const payload: TornChatIdentity = {
    system: identity.system,
    conversationKey: identity.conversationKey,
    kind: identity.kind,
    libraryID: identity.libraryID,
  };
  if (identity.kind === "paper") payload.paperItemID = identity.paperItemID;
  return JSON.stringify(payload);
}

/** The identity a tear-off drag carries, or null for anything malformed. */
export function decodeTornChatIdentity(raw: string): TornChatIdentity | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  const system = value.system as ConversationSystem;
  if (!CONVERSATION_SYSTEMS.includes(system)) return null;
  if (value.kind !== "paper" && value.kind !== "global") return null;
  if (!isPositiveInteger(value.conversationKey)) return null;
  if (!isPositiveInteger(value.libraryID)) return null;
  const identity: TornChatIdentity = {
    system,
    conversationKey: value.conversationKey,
    kind: value.kind,
    libraryID: value.libraryID,
  };
  if (value.kind === "paper") {
    if (!isPositiveInteger(value.paperItemID)) return null;
    identity.paperItemID = value.paperItemID;
  }
  return identity;
}

function containsPoint(rect: ScreenRect, x: number, y: number): boolean {
  return (
    x >= rect.left &&
    x < rect.left + rect.width &&
    y >= rect.top &&
    y < rect.top + rect.height
  );
}

/** The axis position that keeps `size` inside [start, start + extent). */
function clampAxis(
  position: number,
  start: number,
  extent: number,
  size: number,
): number {
  return Math.max(start, Math.min(position, start + extent - size));
}

/**
 * What a finished drag does: nothing when it was cancelled, a target took
 * it, or it ended over a Zotero or plugin window; otherwise a torn-off
 * window opens with its top-left corner at the drop point, moved so the
 * whole window lies on the drop screen.
 */
export function classifyTearOffDragEnd(
  input: TearOffDragEndInput,
): TearOffDragEndDecision {
  if (input.userCancelled) return { kind: "ignore" };
  if (input.dropEffect !== "none") return { kind: "ignore" };
  const { screenX, screenY } = input;
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) {
    return { kind: "ignore" };
  }
  if (
    input.appWindowRects.some((rect) => containsPoint(rect, screenX, screenY))
  ) {
    return { kind: "ignore" };
  }
  const { dropScreen, windowSize } = input;
  return {
    kind: "open",
    screenX: clampAxis(
      screenX,
      dropScreen.left,
      dropScreen.width,
      windowSize.width,
    ),
    screenY: clampAxis(
      screenY,
      dropScreen.top,
      dropScreen.height,
      windowSize.height,
    ),
  };
}
