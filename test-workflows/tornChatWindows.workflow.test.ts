import { assert } from "chai";
import {
  getModelEntryById,
  setModelProviderGroups,
} from "../src/utils/modelProviders";
import {
  TEAR_OFF_MIME,
  decodeTornChatIdentity,
} from "../src/modules/contextPanel/tearOffDrag";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
  WorkflowTestSeededHistoryConversation,
} from "../src/modules/contextPanel/workflowTestTypes";
import {
  installHeldChatProvider,
  type HeldChatProvider,
} from "./helpers/heldChatProvider";
import {
  lastAssistantBubbleText,
  startSharedConversationStream,
} from "./helpers/sharedConversationStream";

/**
 * A torn-off chat window (a "follower") is a compact second instance of the
 * standalone window document that holds one chat: it shows no chat list, no
 * Paper chat | Library chat toggle and no New chat, it does not follow the
 * PDF reader, and it keeps its own selection and model choices apart from
 * the standalone window (the "leader"). The leader keeps its singleton
 * behavior.
 *
 * Everything runs in the real Zotero host against real reader tabs and real
 * chat windows. Most cases send nothing and exercise only the menus and
 * choices; the two-window streaming cases send through the panels' own
 * composers to a held fake provider, so the test decides when each answer
 * streams and ends.
 */

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero.";
const API_BASE = "https://workflow-torn-chat-windows.invalid/v1";
const GROUP_ID = "workflow-torn-group";
const ENTRY_A = "workflow-torn-model-a";
const MODEL_A = "torn-model-a";
const ENTRY_B = "workflow-torn-model-b";
const MODEL_B = "torn-model-b";
const WEBCHAT_GROUP_ID = "workflow-torn-webchat-group";
const WEBCHAT_ENTRY = "workflow-torn-webchat-model";
const NO_PAPER_STATUS =
  "Open a supported Zotero document to start a paper chat";

const SAVED_PREF_KEYS = [
  "modelProviderGroups",
  "modelProviderGroupsMigrationVersion",
  "lastUsedModelEntryId",
  "lastUsedRuntimeMode",
  "conversationSystem",
  "enableCodexAppServerMode",
  "enableClaudeCodeMode",
  "sidebarLayout",
  "standalonePinnedPapers",
  "standaloneSidebarCollapsedGroups",
  "logLevel",
];

type PanelState = {
  open: boolean;
  conversationKey: number;
  conversationKind: string;
  basePaperItemId: number;
  inputDisabled: boolean | null;
  statusText: string;
  modelLabel: string;
};

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

function toKey(value: unknown): number {
  const parsed = Math.floor(Number(value || 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function textOf(node: Element | null | undefined): string {
  return (node?.textContent || "").replace(/\s+/gu, " ").trim();
}

const apiModelGroup = () => ({
  id: GROUP_ID,
  authMode: "api_key",
  apiBase: API_BASE,
  apiKey: "workflow-dummy-key",
  providerProtocol: "openai_chat_compat",
  models: [
    {
      id: ENTRY_A,
      model: MODEL_A,
      temperature: 0.3,
      outputTokenLimit: { mode: "auto" },
    },
    {
      id: ENTRY_B,
      model: MODEL_B,
      temperature: 0.3,
      outputTokenLimit: { mode: "auto" },
    },
  ],
});

/** A ChatGPT WebChat model (as webchatModeSwitching offers; no account needed). */
const webChatModelGroup = () => ({
  id: WEBCHAT_GROUP_ID,
  apiBase: "",
  apiKey: "",
  authMode: "webchat",
  providerProtocol: "web_sync",
  models: [
    {
      id: WEBCHAT_ENTRY,
      model: "chatgpt.com",
      temperature: 0.7,
      maxTokens: 4096,
    },
  ],
});

describe("workflow: torn-off chat windows keep their own paper", function () {
  this.timeout(180_000);

  let api: WorkflowTestApi;
  let provider: HeldChatProvider;
  const previousPrefs = new Map<string, unknown>();
  const fixtures: WorkflowTestFixture[] = [];
  const seededChats: WorkflowTestSeededHistoryConversation[] = [];
  const readers: any[] = [];

  const mainWin = () => Zotero.getMainWindow();

  // ── Windows and their panels ─────────────────────────────────────────────

  const standaloneWin = (): Window | null => {
    const win = (Zotero as any).LLMForZotero?.data?.standaloneWindow as
      | Window
      | undefined;
    return win && !win.closed ? win : null;
  };

  const tornWin = (): Window | null =>
    api.getTornChatWindowsForTest().find((win) => !win.closed) || null;

  const bodyOf = (win: Window | null): HTMLElement | null =>
    (win?.document.querySelector(
      ".llm-standalone-content",
    ) as HTMLElement | null) || null;

  const rootOf = (win: Window | null): HTMLElement | null =>
    (bodyOf(win)?.querySelector("#llm-main") as HTMLElement | null) || null;

  function readPanel(body: HTMLElement | null): PanelState {
    const root = body?.querySelector("#llm-main") as HTMLElement | null;
    const input = body?.querySelector(
      "#llm-input",
    ) as HTMLTextAreaElement | null;
    return {
      open: Boolean(root?.isConnected),
      conversationKey: toKey(root?.dataset.itemId),
      conversationKind: root?.dataset.conversationKind || "",
      basePaperItemId: toKey(root?.dataset.basePaperItemId),
      inputDisabled: input ? input.disabled : null,
      statusText: textOf(body?.querySelector("#llm-status")),
      modelLabel:
        (body?.querySelector("#llm-model-toggle") as HTMLElement | null)
          ?.dataset.modelLabel || "",
    };
  }

  const stateOf = (win: Window | null) => readPanel(bodyOf(win));

  /** The window's paper chips, as `paperItemId:paperContextItemId`. */
  const chipKeys = (win: Window | null): string[] =>
    Array.from(
      bodyOf(win)?.querySelectorAll(
        "#llm-paper-context-preview .llm-paper-context-chip",
      ) || [],
    ).map(
      (chip: any) =>
        `${chip.dataset.paperItemId}:${chip.dataset.paperContextItemId}`,
    );

  async function until(
    check: () => boolean | Promise<boolean>,
    describe: () => string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await Zotero.Promise.delay(50);
    }
    if (await check()) return;
    assert.fail(describe());
  }

  /** Rendered, with a box: not detached, hidden or display:none. */
  function isShown(node: Element | null | undefined): boolean {
    if (!node || !node.isConnected) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  const shownIn = (win: Window, selector: string): HTMLElement[] =>
    (
      Array.from(win.document.querySelectorAll(selector)) as HTMLElement[]
    ).filter(isShown);

  const windowRoot = (win: Window | null): HTMLElement | null =>
    (win?.document.getElementById(
      "llmforzotero-standalone-chat-root",
    ) as HTMLElement | null) || null;

  const followerTitleOf = (win: Window | null): HTMLElement | null =>
    (win?.document.querySelector(
      ".llm-follower-title",
    ) as HTMLElement | null) || null;

  // The window's own all-chats popup (the chat panel has popups of its own
  // with the same classes, inside the content area).
  const WINDOW_SEARCH_OVERLAY =
    "#llmforzotero-standalone-chat-root > .llm-standalone-search-overlay";

  const searchOverlayOf = (win: Window): HTMLElement | null =>
    win.document.querySelector(WINDOW_SEARCH_OVERLAY) as HTMLElement | null;

  const searchRowOf = (win: Window, key: number): HTMLElement | null =>
    win.document.querySelector(
      `${WINDOW_SEARCH_OVERLAY} .llm-standalone-search-item[data-conversation-key="${key}"]`,
    ) as HTMLElement | null;

  /** Opens the follower's History popup and waits for `key`'s row. */
  async function openFollowerHistory(
    win: Window,
    key: number,
  ): Promise<HTMLElement> {
    const history = win.document.querySelector(
      ".llm-follower-history",
    ) as HTMLElement | null;
    assert.isOk(history, "the follower has a History button");
    history!.click();
    await until(
      () =>
        searchOverlayOf(win)?.style.display !== "none" &&
        Boolean(searchRowOf(win, key)),
      () =>
        `the follower's History lists chat ${key}: ${JSON.stringify(
          Array.from(
            win.document.querySelectorAll(
              `${WINDOW_SEARCH_OVERLAY} .llm-standalone-search-item`,
            ),
          ).map((row: any) => row.dataset.conversationKey),
        )}`,
    );
    return searchRowOf(win, key)!;
  }

  function listedConversationKeys(win: Window | null): number[] {
    return Array.from(
      win?.document.querySelectorAll(
        ".llm-standalone-sidebar-list .llm-standalone-conv-item",
      ) || [],
    ).map((row: any) => toKey(row.dataset.conversationKey));
  }

  // ── Zotero tabs and papers ───────────────────────────────────────────────

  async function newPaper(title: string) {
    const fixture = await api.createPaperWithPdfFixture({
      title,
      pdfTitle: `${title} PDF`,
      pages: [`${title}: a short page about torn-off chat windows.`],
    });
    fixtures.push(fixture);
    return fixture;
  }

  async function openReader(fixture: WorkflowTestFixture): Promise<any> {
    const reader = await Zotero.Reader.open(fixture.pdfAttachmentId, {
      pageIndex: 0,
    });
    assert.isOk(reader, "the PDF reader tab opens");
    readers.push(reader);
    await reader._initPromise;
    if (typeof reader._waitForReader === "function") {
      await reader._waitForReader();
    }
    return reader;
  }

  const showReader = (reader: any) =>
    mainWin().Zotero_Tabs.select(reader.tabID);

  /** Zotero shows the paper in the library: library tab, paper selected. */
  async function showInLibrary(itemId: number): Promise<void> {
    mainWin().Zotero_Tabs.select("zotero-pane");
    await mainWin().ZoteroPane.selectItem(itemId);
  }

  /** A stored chat (one turn) written straight into a runtime's store. */
  async function seedChat(input: {
    system: "upstream" | "codex" | "claude_code";
    kind: "global" | "paper";
    paperItemId?: number;
    userText: string;
  }): Promise<WorkflowTestSeededHistoryConversation> {
    const chat = await api.seedHistoryConversation({
      ...input,
      assistantText: `Answer to: ${input.userText}`,
    });
    seededChats.push(chat);
    return chat;
  }

  /** Opens a follower on a stored chat and waits until it shows it. */
  async function openFollower(identity: {
    system: "upstream" | "codex" | "claude_code";
    conversationKey: number;
    kind: "global" | "paper";
    paperItemID?: number;
  }): Promise<Window> {
    await api.openTornChatWindowForTest({
      ...identity,
      libraryID: Number(Zotero.Libraries.userLibraryID),
    });
    await until(
      () => stateOf(tornWin()).conversationKey === identity.conversationKey,
      () =>
        `a follower shows chat ${identity.conversationKey}: ${JSON.stringify(stateOf(tornWin()))}`,
    );
    return tornWin()!;
  }

  /**
   * Papers A and B open in reader tabs, A shown; the standalone window shows
   * A's paper chat (one stored turn); a torn-off window shows the same chat.
   */
  async function setupTornOnA(title: string) {
    const a = await newPaper(`${title} A`);
    const b = await newPaper(`${title} B`);
    const readerA = await openReader(a);
    const readerB = await openReader(b);
    showReader(readerA);
    await api.openStandaloneForItem(a.parentItemId);
    await until(
      () =>
        stateOf(standaloneWin()).conversationKind === "paper" &&
        stateOf(standaloneWin()).basePaperItemId === a.parentItemId &&
        stateOf(standaloneWin()).conversationKey > 0,
      () =>
        `the standalone window shows A's paper chat: ${JSON.stringify(stateOf(standaloneWin()))}`,
    );
    await api.seedStandaloneConversation([
      { role: "user", text: `${title} seed question` },
      { role: "assistant", text: `${title} seed answer` },
    ]);
    const key = stateOf(standaloneWin()).conversationKey;
    const standalone = standaloneWin()!;
    const libraryID = Number(Zotero.Libraries.userLibraryID);
    const opened = await api.openTornChatWindowForTest({
      system: "upstream",
      conversationKey: key,
      kind: "paper",
      libraryID,
      paperItemID: a.parentItemId,
    });
    assert.match(opened.surface, /^torn:[^|]+$/u, JSON.stringify(opened));
    await until(
      () =>
        stateOf(tornWin()).conversationKey === key &&
        stateOf(tornWin()).basePaperItemId === a.parentItemId,
      () =>
        `the torn-off window shows A's chat ${key}: ${JSON.stringify(stateOf(tornWin()))}`,
    );
    // The torn-off window paints its own paper's chip a little later; wait
    // for it so callers start from a settled chip list.
    await until(
      () => chipKeys(tornWin()).some((k) => k.startsWith(`${a.parentItemId}:`)),
      () =>
        `the torn-off window shows A's own chip: ${JSON.stringify(chipKeys(tornWin()))}`,
    );
    // Compared with ===: chai cannot print a chrome window in a message.
    assert.isTrue(
      standaloneWin() === standalone,
      "the standalone window stays the session window after the tear-off",
    );
    return {
      a,
      b,
      readerA,
      readerB,
      key,
      libraryID,
      standalone,
      surface: opened.surface,
    };
  }

  function assertTornOnA(
    context: string,
    expected: { key: number; paperId: number },
  ): void {
    const state = stateOf(tornWin());
    assert.equal(
      state.conversationKind,
      "paper",
      `${context}: the torn-off window stays in Paper chat: ${JSON.stringify(state)}`,
    );
    assert.equal(
      state.conversationKey,
      expected.key,
      `${context}: the torn-off window keeps its chat: ${JSON.stringify(state)}`,
    );
    assert.equal(
      state.basePaperItemId,
      expected.paperId,
      `${context}: the torn-off window keeps its paper: ${JSON.stringify(state)}`,
    );
  }

  // ── Model menus ──────────────────────────────────────────────────────────

  const MODEL_MENU_OPTION = "#llm-model-menu .llm-model-option";

  function modelOptions(body: HTMLElement): HTMLElement[] {
    const inBody = Array.from(
      body.querySelectorAll(MODEL_MENU_OPTION),
    ) as HTMLElement[];
    return inBody.length
      ? inBody
      : (Array.from(
          body.ownerDocument.querySelectorAll(MODEL_MENU_OPTION),
        ) as HTMLElement[]);
  }

  const modelMenuOf = (body: HTMLElement): HTMLElement | null =>
    (body.querySelector("#llm-model-menu") as HTMLElement | null) ||
    (body.ownerDocument.querySelector("#llm-model-menu") as HTMLElement | null);

  const isModelMenuOpen = (body: HTMLElement) =>
    Boolean(modelMenuOf(body)?.classList.contains("llm-model-menu-open"));

  /** Opens the panel's model menu (rebuilt on open), reads it, closes it. */
  async function readModelMenu(
    body: HTMLElement,
    name: string,
  ): Promise<{ entryIds: string[]; selected: string; label: string }> {
    const toggle = body.querySelector(
      "#llm-model-toggle",
    ) as HTMLButtonElement | null;
    assert.isOk(toggle, `the ${name} has a model button`);
    if (isModelMenuOpen(body)) toggle!.click();
    toggle!.click();
    await until(
      () => isModelMenuOpen(body) && modelOptions(body).length > 0,
      () => `the ${name}'s model menu opens`,
    );
    const options = modelOptions(body);
    const result = {
      entryIds: options.map((option) => option.dataset.entryId || ""),
      selected:
        options.find((option) =>
          option.classList.contains("llm-menu-option-selected"),
        )?.dataset.entryId || "",
      label: readPanel(body).modelLabel,
    };
    if (isModelMenuOpen(body)) toggle!.click();
    return result;
  }

  async function selectModel(
    body: HTMLElement,
    entryId: string,
    model: string,
    name: string,
  ): Promise<void> {
    const toggle = body.querySelector(
      "#llm-model-toggle",
    ) as HTMLButtonElement | null;
    assert.isOk(toggle, `the ${name} has a model button`);
    if (isModelMenuOpen(body)) toggle!.click();
    toggle!.click();
    let option: HTMLElement | null = null;
    await until(
      () => {
        option =
          modelOptions(body).find(
            (candidate) => candidate.dataset.entryId === entryId,
          ) || null;
        return Boolean(option);
      },
      () => `the ${name}'s model menu offers ${entryId}`,
    );
    option!.click();
    await until(
      () => readPanel(body).modelLabel.includes(model),
      () =>
        `the ${name}'s model button shows ${model}: ${JSON.stringify(readPanel(body))}`,
    );
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = getWorkflowTestApi();
    for (const key of SAVED_PREF_KEYS) {
      previousPrefs.set(key, Zotero.Prefs.get(PREF_PREFIX + key, true));
    }
    provider = installHeldChatProvider(API_BASE);
    Zotero.Prefs.set(PREF_PREFIX + "sidebarLayout", "independent", true);
    Zotero.Prefs.set(PREF_PREFIX + "conversationSystem", "upstream", true);
    Zotero.Prefs.set(PREF_PREFIX + "enableCodexAppServerMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "enableClaudeCodeMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedRuntimeMode", "chat", true);
  });

  after(async function () {
    provider?.restore();
    await api.reset();
    for (const [key, value] of previousPrefs) {
      if (value === undefined) Zotero.Prefs.clear(PREF_PREFIX + key, true);
      else Zotero.Prefs.set(PREF_PREFIX + key, value, true);
    }
  });

  beforeEach(async function () {
    await api.reset();
    setModelProviderGroups([apiModelGroup()] as any);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedModelEntryId", ENTRY_A, true);
    assert.isOk(getModelEntryById(ENTRY_A), "fake model A is configured");
    assert.isOk(getModelEntryById(ENTRY_B), "fake model B is configured");
  });

  afterEach(async function () {
    provider.failOpenStreams("workflow case ended");
    await api.closeTornChatWindowsForTest();
    for (const reader of readers.splice(0)) {
      try {
        await mainWin().Zotero_Tabs.close(reader.tabID);
      } catch {
        // already closed
      }
    }
    mainWin().Zotero_Tabs?.select?.("zotero-pane");
    await api.closeStandalone();
    for (const chat of seededChats.splice(0)) {
      await api.deleteSeededHistoryConversation(chat);
    }
    for (const fixture of fixtures.splice(0)) {
      await api.cleanupFixture(fixture);
    }
    Zotero.Prefs.set(PREF_PREFIX + "enableCodexAppServerMode", false, true);
    await api.reset();
  });

  // ── W1 ───────────────────────────────────────────────────────────────────

  it("W1: a torn-off paper chat stays on its paper when Zotero switches PDF tabs", async function () {
    const { a, b, readerB, key } = await setupTornOnA("Torn W1");
    const torn = tornWin()!;
    assert.isTrue(
      torn !== standaloneWin(),
      "the torn-off window is not the standalone window",
    );
    assert.equal(
      torn.document.documentElement.getAttribute("windowtype"),
      "llmforzotero:chat",
      "the torn-off window declares its window type",
    );
    assert.notEqual(
      standaloneWin()!.document.documentElement.getAttribute("windowtype"),
      "llmforzotero:chat",
      "the standalone window keeps its window type",
    );
    assert.approximately(
      torn.outerWidth,
      420,
      4,
      "the torn-off window opens 420 px wide",
    );

    showReader(readerB);
    await until(
      () => stateOf(standaloneWin()).basePaperItemId === b.parentItemId,
      () =>
        `the standalone window follows the reader to B: ${JSON.stringify(stateOf(standaloneWin()))}`,
    );
    await Zotero.Promise.delay(500);
    assertTornOnA("after the reader switched to B", {
      key,
      paperId: a.parentItemId,
    });
    const chips = chipKeys(tornWin());
    assert.isNotEmpty(chips, "the torn-off window still shows a paper chip");
    for (const chip of chips) {
      assert.isTrue(
        chip.startsWith(`${a.parentItemId}:`),
        `the torn-off window's chips stay A's after the reader moved to B: ${JSON.stringify(chips)}`,
      );
    }
  });

  // ── W2 ───────────────────────────────────────────────────────────────────

  it("W2: closing paper A's PDF tab leaves the torn-off window on A", async function () {
    const { a, readerA, key } = await setupTornOnA("Torn W2");
    const tabs = mainWin().Zotero_Tabs;
    await tabs.close(readerA.tabID);
    await until(
      () =>
        tabs.selectedID !== readerA.tabID &&
        !(tabs._tabs || []).some((tab: any) => tab.id === readerA.tabID),
      () => "A's reader tab closes and Zotero selects another tab",
    );
    // The standalone window has followed the newly selected tab by now.
    await Zotero.Promise.delay(800);
    assert.isOk(standaloneWin(), "the standalone window stays open");
    assertTornOnA("after A's reader tab closed", {
      key,
      paperId: a.parentItemId,
    });
  });

  // ── W5 ───────────────────────────────────────────────────────────────────

  it("W5: closing a torn-off window leaves the standalone window following PDF tabs", async function () {
    const { b, readerB } = await setupTornOnA("Torn W5");
    await api.closeTornChatWindowsForTest();
    assert.lengthOf(api.getTornChatWindowsForTest(), 0);
    assert.isOk(standaloneWin(), "the standalone window stays open");
    showReader(readerB);
    await until(
      () => stateOf(standaloneWin()).basePaperItemId === b.parentItemId,
      () =>
        `the standalone window still follows the reader to B: ${JSON.stringify(stateOf(standaloneWin()))}`,
    );
    assert.isTrue(api.isStandaloneWindowActiveForTest());
  });

  // ── W6 ───────────────────────────────────────────────────────────────────

  it("W6: closing the standalone window leaves a torn-off window working", async function () {
    const { a, readerB, key } = await setupTornOnA("Torn W6");
    await api.closeStandalone();
    assert.isNull(standaloneWin(), "the standalone window closed");
    assert.isFalse(api.isStandaloneWindowActiveForTest());
    assert.isOk(tornWin(), "the torn-off window stays open");
    showReader(readerB);
    await Zotero.Promise.delay(600);
    assertTornOnA("after the standalone window closed and the reader moved", {
      key,
      paperId: a.parentItemId,
    });
    // Its History still lists every chat, its own included.
    await openFollowerHistory(tornWin()!, key);
  });

  // ── W7 ───────────────────────────────────────────────────────────────────

  it("W7: the torn-off window's paper moved to the trash shows the no-paper status", async function () {
    const { a } = await setupTornOnA("Torn W7");
    await Zotero.Items.trashTx([a.parentItemId]);
    await until(
      () =>
        stateOf(tornWin()).conversationKind === "global" &&
        stateOf(tornWin()).statusText.includes(NO_PAPER_STATUS),
      () =>
        `the torn-off window shows Library chat and the no-paper status: ${JSON.stringify(stateOf(tornWin()))}`,
    );
    await Zotero.Promise.delay(400);
    const state = stateOf(tornWin());
    assert.notEqual(
      state.basePaperItemId,
      a.parentItemId,
      `the trashed paper is not shown: ${JSON.stringify(state)}`,
    );
    assert.isAbove(state.conversationKey, 0, JSON.stringify(state));
    assert.isFalse(
      state.inputDisabled,
      `Library chat takes input: ${JSON.stringify(state)}`,
    );
  });

  // ── W8 ───────────────────────────────────────────────────────────────────

  it("W8: a torn-off window keeps its own model choice apart from the standalone window", async function () {
    await setupTornOnA("Torn W8");
    const tornBody = () => bodyOf(tornWin())!;
    const standaloneBody = () => bodyOf(standaloneWin())!;

    await selectModel(tornBody(), ENTRY_B, MODEL_B, "torn-off window");
    let standalone = await readModelMenu(standaloneBody(), "standalone window");
    assert.equal(
      standalone.selected,
      ENTRY_A,
      `the standalone window keeps model A: ${JSON.stringify(standalone)}`,
    );
    assert.equal(
      Zotero.Prefs.get(PREF_PREFIX + "lastUsedModelEntryId", true),
      ENTRY_A,
      "the torn-off window does not write the saved model",
    );

    await selectModel(standaloneBody(), ENTRY_B, MODEL_B, "standalone window");
    await selectModel(tornBody(), ENTRY_A, MODEL_A, "torn-off window");
    standalone = await readModelMenu(standaloneBody(), "standalone window");
    assert.equal(
      standalone.selected,
      ENTRY_B,
      `the standalone window keeps model B: ${JSON.stringify(standalone)}`,
    );
    const torn = await readModelMenu(tornBody(), "torn-off window");
    assert.equal(torn.selected, ENTRY_A, JSON.stringify(torn));
  });

  // ── W9 ───────────────────────────────────────────────────────────────────

  it("W9: a torn-off window offers no WebChat model entries", async function () {
    setModelProviderGroups([apiModelGroup(), webChatModelGroup()] as any);
    assert.isOk(getModelEntryById(WEBCHAT_ENTRY), "a WebChat model is offered");
    await setupTornOnA("Torn W9");

    const standalone = await readModelMenu(
      bodyOf(standaloneWin())!,
      "standalone window",
    );
    assert.include(
      standalone.entryIds,
      WEBCHAT_ENTRY,
      `the standalone window offers WebChat: ${JSON.stringify(standalone)}`,
    );
    const torn = await readModelMenu(bodyOf(tornWin())!, "torn-off window");
    assert.include(torn.entryIds, ENTRY_A, JSON.stringify(torn));
    assert.notInclude(
      torn.entryIds,
      WEBCHAT_ENTRY,
      `the torn-off window offers no WebChat model: ${JSON.stringify(torn)}`,
    );
    for (const entryId of torn.entryIds) {
      assert.notEqual(
        getModelEntryById(entryId)?.authMode,
        "webchat",
        `entry ${entryId} is not a WebChat entry`,
      );
    }
    assert.notEqual(
      rootOf(tornWin())?.dataset.webchatMode,
      "true",
      "the torn-off window is not in WebChat",
    );
  });

  // ── W9c ──────────────────────────────────────────────────────────────────

  it("W9c: a new chat started in the standalone window right after a torn-off window opened is unaffected", async function () {
    const { a, key, standalone } = await setupTornOnA("Torn W9c");
    const torn = tornWin()!;
    assert.isTrue(
      (Zotero as any).LLMForZotero.data.standaloneWindow === standalone,
      "the standalone window is still the session window",
    );

    // A new chat in the standalone window lands there, not in the torn one.
    const fresh = await api.startNewStandaloneConversation();
    assert.notEqual(fresh.conversationKey, key, JSON.stringify(fresh));
    assert.isTrue(standaloneWin() === standalone, "the same standalone window");
    assert.equal(stateOf(standalone).conversationKey, fresh.conversationKey);
    assert.equal(stateOf(torn).conversationKey, key, "the torn chat is kept");

    // The standalone window reopens while a torn-off window closes.
    await api.closeStandalone();
    assert.isFalse(api.isStandaloneWindowActiveForTest());
    api.beginOpenStandaloneForTest(a.parentItemId);
    torn.close();
    const samples: boolean[] = [];
    await until(
      () => {
        samples.push(api.isStandaloneWindowActiveForTest());
        return Boolean(rootOf(standaloneWin())?.dataset.handlersInitialized);
      },
      () => "the standalone window opens",
    );
    await until(
      () => api.getTornChatWindowsForTest().length === 0,
      () => "the torn-off window closed",
    );
    samples.push(api.isStandaloneWindowActiveForTest());
    assert.notInclude(
      samples,
      false,
      `the standalone window counts as active throughout its open: ${JSON.stringify(samples)}`,
    );
    const reopened = standaloneWin()!;
    assert.isTrue(reopened !== torn, "the reopened window is not the torn one");

    // Opening again focuses the one standalone window.
    api.beginOpenStandaloneForTest(a.parentItemId);
    await Zotero.Promise.delay(500);
    assert.isTrue(
      standaloneWin() === reopened,
      "opening again focuses the same standalone window",
    );
    const windows = api.listChatWindowsForTest();
    assert.lengthOf(
      windows.filter((entry) => !entry.torn),
      1,
      `one standalone window: ${JSON.stringify(windows)}`,
    );
    assert.lengthOf(
      windows.filter((entry) => entry.torn),
      0,
      `no torn-off window: ${JSON.stringify(windows)}`,
    );
    const again = await api.startNewStandaloneConversation();
    assert.isAbove(toKey(again.conversationKey), 0, JSON.stringify(again));
  });

  // ── W10 ──────────────────────────────────────────────────────────────────

  it("W10: every follower, paper or library chat, shows the unlinked icon before its title, and the leader never does", async function () {
    const { standalone } = await setupTornOnA("Torn W10");
    const iconOf = (win: Window) =>
      win.document.querySelector(
        "span.llm-standalone-unlinked-icon",
      ) as HTMLElement | null;
    const assertIconBeforeTitle = (win: Window, context: string) => {
      const icon = iconOf(win);
      const title = followerTitleOf(win);
      assert.isOk(icon, `${context}: the follower has an unlinked icon`);
      assert.isTrue(isShown(icon), `${context}: the icon shows`);
      assert.isOk(title, `${context}: the follower has a title`);
      assert.isTrue(
        Boolean(
          icon!.compareDocumentPosition(title!) &
          (win as any).Node.DOCUMENT_POSITION_FOLLOWING,
        ),
        `${context}: the icon comes before the title`,
      );
      assert.equal(
        icon!.title,
        "Not linked to the PDF reader. Switching PDF tabs does not change this chat.",
      );
      assert.equal(
        windowRoot(win)?.getAttribute("data-reader-link"),
        "unlinked",
      );
    };

    assertIconBeforeTitle(tornWin()!, "paper chat");
    assert.isNull(iconOf(standalone), "the leader has no unlinked icon");
    assert.isNull(windowRoot(standalone)?.getAttribute("data-reader-link"));

    await api.closeTornChatWindowsForTest();
    const library = await seedChat({
      system: "upstream",
      kind: "global",
      userText: "Torn W10 library question",
    });
    const torn = await openFollower({
      system: "upstream",
      conversationKey: library.conversationKey,
      kind: "global",
    });
    assert.equal(stateOf(torn).conversationKind, "global");
    assertIconBeforeTitle(torn, "library chat");
    assert.isNull(iconOf(standalone), "the leader still has no icon");
  });

  // ── W24 ──────────────────────────────────────────────────────────────────

  it("W24: a follower shows one chat's controls in two rows and none of the leader's navigation", async function () {
    // Codex on: the leader then offers runtime controls a follower must not.
    Zotero.Prefs.set(PREF_PREFIX + "enableCodexAppServerMode", true, true);
    const { key, standalone } = await setupTornOnA("Torn W24");
    const torn = tornWin()!;
    const doc = torn.document;
    assert.equal(
      windowRoot(torn)?.getAttribute("data-window-role"),
      "follower",
    );
    assert.equal(
      windowRoot(standalone)?.getAttribute("data-window-role"),
      "leader",
    );

    // Leader-only navigation is absent.
    for (const selector of [
      ".llm-standalone-sidebar",
      ".llm-standalone-tab-group",
      ".llm-standalone-tab[data-tab]",
      "[data-sidebar-action='new-chat']",
      "[data-sidebar-action='search-history']",
      ".llm-standalone-conv-group-new",
      ".llm-standalone-pinned-region",
      ".llm-standalone-icon-pin",
      ".llm-standalone-runtime-system-controls",
    ]) {
      assert.lengthOf(
        shownIn(torn, selector),
        0,
        `the follower shows no ${selector}`,
      );
    }
    assert.isAbove(
      shownIn(standalone, ".llm-standalone-runtime-system-controls button")
        .length,
      0,
      "the leader shows its runtime controls",
    );
    // The composer's runtime badge names the runtime but switches nothing.
    const badge = bodyOf(torn)?.querySelector(
      "#llm-runtime-mode-toggle",
    ) as HTMLButtonElement | null;
    assert.isTrue(
      !isShown(badge) || badge!.disabled,
      "the follower's runtime badge is not a switch",
    );

    // Its own controls, each once.
    const one = (selector: string): HTMLElement => {
      const shown = shownIn(torn, selector);
      assert.lengthOf(shown, 1, `the follower shows one ${selector}`);
      return shown[0];
    };
    const title = one(".llm-follower-title");
    const icon = one(".llm-standalone-unlinked-icon");
    const sidePanel = one(".llm-standalone-side-panel-toggle");
    const openMain = one(".llm-follower-open-main");
    const history = one(".llm-follower-history");
    const exportButton = one(".llm-standalone-icon-export");
    const deleteButton = one(".llm-standalone-icon-clear");
    assert.equal(openMain.title, "Open in main window");
    assert.lengthOf(
      torn.document.querySelectorAll(".llm-follower-pin"),
      0,
      "the follower has no keep-on-top pin",
    );
    assert.equal(history.title, "History");

    // Top row: icon, title, then side panel and Open in main window.
    const topRow = doc.querySelector(".llm-standalone-tab-row")!;
    for (const node of [icon, title, sidePanel, openMain]) {
      assert.isTrue(
        topRow.contains(node),
        `${node.className} is in the top row`,
      );
    }
    // The window buttons (macOS draws its traffic lights there) lead the
    // top row; the sidebar toggle that goes with them in the leader does not.
    const windowButtons = doc.querySelector(".llm-window-buttons");
    assert.isTrue(
      Boolean(windowButtons && topRow.contains(windowButtons)),
      "the window buttons are in the top row",
    );
    assert.lengthOf(shownIn(torn, ".llm-standalone-nav-toggle"), 0);
    const left = (node: Element) => node.getBoundingClientRect().left;
    assert.isBelow(left(title), left(sidePanel));
    assert.isBelow(left(sidePanel), left(openMain));
    // Second row: History on the left, export and delete on the right.
    const secondRow = doc.querySelector(".llm-standalone-content-title")!;
    for (const node of [history, exportButton, deleteButton]) {
      assert.isTrue(
        secondRow.contains(node),
        `${node.className} is in the second row`,
      );
    }
    assert.isBelow(left(history), left(exportButton));
    assert.isBelow(left(exportButton), left(deleteButton));
    assert.isBelow(
      topRow.getBoundingClientRect().top,
      secondRow.getBoundingClientRect().top,
      "the top row is above the second row",
    );
    assert.isBelow(
      secondRow.getBoundingClientRect().top,
      (doc.querySelector("#llm-input") as HTMLElement).getBoundingClientRect()
        .top,
      "the composer is below both rows",
    );

    // History opens the all-chats popup under its button.
    await openFollowerHistory(torn, key);
    const popup = searchOverlayOf(torn)!.querySelector(
      ".llm-standalone-search-popup",
    ) as HTMLElement;
    const historyRect = history.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    assert.isAtLeast(
      popupRect.top,
      historyRect.bottom - 1,
      "the popup opens below the History button",
    );
    assert.isAtMost(
      Math.abs(popupRect.left - historyRect.left),
      16,
      `the popup lines up with the History button: ${JSON.stringify({
        popup: popupRect.left,
        history: historyRect.left,
      })}`,
    );
    const input = searchOverlayOf(torn)!.querySelector(
      ".llm-standalone-search-input",
    ) as HTMLElement;
    input.dispatchEvent(
      new (torn as any).KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }),
    );
    assert.equal(searchOverlayOf(torn)?.style.display, "none");

    // The follower keeps a minimum of its own, below the leader's 500 px.
    torn.resizeTo(370, 500);
    await until(
      () => Math.abs(torn.outerWidth - 370) <= 4,
      () => `the follower narrows to 370 px: ${torn.outerWidth}`,
    );
    await Zotero.Promise.delay(400);
    assert.approximately(torn.outerWidth, 370, 4, "it is not grown back");
    torn.resizeTo(300, 400);
    await Zotero.Promise.delay(600);
    assert.isAtLeast(torn.outerWidth, 356, "it stops at 360 px wide");
    assert.isAtLeast(torn.outerHeight, 476, "it stops at 480 px high");
  });

  // ── W24b ─────────────────────────────────────────────────────────────────

  it("W24b: History in a follower opens paper A's Codex chat while Zotero shows paper C, and the next answer uses A", async function () {
    Zotero.Prefs.set(PREF_PREFIX + "enableCodexAppServerMode", true, true);
    const a = await newPaper("Torn W24b A");
    const c = await newPaper("Torn W24b C");
    await openReader(a);
    const readerC = await openReader(c);
    const library = await seedChat({
      system: "upstream",
      kind: "global",
      userText: "Torn W24b library question",
    });
    const codexA = await seedChat({
      system: "codex",
      kind: "paper",
      paperItemId: a.parentItemId,
      userText: "Torn W24b Codex question",
    });
    const agentA = await seedChat({
      system: "upstream",
      kind: "paper",
      paperItemId: a.parentItemId,
      userText: "Torn W24b Agent question",
    });
    const torn = await openFollower({
      system: "upstream",
      conversationKey: library.conversationKey,
      kind: "global",
    });
    showReader(readerC);
    await Zotero.Promise.delay(300);
    const selectedTab = mainWin().Zotero_Tabs.selectedID;
    assert.equal(selectedTab, readerC.tabID, "Zotero shows C");

    // Every state the follower passes through on the way, sampled.
    const seenPapers = new Set<number>();
    const settlesOn = async (key: number, system: string) => {
      await until(
        () => {
          const state = stateOf(tornWin());
          seenPapers.add(state.basePaperItemId);
          return (
            state.conversationKey === key &&
            rootOf(tornWin())?.dataset.conversationSystem === system &&
            chipKeys(tornWin()).some((k) => k.startsWith(`${a.parentItemId}:`))
          );
        },
        () =>
          `the follower shows ${system} chat ${key} on A: ${JSON.stringify({
            state: stateOf(tornWin()),
            system: rootOf(tornWin())?.dataset.conversationSystem,
            chips: chipKeys(tornWin()),
          })}`,
        15_000,
      );
    };

    (await openFollowerHistory(torn, codexA.conversationKey)).click();
    await settlesOn(codexA.conversationKey, "codex");
    let state = stateOf(tornWin());
    assert.equal(state.conversationKind, "paper", JSON.stringify(state));
    assert.equal(state.basePaperItemId, a.parentItemId, JSON.stringify(state));
    for (const chip of chipKeys(tornWin())) {
      assert.isTrue(
        chip.startsWith(`${a.parentItemId}:`),
        `the follower's chips are A's: ${JSON.stringify(chipKeys(tornWin()))}`,
      );
    }

    // Back to the Agent runtime on A's own chat, then ask.
    (await openFollowerHistory(torn, agentA.conversationKey)).click();
    await settlesOn(agentA.conversationKey, "upstream");
    state = stateOf(tornWin());
    assert.equal(state.basePaperItemId, a.parentItemId, JSON.stringify(state));
    assert.notInclude(
      Array.from(seenPapers),
      c.parentItemId,
      "the follower never showed C, the paper Zotero shows",
    );
    assert.equal(
      mainWin().Zotero_Tabs.selectedID,
      selectedTab,
      "Zotero still shows C",
    );

    api.enableLiveAgentSending();
    const question = "Torn W24b question about its paper";
    const body = bodyOf(tornWin())!;
    const input = body.querySelector("#llm-input") as HTMLTextAreaElement;
    input.value = question;
    input.dispatchEvent(new (torn as any).Event("input", { bubbles: true }));
    (body.querySelector("#llm-send") as HTMLButtonElement).click();
    const stream = await provider.waitForStream(question);
    try {
      assert.include(
        stream.requestBody,
        "Torn W24b A: a short page",
        "the request carries paper A's text",
      );
      assert.notInclude(
        stream.requestBody,
        "Torn W24b C: a short page",
        "the request does not carry paper C's text",
      );
    } finally {
      stream.finish();
    }
  });

  // ── W25 ──────────────────────────────────────────────────────────────────

  it("W25: a follower's title is the paper's short label for a paper chat and the chat's title for a library chat", async function () {
    const a = await newPaper("Torn W25 A");
    const paper = Zotero.Items.get(a.parentItemId);
    paper.setCreators([
      { firstName: "Ada", lastName: "Klaus", creatorType: "author" },
    ]);
    paper.setField("date", "2017");
    await paper.saveTx();
    const paperChat = await seedChat({
      system: "upstream",
      kind: "paper",
      paperItemId: a.parentItemId,
      userText: "Torn W25 paper question",
    });
    await openFollower({
      system: "upstream",
      conversationKey: paperChat.conversationKey,
      kind: "paper",
      paperItemID: a.parentItemId,
    });
    await until(
      () => textOf(followerTitleOf(tornWin())) === "Klaus, 2017",
      () =>
        `the paper chat's title is the short label: ${JSON.stringify(textOf(followerTitleOf(tornWin())))}`,
    );

    await api.closeTornChatWindowsForTest();
    const library = await seedChat({
      system: "upstream",
      kind: "global",
      userText: "Torn W25 library question",
    });
    await Zotero.DB.queryAsync(
      "UPDATE llm_for_zotero_global_conversations SET title = ? WHERE conversation_key = ?",
      ["Torn W25 library title", library.conversationKey],
    );
    await openFollower({
      system: "upstream",
      conversationKey: library.conversationKey,
      kind: "global",
    });
    await until(
      () => textOf(followerTitleOf(tornWin())) === "Torn W25 library title",
      () =>
        `the library chat's title is its own: ${JSON.stringify(textOf(followerTitleOf(tornWin())))}`,
    );
  });

  // ── Tear-off gesture and row menu ────────────────────────────────────────

  type ScreenRect = {
    left: number;
    top: number;
    width: number;
    height: number;
  };

  /** Every open Zotero or plugin window. */
  function openWindowRects(): ScreenRect[] {
    const services =
      (globalThis as any).Services || (mainWin() as any).Services;
    const rects: ScreenRect[] = [];
    const enumerator = services.wm.getEnumerator(null);
    while (enumerator.hasMoreElements()) {
      const win = enumerator.getNext() as any;
      if (!win || win.closed) continue;
      rects.push({
        left: win.screenX,
        top: win.screenY,
        width: win.outerWidth,
        height: win.outerHeight,
      });
    }
    return rects;
  }

  /** A screen point right of every open window. */
  function pointOutsideEveryWindow(): { screenX: number; screenY: number } {
    const rects = openWindowRects();
    const right = Math.max(...rects.map((rect) => rect.left + rect.width));
    const top = Math.min(...rects.map((rect) => rect.top));
    return { screenX: right + 200, screenY: top + 40 };
  }

  const listRows = (win: Window | null): HTMLElement[] =>
    Array.from(
      win?.document.querySelectorAll(
        ".llm-standalone-sidebar-list .llm-standalone-conv-item",
      ) || [],
    ) as HTMLElement[];

  const rowOf = (win: Window | null, key: number): HTMLElement | null =>
    listRows(win).find((row) => toKey(row.dataset.conversationKey) === key) ||
    null;

  const titleOf = (win: Window): HTMLElement | null =>
    win.document.querySelector(
      ".llm-standalone-content-title-text",
    ) as HTMLElement | null;

  const convMenuOf = (win: Window): HTMLElement | null =>
    win.document.querySelector(
      ".llm-standalone-conv-ctx-menu",
    ) as HTMLElement | null;

  const isConvMenuShown = (win: Window): boolean => {
    const menu = convMenuOf(win);
    return Boolean(menu && menu.style.display !== "none");
  };

  /** Dispatches a synthetic dragstart on `source`; returns its DataTransfer. */
  function startDrag(win: Window, source: HTMLElement): DataTransfer {
    const transfer = new (win as any).DataTransfer() as DataTransfer;
    source.dispatchEvent(
      new (win as any).DragEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
    return transfer;
  }

  /** Ends the drag on `source` at a screen point. */
  function endDrag(
    win: Window,
    source: HTMLElement,
    transfer: DataTransfer,
    point: { screenX: number; screenY: number },
  ): void {
    source.dispatchEvent(
      new (win as any).DragEvent("dragend", {
        bubbles: true,
        dataTransfer: transfer,
        screenX: point.screenX,
        screenY: point.screenY,
      }),
    );
  }

  /** Fires a drag event of `type` on `target` (dragover, drop, drag, dragend). */
  function fireDrag(
    win: Window,
    target: Element,
    type: string,
    transfer: DataTransfer,
    point: { screenX: number; screenY: number } = { screenX: 0, screenY: 0 },
  ): DragEvent {
    const event = new (win as any).DragEvent(type, {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      screenX: point.screenX,
      screenY: point.screenY,
    }) as DragEvent;
    target.dispatchEvent(event);
    return event;
  }

  /** The leader's chat list: a row drag's source region. */
  const sourceListOf = (win: Window): HTMLElement =>
    win.document.querySelector(".llm-standalone-sidebar-list") as HTMLElement;

  /** The leader's title row: the title drag's source region. */
  const titleRowOf = (win: Window): HTMLElement =>
    titleOf(win)!.closest(".llm-standalone-content-title") as HTMLElement;

  /** The middle of the main Zotero window, in screen pixels. */
  function pointOverMainWindow(): { screenX: number; screenY: number } {
    const win = mainWin();
    return {
      screenX: win.screenX + Math.round(win.outerWidth / 2),
      screenY: win.screenY + Math.round(win.outerHeight / 2),
    };
  }

  function openRowMenu(win: Window, row: HTMLElement): void {
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(
      new (win as any).MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: rect.left + 10,
        clientY: rect.top + rect.height / 2,
      }),
    );
  }

  /**
   * Paper A's chat (one stored turn) in the standalone window, listed in
   * its sidebar.
   */
  async function setupStandaloneOnA(title: string) {
    const a = await newPaper(`${title} A`);
    await api.openStandaloneForItem(a.parentItemId);
    await until(
      () =>
        stateOf(standaloneWin()).conversationKind === "paper" &&
        stateOf(standaloneWin()).basePaperItemId === a.parentItemId &&
        stateOf(standaloneWin()).conversationKey > 0,
      () =>
        `the standalone window shows A's paper chat: ${JSON.stringify(stateOf(standaloneWin()))}`,
    );
    await api.seedStandaloneConversation([
      { role: "user", text: `${title} seed question` },
      { role: "assistant", text: `${title} seed answer` },
    ]);
    const key = stateOf(standaloneWin()).conversationKey;
    await until(
      () => Boolean(rowOf(standaloneWin(), key)),
      () =>
        `the standalone window lists A's chat ${key}: ${JSON.stringify(listedConversationKeys(standaloneWin()))}`,
    );
    return { a, key, standalone: standaloneWin()! };
  }

  // ── W11 ──────────────────────────────────────────────────────────────────

  it("W11: a list row released over the main Zotero window opens a follower on that chat", async function () {
    const { a, key, standalone } = await setupStandaloneOnA("Torn W11");
    const row = rowOf(standalone, key)!;
    assert.equal(row.getAttribute("draggable"), "true", "the row is draggable");
    assert.equal(
      titleOf(standalone)?.getAttribute("draggable"),
      "true",
      "the chat title is draggable in Paper chat",
    );

    const transfer = startDrag(standalone, row);
    assert.deepEqual(
      Array.from(transfer.types),
      [TEAR_OFF_MIME],
      "the drag carries only the plugin's own type",
    );
    assert.equal(transfer.effectAllowed, "move");
    assert.deepEqual(decodeTornChatIdentity(transfer.getData(TEAR_OFF_MIME)), {
      system: "upstream",
      conversationKey: key,
      kind: "paper",
      libraryID: Number(Zotero.Libraries.userLibraryID),
      paperItemID: a.parentItemId,
    });
    assert.isFalse(
      Boolean((transfer as any).mozShowFailAnimation),
      "a drop outside every window does not slide the image back",
    );
    // The drag image: a small window shape off-screen, rendered (not
    // display:none), with the unlinked icon and the follower's title.
    const image = standalone.document.querySelector(
      ".llm-tear-off-drag-image",
    ) as HTMLElement | null;
    assert.isOk(image, "the leader renders a drag image");
    assert.notEqual(
      standalone.getComputedStyle(image!)!.display,
      "none",
      "the drag image is rendered",
    );
    const imageRect = image!.getBoundingClientRect();
    assert.isAbove(imageRect.width, 0, "the drag image has a size");
    assert.isAtMost(imageRect.right, 0, "the drag image is off-screen");
    assert.isOk(
      image!.querySelector(".llm-standalone-unlinked-icon"),
      "the drag image shows the unlinked icon",
    );
    const imageTitle = textOf(
      image!.querySelector(".llm-tear-off-drag-image-title"),
    );

    // The list renders again mid-drag: the row the drag started on is gone.
    row.remove();
    assert.isNull(rowOf(standalone, key), "the source row was replaced");
    // dataTransfer.addElement sends dragend to the list, not the row.
    fireDrag(
      standalone,
      sourceListOf(standalone),
      "dragend",
      transfer,
      pointOverMainWindow(),
    );
    await until(
      () =>
        api.getTornChatWindowsForTest().length === 1 &&
        stateOf(tornWin()).conversationKey === key,
      () =>
        `one follower opens on chat ${key}: ${JSON.stringify({
          windows: api.getTornChatWindowsForTest().length,
          state: stateOf(tornWin()),
        })}`,
      15_000,
    );
    assertTornOnA("after the tear-off drag", {
      key,
      paperId: a.parentItemId,
    });
    await until(
      () => textOf(followerTitleOf(tornWin())) === imageTitle,
      () =>
        `the drag image showed the follower's title: ${JSON.stringify({
          image: imageTitle,
          follower: textOf(followerTitleOf(tornWin())),
        })}`,
    );
    assert.isTrue(
      standaloneWin() === standalone,
      "the standalone window stays the session window",
    );
    assert.equal(
      stateOf(standalone).conversationKey,
      key,
      "the standalone window still shows its chat",
    );
  });

  // ── W11b ─────────────────────────────────────────────────────────────────

  it("W11b: a dragend with no screen point opens at the last drag point, and a row released on the title row opens too", async function () {
    const { key, standalone } = await setupStandaloneOnA("Torn W11b");
    const row = rowOf(standalone, key)!;
    const transfer = startDrag(standalone, row);
    // A row drag dropped on the title row: not its own source region.
    fireDrag(standalone, titleRowOf(standalone), "dragover", transfer);
    fireDrag(standalone, titleRowOf(standalone), "drop", transfer);
    // `drag` goes to the list too (addElement); dragend reports (0, 0).
    fireDrag(
      standalone,
      sourceListOf(standalone),
      "drag",
      transfer,
      pointOverMainWindow(),
    );
    fireDrag(standalone, sourceListOf(standalone), "dragend", transfer);
    await until(
      () =>
        api.getTornChatWindowsForTest().length === 1 &&
        stateOf(tornWin()).conversationKey === key,
      () =>
        `one follower opens on chat ${key}: ${JSON.stringify({
          windows: api.getTornChatWindowsForTest().length,
          state: stateOf(tornWin()),
        })}`,
      15_000,
    );
  });

  // ── W12 ──────────────────────────────────────────────────────────────────

  it("W12: a drag released back on its own source region, or with no point at all, opens nothing", async function () {
    const { key, standalone } = await setupStandaloneOnA("Torn W12");
    const list = sourceListOf(standalone);

    // A row dropped back on the chat list opens nothing, wherever dragend
    // says it ended.
    let row = rowOf(standalone, key)!;
    let transfer = startDrag(standalone, row);
    const over = fireDrag(standalone, row, "dragover", transfer);
    assert.isTrue(
      over.defaultPrevented,
      "the chat list accepts its own row's drag",
    );
    fireDrag(standalone, row, "drop", transfer);
    fireDrag(standalone, list, "dragend", transfer, pointOutsideEveryWindow());

    // The title dropped back on its own title row opens nothing.
    const title = titleOf(standalone)!;
    transfer = startDrag(standalone, title);
    assert.deepEqual(Array.from(transfer.types), [TEAR_OFF_MIME]);
    fireDrag(standalone, title, "dragover", transfer);
    fireDrag(standalone, title, "drop", transfer);
    fireDrag(
      standalone,
      titleRowOf(standalone),
      "dragend",
      transfer,
      pointOverMainWindow(),
    );

    // A drag with no usable point, from dragend or any drag event, opens
    // nothing.
    row = rowOf(standalone, key)!;
    transfer = startDrag(standalone, row);
    fireDrag(standalone, list, "drag", transfer);
    fireDrag(standalone, list, "dragend", transfer);

    await Zotero.Promise.delay(1000);
    assert.lengthOf(api.getTornChatWindowsForTest(), 0, "no follower opened");
    assert.equal(stateOf(standalone).conversationKey, key);
  });

  // ── W13 ──────────────────────────────────────────────────────────────────

  it("W13: right-click Open in New Window opens a torn-off window", async function () {
    const { a, key, standalone } = await setupStandaloneOnA("Torn W13");
    const row = rowOf(standalone, key)!;
    openRowMenu(standalone, row);
    assert.isTrue(isConvMenuShown(standalone), "the row menu opens");
    const items = Array.from(
      convMenuOf(standalone)!.querySelectorAll("button"),
    ) as HTMLButtonElement[];
    assert.deepEqual(
      items.map((item) => textOf(item)),
      ["Open in New Window"],
      "the menu has one item",
    );
    items[0].click();
    assert.isFalse(isConvMenuShown(standalone), "the menu closes");
    await until(
      () =>
        api.getTornChatWindowsForTest().length === 1 &&
        stateOf(tornWin()).conversationKey === key,
      () =>
        `one torn-off window opens on chat ${key}: ${JSON.stringify(stateOf(tornWin()))}`,
      15_000,
    );
    assertTornOnA("after Open in New Window", {
      key,
      paperId: a.parentItemId,
    });
    assert.equal(stateOf(standalone).conversationKey, key);

    // Escape closes the menu without opening anything.
    openRowMenu(standalone, rowOf(standalone, key)!);
    assert.isTrue(isConvMenuShown(standalone));
    standalone.document.dispatchEvent(
      new (standalone as any).KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }),
    );
    assert.isFalse(isConvMenuShown(standalone), "Escape closes the menu");
    assert.lengthOf(api.getTornChatWindowsForTest(), 1);
  });

  // ── W14 ──────────────────────────────────────────────────────────────────

  it("W14: WebChat rows and note chats are not draggable and have no Open in New Window item", async function () {
    // A note chat.
    const note = await api.createStandaloneNoteFixture({
      noteHtml: "<p>Torn W14 note</p><p>Body.</p>",
    });
    fixtures.push(note as unknown as WorkflowTestFixture);
    await api.openStandaloneForItem(note.noteItemId);
    await until(
      () => stateOf(standaloneWin()).conversationKey > 0,
      () =>
        `the standalone window shows the note chat: ${JSON.stringify(stateOf(standaloneWin()))}`,
    );
    await api.seedStandaloneConversation([
      { role: "user", text: "Torn W14 note question" },
      { role: "assistant", text: "Torn W14 note answer" },
    ]);
    let standalone = standaloneWin()!;
    const noteKey = stateOf(standalone).conversationKey;
    await until(
      () => Boolean(rowOf(standaloneWin(), noteKey)),
      () =>
        `the note chat ${noteKey} is listed: ${JSON.stringify(listedConversationKeys(standaloneWin()))}`,
    );
    for (const row of listRows(standalone)) {
      assert.notEqual(
        row.getAttribute("draggable"),
        "true",
        `note chat row ${row.dataset.conversationKey} is not draggable`,
      );
    }
    assert.isNull(
      titleOf(standalone)!.getAttribute("draggable"),
      "the note chat title is not draggable",
    );
    const noteRow = rowOf(standalone, noteKey)!;
    openRowMenu(standalone, noteRow);
    assert.isFalse(isConvMenuShown(standalone), "a note chat row has no menu");
    let transfer = startDrag(standalone, noteRow);
    assert.notInclude(Array.from(transfer.types), TEAR_OFF_MIME);
    endDrag(standalone, noteRow, transfer, pointOutsideEveryWindow());
    transfer = startDrag(standalone, titleOf(standalone)!);
    assert.notInclude(Array.from(transfer.types), TEAR_OFF_MIME);
    endDrag(
      standalone,
      titleOf(standalone)!,
      transfer,
      pointOutsideEveryWindow(),
    );
    await Zotero.Promise.delay(500);
    assert.lengthOf(api.getTornChatWindowsForTest(), 0);

    // WebChat.
    setModelProviderGroups([apiModelGroup(), webChatModelGroup()] as any);
    const { key } = await setupStandaloneOnA("Torn W14");
    standalone = standaloneWin()!;
    assert.equal(rowOf(standalone, key)?.getAttribute("draggable"), "true");
    const body = bodyOf(standalone)!;
    const toggle = body.querySelector(
      "#llm-model-toggle",
    ) as HTMLButtonElement | null;
    assert.isOk(toggle, "the standalone window has a model button");
    if (isModelMenuOpen(body)) toggle!.click();
    toggle!.click();
    let webChatOption: HTMLElement | null = null;
    await until(
      () => {
        webChatOption =
          modelOptions(body).find(
            (option) => option.dataset.entryId === WEBCHAT_ENTRY,
          ) || null;
        return Boolean(webChatOption);
      },
      () => "the standalone window offers the WebChat model",
    );
    webChatOption!.click();
    await until(
      () => rootOf(standaloneWin())?.dataset.webchatMode === "true",
      () => "the standalone window enters WebChat",
      15_000,
    );
    await until(
      () =>
        !listRows(standaloneWin()).some(
          (row) => row.getAttribute("draggable") === "true",
        ) && titleOf(standaloneWin()!)?.getAttribute("draggable") === null,
      () =>
        `no row or title is draggable in WebChat: ${JSON.stringify(
          listRows(standaloneWin()).map((row) => ({
            key: row.dataset.conversationKey || "",
            draggable: row.getAttribute("draggable"),
          })),
        )}`,
    );
    standalone = standaloneWin()!;
    for (const row of listRows(standalone)) {
      openRowMenu(standalone, row);
      assert.isFalse(
        isConvMenuShown(standalone),
        "a WebChat row has no Open in New Window item",
      );
    }
    transfer = startDrag(standalone, titleOf(standalone)!);
    assert.notInclude(Array.from(transfer.types), TEAR_OFF_MIME);
    endDrag(
      standalone,
      titleOf(standalone)!,
      transfer,
      pointOutsideEveryWindow(),
    );
    await Zotero.Promise.delay(500);
    assert.lengthOf(api.getTornChatWindowsForTest(), 0);
  });

  // ── One window per chat; followers are never sources ─────────────────────

  /** Counts `win.focus()` calls until restored. */
  function spyOnFocus(win: Window): {
    count: () => number;
    restore: () => void;
  } {
    const original = win.focus;
    let calls = 0;
    (win as any).focus = function (this: unknown, ...args: unknown[]) {
      calls += 1;
      return (original as any).apply(win, args);
    };
    return {
      count: () => calls,
      restore: () => {
        delete (win as any).focus;
      },
    };
  }

  /** Opens a follower on a stored chat; returns the window that holds it. */
  async function openAnotherFollower(identity: {
    system: "upstream" | "codex" | "claude_code";
    conversationKey: number;
    kind: "global" | "paper";
    paperItemID?: number;
  }): Promise<Window> {
    const before = api.getTornChatWindowsForTest();
    await api.openTornChatWindowForTest({
      ...identity,
      libraryID: Number(Zotero.Libraries.userLibraryID),
    });
    const opened = api
      .getTornChatWindowsForTest()
      .find((win) => !before.includes(win));
    assert.isOk(opened, `a new follower opens on ${identity.conversationKey}`);
    await until(
      () => stateOf(opened!).conversationKey === identity.conversationKey,
      () =>
        `the new follower shows chat ${identity.conversationKey}: ${JSON.stringify(stateOf(opened!))}`,
    );
    return opened!;
  }

  // ── W26 ──────────────────────────────────────────────────────────────────

  it("W26: opening a chat a follower holds brings that follower forward and opens nothing", async function () {
    const { a, key, standalone } = await setupStandaloneOnA("Torn W26");
    const clickOpenInNewWindow = () => {
      openRowMenu(standalone, rowOf(standalone, key)!);
      assert.isTrue(isConvMenuShown(standalone), "the row menu opens");
      (
        convMenuOf(standalone)!.querySelector(
          '[data-action="open-in-new-window"]',
        ) as HTMLButtonElement
      ).click();
    };
    clickOpenInNewWindow();
    await until(
      () =>
        api.getTornChatWindowsForTest().length === 1 &&
        stateOf(tornWin()).conversationKey === key,
      () =>
        `one follower opens on chat ${key}: ${JSON.stringify(stateOf(tornWin()))}`,
      15_000,
    );
    const follower = tornWin()!;
    const focus = spyOnFocus(follower);
    try {
      // The row menu again.
      clickOpenInNewWindow();
      await until(
        () => focus.count() === 1,
        () => `the follower comes forward: ${focus.count()} focus calls`,
      );
      await Zotero.Promise.delay(500);
      assert.lengthOf(
        api.getTornChatWindowsForTest(),
        1,
        "the menu opened no second follower",
      );

      // The open function every follower path uses (drag, menu, tests).
      const opened = await api.openTornChatWindowForTest({
        system: "upstream",
        conversationKey: key,
        kind: "paper",
        libraryID: Number(Zotero.Libraries.userLibraryID),
        paperItemID: a.parentItemId,
      });
      assert.equal(focus.count(), 2, "the follower comes forward again");
      assert.equal(
        opened.surface,
        bodyOf(follower)?.dataset.selectionSurface,
        "the open function hands back the follower that holds the chat",
      );
      await Zotero.Promise.delay(500);
      assert.lengthOf(
        api.getTornChatWindowsForTest(),
        1,
        "the open function opened no second follower",
      );
      assert.isTrue(tornWin() === follower, "the same follower stays open");
      assertTornOnA("after both opens", { key, paperId: a.parentItemId });
      assert.equal(
        stateOf(standalone).conversationKey,
        key,
        "the leader still shows the chat too",
      );
    } finally {
      focus.restore();
    }
  });

  // ── W27 ──────────────────────────────────────────────────────────────────

  it("W27: History in one follower picking the chat another follower holds brings that one forward and leaves the first unchanged", async function () {
    const a = await newPaper("Torn W27 A");
    const libraryChat = await seedChat({
      system: "upstream",
      kind: "global",
      userText: "Torn W27 library question",
    });
    const paperChat = await seedChat({
      system: "upstream",
      kind: "paper",
      paperItemId: a.parentItemId,
      userText: "Torn W27 paper question",
    });
    const otherChat = await seedChat({
      system: "upstream",
      kind: "global",
      userText: "Torn W27 other library question",
    });
    const followerA = await openAnotherFollower({
      system: "upstream",
      conversationKey: libraryChat.conversationKey,
      kind: "global",
    });
    const followerB = await openAnotherFollower({
      system: "upstream",
      conversationKey: paperChat.conversationKey,
      kind: "paper",
      paperItemID: a.parentItemId,
    });
    const focusA = spyOnFocus(followerA);
    const focusB = spyOnFocus(followerB);
    try {
      (await openFollowerHistory(followerA, paperChat.conversationKey)).click();
      await until(
        () => focusB.count() === 1,
        () => `follower B comes forward: ${focusB.count()} focus calls`,
      );
      await Zotero.Promise.delay(500);
      assert.equal(
        searchOverlayOf(followerA)?.style.display,
        "none",
        "follower A's History closes",
      );
      const stateA = stateOf(followerA);
      assert.equal(
        stateA.conversationKey,
        libraryChat.conversationKey,
        `follower A keeps its chat: ${JSON.stringify(stateA)}`,
      );
      assert.equal(stateA.conversationKind, "global", JSON.stringify(stateA));
      assert.equal(
        stateOf(followerB).conversationKey,
        paperChat.conversationKey,
        "follower B keeps its chat",
      );
      assert.equal(focusA.count(), 0, "follower A is not brought forward");
      assert.lengthOf(api.getTornChatWindowsForTest(), 2);
    } finally {
      focusA.restore();
      focusB.restore();
    }

    // A moves to a third chat in place; the chat it left is free again, so
    // opening it opens a new follower.
    (await openFollowerHistory(followerA, otherChat.conversationKey)).click();
    await until(
      () => stateOf(followerA).conversationKey === otherChat.conversationKey,
      () =>
        `follower A switches to chat ${otherChat.conversationKey}: ${JSON.stringify(stateOf(followerA))}`,
    );
    const followerC = await openAnotherFollower({
      system: "upstream",
      conversationKey: libraryChat.conversationKey,
      kind: "global",
    });
    assert.isTrue(followerC !== followerA, "a new follower holds the old chat");
    assert.lengthOf(api.getTornChatWindowsForTest(), 3);
  });

  // ── W28 ──────────────────────────────────────────────────────────────────

  it("W28: a follower's title is no drag source and the follower has no Open in New Window item", async function () {
    const a = await newPaper("Torn W28 A");
    const paperChat = await seedChat({
      system: "upstream",
      kind: "paper",
      paperItemId: a.parentItemId,
      userText: "Torn W28 paper question",
    });
    const follower = await openFollower({
      system: "upstream",
      conversationKey: paperChat.conversationKey,
      kind: "paper",
      paperItemID: a.parentItemId,
    });
    const title = followerTitleOf(follower)!;
    assert.isOk(title, "the follower has a title");
    assert.isNull(
      title.getAttribute("draggable"),
      "the follower's title is not draggable",
    );
    assert.deepEqual(
      Array.from(follower.document.querySelectorAll('[draggable="true"]')).map(
        (node) => (node as HTMLElement).className,
      ),
      [],
      "nothing in the follower is a drag source",
    );
    if (follower.document.documentElement!.hasAttribute("customtitlebar")) {
      // The title is not cut out of the top row's window-move area
      // ("default" leaves the row's "drag" in effect).
      assert.notEqual(
        follower
          .getComputedStyle(title)!
          .getPropertyValue("-moz-window-dragging"),
        "no-drag",
        "dragging the title moves the window",
      );
      const topRow = title.closest(".llm-standalone-tab-row");
      assert.isOk(topRow, "the title is in the top row");
      assert.equal(
        follower
          .getComputedStyle(topRow!)!
          .getPropertyValue("-moz-window-dragging"),
        "drag",
        "the top row moves the window",
      );
    }
    const transfer = startDrag(follower, title);
    assert.notInclude(
      Array.from(transfer.types),
      TEAR_OFF_MIME,
      "a drag on the title carries no chat",
    );
    endDrag(follower, title, transfer, pointOutsideEveryWindow());
    assert.isNull(
      follower.document.querySelector(".llm-standalone-conv-ctx-menu"),
      "the follower has no row menu",
    );
    assert.isNull(
      follower.document.querySelector('[data-action="open-in-new-window"]'),
      "the follower has no Open in New Window item",
    );
    // Right-clicking a History row offers nothing either.
    const historyRow = await openFollowerHistory(
      follower,
      paperChat.conversationKey,
    );
    const rect = historyRow.getBoundingClientRect();
    historyRow.dispatchEvent(
      new (follower as any).MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: rect.left + 10,
        clientY: rect.top + rect.height / 2,
      }),
    );
    assert.isNull(
      follower.document.querySelector('[data-action="open-in-new-window"]'),
      "a History row has no Open in New Window item",
    );
    await Zotero.Promise.delay(500);
    assert.lengthOf(
      api.getTornChatWindowsForTest(),
      1,
      "no second follower opened",
    );
  });

  // ── W15 ──────────────────────────────────────────────────────────────────

  it("W15: with only torn-off windows open, Open in Window opens the standalone window", async function () {
    const { a, key } = await setupTornOnA("Torn W15");
    const torn = tornWin()!;
    await api.closeStandalone();
    assert.isNull(standaloneWin(), "the standalone window is closed");
    assert.isFalse(torn.closed, "the torn-off window outlives it");

    // The user's own entry point: the sidebar's pop-out button.
    const win = mainWin();
    win.Zotero_Tabs?.select?.("zotero-pane");
    await win.ZoteroPane.selectItem(a.parentItemId);
    const details = win.document.getElementById("zotero-item-details");
    const section = () =>
      details?.querySelector(".llm-dedicated-chat-pane") as HTMLElement | null;
    await until(
      () => Boolean(section()),
      () => "native chat section is registered in the item pane",
    );
    if (
      win.document.documentElement.getAttribute("data-llm-pane-view") !==
        "chat" ||
      (details as any).sidenav._collapsed
    ) {
      const button = Array.from(
        (details as any).sidenav.querySelectorAll("[data-pane]"),
      ).find(
        (node: any) =>
          node.getAttribute("data-pane") === section()!.dataset.pane,
      ) as Element | undefined;
      assert.isOk(button, "the chat rail icon exists");
      button!.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, button: 0 }),
      );
    }
    const popout = () =>
      section()?.querySelector("#llm-popout") as HTMLElement | null;
    await until(
      () => Boolean(popout() && popout()!.getBoundingClientRect().width > 0),
      () => "the sidebar pop-out button is visible",
    );
    popout()!.click();
    await until(
      () => Boolean(standaloneWin()),
      () => "Open in Window opens the standalone window",
      15_000,
    );
    assert.isTrue(
      standaloneWin() !== torn,
      "the standalone window is a new window, not the torn-off one",
    );
    assert.isFalse(torn.closed, "the torn-off window stays open");
    assert.lengthOf(api.getTornChatWindowsForTest(), 1);
    assertTornOnA("after Open in Window", { key, paperId: a.parentItemId });
  });

  // ── W16 ──────────────────────────────────────────────────────────────────

  it("W16: Add Items as Context never lands in a torn-off window", async function () {
    // Create the paper to add first: a new item re-registers the standalone
    // window's panel, and the torn-off window must be the last to register.
    const c = await newPaper("Torn W16 C");
    const { standalone } = await setupTornOnA("Torn W16");
    const tornBefore = chipKeys(tornWin()!);
    const tornStateBefore = stateOf(tornWin());
    const standaloneKeyBefore = stateOf(standalone).conversationKey;
    // The torn-off window registered last. Zotero's menu command reaches
    // dispatchZoteroItemsAsContext, which the harness helper calls too.
    const result = await api.addItemsAsStandaloneContext([c.parentItemId]);
    assert.isTrue(standaloneWin() === standalone, "the same window answers");
    await until(
      () =>
        chipKeys(standaloneWin()!).some((k) =>
          k.startsWith(`${c.parentItemId}:`),
        ),
      () =>
        `the chip appears in the standalone window: ${JSON.stringify(chipKeys(standaloneWin()!))} ${JSON.stringify(result.chipText)}`,
    );
    await Zotero.Promise.delay(500);
    assert.isFalse(
      chipKeys(tornWin()).some((k) => k.startsWith(`${c.parentItemId}:`)),
      `the torn-off window gets no chip for C: ${JSON.stringify(chipKeys(tornWin()))}`,
    );
    assert.deepEqual(
      chipKeys(tornWin()!),
      tornBefore,
      "the torn-off window gets no chip",
    );
    assert.deepEqual(
      stateOf(tornWin()),
      tornStateBefore,
      "the torn-off window keeps its chat and panel state",
    );
    assert.isAbove(
      standaloneKeyBefore,
      0,
      "the standalone window had a chat before",
    );
  });

  // ── W17 ──────────────────────────────────────────────────────────────────

  it("W17: a font-size change reaches torn-off windows", async function () {
    await setupTornOnA("Torn W17");
    const scaleOf = (win: Window | null) =>
      rootOf(win)?.style.getPropertyValue("--llm-font-scale") || "";
    const prefs = (
      Zotero.Utilities.Internal as unknown as {
        openPreferences: (pane: string) => Window;
      }
    ).openPreferences("llmforzotero-preferences");
    assert.isOk(prefs, "preferences window should open");
    const slider = () =>
      prefs.document.querySelector(
        "#llmforzotero-panel-font-scale",
      ) as HTMLInputElement | null;
    try {
      await until(
        () => Boolean(slider()),
        () => "the preferences pane renders the font-size slider",
        30_000,
      );
      await Zotero.Promise.delay(1000);
      const before = scaleOf(tornWin());
      slider()!.value = before === "1.4" ? "120" : "140";
      slider()!.dispatchEvent(
        new (prefs as any).Event("input", { bubbles: true }),
      );
      const expected = before === "1.4" ? "1.2" : "1.4";
      await until(
        () => scaleOf(standaloneWin()) === expected,
        () =>
          `the standalone window takes ${expected}: ${scaleOf(standaloneWin())}`,
      );
      assert.equal(
        scaleOf(tornWin()),
        expected,
        "the torn-off window takes the new font size",
      );
    } finally {
      (
        prefs.document.querySelector(
          "#llmforzotero-panel-font-scale-reset",
        ) as HTMLElement | null
      )?.click();
      prefs.close();
    }
  });

  // ── Two live windows: one chat in both ───────────────────────────────────

  /** Wait until the conversation's newest answer is final and contains `text`. */
  async function waitForAnswer(key: number, text: string): Promise<void> {
    let last: unknown = null;
    await until(
      async () => {
        const state = await api.readChatTurnLifecycle(key);
        const assistant = [...state.memory]
          .reverse()
          .find((message) => message.role === "assistant");
        last = { requestPending: state.requestPending, assistant };
        return (
          !state.requestPending &&
          Boolean(assistant) &&
          assistant!.streaming !== true &&
          String(assistant!.text || "").includes(text)
        );
      },
      () =>
        `conversation ${key} finishes an answer containing "${text}": ${JSON.stringify(last)}`,
      30_000,
    );
  }

  const isStreaming = (win: Window | null) =>
    Boolean(rootOf(win)?.querySelector(".llm-bubble.assistant.streaming"));

  // ── W19 ──────────────────────────────────────────────────────────────────

  it("W19: a question asked in the torn-off window streams into the standalone window too", async function () {
    const { key, standalone } = await setupTornOnA("Torn W19");
    api.enableLiveAgentSending();
    const stream = await startSharedConversationStream({
      provider,
      senderBody: () => bodyOf(tornWin()),
      question: "Torn W19 shared question MIRROR-Q",
    });
    await until(
      () =>
        lastAssistantBubbleText(rootOf(standalone)).includes("MIRROR-PART-ONE"),
      () =>
        `the standalone window shows the partial answer: ${JSON.stringify(stateOf(standalone))}`,
    );
    stream.push("MIRROR-PART-TWO");
    await until(
      () =>
        lastAssistantBubbleText(rootOf(standalone)).includes("MIRROR-PART-TWO"),
      () =>
        `the standalone window keeps receiving streamed text: ${lastAssistantBubbleText(rootOf(standalone))}`,
    );
    stream.finish();
    await waitForAnswer(key, "MIRROR-PART-ONE MIRROR-PART-TWO");
    await until(
      () =>
        !isStreaming(standalone) &&
        !isStreaming(tornWin()) &&
        lastAssistantBubbleText(rootOf(standalone)) ===
          lastAssistantBubbleText(rootOf(tornWin())),
      () =>
        `both windows end with the same final answer: ${JSON.stringify({
          standalone: lastAssistantBubbleText(rootOf(standalone)),
          torn: lastAssistantBubbleText(rootOf(tornWin())),
        })}`,
    );
    assert.include(
      lastAssistantBubbleText(rootOf(standalone)),
      "MIRROR-PART-ONE MIRROR-PART-TWO",
    );
  });

  // ── W22 ──────────────────────────────────────────────────────────────────

  it("W22: a question asked in the torn-off window carries its own paper's text while Zotero shows reader B", async function () {
    const { a, b, readerB, standalone } = await setupTornOnA("Torn W22");
    showReader(readerB);
    await until(
      () => stateOf(standalone).basePaperItemId === b.parentItemId,
      () =>
        `the standalone window follows the reader to B: ${JSON.stringify(stateOf(standalone))}`,
    );
    await Zotero.Promise.delay(500);
    api.enableLiveAgentSending();
    const question = "Torn W22 question about its paper";
    const body = bodyOf(tornWin());
    assert.isOk(body, "the torn-off window has a panel");
    const input = body!.querySelector("#llm-input") as HTMLTextAreaElement;
    const win = tornWin() as any;
    input.value = question;
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    (body!.querySelector("#llm-send") as HTMLButtonElement).click();
    const stream = await provider.waitForStream(question);
    try {
      assert.include(
        stream.requestBody,
        "Torn W22 A: a short page",
        "the request carries paper A's text",
      );
      assert.notInclude(
        stream.requestBody,
        "Torn W22 B: a short page",
        "the request does not carry paper B's text",
      );
      for (const chip of chipKeys(tornWin())) {
        assert.isTrue(
          chip.startsWith(`${a.parentItemId}:`),
          `the torn-off window's chips are A's: ${JSON.stringify(chipKeys(tornWin()))}`,
        );
      }
    } finally {
      stream.finish();
    }
  });

  // ── W21 ──────────────────────────────────────────────────────────────────

  it("W21: deleting the shown chat from the standalone window moves the torn-off window off it", async function () {
    const { a, key, standalone } = await setupTornOnA("Torn W21");
    // The plugin's warnings and errors reach Zotero.debug through its
    // toolkit log, prefixed with the add-on name, at the "warn" level.
    Zotero.Prefs.set(PREF_PREFIX + "logLevel", "warn", true);
    const logged: string[] = [];
    const originalDebug = Zotero.debug;
    const originalLogError = Zotero.logError;
    Zotero.debug = function (this: unknown, message: unknown, ...rest: any[]) {
      const text = String(message ?? "");
      if (text.startsWith("[llm-for-zotero]")) logged.push(text);
      return originalDebug.call(this, message, ...rest);
    };
    Zotero.logError = function (this: unknown, error: unknown) {
      logged.push(`logError: ${String(error)}`);
      return originalLogError.call(this, error);
    };
    try {
      await until(
        () => Boolean(rowOf(standalone, key)),
        () => `the standalone window lists chat ${key}`,
      );
      const remove = rowOf(standalone, key)!.querySelector(
        ".llm-standalone-conv-delete",
      ) as HTMLElement | null;
      assert.isOk(remove, "the row offers Delete");
      remove!.click();
      await until(
        async () =>
          (
            await api.getPendingDeletionState()
          ).pendingConversationKeys.includes(key),
        () => `the deletion of chat ${key} is queued`,
      );
      await until(
        () => {
          const torn = stateOf(tornWin());
          return (
            torn.conversationKey !== key &&
            (torn.conversationKey === 0 ||
              (torn.conversationKind === "paper" &&
                torn.basePaperItemId === a.parentItemId))
          );
        },
        () =>
          `the torn-off window leaves the deleted chat for another chat of A: ${JSON.stringify(stateOf(tornWin()))}`,
        15_000,
      );
      await until(
        () => stateOf(standalone).conversationKey !== key,
        () =>
          `the standalone window leaves the deleted chat: ${JSON.stringify(stateOf(standalone))}`,
      );
      await Zotero.Promise.delay(800);
      const torn = stateOf(tornWin());
      assert.notEqual(torn.conversationKey, key, JSON.stringify(torn));
      assert.notInclude(
        torn.statusText,
        "Cannot delete active conversation",
        JSON.stringify(torn),
      );
      assert.deepEqual(logged, [], "no warning or error is logged");
    } finally {
      Zotero.debug = originalDebug;
      Zotero.logError = originalLogError;
    }
  });

  // ── W20 ──────────────────────────────────────────────────────────────────

  it("W20: closing the sending window mid-stream still delivers the final answer to the other", async function () {
    const { key, standalone } = await setupTornOnA("Torn W20");
    api.enableLiveAgentSending();
    const stream = await startSharedConversationStream({
      provider,
      senderBody: () => bodyOf(tornWin()),
      question: "Torn W20 shared question MIRROR-Q",
    });
    await until(
      () =>
        lastAssistantBubbleText(rootOf(standalone)).includes("MIRROR-PART-ONE"),
      () =>
        `the standalone window shows the partial answer: ${JSON.stringify(stateOf(standalone))}`,
    );
    const torn = tornWin()!;
    torn.close();
    await until(
      () => torn.closed && api.getTornChatWindowsForTest().length === 0,
      () => "the sending torn-off window closes",
    );
    await Zotero.Promise.delay(300);
    assert.isFalse(
      stream.aborted,
      "closing the sending window does not abort the answer",
    );
    stream.push("MIRROR-PART-TWO");
    stream.finish();
    await waitForAnswer(key, "MIRROR-PART-ONE MIRROR-PART-TWO");
    await until(
      () =>
        !isStreaming(standalone) &&
        lastAssistantBubbleText(rootOf(standalone)).includes(
          "MIRROR-PART-ONE MIRROR-PART-TWO",
        ),
      () =>
        `the standalone window ends with the final answer: ${lastAssistantBubbleText(rootOf(standalone))}`,
    );
    const history = await api.getConversationHistoryTexts(key);
    assert.isTrue(
      history.stored.some(
        (entry) =>
          entry.role === "assistant" &&
          entry.text.includes("MIRROR-PART-ONE MIRROR-PART-TWO"),
      ),
      `the final answer is stored: ${JSON.stringify(history.stored)}`,
    );
  });
});
