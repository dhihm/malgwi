import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import {
  authoringPromptForBatch,
  batchIndices,
  browserCanonicalJson,
  buildLessonDraft,
  isLessonComplete,
  localLessonStorageKey,
  mergeModelBatch,
  parseModelBatchResponse,
  prepareAuthoringModule,
  sealLesson,
  upsertLocalLessonIndex,
} from "../src/authoring.ts";
import { captionDigest, canonicalJson, validateCaptions } from "../src/lesson.ts";

const captionsFixture = JSON.parse(readFileSync(new URL("../fixtures/captions.sample.json", import.meta.url), "utf8"));
const lessonFixture = JSON.parse(readFileSync(new URL("../fixtures/lesson.sample.json", import.meta.url), "utf8"));
const authoringTemplate = readFileSync(new URL("../runtime/authoring.template.js", import.meta.url), "utf8");

async function browserSha256Hex(text: string): Promise<string> {
  const buffer = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("caption digest parity", () => {
  test("browser canonicalJson matches lesson.ts", () => {
    const captions = validateCaptions(captionsFixture);
    expect(browserCanonicalJson(captions)).toBe(canonicalJson(captions));
  });

  test("Web Crypto sha256 over browser canonicalJson matches captionDigest", async () => {
    const captions = validateCaptions(captionsFixture);
    const canonical = browserCanonicalJson(captions);
    expect(await browserSha256Hex(canonical)).toBe(captionDigest(captions));
    expect(await browserSha256Hex(canonical)).toBe(lessonFixture.source_digest);
  });

  test("prepareAuthoringModule injects the shared canonicalJson implementation", () => {
    const prepared = prepareAuthoringModule(authoringTemplate);
    expect(prepared).toContain("return a < b ? -1 : a > b ? 1 : 0");
    expect(prepared).not.toContain("/*__CANONICAL_JSON__*/");
  });
});

describe("local lesson storage keys", () => {
  test("keys lessons by video_id, study_language, and source_digest", () => {
    const key = localLessonStorageKey("abc123XYZ_-", "ko", lessonFixture.source_digest);
    expect(key).toBe(`ysp:lesson:v2:abc123XYZ_-:ko:${lessonFixture.source_digest}`);
  });

  test("upsert replaces prior entry for the same video and study language", () => {
    const first = upsertLocalLessonIndex([], {
      video_id: "abc123XYZ_-",
      study_language: "ko",
      source_digest: "aaa",
      complete: false,
    });
    const second = upsertLocalLessonIndex(first, {
      video_id: "abc123XYZ_-",
      study_language: "ko",
      source_digest: "bbb",
      complete: true,
    });
    expect(second).toHaveLength(1);
    expect(second[0]!.source_digest).toBe("bbb");
  });
});

describe("lesson draft from captions", () => {
  test("copies originals and timecodes verbatim and binds source_digest", () => {
    const captions = validateCaptions(captionsFixture);
    const draft = buildLessonDraft(captions, lessonFixture.video, "ko");
    expect(draft.source_digest).toBe(captionDigest(captions));
    expect(draft.lines).toHaveLength(captions.length);
    for (const [index, caption] of captions.entries()) {
      expect(draft.lines[index]).toMatchObject({
        start_ms: caption.start_ms,
        end_ms: caption.end_ms,
        original: caption.text,
      });
      expect(draft.lines[index]).not.toHaveProperty("pronunciation");
      expect(draft.lines[index]).not.toHaveProperty("translation");
    }
    expect(isLessonComplete(draft)).toBe(false);
  });

  test("seals only when every line has model fields", () => {
    const draft = buildLessonDraft(validateCaptions(captionsFixture), lessonFixture.video, "ko");
    expect(() => sealLesson(draft)).toThrow();
    const filled = {
      ...draft,
      lines: draft.lines.map((line, index) => ({
        ...line,
        pronunciation: lessonFixture.lines[index]!.pronunciation,
        translation: lessonFixture.lines[index]!.translation,
      })),
    };
    expect(isLessonComplete(filled)).toBe(true);
    expect(sealLesson(filled).source_digest).toBe(draft.source_digest);
  });
});

describe("model batching and merge", () => {
  test("splits indices with a cap", () => {
    expect(batchIndices(10, 4, 200)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9],
    ]);
    expect(batchIndices(250, 40, 200)).toHaveLength(5);
    expect(batchIndices(250, 40, 200)!.flat()).toHaveLength(200);
  });

  test("merges pronunciation and translation without touching originals", () => {
    const draft = buildLessonDraft(validateCaptions(captionsFixture), lessonFixture.video, "ko");
    const merged = mergeModelBatch(draft, 0, {
      lines: [
        { pronunciation: "왓 아 유 두잉 히어?", translation: "여기서 뭐 하고 있어?" },
        { pronunciation: "아이 쿠드 애스크 유 더 세임 씽.", translation: "그건 내가 묻고 싶은 말인데." },
      ],
    });
    expect(merged.lines[0]!.original).toBe(draft.lines[0]!.original);
    expect(merged.lines[1]!.translation).toBe("그건 내가 묻고 싶은 말인데.");
    expect(isLessonComplete(merged)).toBe(false);
  });

  test("seals after the final batch fills every line", () => {
    const draft = buildLessonDraft(validateCaptions(captionsFixture), lessonFixture.video, "ko");
    const modelLines = lessonFixture.lines.map((line: { pronunciation: string; translation: string }) => ({
      pronunciation: line.pronunciation,
      translation: line.translation,
    }));
    const merged = mergeModelBatch(draft, 0, { lines: modelLines, glossary: [{ word: "town", meaning: "마을" }] });
    expect(isLessonComplete(merged)).toBe(true);
    expect(merged.glossary).toEqual([{ word: "town", meaning: "마을" }]);
    expect(() => validateCaptions(captionsFixture)).not.toThrow();
  });

  test("rejects model output with unknown keys", () => {
    expect(() =>
      parseModelBatchResponse({ lines: [{ pronunciation: "p", translation: "t", original: "hack" }] }, 1),
    ).toThrow(/unknown key/u);
  });

  test("prompt lists originals and forbids editing them", () => {
    const draft = buildLessonDraft(validateCaptions(captionsFixture), lessonFixture.video, "ko");
    const prompt = authoringPromptForBatch(draft, [0, 1]);
    expect(prompt.system).toContain("Never change original");
    expect(prompt.user).toContain("Study language: ko");
    expect(prompt.user).toContain(draft.lines[0]!.original);
  });
});
