import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  captionDigest,
  firstOriginalMismatch,
  inlineLessonJson,
  LessonValidationError,
  validateCaptions,
  validateLesson,
} from "../src/lesson.ts";

const captionsFixture = JSON.parse(readFileSync(new URL("../fixtures/captions.sample.json", import.meta.url), "utf8"));
const lessonFixture = JSON.parse(readFileSync(new URL("../fixtures/lesson.sample.json", import.meta.url), "utf8"));

describe("caption capture validation", () => {
  test("accepts the fixture capture", () => {
    expect(validateCaptions(captionsFixture)).toHaveLength(5);
  });

  test("rejects overlapping order regression", () => {
    const bad = [
      { start_ms: 1000, end_ms: 2000, text: "b" },
      { start_ms: 500, end_ms: 900, text: "a" },
    ];
    expect(() => validateCaptions(bad)).toThrow(LessonValidationError);
  });

  test("rejects an empty or inverted line", () => {
    expect(() => validateCaptions([])).toThrow(LessonValidationError);
    expect(() => validateCaptions([{ start_ms: 900, end_ms: 900, text: "x" }])).toThrow(LessonValidationError);
    expect(() => validateCaptions([{ start_ms: 0, end_ms: 10, text: "" }])).toThrow(LessonValidationError);
  });
});

describe("lesson validation", () => {
  test("accepts the fixture lesson", () => {
    const lesson = validateLesson(lessonFixture);
    expect(lesson.video.video_id).toBe("abc123XYZ_-");
    expect(lesson.lines).toHaveLength(5);
  });

  test("binds source_digest to the capture", () => {
    const captions = validateCaptions(captionsFixture);
    expect(captionDigest(captions)).toBe(lessonFixture.source_digest);
  });

  test("rejects unknown keys, bad ids, and bad digests", () => {
    expect(() => validateLesson({ ...lessonFixture, extra: 1 })).toThrow(LessonValidationError);
    expect(() =>
      validateLesson({ ...lessonFixture, video: { ...lessonFixture.video, video_id: "short" } }),
    ).toThrow(LessonValidationError);
    expect(() => validateLesson({ ...lessonFixture, source_digest: "nope" })).toThrow(LessonValidationError);
  });

  test("accepts sheet display mode and rejects unknown modes", () => {
    const sheet = validateLesson({ ...lessonFixture, display: { mode: "sheet" } });
    expect(sheet.display).toEqual({ mode: "sheet" });
    expect(validateLesson(lessonFixture).display).toBeUndefined();
    expect(() => validateLesson({ ...lessonFixture, display: { mode: "overlay" } })).toThrow(LessonValidationError);
    expect(() => validateLesson({ ...lessonFixture, display: { mode: "sheet", extra: 1 } })).toThrow(LessonValidationError);
  });

  test("rejects a line missing model fields", () => {
    const lines = structuredClone(lessonFixture.lines);
    delete lines[0].translation;
    expect(() => validateLesson({ ...lessonFixture, lines })).toThrow(LessonValidationError);
  });
});

describe("original immutability", () => {
  test("verbatim lesson has no mismatch", () => {
    const captions = validateCaptions(captionsFixture);
    expect(firstOriginalMismatch(captions, validateLesson(lessonFixture))).toBe(-1);
  });

  test("an edited original is caught with its line index", () => {
    const captions = validateCaptions(captionsFixture);
    const tampered = structuredClone(lessonFixture);
    tampered.lines[2].original = "I thought you left town.";
    expect(firstOriginalMismatch(captions, validateLesson(tampered))).toBe(2);
  });

  test("a shifted timecode is caught", () => {
    const captions = validateCaptions(captionsFixture);
    const tampered = structuredClone(lessonFixture);
    tampered.lines[4].end_ms += 100;
    expect(firstOriginalMismatch(captions, validateLesson(tampered))).toBe(4);
  });

  test("a dropped line is caught", () => {
    const captions = validateCaptions(captionsFixture);
    const tampered = structuredClone(lessonFixture);
    tampered.lines.pop();
    expect(firstOriginalMismatch(captions, validateLesson(tampered))).toBe(4);
  });
});

describe("v1 migration", () => {
  test("a legacy v1 document upgrades to v2 with study_language ko", () => {
    const v1 = {
      schema_version: 1,
      video: { provider: "youtube", video_id: "abc123XYZ_-", source_language: "en" },
      source_digest: lessonFixture.source_digest,
      lines: [
        {
          start_ms: 0,
          end_ms: 900,
          original: "Hi.",
          pronunciation_ko: "하이.",
          translation_ko: "안녕.",
        },
      ],
      glossary: [{ word: "hi", meaning_ko: "안녕 (인사)" }],
    };
    const lesson = validateLesson(v1);
    expect(lesson.schema_version).toBe(2);
    expect(lesson.study_language).toBe("ko");
    expect(lesson.lines[0]).toMatchObject({ pronunciation: "하이.", translation: "안녕." });
    expect(lesson.glossary).toEqual([{ word: "hi", meaning: "안녕 (인사)" }]);
  });

  test("a v2 lesson accepts non-Korean study languages and CJK glossary words", () => {
    const lesson = validateLesson({
      ...lessonFixture,
      study_language: "zh-Hans",
      glossary: [{ word: "안녕", meaning: "你好" }],
    });
    expect(lesson.study_language).toBe("zh-Hans");
    expect(lesson.glossary).toEqual([{ word: "안녕", meaning: "你好" }]);
    expect(() => validateLesson({ ...lessonFixture, study_language: "Korean!" })).toThrow(LessonValidationError);
  });
});

describe("inline JSON safety", () => {
  test("script-breaking sequences are escaped and still round-trip", () => {
    const hostile = structuredClone(lessonFixture);
    hostile.lines[0].original = "</script><script>alert(1)</script>";
    hostile.lines[0].pronunciation = "\uc904\u2028\ubc14\uafc8\u2029\ub05d";
    const inline = inlineLessonJson(validateLesson(hostile));
    expect(inline).not.toContain("<");
    expect(inline).not.toContain("\u2028");
    expect(inline).not.toContain("\u2029");
    const parsed = JSON.parse(inline);
    expect(parsed.lines[0].original).toBe("</script><script>alert(1)</script>");
    expect(parsed.lines[0].pronunciation).toBe(hostile.lines[0].pronunciation);
  });
});
