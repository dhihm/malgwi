/**
 * Author a sealed lesson-v2 document from local captions and a model endpoint.
 *
 *   bun compiler/author.ts --captions capture.vtt --video-id abc123XYZ_- --study-language ko
 *
 * Credentials come from OPENROUTER_API_KEY or OPENAI_API_KEY only, with optional
 * OPENROUTER_BASE_URL / OPENAI_BASE_URL overrides. The key is never written into
 * lesson JSON or logs.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  authorLessonFromDraft,
  buildLessonDraft,
  outputContainsSecret,
  resolveEnvCredentials,
  type AuthoringSettings,
} from "../src/authoring.ts";
import { parseCaptionsFile } from "../src/captions.ts";
import { canonicalJson, type LessonV2 } from "../src/lesson.ts";

export interface AuthorCliOptions {
  readonly captionsPath: string;
  readonly videoId: string;
  readonly studyLanguage: string;
  readonly sourceLanguage: string;
  readonly title?: string;
  readonly outputPath: string;
  readonly modelOverride?: string;
  readonly settings: AuthoringSettings;
  readonly fetchImpl?: typeof fetch;
}

export interface AuthorResult {
  readonly lesson: LessonV2;
  readonly outputPath: string;
}

function usage(): never {
  console.error(
    "usage: bun compiler/author.ts --captions <file> --video-id <id> --study-language <tag> " +
      "[--source-language <tag>] [--title <text>] [--output <lesson.json>] [--model <name>]",
  );
  process.exit(2);
}

export function parseAuthorArgs(argv: readonly string[]): Omit<AuthorCliOptions, "settings" | "fetchImpl"> {
  let captionsPath = "";
  let videoId = "";
  let studyLanguage = "";
  let sourceLanguage = "en";
  let title: string | undefined;
  let outputPath = "lesson.json";
  let modelOverride: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = argv[index + 1];
    if (arg === "--captions" && next) {
      captionsPath = next;
      index += 1;
    } else if (arg === "--video-id" && next) {
      videoId = next;
      index += 1;
    } else if (arg === "--study-language" && next) {
      studyLanguage = next;
      index += 1;
    } else if (arg === "--source-language" && next) {
      sourceLanguage = next;
      index += 1;
    } else if (arg === "--title" && next) {
      title = next;
      index += 1;
    } else if (arg === "--output" && next) {
      outputPath = next;
      index += 1;
    } else if (arg === "--model" && next) {
      modelOverride = next;
      index += 1;
    } else if (arg === "--api-key") {
      console.error("refusing --api-key; set OPENROUTER_API_KEY or OPENAI_API_KEY instead");
      process.exit(2);
    } else if (arg.startsWith("--")) {
      console.error(`unknown option: ${arg}`);
      usage();
    }
  }
  if (!captionsPath || !videoId || !studyLanguage) usage();
  return {
    captionsPath,
    videoId,
    studyLanguage,
    sourceLanguage,
    ...(title !== undefined ? { title } : {}),
    outputPath,
    ...(modelOverride !== undefined ? { modelOverride } : {}),
  };
}

export async function authorLessonFromCaptions(options: AuthorCliOptions): Promise<AuthorResult> {
  const captions = parseCaptionsFile(options.captionsPath);
  const draft = buildLessonDraft(captions, {
    provider: "youtube",
    video_id: options.videoId,
    source_language: options.sourceLanguage,
    ...(options.title !== undefined ? { title: options.title } : {}),
  }, options.studyLanguage);
  const client = options.fetchImpl ?? fetch;
  const lesson = await authorLessonFromDraft(draft, options.settings, client);
  if (outputContainsSecret(lesson, options.settings.apiKey)) {
    throw new Error("refusing to write lesson JSON that embeds the API key");
  }
  const target = resolve(options.outputPath);
  writeFileSync(target, `${canonicalJson(lesson)}\n`, "utf8");
  return { lesson, outputPath: target };
}

if (import.meta.main) {
  const parsed = parseAuthorArgs(process.argv.slice(2));
  const settings = resolveEnvCredentials();
  const mergedSettings = parsed.modelOverride ? { ...settings, model: parsed.modelOverride } : settings;
  const { modelOverride: _ignored, ...cliOptions } = parsed;
  authorLessonFromCaptions({ ...cliOptions, settings: mergedSettings })
    .then((result) => {
      console.log(`wrote ${result.outputPath} (${result.lesson.lines.length} lines)`);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exit(1);
    });
}
