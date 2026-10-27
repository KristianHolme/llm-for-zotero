import { assert } from "chai";
import {
  TEAR_OFF_MIME,
  classifyTearOffDragEnd,
  decodeTornChatIdentity,
  encodeTornChatIdentity,
  type ScreenRect,
} from "../src/modules/contextPanel/tearOffDrag";
import type { TornChatIdentity } from "../src/modules/contextPanel/tornChatWindows";

const classify = classifyTearOffDragEnd;

const screen: ScreenRect = { left: 0, top: 25, width: 1920, height: 1055 };

const base = {
  dropEffect: "none",
  userCancelled: false,
  screenX: 900,
  screenY: 300,
  appWindowRects: [
    { left: 0, top: 25, width: 600, height: 800 },
    { left: 1300, top: 100, width: 500, height: 700 },
  ] as ScreenRect[],
  dropScreen: screen,
  windowSize: { width: 640, height: 760 },
};

describe("tearOffDrag", function () {
  it("uses its own drag data type", function () {
    assert.equal(TEAR_OFF_MIME, "application/x-llmforzotero-chat");
  });

  it("ignores a cancelled drag", function () {
    assert.deepEqual(classify({ ...base, userCancelled: true }), {
      kind: "ignore",
    });
  });

  it("ignores a drag some target accepted", function () {
    assert.deepEqual(classify({ ...base, dropEffect: "move" }), {
      kind: "ignore",
    });
  });

  it("ignores a drop inside any Zotero or plugin window", function () {
    assert.deepEqual(classify({ ...base, screenX: 1400, screenY: 400 }), {
      kind: "ignore",
    });
    assert.deepEqual(classify({ ...base, screenX: 10, screenY: 30 }), {
      kind: "ignore",
    });
  });

  it("opens at the drop point when it fits", function () {
    assert.deepEqual(classify(base), {
      kind: "open",
      screenX: 900,
      screenY: 300,
    });
  });

  it("clamps the window inside the drop screen", function () {
    const corner = classify({
      ...base,
      appWindowRects: [],
      screenX: screen.left + screen.width - 1,
      screenY: screen.top + screen.height - 1,
    });
    assert.deepEqual(corner, {
      kind: "open",
      screenX: screen.left + screen.width - 640,
      screenY: screen.top + screen.height - 760,
    });
    const second = classify({
      ...base,
      appWindowRects: [],
      dropScreen: { left: -1280, top: 0, width: 1280, height: 1024 },
      screenX: -1300,
      screenY: -20,
    });
    assert.deepEqual(second, { kind: "open", screenX: -1280, screenY: 0 });
  });

  it("keeps the window's top-left on the screen when the screen is smaller", function () {
    const result = classify({
      ...base,
      appWindowRects: [],
      dropScreen: { left: 100, top: 50, width: 500, height: 600 },
      screenX: 300,
      screenY: 300,
    });
    assert.deepEqual(result, { kind: "open", screenX: 100, screenY: 50 });
  });

  it("ignores a drop point that is not a number", function () {
    assert.deepEqual(classify({ ...base, screenX: Number.NaN }), {
      kind: "ignore",
    });
  });

  it("round-trips an identity and rejects junk", function () {
    const paper: TornChatIdentity = {
      system: "upstream",
      conversationKey: 42,
      kind: "paper",
      libraryID: 1,
      paperItemID: 7,
    };
    assert.deepEqual(
      decodeTornChatIdentity(encodeTornChatIdentity(paper)),
      paper,
    );
    const library: TornChatIdentity = {
      system: "codex",
      conversationKey: 5_000_000_000_000_123,
      kind: "global",
      libraryID: 3,
    };
    assert.deepEqual(
      decodeTornChatIdentity(encodeTornChatIdentity(library)),
      library,
    );
    assert.isNull(decodeTornChatIdentity("{}"));
    assert.isNull(decodeTornChatIdentity("not json"));
    assert.isNull(decodeTornChatIdentity(""));
    assert.isNull(decodeTornChatIdentity("null"));
    const reject = (patch: Record<string, unknown>) =>
      decodeTornChatIdentity(JSON.stringify({ ...paper, ...patch }));
    assert.isNull(reject({ conversationKey: 0 }));
    assert.isNull(reject({ conversationKey: -3 }));
    assert.isNull(reject({ conversationKey: "42" }));
    assert.isNull(reject({ libraryID: 0 }));
    assert.isNull(reject({ system: "webchat" }));
    assert.isNull(reject({ kind: "note" }));
    assert.isNull(reject({ paperItemID: 0 }));
    assert.isNull(reject({ paperItemID: undefined }));
  });
});
