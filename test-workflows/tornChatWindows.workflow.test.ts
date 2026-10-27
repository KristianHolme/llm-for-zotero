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
 * A torn-off chat window is a second instance of the standalone window
 * document that keeps its own paper: it does not follow the PDF reader, and
 * it keeps its own selection and model choices apart from the standalone
 * window. The standalone window keeps its singleton behavior.
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

  // ── W10 ──────────────────────────────────────────────────────────────────

  it("W10: the unlinked icon shows in Paper chat only, and never in the standalone window", async function () {
    const { standalone } = await setupTornOnA("Torn W10");
    const torn = tornWin()!;
    const iconOf = (win: Window) =>
      win.document.querySelector(
        ".llm-standalone-content-title .llm-standalone-unlinked-icon",
      ) as HTMLElement | null;
    const shown = (win: Window) => {
      const icon = iconOf(win);
      if (!icon) return false;
      return win.getComputedStyle(icon)?.display !== "none" && !icon.hidden;
    };

    const windowRoot = (win: Window) =>
      win.document.getElementById("llmforzotero-standalone-chat-root");
    assert.equal(
      windowRoot(torn)?.getAttribute("data-reader-link"),
      "unlinked",
    );
    assert.isNull(windowRoot(standalone)?.getAttribute("data-reader-link"));
    const icon = iconOf(torn);
    assert.isOk(icon, "the torn-off window has an unlinked icon");
    assert.isTrue(shown(torn), "the icon shows in Paper chat");
    assert.equal(
      icon!.title,
      "Not linked to the PDF reader. Switching PDF tabs does not change this chat.",
    );

    await clickWindowTab(torn, "open");
    await until(
      () => stateOf(tornWin()).conversationKind === "global",
      () => `Library chat: ${JSON.stringify(stateOf(tornWin()))}`,
    );
    assert.isFalse(shown(torn), "the icon is hidden in Library chat");

    await clickWindowTab(torn, "paper");
    await until(
      () => stateOf(tornWin()).conversationKind === "paper",
      () => `Paper chat: ${JSON.stringify(stateOf(tornWin()))}`,
    );
    assert.isTrue(shown(torn), "the icon shows again in Paper chat");

    assert.isNull(iconOf(standalone), "the standalone window has no icon");
  });

  // ── Tear-off gesture and row menu ────────────────────────────────────────

  type ScreenRect = {
    left: number;
    top: number;
    width: number;
    height: number;
  };

  /** Every open Zotero or plugin window, as the drag handler reads them. */
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

  it("W11: dragging a list row out of every window opens a torn-off window on that chat", async function () {
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
    assert.equal(transfer.dropEffect, "none", "no target took the drag");

    endDrag(standalone, row, transfer, pointOutsideEveryWindow());
    await until(
      () =>
        api.getTornChatWindowsForTest().length === 1 &&
        stateOf(tornWin()).conversationKey === key,
      () =>
        `one torn-off window opens on chat ${key}: ${JSON.stringify({
          windows: api.getTornChatWindowsForTest().length,
          state: stateOf(tornWin()),
        })}`,
      15_000,
    );
    assertTornOnA("after the tear-off drag", {
      key,
      paperId: a.parentItemId,
    });
    assert.isTrue(
      standaloneWin() === standalone,
      "the standalone window stays the session window",
    );
    assert.equal(
      stateOf(standalone).conversationKey,
      key,
      "the standalone window still shows its chat",
    );

    // The torn-off window's own rows are drag sources too.
    await until(
      () => rowOf(tornWin(), key)?.getAttribute("draggable") === "true",
      () =>
        `the torn-off window lists a draggable row for chat ${key}: ${JSON.stringify(listedConversationKeys(tornWin()))}`,
    );
  });

  // ── W12 ──────────────────────────────────────────────────────────────────

  it("W12: a drag that ends inside a window opens nothing", async function () {
    const { key, standalone } = await setupStandaloneOnA("Torn W12");
    const row = rowOf(standalone, key)!;

    let transfer = startDrag(standalone, row);
    endDrag(standalone, row, transfer, {
      screenX: standalone.screenX + Math.round(standalone.outerWidth / 2),
      screenY: standalone.screenY + Math.round(standalone.outerHeight / 2),
    });

    // A drag some target accepted opens nothing either, wherever it ends.
    const accepted = rowOf(standalone, key)!;
    transfer = startDrag(standalone, accepted);
    transfer.dropEffect = "move";
    endDrag(standalone, accepted, transfer, pointOutsideEveryWindow());

    // The title dropped back on its own window opens nothing.
    const title = titleOf(standalone)!;
    transfer = startDrag(standalone, title);
    assert.deepEqual(Array.from(transfer.types), [TEAR_OFF_MIME]);
    endDrag(standalone, title, transfer, {
      screenX: standalone.screenX + 20,
      screenY: standalone.screenY + 20,
    });

    await Zotero.Promise.delay(1000);
    assert.lengthOf(
      api.getTornChatWindowsForTest(),
      0,
      "no torn-off window opened",
    );
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

  // ── Two live windows: shared list prefs and one chat in both ─────────────

  const PINNED_PREF = PREF_PREFIX + "standalonePinnedPapers";
  const COLLAPSED_GROUPS_PREF =
    PREF_PREFIX + "standaloneSidebarCollapsedGroups";

  const pinnedPref = (): number[] => {
    try {
      const parsed = JSON.parse(
        String(Zotero.Prefs.get(PINNED_PREF, true) || "[]"),
      );
      return Array.isArray(parsed) ? parsed.map(toKey).filter(Boolean) : [];
    } catch {
      return [];
    }
  };

  const pinnedRows = (win: Window | null): number[] =>
    Array.from(
      win?.document.querySelectorAll(".llm-standalone-pinned-paper") || [],
    ).map((row: any) => toKey(row.dataset.paperItemId));

  const pinButtonOf = (win: Window) =>
    win.document.querySelector(
      ".llm-standalone-icon-pin",
    ) as HTMLButtonElement | null;

  const groupHeaderOf = (win: Window | null, key: string) =>
    (win?.document.querySelector(
      `.llm-standalone-sidebar-list .llm-standalone-conv-group[data-group-key="${key}"]`,
    ) as HTMLElement | null) || null;

  function clickPin(win: Window, name: string): void {
    const button = pinButtonOf(win);
    assert.isOk(button && !button.hidden, `the ${name} shows its pin button`);
    button!.click();
  }

  /** Counts list redraws in both windows while `ms` pass. */
  async function countListMutations(
    windows: Window[],
    ms: number,
  ): Promise<number> {
    let count = 0;
    const observers = windows.map((win) => {
      const observer = new (win as any).MutationObserver(
        (records: unknown[]) => {
          count += records.length;
        },
      );
      for (const selector of [
        ".llm-standalone-pinned-list",
        ".llm-standalone-sidebar-list",
      ]) {
        const node = win.document.querySelector(selector);
        if (node) observer.observe(node, { childList: true });
      }
      return observer;
    });
    await Zotero.Promise.delay(ms);
    for (const observer of observers) observer.disconnect();
    return count;
  }

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

  // ── W18 ──────────────────────────────────────────────────────────────────

  it("W18: pinning a paper in one window shows the pin in the other, and a later change in the other keeps it", async function () {
    Zotero.Prefs.set(PINNED_PREF, "", true);
    Zotero.Prefs.set(COLLAPSED_GROUPS_PREF, "", true);
    try {
      const { a, b, readerB, standalone } = await setupTornOnA("Torn W18");
      const torn = tornWin()!;

      // Pin A in the torn-off window: the standalone window lists it too.
      clickPin(torn, "torn-off window");
      await until(
        () => pinnedPref().includes(a.parentItemId),
        () => `the pref holds A's pin: ${JSON.stringify(pinnedPref())}`,
      );
      await until(
        () => pinnedRows(standalone).includes(a.parentItemId),
        () =>
          `the standalone window lists A's pin: ${JSON.stringify({
            standalone: pinnedRows(standalone),
            torn: pinnedRows(torn),
            pref: pinnedPref(),
          })}`,
      );
      assert.equal(
        pinButtonOf(standalone)?.getAttribute("aria-pressed"),
        "true",
        "the standalone window, also on A, shows A as pinned",
      );
      // A window does not redraw its lists again and again from its own
      // write, or from the other window's.
      const redraws = await countListMutations([standalone, torn], 800);
      assert.equal(redraws, 0, "the lists stay still once the pin shows");

      // Fold the Agent section in the standalone window: the pin stays, and
      // the torn-off window folds it too.
      const header = groupHeaderOf(standalone, "upstream");
      assert.isOk(header, "the standalone window shows the Agent section");
      header!.click();
      await until(
        () =>
          String(Zotero.Prefs.get(COLLAPSED_GROUPS_PREF, true) || "").includes(
            "upstream",
          ),
        () => "the pref holds the folded Agent section",
      );
      assert.deepEqual(
        pinnedPref(),
        [a.parentItemId],
        "folding a section keeps the pin",
      );
      await until(
        () =>
          groupHeaderOf(tornWin(), "upstream")?.dataset.collapsed === "true",
        () => "the torn-off window folds the Agent section too",
      );

      // Pin B in the standalone window: A's pin, made in the other window,
      // is kept.
      showReader(readerB);
      await until(
        () => stateOf(standalone).basePaperItemId === b.parentItemId,
        () =>
          `the standalone window follows the reader to B: ${JSON.stringify(stateOf(standalone))}`,
      );
      clickPin(standalone, "standalone window");
      await until(
        () => pinnedPref().includes(b.parentItemId),
        () => `the pref holds B's pin: ${JSON.stringify(pinnedPref())}`,
      );
      assert.deepEqual(
        pinnedPref(),
        [a.parentItemId, b.parentItemId],
        "pinning B in the standalone window keeps A's pin",
      );
      await until(
        () =>
          JSON.stringify(pinnedRows(tornWin())) ===
          JSON.stringify([a.parentItemId, b.parentItemId]),
        () =>
          `the torn-off window lists both pins: ${JSON.stringify(pinnedRows(tornWin()))}`,
      );

      // Unpin A in the torn-off window: B's pin is kept in both.
      const unpinA = torn.document.querySelector(
        `.llm-standalone-pinned-paper[data-paper-item-id="${a.parentItemId}"] [data-action="unpin"]`,
      ) as HTMLElement | null;
      assert.isOk(unpinA, "the torn-off window offers Unpin on A");
      unpinA!.click();
      await until(
        () =>
          JSON.stringify(pinnedPref()) === JSON.stringify([b.parentItemId]) &&
          JSON.stringify(pinnedRows(standalone)) ===
            JSON.stringify([b.parentItemId]),
        () =>
          `only B stays pinned, in the pref and the standalone window: ${JSON.stringify(
            { pref: pinnedPref(), standalone: pinnedRows(standalone) },
          )}`,
      );
    } finally {
      Zotero.Prefs.set(PINNED_PREF, "", true);
      Zotero.Prefs.set(COLLAPSED_GROUPS_PREF, "", true);
    }
  });

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
      assert.notInclude(
        listedConversationKeys(tornWin()),
        key,
        "the torn-off window's list drops the deleted chat",
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
