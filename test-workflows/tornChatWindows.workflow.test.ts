import { assert } from "chai";
import {
  getModelEntryById,
  setModelProviderGroups,
} from "../src/utils/modelProviders";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

/**
 * A torn-off chat window is a second instance of the standalone window
 * document that keeps its own paper: it does not follow the PDF reader, and
 * it keeps its own selection and model choices apart from the standalone
 * window. The standalone window keeps its singleton behavior.
 *
 * Everything runs in the real Zotero host against real reader tabs and real
 * chat windows. No request is sent; model entries point at an unreachable
 * fake API, so only the menus and choices are exercised.
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
  const previousPrefs = new Map<string, unknown>();
  const fixtures: WorkflowTestFixture[] = [];
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

  async function clickWindowTab(win: Window, tab: "paper" | "open") {
    const button = win.document.querySelector(
      `.llm-standalone-tab-row .llm-standalone-tab[data-tab='${tab}']`,
    ) as HTMLElement | null;
    assert.isOk(button, `the window renders its ${tab} tab`);
    button!.click();
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

  async function catalogPaperItemID(conversationKey: number) {
    const rows = (await Zotero.DB.queryAsync(
      "SELECT paper_item_id AS paperItemID FROM llm_for_zotero_paper_conversations WHERE conversation_key = ?",
      [conversationKey],
    )) as Array<{ paperItemID: number }>;
    return rows.length ? toKey(rows[0].paperItemID) : 0;
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

  // ── Side chats ───────────────────────────────────────────────────────────

  const sideChatBody = (win: Window | null): HTMLElement | null =>
    (win?.document.querySelector(
      ".llm-standalone-side-panel-chat:not([hidden]) .llm-standalone-side-body",
    ) as HTMLElement | null) || null;

  /** Opens the window's side panel and a new side chat in it. */
  async function openSideChat(win: Window, name: string): Promise<HTMLElement> {
    const doc = win.document;
    const launchSelector =
      ".llm-standalone-side-panel-newtab:not([hidden]) [data-side-launch='sidechat']";
    const toggle = doc.querySelector(
      ".llm-standalone-side-panel-toggle",
    ) as HTMLElement | null;
    assert.isOk(toggle, `the ${name} has a side panel toggle`);
    if (toggle!.getAttribute("aria-expanded") !== "true") toggle!.click();
    await Zotero.Promise.delay(250);
    if (!doc.querySelector(launchSelector)) {
      (
        doc.querySelector(
          ".llm-standalone-side-panel-bar > .llm-standalone-side-panel-icon-new-tab",
        ) as HTMLElement | null
      )?.click();
      await Zotero.Promise.delay(250);
    }
    const launch = doc.querySelector(launchSelector) as HTMLElement | null;
    assert.isOk(launch, `the ${name}'s side panel offers a side chat`);
    launch!.click();
    await until(
      () =>
        Boolean(
          (sideChatBody(win)?.querySelector("#llm-main") as HTMLElement | null)
            ?.dataset.handlersInitialized,
        ),
      () => `the ${name}'s side chat mounts`,
    );
    return sideChatBody(win)!;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = getWorkflowTestApi();
    for (const key of SAVED_PREF_KEYS) {
      previousPrefs.set(key, Zotero.Prefs.get(PREF_PREFIX + key, true));
    }
    Zotero.Prefs.set(PREF_PREFIX + "sidebarLayout", "independent", true);
    Zotero.Prefs.set(PREF_PREFIX + "conversationSystem", "upstream", true);
    Zotero.Prefs.set(PREF_PREFIX + "enableCodexAppServerMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "enableClaudeCodeMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedRuntimeMode", "chat", true);
  });

  after(async function () {
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
    for (const fixture of fixtures.splice(0)) {
      await api.cleanupFixture(fixture);
    }
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
      640,
      4,
      "the torn-off window opens 640 px wide",
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

  // ── W3 ───────────────────────────────────────────────────────────────────

  it("W3: Library chat and back returns the torn-off window to its own paper", async function () {
    const { a, b, key } = await setupTornOnA("Torn W3");
    const torn = tornWin()!;
    await clickWindowTab(torn, "open");
    await until(
      () => stateOf(tornWin()).conversationKind === "global",
      () =>
        `the torn-off window switches to Library chat: ${JSON.stringify(stateOf(tornWin()))}`,
    );
    await showInLibrary(b.parentItemId);
    await until(
      () => stateOf(standaloneWin()).basePaperItemId === b.parentItemId,
      () =>
        `Zotero shows B (the standalone window follows): ${JSON.stringify(stateOf(standaloneWin()))}`,
    );
    await clickWindowTab(torn, "paper");
    await until(
      () => stateOf(tornWin()).conversationKind === "paper",
      () =>
        `the torn-off window returns to Paper chat: ${JSON.stringify(stateOf(tornWin()))}`,
    );
    await Zotero.Promise.delay(300);
    assertTornOnA("after Library chat and back while Zotero shows B", {
      key,
      paperId: a.parentItemId,
    });
  });

  // ── W4 ───────────────────────────────────────────────────────────────────

  it("W4: a new paper chat in the torn-off window belongs to its own paper", async function () {
    const { a, b, key } = await setupTornOnA("Torn W4");
    await showInLibrary(b.parentItemId);
    await until(
      () => stateOf(standaloneWin()).basePaperItemId === b.parentItemId,
      () =>
        `Zotero shows B (the standalone window follows): ${JSON.stringify(stateOf(standaloneWin()))}`,
    );
    const newChat = tornWin()!.document.querySelector(
      "[data-sidebar-action='new-chat']",
    ) as HTMLElement | null;
    assert.isOk(newChat, "the torn-off window has a New chat button");
    newChat!.click();
    await until(
      () =>
        stateOf(tornWin()).conversationKey > 0 &&
        stateOf(tornWin()).conversationKey !== key,
      () =>
        `the torn-off window starts a new chat: ${JSON.stringify(stateOf(tornWin()))}`,
    );
    const fresh = stateOf(tornWin());
    assert.equal(fresh.conversationKind, "paper", JSON.stringify(fresh));
    assert.equal(
      fresh.basePaperItemId,
      a.parentItemId,
      `the new chat is A's: ${JSON.stringify(fresh)}`,
    );
    let paperItemID = 0;
    await until(
      async () => {
        paperItemID = await catalogPaperItemID(fresh.conversationKey);
        return paperItemID > 0;
      },
      () => `the new chat ${fresh.conversationKey} is stored`,
    );
    assert.equal(
      paperItemID,
      a.parentItemId,
      "the stored new chat belongs to A, not to B that Zotero shows",
    );
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
    await until(
      () => listedConversationKeys(tornWin()).includes(key),
      () =>
        `the torn-off window's list shows A's chat ${key}: ${JSON.stringify(listedConversationKeys(tornWin()))}`,
    );
    const torn = tornWin()!;
    await clickWindowTab(torn, "open");
    await until(
      () => stateOf(tornWin()).conversationKind === "global",
      () => `Library chat still works: ${JSON.stringify(stateOf(tornWin()))}`,
    );
    await clickWindowTab(torn, "paper");
    await until(
      () => stateOf(tornWin()).conversationKey === key,
      () => `Paper chat returns to A: ${JSON.stringify(stateOf(tornWin()))}`,
    );
    assertTornOnA("after Library chat and back", {
      key,
      paperId: a.parentItemId,
    });
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
    const torn = tornWin()!;
    await clickWindowTab(torn, "paper");
    await Zotero.Promise.delay(400);
    let state = stateOf(tornWin());
    assert.equal(
      state.conversationKind,
      "global",
      `Paper chat has no paper to show: ${JSON.stringify(state)}`,
    );
    assert.include(state.statusText, NO_PAPER_STATUS, JSON.stringify(state));
    assert.notEqual(
      state.basePaperItemId,
      a.parentItemId,
      `the trashed paper is not shown: ${JSON.stringify(state)}`,
    );
    state = stateOf(tornWin());
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

  // ── W9b ──────────────────────────────────────────────────────────────────

  it("W9b: a side chat in a torn-off window keeps its own model choice, and closing one window's side panel leaves the other's choice", async function () {
    await setupTornOnA("Torn W9b");
    const torn = tornWin()!;

    const tornSide = await openSideChat(torn, "torn-off window");
    assert.equal(
      tornSide.dataset.selectionSurface,
      `side:${String(bodyOf(torn)?.dataset.selectionSurface || "").replace(
        /^torn:/u,
        "",
      )}`,
      "the torn-off window's side chat uses its own side surface",
    );
    let side = await readModelMenu(tornSide, "torn-off side chat");
    assert.equal(side.selected, ENTRY_A, JSON.stringify(side));
    await selectModel(tornSide, ENTRY_B, MODEL_B, "torn-off side chat");
    const tornMain = await readModelMenu(bodyOf(torn)!, "torn-off window");
    assert.equal(
      tornMain.selected,
      ENTRY_A,
      `the torn-off window's own chat keeps model A: ${JSON.stringify(tornMain)}`,
    );

    // The standalone window's first side chat starts from its own window.
    const standaloneSide = await openSideChat(
      standaloneWin()!,
      "standalone window",
    );
    assert.equal(standaloneSide.dataset.selectionSurface, "side");
    const standaloneSideMenu = await readModelMenu(
      standaloneSide,
      "standalone side chat",
    );
    assert.equal(
      standaloneSideMenu.selected,
      ENTRY_A,
      JSON.stringify(standaloneSideMenu),
    );
    side = await readModelMenu(sideChatBody(torn)!, "torn-off side chat");
    assert.equal(
      side.selected,
      ENTRY_B,
      `the torn-off side chat keeps model B after the standalone side chat started: ${JSON.stringify(side)}`,
    );

    // Closing the standalone window drops its side panel and side choices.
    await api.closeStandalone();
    assert.isNull(standaloneWin());
    side = await readModelMenu(sideChatBody(torn)!, "torn-off side chat");
    assert.equal(
      side.selected,
      ENTRY_B,
      `the torn-off side chat keeps model B after the standalone side panel closed: ${JSON.stringify(side)}`,
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
});
