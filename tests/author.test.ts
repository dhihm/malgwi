import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorLessonFromCaptions } from "../compiler/author.ts";
import {
  authoringPromptForBatch,
  batchIndices,
  buildLessonDraft,
  callModelBatch,
  isAuthoringEndpointAllowed,
  isLessonComplete,
  mergeModelBatch,
  outputContainsSecret,
  parseModelBatchResponse,
  PROVIDER_PRESETS,
  resolveEnvCredentials,
  sealLesson,
  type ChatCompletionClient,
} from "../src/authoring.ts";
import { parseCaptionsFile } from "../src/captions.ts";
import { captionDigest, validateCaptions, validateLesson } from "../src/lesson.ts";

const captionsFixture = JSON.parse(readFileSync(new URL("../fixtures/captions.sample.json", import.meta.url), "utf8"));
const lessonFixture = JSON.parse(readFileSync(new URL("../fixtures/lesson.sample.json", import.meta.url), "utf8"));

describe("caption file parsing", () => {
  test("accepts JSON captures", () => {
    const dir = mkdtempSync(join(tmpdir(), "ysp-cap-"));
    const path = join(dir, "captions.json");
    writeFileSync(path, JSON.stringify(captionsFixture), "utf8");
    expect(parseCaptionsFile(path)).toHaveLength(5);
  });

  test("accepts a minimal SRT file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ysp-srt-"));
    const path = join(dir, "captions.srt");
    writeFileSync(
      path,
      "1\n00:00:00,400 --> 00:00:02,100\nWhat are you doing here?\n\n" +
        "2\n00:00:02,100 --> 00:00:04,300\nI could ask you the same thing.\n",
      "utf8",
    );
    const captions = parseCaptionsFile(path);
    expect(captions[0]).toMatchObject({ start_ms: 400, end_ms: 2100, text: "What are you doing here?" });
  });
});

describe("environment credentials", () => {
  test("prefers OpenRouter when both keys are set", () => {
    const settings = resolveEnvCredentials({
      OPENROUTER_API_KEY: "or-key",
      OPENAI_API_KEY: "oa-key",
      OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
    });
    expect(settings.provider).toBe("openrouter");
    expect(settings.apiKey).toBe("or-key");
    expect(settings.endpoint).toBe("https://openrouter.ai/api/v1");
    expect(settings.model).toBe(PROVIDER_PRESETS.openrouter.defaultModel);
  });

  test("falls back to OpenAI when only OPENAI_API_KEY is set", () => {
    const settings = resolveEnvCredentials({
      OPENAI_API_KEY: "oa-key",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      OPENAI_MODEL: "gpt-4o-mini",
    });
    expect(settings.provider).toBe("openai");
    expect(settings.endpoint).toBe("https://api.openai.com/v1");
  });

  test("requires an API key in the environment", () => {
    expect(() => resolveEnvCredentials({})).toThrow(/OPENROUTER_API_KEY|OPENAI_API_KEY/u);
  });
});

describe("authoring endpoint policy", () => {
  test("allows HTTPS endpoints and localhost HTTP", () => {
    expect(isAuthoringEndpointAllowed("https://api.example.test/v1")).toBe(true);
    expect(isAuthoringEndpointAllowed("http://localhost:8080/v1")).toBe(true);
    expect(isAuthoringEndpointAllowed("http://api.example.test/v1")).toBe(false);
  });
});

describe("lesson draft and merge", () => {
  test("builds a draft with sealed originals", () => {
    const captions = validateCaptions(captionsFixture);
    const draft = buildLessonDraft(captions, lessonFixture.video, "ko");
    expect(draft.source_digest).toBe(captionDigest(captions));
    expect(isLessonComplete(draft)).toBe(false);
  });

  test("merges model batches without touching originals", () => {
    const draft = buildLessonDraft(validateCaptions(captionsFixture), lessonFixture.video, "ko");
    const merged = mergeModelBatch(draft, 0, {
      lines: lessonFixture.lines.map((line: { pronunciation: string; translation: string }) => ({
        pronunciation: line.pronunciation,
        translation: line.translation,
      })),
    });
    expect(merged.lines[0]!.original).toBe(draft.lines[0]!.original);
    expect(isLessonComplete(merged)).toBe(true);
    expect(sealLesson(merged as ReturnType<typeof buildLessonDraft>)).toMatchObject({
      source_digest: draft.source_digest,
    });
  });

  test("rejects model output with unknown keys", () => {
    expect(() =>
      parseModelBatchResponse({ lines: [{ pronunciation: "p", translation: "t", original: "hack" }] }, 1),
    ).toThrow(/unknown key/u);
  });

  test("splits long lessons into capped batches", () => {
    expect(batchIndices(250, 40, 200)).toHaveLength(5);
    expect(batchIndices(250, 40, 200)!.flat()).toHaveLength(200);
  });

  test("prompt lists originals and forbids editing them", () => {
    const draft = buildLessonDraft(validateCaptions(captionsFixture), lessonFixture.video, "ko");
    const prompt = authoringPromptForBatch(draft, [0, 1]);
    expect(prompt.system).toContain("Never change original");
    expect(prompt.user).toContain(draft.lines[0]!.original);
  });
});

describe("local author CLI", () => {
  test("refuses --api-key on the command line", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "compiler/author.ts",
        "--captions",
        "fixtures/captions.sample.json",
        "--video-id",
        "abc123XYZ_-",
        "--study-language",
        "ko",
        "--api-key",
        "secret",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await proc.exited).toBe(2);
  });

  test("authors a sealed lesson from the captions fixture with mocked HTTPS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ysp-author-"));
    const captionsPath = join(dir, "captions.json");
    writeFileSync(captionsPath, JSON.stringify(captionsFixture), "utf8");
    const outputPath = join(dir, "lesson.json");
    const secret = "test-secret-key";
    let requestedUrl = "";
    let authorization = "";
    const client: ChatCompletionClient = async (url, init) => {
      requestedUrl = url;
      authorization = init.headers.Authorization ?? "";
      const body = JSON.parse(init.body) as { messages: { content: string }[] };
      expect(body.messages[0]!.content).toContain("Never change original");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                lines: lessonFixture.lines.map((line: { pronunciation: string; translation: string }) => ({
                  pronunciation: line.pronunciation,
                  translation: line.translation,
                })),
                glossary: [{ word: "town", meaning: "마을" }],
              }),
            },
          }],
        }),
      };
    };
    const settings = {
      provider: "openrouter" as const,
      endpoint: "https://example.test/v1",
      apiKey: secret,
      model: "test-model",
      study_language: "ko",
    };
    const result = await authorLessonFromCaptions({
      captionsPath,
      videoId: lessonFixture.video.video_id,
      studyLanguage: "ko",
      sourceLanguage: "en",
      title: lessonFixture.video.title,
      outputPath,
      settings,
      fetchImpl: client as unknown as typeof fetch,
    });
    expect(requestedUrl).toBe("https://example.test/v1/chat/completions");
    expect(authorization).toBe(`Bearer ${secret}`);
    expect(validateLesson(result.lesson).lines).toHaveLength(5);
    expect(readFileSync(outputPath, "utf8")).not.toContain(secret);
    expect(outputContainsSecret(result.lesson, secret)).toBe(false);
  });

  test("callModelBatch rejects insecure endpoints before any request", async () => {
    const draft = buildLessonDraft(validateCaptions(captionsFixture), lessonFixture.video, "ko");
    let called = false;
    await expect(
      callModelBatch(
        {
          provider: "openrouter",
          endpoint: "http://evil.test/v1",
          apiKey: "key",
          model: "m",
          study_language: "ko",
        },
        draft,
        [0],
        async () => {
          called = true;
          return { ok: true, status: 200, json: async () => ({}) };
        },
      ),
    ).rejects.toThrow(/insecure endpoint/u);
    expect(called).toBe(false);
  });
});
