/**
 * Executes the compiled library userscript against a minimal DOM stub, so
 * regressions in the panel runtime (mount, rows, jump seeking, vocabulary
 * capture) fail here instead of in a real browser.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildLessonDraft,
  localLessonStorageKey,
  prepareAuthoringModule,
  sealLesson,
  upsertLocalLessonIndex,
  LOCAL_LESSON_INDEX_KEY,
} from "../src/authoring.ts";
import { compileLibrary, validateLesson } from "../src/lesson.ts";
import { captionDigest, validateCaptions } from "../src/lesson.ts";

const template = readFileSync(new URL("../runtime/library.user.template.js", import.meta.url), "utf8");
const authoringModule = prepareAuthoringModule(
  readFileSync(new URL("../runtime/authoring.template.js", import.meta.url), "utf8"),
);
const lessonFixture = JSON.parse(readFileSync(new URL("../fixtures/lesson.sample.json", import.meta.url), "utf8"));

function compileLibraryScript(lessons: ReturnType<typeof validateLesson>[]) {
  return compileLibrary(template, lessons, authoringModule);
}

function storeSealedLocalLesson(storage: Map<string, string>, sealed: ReturnType<typeof sealLesson>) {
  storage.set(
    localLessonStorageKey(sealed.video.video_id, sealed.study_language, sealed.source_digest),
    JSON.stringify(sealed),
  );
  storage.set(
    LOCAL_LESSON_INDEX_KEY,
    JSON.stringify(
      upsertLocalLessonIndex([], {
        video_id: sealed.video.video_id,
        study_language: sealed.study_language,
        source_digest: sealed.source_digest,
        complete: true,
      }),
    ),
  );
}

function digestBanner(panel: StubNode | null) {
  if (!panel) return null;
  const queue = [...panel.children];
  while (queue.length > 0) {
    const candidate = queue.shift()!;
    if (candidate.attrs["data-ysp"] === "digest-banner") return candidate;
    queue.push(...candidate.children);
  }
  return null;
}

interface StubNode {
  tag: string;
  id: string;
  className: string;
  textContent: string;
  title: string;
  tabIndex: number;
  style: Record<string, string>;
  attrs: Record<string, string>;
  children: StubNode[];
  parent: StubNode | null;
  listeners: Record<string, ((event: unknown) => void)[]>;
  scrollTop: number;
  clientHeight: number;
  offsetTop: number;
  appendChild(child: StubNode): void;
  remove(): void;
  addEventListener(type: string, handler: (event: unknown) => void): void;
  setAttribute(key: string, value: string): void;
  hasAttribute(key: string): boolean;
  contains(node: unknown): boolean;
  querySelector(selector: string): StubNode | null;
  fire(type: string, event?: unknown): void;
}

function createHarness(
  script: string,
  sharedStorage?: Map<string, string>,
  uiLanguage = "ko-KR",
  options: { fetchImpl?: typeof fetch; confirmImpl?: () => boolean } = {},
) {
  const nodes: StubNode[] = [];

  function makeNode(tag: string): StubNode {
    let text = "";
    const node: StubNode = {
      tag,
      id: "",
      className: "",
      /* Real DOM: assigning textContent replaces all children. */
      get textContent() {
        return text;
      },
      set textContent(value: string) {
        text = value;
        for (const child of node.children) child.parent = null;
        node.children = [];
      },
      title: "",
      tabIndex: 0,
      style: {},
      attrs: {},
      children: [],
      parent: null,
      listeners: {},
      scrollTop: 0,
      clientHeight: 100,
      offsetTop: 0,
      appendChild(child) {
        child.parent = node;
        node.children.push(child);
      },
      remove() {
        if (node.parent) {
          node.parent.children = node.parent.children.filter((child) => child !== node);
          node.parent = null;
        }
      },
      addEventListener(type, handler) {
        (node.listeners[type] ??= []).push(handler);
      },
      setAttribute(key, value) {
        node.attrs[key] = value;
      },
      hasAttribute(key) {
        return key in node.attrs;
      },
      contains(candidate) {
        let cursor = candidate as StubNode | null;
        while (cursor) {
          if (cursor === node) return true;
          cursor = cursor.parent;
        }
        return false;
      },
      querySelector(selector) {
        const match = /^\[data-ysp="(.+)"\]$/u.exec(selector);
        if (!match) return null;
        const wanted = match[1];
        const queue = [...node.children];
        while (queue.length > 0) {
          const candidate = queue.shift()!;
          if (candidate.attrs["data-ysp"] === wanted) return candidate;
          queue.push(...candidate.children);
        }
        return null;
      },
      fire(type, event = {}) {
        for (const handler of node.listeners[type] ?? []) handler(event);
      },
    };
    nodes.push(node);
    return node;
  }

  const body = makeNode("body");
  const documentElement = makeNode("html");
  const video = { currentTime: 0, playbackRate: 1, played: false, play() { this.played = true; } };
  const storage = sharedStorage ?? new Map<string, string>();
  const opened: string[] = [];
  const intervals: (() => void)[] = [];
  const location = { pathname: "/watch", search: `?v=${lessonFixture.video.video_id}`, protocol: "https:" };
  let selectionText = "";
  let selectionAnchor: StubNode | null = null;
  const confirmImpl = options.confirmImpl ?? (() => true);

  async function sha256Hex(text: string) {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(text, "utf8").digest("hex");
  }

  const cryptoStub = {
    subtle: {
      digest(_algo: string, data: Uint8Array) {
        return sha256Hex(new TextDecoder().decode(data)).then((hex) => {
          const bytes = new Uint8Array(hex.length / 2);
          for (let index = 0; index < bytes.length; index += 1) {
            bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
          }
          return bytes.buffer;
        });
      },
    },
  };

  const documentListeners: Record<string, ((event: unknown) => void)[]> = {};
  const documentStub = {
    body,
    documentElement,
    createElement: (tag: string) => makeNode(tag),
    getElementById: (id: string) => nodes.find((node) => node.id === id) ?? null,
    querySelector: (selector: string) =>
      selector.includes("video") ? video : null,
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      (documentListeners[type] ??= []).push(handler);
    },
  };

  const windowStub = {
    location, 
    crypto: cryptoStub,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    },
    addEventListener: () => {},
    setInterval: (handler: () => void) => {
      intervals.push(handler);
      return intervals.length;
    },
    clearInterval: () => {},
    setTimeout: (handler: () => void) => {
      queueMicrotask(handler);
      return 1;
    },
    confirm: () => confirmImpl(),
    fetch: options.fetchImpl ?? (() => Promise.reject(new Error("fetch disabled in tests"))),
    open: (url: string) => void opened.push(url),
    getSelection: () => ({
      isCollapsed: selectionText.length === 0,
      anchorNode: selectionAnchor,
      toString: () => selectionText,
    }),
    screen: { availWidth: 1280, availHeight: 800 },
    innerWidth: 1280,
    innerHeight: 800,
    navigator: { language: uiLanguage },
    __yspTestHooks: null as null | {
      setReadSessionCaptions: (fn: () => { captions?: { start_ms: number; end_ms: number; text: string }[]; error?: string }) => void;
      storeLocalLesson: (lesson: unknown, complete: boolean) => void;
      resolveLocalLesson: (videoId: string) => unknown;
    },
  };

  new Function("window", "document", script)(windowStub, documentStub);
  windowStub.__yspTestHooks = (windowStub as { __yspTestHooks?: typeof windowStub.__yspTestHooks }).__yspTestHooks ?? null;

  return {
    body,
    nodes,
    video,
    storage,
    opened,
    windowStub,
    async flush() {
      for (let index = 0; index < 8; index += 1) {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      }
    },
    select(text: string, anchor: StubNode) {
      selectionText = text;
      selectionAnchor = anchor;
    },
    tick() {
      for (const handler of intervals) handler();
    },
    docFire(type: string, event: unknown = {}) {
      for (const handler of documentListeners[type] ?? []) handler(event);
    },
    navigate(videoId: string | null) {
      location.pathname = videoId === null ? "/" : "/watch";
      location.search = videoId === null ? "" : `?v=${videoId}`;
      // The 2s polling fallback drives check() in the harness.
      for (const handler of intervals) handler();
    },
    panel: () =>
      nodes.find((node) => node.id === "ysp-panel" && body.contains(node)) ?? null,
    createPanel: () =>
      nodes.find((node) => node.id === "ysp-create-panel" && body.contains(node)) ?? null,
    digestBanner: () => digestBanner(nodes.find((node) => node.id === "ysp-panel" && body.contains(node)) ?? null),
  };
}

describe("library userscript runtime smoke", () => {
  const lesson = validateLesson({
    ...lessonFixture,
    glossary: [{ word: "town", meaning: "마을, 동네" }],
  });
  const script = compileLibraryScript([lesson]);

  test("mounts a localized panel with one row per line", () => {
    const harness = createHarness(script);
    const panel = harness.panel();
    expect(panel).not.toBeNull();
    const list = panel!.children[2]!;
    expect(list.children).toHaveLength(lesson.lines.length);
    const firstBody = list.children[0]!.children[1]!;
    expect(firstBody.children[0]!.textContent).toBe(lesson.lines[0]!.original);
    expect(firstBody.children[1]!.textContent).toBe(lesson.lines[0]!.pronunciation);
    expect(firstBody.children[2]!.textContent).toBe(lesson.lines[0]!.translation);
    // Korean study language selects the Korean UI strings.
    const header = panel!.children[0]!;
    expect(header.children.map((child) => child.textContent)).toContain("단어장");
  });

  test("the explicit jump button seeks the page player", () => {
    const harness = createHarness(script);
    const list = harness.panel()!.children[2]!;
    const jump = list.children[2]!.children[0]!.children[0]!;
    expect(jump.textContent.startsWith("▶")).toBe(true);
    jump.fire("click");
    expect(harness.video.currentTime).toBeCloseTo(lesson.lines[2]!.start_ms / 1000);
    expect(harness.video.played).toBe(true);
  });

  test("navigating between videos remounts the right lesson", () => {
    const other = validateLesson({
      ...lessonFixture,
      video: { ...lessonFixture.video, video_id: "zzz999AAA_-", title: "Second video" },
      lines: [
        { start_ms: 0, end_ms: 1500, original: "Hello again.", pronunciation: "헬로 어겐.", translation: "다시 안녕." },
      ],
    });
    const harness = createHarness(compileLibraryScript([lesson, other]));

    // Mounted for the first video with its line count.
    expect(harness.panel()!.children[2]!.children).toHaveLength(lesson.lines.length);

    // SPA-navigate to the second studied video: panel rebuilds for it.
    harness.navigate("zzz999AAA_-");
    expect(harness.panel()!.children[2]!.children).toHaveLength(1);
    expect(harness.panel()!.children[2]!.children[0]!.children[1]!.children[0]!.textContent).toBe("Hello again.");

    // Navigate to a video that is not in the library: create-lesson panel appears.
    harness.navigate("unstudied123".slice(0, 11));
    expect(harness.panel()).toBeNull();
    expect(harness.createPanel()).not.toBeNull();

    // And back to the first video: panel returns.
    harness.navigate(lesson.video.video_id);
    expect(harness.panel()!.children[2]!.children).toHaveLength(lesson.lines.length);
  });

  test("the repeat button cycles once, loop, off", () => {
    const harness = createHarness(script);
    const list = harness.panel()!.children[2]!;
    const side = list.children[1]!.children[0]!;
    const repeat = side.children[1]!;
    const line = lesson.lines[1]!;
    expect(repeat.textContent).toBe("↺");

    // First press: repeat once — seeks to the line and replays it one time.
    repeat.fire("click");
    expect(repeat.textContent).toBe("↺1");
    expect(harness.video.currentTime).toBeCloseTo(line.start_ms / 1000);
    harness.video.currentTime = line.end_ms / 1000 + 0.1;
    harness.tick();
    expect(harness.video.currentTime).toBeCloseTo(line.start_ms / 1000);
    harness.video.currentTime = line.end_ms / 1000 + 0.1;
    harness.tick();
    expect(repeat.textContent).toBe("↺");

    // Two presses: loop until turned off by the third press.
    repeat.fire("click");
    repeat.fire("click");
    expect(repeat.textContent).toBe("↺∞");
    harness.video.currentTime = line.end_ms / 1000 + 0.1;
    harness.tick();
    expect(harness.video.currentTime).toBeCloseTo(line.start_ms / 1000);
    harness.video.currentTime = line.end_ms / 1000 + 0.1;
    harness.tick();
    expect(harness.video.currentTime).toBeCloseTo(line.start_ms / 1000);
    expect(repeat.textContent).toBe("↺∞");
    repeat.fire("click");
    expect(repeat.textContent).toBe("↺");

    // Seeking far away from the repeated line drops the repeat.
    repeat.fire("click");
    expect(repeat.textContent).toBe("↺1");
    harness.video.currentTime = line.end_ms / 1000 + 60;
    harness.tick();
    expect(repeat.textContent).toBe("↺");

    // Repeating a different line moves the state over.
    const otherRepeat = list.children[3]!.children[0]!.children[1]!;
    repeat.fire("click");
    otherRepeat.fire("click");
    expect(repeat.textContent).toBe("↺");
    expect(otherRepeat.textContent).toBe("↺1");
  });

  test("an explicit jump cancels an active repeat", () => {
    const harness = createHarness(script);
    const list = harness.panel()!.children[2]!;
    const repeat = list.children[1]!.children[0]!.children[1]!;
    repeat.fire("click");
    expect(repeat.textContent).toBe("↺1");
    // Jump to the next paragraph while the repeat is still armed.
    const nextJump = list.children[2]!.children[0]!.children[0]!;
    nextJump.fire("click");
    expect(repeat.textContent).toBe("↺");
    expect(harness.video.currentTime).toBeCloseTo(lesson.lines[2]!.start_ms / 1000);
    // The tick must not yank playback back to the old repeat range.
    harness.tick();
    expect(harness.video.currentTime).toBeCloseTo(lesson.lines[2]!.start_ms / 1000);
  });

  test("the panel can be dragged and remembers placement and opacity", () => {
    const storage = new Map<string, string>();
    const harness = createHarness(script, storage);
    const panel = harness.panel()!;
    const header = panel.children[0]!;

    // Drag by the header background: docked -> floating at the drop point.
    header.fire("mousedown", { target: header, clientX: 1000, clientY: 100 });
    harness.docFire("mousemove", { clientX: 900, clientY: 250 });
    harness.docFire("mouseup", {});
    expect(panel.style.left).toBe("780px"); // (1280-400) - 100
    expect(panel.style.top).toBe("210px"); // 60 + 150
    expect(storage.get("ysp:panel:v1")).toContain('"left":780');

    // Opacity cycles and persists.
    const opacity = header.children.find((child) => child.textContent === "100%")!;
    opacity.fire("click");
    expect(panel.style.opacity).toBe("0.85");
    expect(opacity.textContent).toBe("85%");

    // A fresh mount in the same browser restores both.
    const second = createHarness(script, storage);
    const panel2 = second.panel()!;
    expect(panel2.style.left).toBe("780px");
    expect(panel2.style.opacity).toBe("0.85");
  });

  test("the resize grip resizes the panel and persists the size", () => {
    const storage = new Map<string, string>();
    const harness = createHarness(script, storage);
    const panel = harness.panel()!;
    const grip = harness.nodes.find((node) => node.id === "ysp-grip")!;
    expect(grip).toBeDefined();

    grip.fire("mousedown", { clientX: 800, clientY: 500 });
    harness.docFire("mousemove", { clientX: 900, clientY: 560 });
    harness.docFire("mouseup", {});
    expect(panel.style.width).toBe("500px"); // 400 + 100
    expect(panel.style.height).toBe("720px"); // (800-140) + 60
    expect(panel.style.bottom).toBe("auto");
    expect(storage.get("ysp:panel:v1")).toContain('"width":500');

    // A fresh mount restores the stored size and clamps to minimums.
    const second = createHarness(script, storage);
    expect(second.panel()!.style.width).toBe("500px");
    storage.set("ysp:panel:v1", JSON.stringify({ width: 10, height: 10 }));
    const third = createHarness(script, storage);
    expect(third.panel()!.style.width).toBe("280px");
    expect(third.panel()!.style.height).toBe("200px");
  });

  test("the panel title carries the brand and the UI follows the system locale", () => {
    const korean = createHarness(script);
    const koreanHeader = korean.panel()!.children[0]!;
    expect(koreanHeader.children[0]!.textContent).toBe("말귀");
    expect(koreanHeader.children.map((c) => c.textContent)).toContain("단어장");

    const english = createHarness(script, undefined, "en-US");
    const englishHeader = english.panel()!.children[0]!;
    expect(englishHeader.children[0]!.textContent).toBe("Malgwi");
    expect(englishHeader.children.map((c) => c.textContent)).toContain("Vocabulary");

    const chinese = createHarness(script, undefined, "zh-CN");
    expect(chinese.panel()!.children[0]!.children.map((c) => c.textContent)).toContain("生词本");
  });

  test("dragging the header never hijacks its buttons", () => {
    const harness = createHarness(script);
    const panel = harness.panel()!;
    const header = panel.children[0]!;
    const chip = header.children[1]!; // a real button
    header.fire("mousedown", { target: chip, clientX: 1000, clientY: 100 });
    harness.docFire("mousemove", { clientX: 500, clientY: 500 });
    expect(panel.style.left).toBeUndefined();
  });

  test("the speed chip cycles the page player's playback rate", () => {
    const harness = createHarness(script);
    const header = harness.panel()!.children[0]!;
    const speed = header.children.find((child) => child.textContent === "1×")!;
    expect(speed).toBeDefined();
    speed.fire("click");
    expect(harness.video.playbackRate).toBe(0.75);
    expect(speed.textContent).toBe("0.75×");
    speed.fire("click");
    expect(harness.video.playbackRate).toBe(0.5);
    speed.fire("click");
    expect(harness.video.playbackRate).toBe(1);
    expect(speed.textContent).toBe("1×");
  });

  test("sentence mode repeats the whole derived sentence across cue cuts", () => {
    const fragmented = validateLesson({
      ...lessonFixture,
      source_digest: lessonFixture.source_digest,
      lines: [
        { start_ms: 0, end_ms: 2000, original: "This class is on self-improving AI", pronunciation: "p0", translation: "t0" },
        { start_ms: 2000, end_ms: 3500, original: "agents.", pronunciation: "p1", translation: "t1" },
        { start_ms: 3600, end_ms: 5000, original: ">> There's a good balance.", pronunciation: "p2", translation: "t2" },
      ],
    });
    const harness = createHarness(compileLibraryScript([fragmented]));
    const list = harness.panel()!.children[2]!;
    const repeatOnSecondCue = list.children[1]!.children[0]!.children[1]!;

    // Sentence mode (default): the repeat range spans both fragment cues.
    repeatOnSecondCue.fire("click");
    expect(harness.video.currentTime).toBeCloseTo(0);
    harness.video.currentTime = 3.6;
    harness.tick();
    expect(harness.video.currentTime).toBeCloseTo(0);
    harness.video.currentTime = 3.6;
    harness.tick();
    expect(repeatOnSecondCue.textContent).toBe("↺");

    // Toggling the sentence chip off repeats only the single cue.
    const header = harness.panel()!.children[0]!;
    const sentenceChip = header.children.find((child) => child.textContent === "문장 반복")!;
    sentenceChip.fire("click");
    repeatOnSecondCue.fire("click");
    expect(harness.video.currentTime).toBeCloseTo(2.0);
    harness.video.currentTime = 3.55;
    harness.tick();
    expect(harness.video.currentTime).toBeCloseTo(2.0);
  });

  test("explicit sentence_end flags override the boundary heuristics", () => {
    const flagged = validateLesson({
      ...lessonFixture,
      lines: [
        // No punctuation, but explicitly a sentence end.
        { start_ms: 0, end_ms: 2000, original: "so that is the whole idea", pronunciation: "p0", translation: "t0", sentence_end: true },
        // Punctuation, but explicitly NOT an end (e.g. an abbreviation).
        { start_ms: 2000, end_ms: 3500, original: "and then Dr.", pronunciation: "p1", translation: "t1", sentence_end: false },
        { start_ms: 3500, end_ms: 5000, original: "Smith continued", pronunciation: "p2", translation: "t2" },
      ],
    });
    const harness = createHarness(compileLibraryScript([flagged]));
    const list = harness.panel()!.children[2]!;

    // Line 0 stands alone: repeating it never pulls in line 1.
    list.children[0]!.children[0]!.children[1]!.fire("click");
    expect(harness.video.currentTime).toBeCloseTo(0);
    harness.video.currentTime = 2.1;
    harness.tick();
    expect(harness.video.currentTime).toBeCloseTo(0);

    // Line 1 flows into line 2 despite the period: the range spans both.
    const secondRepeat = list.children[1]!.children[0]!.children[1]!;
    secondRepeat.fire("click");
    expect(harness.video.currentTime).toBeCloseTo(2.0);
    harness.video.currentTime = 5.1;
    harness.tick();
    expect(harness.video.currentTime).toBeCloseTo(2.0);
  });

  test("dragging a word captures it with gloss, examples, and dictionary link", async () => {
    const harness = createHarness(script);
    const panel = harness.panel()!;
    const list = panel.children[2]!;

    // Simulate selecting "town" inside the list, then confirm the popup.
    harness.select("Town, ", list.children[2]!);
    list.fire("mouseup", { clientX: 100, clientY: 100 });
    await harness.flush();
    const addButton = harness.nodes.find((node) => node.textContent.startsWith("+ 단어장: "));
    expect(addButton).toBeDefined();
    expect(addButton!.textContent).toBe("+ 단어장: town");
    addButton!.fire("click");
    expect(harness.storage.get("ysp:vocab:v1")).toContain('"town"');

    // Switch to the vocabulary view and inspect the card.
    const header = panel.children[0]!;
    const vocabChip = header.children.find((child) => child.textContent === "단어장")!;
    vocabChip.fire("click");
    const card = list.children[0]!;
    const head = card.children[0]!;
    expect(head.children[0]!.textContent).toBe("town");
    expect(head.children[1]!.textContent).toBe("마을, 동네");
    // One usage example from the lines, with its translation.
    expect(card.children.length).toBeGreaterThan(1);
    const example = card.children[1]!;
    expect(example.children[1]!.children[0]!.textContent).toContain("town");

    // The dictionary button opens the pair-mapped dictionary once.
    head.children[2]!.fire("click");
    expect(harness.opened.some((url) => url.includes("query=town"))).toBe(true);

    // Delete removes it from the persistent store.
    head.children[3]!.fire("click");
    expect(harness.storage.get("ysp:vocab:v1")).not.toContain('"town"');
  });

  test("a stored local lesson mounts the study panel without fetch", async () => {
    const videoId = "local000ABC";
    const captions = validateCaptions([
      { start_ms: 0, end_ms: 1000, text: "Offline line." },
    ]);
    const draft = buildLessonDraft(captions, { provider: "youtube", video_id: videoId, source_language: "en" }, "ko");
    const sealed = sealLesson({
      ...draft,
      lines: [{ ...draft.lines[0]!, pronunciation: "오프", translation: "오프라인 줄." }],
    });
    const storage = new Map<string, string>();
    storeSealedLocalLesson(storage, sealed);
    const harness = createHarness(compileLibraryScript([lesson]), storage);
    harness.windowStub.__yspTestHooks!.setReadSessionCaptions(() => ({
      captions: captions.map((caption) => ({ ...caption })),
      language: "en",
    }));
    harness.navigate(videoId);
    await harness.flush();
    expect(harness.createPanel()).toBeNull();
    expect(harness.panel()).not.toBeNull();
    expect(harness.digestBanner()).toBeNull();
    expect(harness.panel()!.children[2]!.children[0]!.children[1]!.children[0]!.textContent).toBe("Offline line.");
  });

  test("revisit with matching session captions stays offline without a digest banner", async () => {
    const videoId = "digest00001";
    const captions = validateCaptions([
      { start_ms: 0, end_ms: 1000, text: "Still the same cue." },
    ]);
    const draft = buildLessonDraft(captions, { provider: "youtube", video_id: videoId, source_language: "en" }, "ko");
    const sealed = sealLesson({
      ...draft,
      lines: [{ ...draft.lines[0]!, pronunciation: "p", translation: "t" }],
    });
    expect(sealed.source_digest).toBe(captionDigest(captions));
    const storage = new Map<string, string>();
    storeSealedLocalLesson(storage, sealed);
    const harness = createHarness(compileLibraryScript([lesson]), storage, "en-US");
    harness.windowStub.__yspTestHooks!.setReadSessionCaptions(() => ({
      captions: captions.map((caption) => ({ ...caption })),
      language: "en",
    }));
    harness.navigate(videoId);
    await harness.flush();
    expect(harness.panel()).not.toBeNull();
    expect(harness.digestBanner()).toBeNull();
    expect(harness.createPanel()).toBeNull();
  });

  test("revisit detects caption digest changes and keeps the stored lesson visible", async () => {
    const videoId = "digest00002";
    const storedCaptions = validateCaptions([
      { start_ms: 0, end_ms: 1000, text: "Original stored cue." },
    ]);
    const draft = buildLessonDraft(
      storedCaptions,
      { provider: "youtube", video_id: videoId, source_language: "en" },
      "ko",
    );
    const sealed = sealLesson({
      ...draft,
      lines: [{ ...draft.lines[0]!, pronunciation: "stored", translation: "저장됨" }],
    });
    const changedCaptions = validateCaptions([
      { start_ms: 0, end_ms: 1000, text: "Updated player cue." },
    ]);
    expect(captionDigest(changedCaptions)).not.toBe(sealed.source_digest);
    const storage = new Map<string, string>();
    storeSealedLocalLesson(storage, sealed);
    const harness = createHarness(compileLibraryScript([lesson]), storage, "en-US");
    harness.windowStub.__yspTestHooks!.setReadSessionCaptions(() => ({
      captions: changedCaptions.map((caption) => ({ ...caption })),
      language: "en",
    }));
    harness.navigate(videoId);
    await harness.flush();
    expect(harness.panel()).not.toBeNull();
    expect(harness.digestBanner()).not.toBeNull();
    const original = harness.nodes.find((node) => node.textContent === "Original stored cue.");
    expect(original).toBeDefined();
  });

  test("revisit without loaded session captions keeps the stored lesson without a false digest banner", async () => {
    const videoId = "digest00003";
    const captions = validateCaptions([
      { start_ms: 0, end_ms: 1000, text: "No player captions yet." },
    ]);
    const draft = buildLessonDraft(captions, { provider: "youtube", video_id: videoId, source_language: "en" }, "ko");
    const sealed = sealLesson({
      ...draft,
      lines: [{ ...draft.lines[0]!, pronunciation: "p", translation: "t" }],
    });
    const storage = new Map<string, string>();
    storeSealedLocalLesson(storage, sealed);
    const harness = createHarness(compileLibraryScript([lesson]), storage, "en-US");
    harness.windowStub.__yspTestHooks!.setReadSessionCaptions(() => ({ error: "no_captions" }));
    harness.navigate(videoId);
    await harness.flush();
    expect(harness.panel()).not.toBeNull();
    expect(harness.digestBanner()).toBeNull();
  });

  test("regenerate replaces a stored lesson after captions change", async () => {
    const videoId = "digest00004";
    const storedCaptions = validateCaptions([
      { start_ms: 0, end_ms: 1200, text: "Old cue." },
    ]);
    const draft = buildLessonDraft(
      storedCaptions,
      { provider: "youtube", video_id: videoId, source_language: "en" },
      "ko",
    );
    const sealed = sealLesson({
      ...draft,
      lines: [{ ...draft.lines[0]!, pronunciation: "old", translation: "옛 줄" }],
    });
    const changedCaptions = validateCaptions([
      { start_ms: 0, end_ms: 1200, text: "Fresh cue." },
      { start_ms: 1200, end_ms: 2400, text: "Second fresh cue." },
    ]);
    const storage = new Map<string, string>();
    storeSealedLocalLesson(storage, sealed);
    let fetchCalls = 0;
    const harness = createHarness(compileLibraryScript([lesson]), storage, "en-US", {
      fetchImpl: () => {
        fetchCalls += 1;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  lines: [
                    { pronunciation: "new1", translation: "t1" },
                    { pronunciation: "new2", translation: "t2" },
                  ],
                }),
              },
            }],
          }),
        } as Response);
      },
    });
    harness.windowStub.__yspTestHooks!.setReadSessionCaptions(() => ({
      captions: changedCaptions.map((caption) => ({ ...caption })),
      language: "en",
    }));
    harness.storage.set(
      "ysp:authoring:v1",
      JSON.stringify({
        endpoint: "https://example.test/v1",
        apiKey: "test-key",
        model: "test-model",
        study_language: "ko",
      }),
    );
    harness.navigate(videoId);
    await harness.flush();
    const regenBtn = harness.nodes.find((node) => node.textContent === "Regenerate lesson");
    expect(regenBtn).toBeDefined();
    regenBtn!.fire("click");
    await harness.flush();
    await harness.flush();
    await harness.flush();
    expect(fetchCalls).toBe(1);
    expect(harness.panel()).not.toBeNull();
    expect(harness.digestBanner()).toBeNull();
    expect(harness.panel()!.children[2]!.children).toHaveLength(2);
    expect(harness.panel()!.children[2]!.children[0]!.children[1]!.children[0]!.textContent).toBe("Fresh cue.");
    expect(harness.storage.get(LOCAL_LESSON_INDEX_KEY)).toContain(captionDigest(changedCaptions));
  });

  test("compiled library lessons win over a stored local lesson", async () => {
    const storage = new Map<string, string>();
    const localDraft = buildLessonDraft(
      [{ start_ms: 0, end_ms: 1000, text: "Local only." }],
      { provider: "youtube", video_id: lesson.video.video_id, source_language: "en" },
      "ko",
    );
    const localSealed = sealLesson({
      ...localDraft,
      lines: [{ ...localDraft.lines[0]!, pronunciation: "로컬", translation: "로컬만." }],
    });
    storage.set(localLessonStorageKey(lesson.video.video_id, "ko", localSealed.source_digest), JSON.stringify(localSealed));
    storage.set(
      LOCAL_LESSON_INDEX_KEY,
      JSON.stringify([
        {
          video_id: lesson.video.video_id,
          study_language: "ko",
          source_digest: localSealed.source_digest,
          complete: true,
        },
      ]),
    );
    const harness = createHarness(compileLibraryScript([lesson]), storage);
    await harness.flush();
    expect(harness.panel()!.children[2]!.children).toHaveLength(lesson.lines.length);
    expect(harness.panel()!.children[2]!.children[0]!.children[1]!.children[0]!.textContent).toBe(
      lesson.lines[0]!.original,
    );
  });

  test("create lesson stores a sealed lesson after mocked model batches", async () => {
    const videoId = "newvid12345";
    const captions = validateCaptions([
      { start_ms: 0, end_ms: 1200, text: "First cue." },
      { start_ms: 1200, end_ms: 2400, text: "Second cue." },
    ]);
    let fetchCalls = 0;
    const harness = createHarness(compileLibraryScript([lesson]), new Map(), "en-US", {
      fetchImpl: () => {
        fetchCalls += 1;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  lines: [
                    { pronunciation: "p1", translation: "t1" },
                    { pronunciation: "p2", translation: "t2" },
                  ],
                }),
              },
            }],
          }),
        } as Response);
      },
    });
    expect(harness.windowStub.__yspTestHooks).not.toBeNull();
    harness.windowStub.__yspTestHooks!.setReadSessionCaptions(() => ({
      captions: captions.map((caption) => ({ ...caption })),
      language: "en",
    }));
    harness.storage.set(
      "ysp:authoring:v1",
      JSON.stringify({
        endpoint: "https://example.test/v1",
        apiKey: "test-key",
        model: "test-model",
        study_language: "ko",
      }),
    );
    harness.navigate(videoId);
    await harness.flush();
    expect(harness.createPanel()).not.toBeNull();
    const createBtn = harness.nodes.find((node) => node.textContent === "Create lesson");
    expect(createBtn).toBeDefined();
    createBtn!.fire("click");
    await harness.flush();
    await harness.flush();
    await harness.flush();
    expect(fetchCalls).toBe(1);
    expect(harness.panel()).not.toBeNull();
    expect(harness.panel()!.children[2]!.children).toHaveLength(2);
    expect(harness.storage.get(LOCAL_LESSON_INDEX_KEY)).toContain(videoId);
  });
});
