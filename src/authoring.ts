/**
 * Watch-page lesson authoring: local storage keys, caption-to-lesson
 * conversion, model batching, and field merge. Shared by tests and the
 * compiler when embedding the authoring runtime module.
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
import { readFileSync } from "node:fs";

export const LOCAL_LESSON_PREFIX = "ysp:lesson:v2:";
export const LOCAL_LESSON_INDEX_KEY = "ysp:local-lessons:v1";
export const AUTHORING_SETTINGS_KEY = "ysp:authoring:v1";
export const AUTHORING_API_KEY_STORAGE_KEY = "ysp:authoring:apiKey:v1";

export type ProviderPreset = "openrouter" | "openai" | "custom";

export const PROVIDER_PRESETS = {
  openrouter: {
    endpoint: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
  },
  openai: {
    endpoint: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
  },
} as const satisfies Record<Exclude<ProviderPreset, "custom">, { endpoint: string; defaultModel: string }>;

/** Injected into runtime/authoring.template.js so browser digests match lesson.ts. */
export const CANONICAL_JSON_SLOT = "/*__CANONICAL_JSON__*/";
export const AUTHORING_CORE_SLOT = "/*__AUTHORING_CORE__*/";
export const PROVIDER_PRESETS_SLOT = "/*__PROVIDER_PRESETS__*/";
export const TEST_HOOKS_SLOT = "/*__TEST_HOOKS__*/";
export const BROWSER_CANONICAL_JSON_SOURCE = `function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  var entries = Object.keys(value)
    .filter(function (key) { return value[key] !== undefined; })
    .sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; })
    .map(function (key) { return JSON.stringify(key) + ":" + canonicalJson(value[key]); });
  return "{" + entries.join(",") + "}";
}`;

export const BROWSER_PROVIDER_PRESETS_SOURCE = `var PROVIDER_PRESETS = {
  openrouter: { endpoint: "https://openrouter.ai/api/v1", defaultModel: "openai/gpt-4o-mini" },
  openai: { endpoint: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" }
};
function normalizeProvider(value) {
  if (value === "openai" || value === "custom") return value;
  return "openrouter";
}
function resolveProviderEndpoint(provider, customEndpoint) {
  if (provider === "custom") return String(customEndpoint || "").trim();
  return PROVIDER_PRESETS[provider].endpoint;
}
function resolveProviderModel(provider, modelOverride) {
  var trimmed = String(modelOverride || "").trim();
  if (trimmed) return trimmed;
  if (provider === "custom") return "gpt-4o-mini";
  return PROVIDER_PRESETS[provider].defaultModel;
}
function resolveAuthoringSettings(publicSettings, apiKey) {
  var provider = normalizeProvider(publicSettings && publicSettings.provider);
  var endpoint = resolveProviderEndpoint(provider, publicSettings && publicSettings.custom_endpoint);
  var model = resolveProviderModel(provider, publicSettings && publicSettings.model);
  var studyLanguage = publicSettings && publicSettings.study_language ? String(publicSettings.study_language).trim() : "ko";
  var key = String(apiKey || "").trim();
  if (!endpoint || !key) return null;
  return { provider: provider, endpoint: endpoint, apiKey: key, model: model, study_language: studyLanguage || "ko" };
}
function maskApiKey(apiKey) {
  var key = String(apiKey || "");
  if (key.length <= 4) return "";
  return "\\u2022\\u2022\\u2022\\u2022" + key.slice(-4);
}
function publicSettingsForStorage(publicSettings) {
  var provider = normalizeProvider(publicSettings && publicSettings.provider);
  var stored = {
    provider: provider,
    study_language: publicSettings && publicSettings.study_language ? String(publicSettings.study_language).trim() || "ko" : "ko",
  };
  if (publicSettings && publicSettings.model) stored.model = String(publicSettings.model).trim();
  if (provider === "custom" && publicSettings && publicSettings.custom_endpoint) {
    stored.custom_endpoint = String(publicSettings.custom_endpoint).trim();
  }
  return stored;
}`;

export const BROWSER_TEST_HOOKS_SOURCE = `if (typeof window !== "undefined") {
  window.__yspTestHooks = {
    setReadSessionCaptions: function (fn) { readSessionCaptionsImpl = fn; },
    captionDigest: captionDigest,
    storeLocalLesson: storeLocalLesson,
    resolveLocalLesson: resolveLocalLesson,
    loadAuthoringSettings: loadAuthoringSettings,
    saveAuthoringSettings: saveAuthoringSettings,
    loadApiKey: loadApiKey,
    saveApiKey: saveApiKey,
    resolveAuthoringSettings: resolveAuthoringSettings,
    publicSettingsForStorage: publicSettingsForStorage,
  };
}`;

/** Prepare the authoring runtime module with shared browser implementations. */
export function prepareAuthoringModule(source: string, options?: { testHooks?: boolean }): string {
  if (!source.includes(CANONICAL_JSON_SLOT)) {
    throw new Error("authoring template missing canonical JSON slot");
  }
  if (!source.includes(AUTHORING_CORE_SLOT)) {
    throw new Error("authoring template missing authoring core slot");
  }
  if (!source.includes(PROVIDER_PRESETS_SLOT)) {
    throw new Error("authoring template missing provider presets slot");
  }
  const core = readFileSync(new URL("../runtime/authoring-core.browser.js", import.meta.url), "utf8");
  return source
    .replace(CANONICAL_JSON_SLOT, BROWSER_CANONICAL_JSON_SOURCE)
    .replace(PROVIDER_PRESETS_SLOT, BROWSER_PROVIDER_PRESETS_SOURCE)
    .replace(AUTHORING_CORE_SLOT, () => core)
    .replace(TEST_HOOKS_SLOT, () => (options?.testHooks ? BROWSER_TEST_HOOKS_SOURCE : ""));
}

/** Verify browser canonicalJson matches the compiler implementation. */
export function browserCanonicalJson(value: unknown): string {
  const fn = new Function(`${BROWSER_CANONICAL_JSON_SOURCE}; return canonicalJson;`)();
  return fn(value) as string;
}

export interface LessonDraftLine {
  readonly start_ms: number;
  readonly end_ms: number;
  readonly original: string;
  readonly pronunciation?: string;
  readonly translation?: string;
  readonly sentence_end?: boolean;
}

/** In-progress watch-page lesson; model fields appear only after authoring batches. */
export interface LessonDraft {
  readonly schema_version: 2;
  readonly video: LessonVideo;
  readonly study_language: string;
  readonly source_digest: string;
  readonly lines: readonly LessonDraftLine[];
  readonly glossary?: readonly GlossaryEntry[];
}

/** Default cap on lines sent to the model in one generate action. */
export const DEFAULT_LINE_CAP = 200;
/** Lines per model request when batching. */
export const DEFAULT_BATCH_SIZE = 40;

/** Non-secret settings persisted in page localStorage. */
export interface AuthoringSettingsPublic {
  readonly provider?: ProviderPreset;
  readonly model?: string;
  readonly custom_endpoint?: string;
  readonly study_language?: string;
}

/** Resolved settings used for model calls. */
export interface AuthoringSettings {
  readonly provider: ProviderPreset;
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly study_language: string;
}

export function normalizeProvider(value: unknown): ProviderPreset {
  if (value === "openai" || value === "custom") return value;
  return "openrouter";
}

export function resolveProviderEndpoint(provider: ProviderPreset, customEndpoint?: string): string {
  if (provider === "custom") return String(customEndpoint ?? "").trim();
  return PROVIDER_PRESETS[provider].endpoint;
}

export function resolveProviderModel(provider: ProviderPreset, modelOverride?: string): string {
  const trimmed = String(modelOverride ?? "").trim();
  if (trimmed) return trimmed;
  if (provider === "custom") return "gpt-4o-mini";
  return PROVIDER_PRESETS[provider].defaultModel;
}

/** Merge public settings with a separately stored API key. */
export function resolveAuthoringSettings(
  publicSettings: AuthoringSettingsPublic,
  apiKey: string,
): AuthoringSettings | null {
  const provider = normalizeProvider(publicSettings.provider);
  const endpoint = resolveProviderEndpoint(provider, publicSettings.custom_endpoint);
  const model = resolveProviderModel(provider, publicSettings.model);
  const studyLanguage = String(publicSettings.study_language ?? "ko").trim() || "ko";
  const key = String(apiKey).trim();
  if (!endpoint || !key) return null;
  return { provider, endpoint, apiKey: key, model, study_language: studyLanguage };
}

/** Placeholder for a saved key field without exposing the full secret. */
export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 4) return "";
  return `\u2022\u2022\u2022\u2022${apiKey.slice(-4)}`;
}

/** Strip secrets before writing authoring settings to page storage. */
export function publicSettingsForStorage(publicSettings: AuthoringSettingsPublic): AuthoringSettingsPublic {
  const provider = normalizeProvider(publicSettings.provider);
  const stored: AuthoringSettingsPublic = {
    provider,
    study_language: String(publicSettings.study_language ?? "ko").trim() || "ko",
  };
  if (publicSettings.model) stored.model = String(publicSettings.model).trim();
  if (provider === "custom" && publicSettings.custom_endpoint) {
    stored.custom_endpoint = String(publicSettings.custom_endpoint).trim();
  }
  return stored;
}

/** True when a serialized lesson document accidentally embeds the API key. */
export function lessonContainsSecret(lesson: unknown, secret: string): boolean {
  if (!secret) return false;
  return JSON.stringify(lesson).includes(secret);
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

export interface LocalLessonIndexEntry {
  readonly video_id: string;
  readonly study_language: string;
  readonly source_digest: string;
  readonly complete: boolean;
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

/** Storage key for one sealed local lesson document. */
export function localLessonStorageKey(
  videoId: string,
  studyLanguage: string,
  sourceDigest: string,
): string {
  return `${LOCAL_LESSON_PREFIX}${videoId}:${studyLanguage}:${sourceDigest}`;
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

/** Validate and seal a completed local lesson for storage and replay. */
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

/**
 * Merge one model batch into a draft. Returns a new lesson; originals and
 * timecodes are never changed. Partial batches leave trailing lines empty.
 */
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
  const glossary = response.glossary?.length
    ? response.glossary
    : lesson.glossary;
  const merged: LessonDraft = {
    ...lesson,
    lines,
    ...(glossary !== undefined ? { glossary } : {}),
  };
  return isLessonComplete(merged) ? sealLesson(merged) : merged;
}

/** Parse model JSON; rejects unknown keys and edits to originals. */
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

/** Update the local-lesson index after storing a document. */
export function upsertLocalLessonIndex(
  index: LocalLessonIndexEntry[],
  entry: LocalLessonIndexEntry,
): LocalLessonIndexEntry[] {
  const filtered = index.filter(
    (candidate) =>
      !(
        candidate.video_id === entry.video_id &&
        candidate.study_language === entry.study_language
      ),
  );
  return [...filtered, entry];
}
