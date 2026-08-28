/**
 * Local lesson authoring shared by the CLI and its tests: caption-to-lesson
 * conversion, model batching, field merge, and credential resolution.
 */
import {
  type CaptionLine,
  captionDigest,
  type GlossaryEntry,
  type LessonLine,
  type LessonV2,
  type LessonVideo,
  validateCaptions,
  validateLesson,
} from "./lesson.ts";

export const PROVIDER_PRESETS = {
  openrouter: {
    endpoint: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
  },
  openai: {
    endpoint: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
  },
} as const;

export type ProviderPreset = keyof typeof PROVIDER_PRESETS;

/** Default cap on lines sent to the model in one generate action. */
export const DEFAULT_LINE_CAP = 200;
/** Lines per model request when batching. */
export const DEFAULT_BATCH_SIZE = 40;

export interface LessonDraftLine {
  readonly start_ms: number;
  readonly end_ms: number;
  readonly original: string;
  readonly pronunciation?: string;
  readonly translation?: string;
  readonly sentence_end?: boolean;
}

/** In-progress lesson; model fields appear only after authoring batches. */
export interface LessonDraft {
  readonly schema_version: 2;
  readonly video: LessonVideo;
  readonly study_language: string;
  readonly source_digest: string;
  readonly lines: readonly LessonDraftLine[];
  readonly glossary?: readonly GlossaryEntry[];
}

/** Resolved settings used for model calls. */
export interface AuthoringSettings {
  readonly provider: ProviderPreset;
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly study_language: string;
}

export interface ModelLineFields {
  readonly pronunciation: string;
  readonly translation: string;
  readonly sentence_end?: boolean;
}

export interface ModelBatchResponse {
  readonly lines: readonly ModelLineFields[];
  readonly glossary?: readonly GlossaryEntry[];
}

export interface ChatCompletionRequest {
  readonly model: string;
  readonly response_format: { readonly type: "json_object" };
  readonly messages: readonly { readonly role: "system" | "user"; readonly content: string }[];
}

export interface ChatCompletionResult {
  readonly ok: boolean;
  readonly status: number;
  readonly json(): Promise<unknown>;
}

export type ChatCompletionClient = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<ChatCompletionResult>;

/** Resolve API credentials from the process environment only. */
export function resolveEnvCredentials(env: NodeJS.ProcessEnv = process.env): AuthoringSettings {
  const studyLanguage = String(env.MALGWI_STUDY_LANGUAGE ?? "ko").trim() || "ko";
  const openRouterKey = String(env.OPENROUTER_API_KEY ?? "").trim();
  if (openRouterKey) {
    const endpoint = String(env.OPENROUTER_BASE_URL ?? PROVIDER_PRESETS.openrouter.endpoint)
      .trim()
      .replace(/\/+$/u, "");
    const model = String(env.OPENROUTER_MODEL ?? PROVIDER_PRESETS.openrouter.defaultModel).trim();
    return {
      provider: "openrouter",
      endpoint,
      apiKey: openRouterKey,
      model,
      study_language: studyLanguage,
    };
  }
  const openAiKey = String(env.OPENAI_API_KEY ?? "").trim();
  if (openAiKey) {
    const endpoint = String(env.OPENAI_BASE_URL ?? PROVIDER_PRESETS.openai.endpoint)
      .trim()
      .replace(/\/+$/u, "");
    const model = String(env.OPENAI_MODEL ?? PROVIDER_PRESETS.openai.defaultModel).trim();
    return {
      provider: "openai",
      endpoint,
      apiKey: openAiKey,
      model,
      study_language: studyLanguage,
    };
  }
  throw new Error("Set OPENROUTER_API_KEY or OPENAI_API_KEY in the environment");
}

/** True when serialized output accidentally embeds a secret. */
export function outputContainsSecret(value: unknown, secret: string): boolean {
  if (!secret) return false;
  return JSON.stringify(value).includes(secret);
}

/** True when the model endpoint is an absolute HTTPS URL (HTTP localhost for tests). */
export function isAuthoringEndpointAllowed(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (!url.hostname) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Split line indices into batches for model calls. */
export function batchIndices(lineCount: number, batchSize: number, lineCap: number): number[][] {
  const capped = Math.min(lineCount, lineCap);
  const batches: number[][] = [];
  for (let start = 0; start < capped; start += batchSize) {
    const end = Math.min(start + batchSize, capped);
    const batch: number[] = [];
    for (let index = start; index < end; index += 1) batch.push(index);
    batches.push(batch);
  }
  return batches;
}

/** Build a lesson draft from captured captions; model fields are added later. */
export function buildLessonDraft(
  captions: readonly CaptionLine[],
  video: LessonVideo,
  studyLanguage: string,
): LessonDraft {
  const validated = validateCaptions(captions);
  const digest = captionDigest(validated);
  const lines: LessonDraftLine[] = validated.map((caption) => ({
    start_ms: caption.start_ms,
    end_ms: caption.end_ms,
    original: caption.text,
  }));
  return {
    schema_version: 2,
    video,
    study_language: studyLanguage,
    source_digest: digest,
    lines,
  };
}

/** Validate and seal a completed lesson. */
export function sealLesson(lesson: LessonDraft): LessonV2 {
  if (!isLessonComplete(lesson)) throw new Error("lesson is incomplete");
  const lines: LessonLine[] = lesson.lines.map((line) => ({
    start_ms: line.start_ms,
    end_ms: line.end_ms,
    original: line.original,
    pronunciation: line.pronunciation!,
    translation: line.translation!,
    ...(line.sentence_end !== undefined ? { sentence_end: line.sentence_end } : {}),
  }));
  return validateLesson({
    schema_version: 2,
    video: lesson.video,
    study_language: lesson.study_language,
    source_digest: lesson.source_digest,
    lines,
    ...(lesson.glossary !== undefined ? { glossary: lesson.glossary } : {}),
  });
}

/** True when every line has non-empty pronunciation and translation. */
export function isLessonComplete(lesson: LessonDraft | LessonV2): boolean {
  return (
    lesson.lines.length > 0 &&
    lesson.lines.every(
      (line) =>
        typeof line.pronunciation === "string" &&
        line.pronunciation.length > 0 &&
        typeof line.translation === "string" &&
        line.translation.length > 0,
    )
  );
}

/** Merge one model batch into a draft. Originals and timecodes never change. */
export function mergeModelBatch(
  lesson: LessonDraft,
  startIndex: number,
  response: ModelBatchResponse,
): LessonDraft | LessonV2 {
  const lines: LessonDraftLine[] = lesson.lines.map((line) => ({ ...line }));
  for (const [offset, fields] of response.lines.entries()) {
    const index = startIndex + offset;
    if (index >= lines.length) break;
    lines[index] = {
      ...lines[index]!,
      pronunciation: fields.pronunciation,
      translation: fields.translation,
      ...(fields.sentence_end !== undefined ? { sentence_end: fields.sentence_end } : {}),
    };
  }
  const glossary = response.glossary?.length ? response.glossary : lesson.glossary;
  const merged: LessonDraft = {
    ...lesson,
    lines,
    ...(glossary !== undefined ? { glossary } : {}),
  };
  return isLessonComplete(merged) ? sealLesson(merged) : merged;
}

/** Parse model JSON; rejects unknown keys. */
export function parseModelBatchResponse(value: unknown, expectedCount: number): ModelBatchResponse {
  const root = value as Record<string, unknown>;
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new Error("model response must be an object");
  }
  if (!Array.isArray(root.lines)) throw new Error("model response.lines must be an array");
  const lines: ModelLineFields[] = [];
  for (const [index, raw] of root.lines.slice(0, expectedCount).entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`model response.lines[${index}] must be an object`);
    }
    const record = raw as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!["pronunciation", "translation", "sentence_end"].includes(key)) {
        throw new Error(`model response.lines[${index}] has unknown key "${key}"`);
      }
    }
    if (typeof record.pronunciation !== "string" || record.pronunciation.length === 0) {
      throw new Error(`model response.lines[${index}].pronunciation must be a non-empty string`);
    }
    if (typeof record.translation !== "string" || record.translation.length === 0) {
      throw new Error(`model response.lines[${index}].translation must be a non-empty string`);
    }
    if (record.sentence_end !== undefined && typeof record.sentence_end !== "boolean") {
      throw new Error(`model response.lines[${index}].sentence_end must be a boolean when present`);
    }
    lines.push({
      pronunciation: record.pronunciation,
      translation: record.translation,
      ...(record.sentence_end !== undefined ? { sentence_end: record.sentence_end as boolean } : {}),
    });
  }
  let glossary: GlossaryEntry[] | undefined;
  if (root.glossary !== undefined) {
    if (!Array.isArray(root.glossary)) throw new Error("model response.glossary must be an array");
    glossary = [];
    for (const [index, raw] of root.glossary.entries()) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(`model response.glossary[${index}] must be an object`);
      }
      const entry = raw as Record<string, unknown>;
      if (Object.keys(entry).some((key) => key !== "word" && key !== "meaning")) {
        throw new Error(`model response.glossary[${index}] has unknown keys`);
      }
      if (typeof entry.word !== "string" || typeof entry.meaning !== "string") {
        throw new Error(`model response.glossary[${index}] needs word and meaning strings`);
      }
      glossary.push({ word: entry.word, meaning: entry.meaning });
    }
  }
  return { lines, ...(glossary !== undefined ? { glossary } : {}) };
}

/** Fixed prompt fragment listing originals the model must not edit. */
export function authoringPromptForBatch(
  lesson: LessonDraft,
  indices: readonly number[],
): { system: string; user: string } {
  const originals = indices.map((index) => {
    const line = lesson.lines[index]!;
    return { index, original: line.original, start_ms: line.start_ms, end_ms: line.end_ms };
  });
  const system =
    "You author study fields for a language-learning lesson. " +
    "Return JSON only: {\"lines\":[{\"pronunciation\":\"…\",\"translation\":\"…\",\"sentence_end\":true|false?},…],\"glossary\":[{\"word\":\"…\",\"meaning\":\"…\"}]?}. " +
    "Fill pronunciation (source speech in the learner's script) and translation (learner's language). " +
    "Optional sentence_end marks sentence boundaries. Optional glossary lists lowercase vocabulary meanings. " +
    "Never change original text or timecodes. Never output HTML or JavaScript.";
  const user =
    `Study language: ${lesson.study_language}\nSource language: ${lesson.video.source_language}\n` +
    `Lines:\n${JSON.stringify(originals)}`;
  return { system, user };
}

export async function callModelBatch(
  settings: AuthoringSettings,
  lesson: LessonDraft,
  indices: readonly number[],
  client: ChatCompletionClient,
  retry = false,
): Promise<ModelBatchResponse> {
  const endpoint = settings.endpoint.replace(/\/+$/u, "");
  if (!settings.apiKey) throw new Error("missing API key");
  if (!isAuthoringEndpointAllowed(endpoint)) throw new Error("insecure endpoint");
  const prompt = authoringPromptForBatch(lesson, indices);
  const body = JSON.stringify({
    model: settings.model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
  } satisfies ChatCompletionRequest);
  const response = await client(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body,
  });
  if (response.status === 429 && !retry) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return callModelBatch(settings, lesson, indices, client, true);
  }
  if (!response.ok) {
    const error = new Error(`model request failed (${response.status})`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = payload.choices?.[0]?.message?.content ?? "";
  const parsed = typeof content === "string" && content.length > 0 ? JSON.parse(content) : content;
  return parseModelBatchResponse(parsed, indices.length);
}

/** Run every batch and return a sealed lesson when complete. */
export async function authorLessonFromDraft(
  draft: LessonDraft,
  settings: AuthoringSettings,
  client: ChatCompletionClient,
  options?: { batchSize?: number; lineCap?: number },
): Promise<LessonV2> {
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
  const lineCap = options?.lineCap ?? DEFAULT_LINE_CAP;
  const batches = batchIndices(draft.lines.length, batchSize, lineCap);
  let current: LessonDraft | LessonV2 = draft;
  for (const indices of batches) {
    const response = await callModelBatch(settings, current as LessonDraft, indices, client);
    current = mergeModelBatch(current as LessonDraft, indices[0]!, response);
  }
  if (!isLessonComplete(current)) throw new Error("lesson is incomplete after authoring");
  return sealLesson(current as LessonDraft);
}
