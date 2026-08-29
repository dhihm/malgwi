import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLessonPage, buildLibraryScript } from "../compiler/build.ts";
import { compileLibrary, compilePage, LESSON_SLOT, LESSONS_SLOT, LessonValidationError, validateLesson } from "../src/lesson.ts";

const template = readFileSync(new URL("../runtime/index.template.html", import.meta.url), "utf8");
const userscript = readFileSync(new URL("../runtime/study.user.template.js", import.meta.url), "utf8");
const libraryTemplate = readFileSync(new URL("../runtime/library.user.template.js", import.meta.url), "utf8");
const lessonFixture = JSON.parse(readFileSync(new URL("../fixtures/lesson.sample.json", import.meta.url), "utf8"));

describe("runtime template contract", () => {
  test("contains the lesson slot exactly once", () => {
    expect(template.split(LESSON_SLOT)).toHaveLength(2);
  });

  test("references no external origin besides YouTube itself", () => {
    const origins = [...template.matchAll(/https?:\/\/[^\s"'<>]+/gu)].map((match) => match[0]);
    expect(origins).toEqual([
      "https://www.youtube.com/watch?v=",
      "https://www.youtube.com/iframe_api",
    ]);
  });

  test("falls back to timestamp links when the embed is refused", () => {
    expect(template).toContain("onError");
    expect(template).toContain("event.data === 101 || event.data === 150 || event.data === 153");
    expect(template).toContain('body[data-embed-failed="1"] .frame');
    expect(template).not.toContain('name="referrer"');
  });

  test("userscript template augments the real watch page without embedding", () => {
    expect(userscript.split(LESSON_SLOT)).toHaveLength(2);
    expect(userscript).toContain("// ==UserScript==");
    expect(userscript).toContain("video.currentTime = ms / 1000");
    expect(userscript).toContain("jumpButton");
    expect(userscript).toContain("ysp:vocab:v1");
    expect(userscript).toContain("glossFor");
    expect(userscript).not.toContain("iframe_api");
    expect(userscript).not.toContain("innerHTML");
    const origins = [...userscript.matchAll(/https?:\/\/[^\s"'<>]+/gu)].map((match) => match[0]);
    for (const origin of origins) {
      const allowed = [
        "https://www.youtube.com",
        "https://en.dict.naver.com",
        "https://dict.naver.com",
        "https://www.youdao.com",
        "https://ejje.weblio.jp",
        "https://en.wiktionary.org",
        "https://github.com/dhihm/",
      ];
      expect(allowed.some((prefix) => origin.startsWith(prefix))).toBe(true);
    }
  });

  test("library userscript is playback-only with no model grants", () => {
    expect(libraryTemplate.split(LESSONS_SLOT)).toHaveLength(2);
    expect(libraryTemplate).toContain("// ==UserScript==");
    // The only manager privilege is the menu entry; nothing data-facing.
    expect(libraryTemplate).toContain("@grant        GM_registerMenuCommand");
    expect(libraryTemplate).not.toContain("GM_xmlhttpRequest");
    expect(libraryTemplate).not.toContain("GM_setValue");
    expect(libraryTemplate).not.toContain("GM_xmlhttpRequest");
    expect(libraryTemplate).not.toContain("GM.setValue");
    expect(libraryTemplate).not.toContain("GM.getValue");
    expect(libraryTemplate).not.toContain("Create lesson");
    expect(libraryTemplate).not.toContain("Regenerate");
    expect(libraryTemplate).toContain("notInLibrary");
    expect(libraryTemplate).not.toContain("innerHTML");
    const other = structuredClone(lessonFixture);
    other.video.video_id = "zzz999AAA_-";
    const script = compileLibrary(libraryTemplate, [validateLesson(lessonFixture), validateLesson(other)]);
    expect(script).toContain("abc123XYZ_-");
    expect(script).toContain("zzz999AAA_-");
    expect(() =>
      compileLibrary(libraryTemplate, [validateLesson(lessonFixture), validateLesson(lessonFixture)]),
    ).toThrow(/duplicate/u);
    expect(() => compileLibrary(libraryTemplate, [])).toThrow(LessonValidationError);
    const dir = mkdtempSync(join(tmpdir(), "ysp-lib-"));
    const first = buildLibraryScript([lessonFixture, other], join(dir, "a", "library.user.js"));
    const second = buildLibraryScript([lessonFixture, other], join(dir, "b", "library.user.js"));
    expect(first.lessonCount).toBe(2);
    expect(first.libraryDigest).toBe(second.libraryDigest);
  });

  test("supports the standalone sheet mode", () => {
    expect(template).toContain('LESSON.display && LESSON.display.mode === "sheet"');
    expect(template).toContain('body[data-mode="sheet"] .frame');
  });

  test("never renders lesson text through innerHTML", () => {
    expect(template).not.toContain("innerHTML");
    expect(template).not.toContain("insertAdjacentHTML");
    expect(template).not.toContain("document.write");
  });
});

describe("page compilation", () => {
  test("injects the lesson and keeps the rest of the template byte-identical", () => {
    const lesson = validateLesson(lessonFixture);
    const page = compilePage(template, lesson);
    const [head, tail] = template.split(LESSON_SLOT);
    expect(page.startsWith(head!)).toBe(true);
    expect(page.endsWith(tail!)).toBe(true);
    expect(page).toContain(lesson.source_digest);
  });

  test("refuses a template without the slot", () => {
    expect(() => compilePage("<html></html>", validateLesson(lessonFixture))).toThrow(LessonValidationError);
  });

  test("build output is deterministic", () => {
    const dirA = mkdtempSync(join(tmpdir(), "ysp-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "ysp-b-"));
    const first = buildLessonPage(lessonFixture, dirA);
    const second = buildLessonPage(lessonFixture, dirB);
    expect(first.pageDigest).toBe(second.pageDigest);
    expect(first.userscriptDigest).toBe(second.userscriptDigest);
    expect(first.lessonDigest).toBe(second.lessonDigest);
    expect(readFileSync(join(dirA, "index.html"), "utf8")).toBe(readFileSync(join(dirB, "index.html"), "utf8"));
    expect(readFileSync(join(dirA, "study.user.js"), "utf8")).toBe(readFileSync(join(dirB, "study.user.js"), "utf8"));
  });

  test("dollar sequences in lesson text are inserted literally", () => {
    const hostile = structuredClone(lessonFixture);
    hostile.lines[0].original = "That costs $100, $& and $' included.";
    const page = compilePage(template, validateLesson(hostile));
    const start = page.indexOf("var LESSON = ") + "var LESSON = ".length;
    const end = page.indexOf(";", start);
    const parsed = JSON.parse(page.slice(start, end));
    expect(parsed.lines[0].original).toBe("That costs $100, $& and $' included.");
  });

  test("hostile lesson text cannot break out of the inline script", () => {
    const hostile = structuredClone(lessonFixture);
    hostile.lines[1].translation = "</script><img src=x onerror=alert(1)>";
    const page = compilePage(template, validateLesson(hostile));
    const scriptCloses = [...page.matchAll(/<\/script>/gu)];
    const templateCloses = [...template.matchAll(/<\/script>/gu)];
    expect(scriptCloses).toHaveLength(templateCloses.length);
  });
});
