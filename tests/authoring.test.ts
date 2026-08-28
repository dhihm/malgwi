import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import {
  authoringPromptForBatch,
  batchIndices,
  browserCanonicalJson,
  buildLessonDraft,
  isLessonComplete,
  isAuthoringEndpointAllowed,
  lessonContainsSecret,
  localLessonStorageKey,
  maskApiKey,
  mergeModelBatch,
  normalizeProvider,
  parseModelBatchResponse,
  prepareAuthoringModule,
  PROVIDER_PRESETS,
  publicSettingsForStorage,
  resolveAuthoringSettings,
  resolveProviderEndpoint,
  resolveProviderModel,
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
    const prepared = prepareAuthoringModule(authoringTemplate, { testHooks: true });
    expect(prepared).toContain("return a < b ? -1 : a > b ? 1 : 0");
    expect(prepared).toContain("openrouter.ai/api/v1");
    expect(prepared).not.toContain("/*__CANONICAL_JSON__*/");
    expect(prepared).not.toContain("/*__AUTHORING_CORE__*/");
    expect(prepared).not.toContain("/*__PROVIDER_PRESETS__*/");
    expect(prepared).toContain("__yspTestHooks");
  });

  test("production authoring modules omit test hooks", () => {
    const prepared = prepareAuthoringModule(authoringTemplate);
    expect(prepared).not.toContain("__yspTestHooks");
    expect(prepared).not.toContain("/*__TEST_HOOKS__*/");
  });
});

describe("provider presets", () => {
  test("OpenRouter fills the default endpoint and cheap chat model", () => {
    expect(resolveProviderEndpoint("openrouter")).toBe(PROVIDER_PRESETS.openrouter.endpoint);
    expect(resolveProviderModel("openrouter")).toBe(PROVIDER_PRESETS.openrouter.defaultModel);
  });

  test("OpenAI fills the default endpoint and model", () => {
    expect(resolveProviderEndpoint("openai")).toBe(PROVIDER_PRESETS.openai.endpoint);
    expect(resolveProviderModel("openai")).toBe(PROVIDER_PRESETS.openai.defaultModel);
  });

  test("custom provider uses the user endpoint and optional model override", () => {
    expect(resolveProviderEndpoint("custom", "https://proxy.example.test/v1")).toBe("https://proxy.example.test/v1");
    expect(resolveProviderModel("custom", "my-model")).toBe("my-model");
    expect(resolveProviderModel("custom")).toBe("gpt-4o-mini");
  });

  test("resolveAuthoringSettings requires both endpoint and key", () => {
    expect(
      resolveAuthoringSettings({ provider: "openrouter", study_language: "ko" }, "secret-key"),
    ).toMatchObject({
      provider: "openrouter",
      endpoint: PROVIDER_PRESETS.openrouter.endpoint,
      apiKey: "secret-key",
      study_language: "ko",
    });
    expect(resolveAuthoringSettings({ provider: "openrouter" }, "")).toBeNull();
    expect(
      resolveAuthoringSettings({ provider: "custom", custom_endpoint: "http://evil.test/v1" }, "secret-key"),
    ).toMatchObject({ endpoint: "http://evil.test/v1" });
  });

  test("public settings storage never includes the API key", () => {
    const stored = publicSettingsForStorage({
      provider: "openrouter",
      study_language: "ko",
      model: "openai/gpt-4o-mini",
    });
    expect(stored).toEqual({
      provider: "openrouter",
      study_language: "ko",
      model: "openai/gpt-4o-mini",
    });
    expect(JSON.stringify(stored)).not.toContain("secret");
  });

  test("maskApiKey shows only the last four characters", () => {
    expect(maskApiKey("sk-live-abcdef1234")).toBe("\u2022\u2022\u2022\u20221234");
    expect(maskApiKey("abc")).toBe("");
  });

  test("lesson JSON must not embed the API key", () => {
    const draft = buildLessonDraft(validateCaptions(captionsFixture), lessonFixture.video, "ko");
    const secret = "super-secret-key";
    expect(lessonContainsSecret(draft, secret)).toBe(false);
    expect(lessonContainsSecret({ ...draft, apiKey: secret }, secret)).toBe(true);
  });

  test("unknown provider values fall back to OpenRouter", () => {
    expect(normalizeProvider(undefined)).toBe("openrouter");
    expect(normalizeProvider("weird")).toBe("openrouter");
  });
});

describe("authoring endpoint policy", () => {
  test("allows HTTPS endpoints", () => {
    expect(isAuthoringEndpointAllowed("https://api.example.test/v1")).toBe(true);
  });

  test("allows HTTP localhost for local testing", () => {
    expect(isAuthoringEndpointAllowed("http://localhost:8080/v1")).toBe(true);
    expect(isAuthoringEndpointAllowed("http://127.0.0.1/v1")).toBe(true);
  });

  test("rejects plain HTTP endpoints", () => {
    expect(isAuthoringEndpointAllowed("http://api.example.test/v1")).toBe(false);
  });

  test("rejects relative endpoints", () => {
    expect(isAuthoringEndpointAllowed("/v1")).toBe(false);
    expect(isAuthoringEndpointAllowed("chat/completions")).toBe(false);
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
