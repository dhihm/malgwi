/**
 * Compile a validated lesson-v1 document into a self-contained static page.
 *
 *   bun compiler/build.ts <lesson.json> <out-dir>
 *
 * Output: <out-dir>/index.html and <out-dir>/lesson.json (canonical form).
 * The page needs no AI, API key, or server; it only embeds the YouTube
 * IFrame player for the referenced video.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalJson, compileLibrary, compilePage, LESSON_SLOT, LESSONS_SLOT, sha256Hex, validateLesson } from "../src/lesson.ts";

const TEMPLATE_PATH = new URL("../runtime/index.template.html", import.meta.url);
const USERSCRIPT_PATH = new URL("../runtime/study.user.template.js", import.meta.url);
const LIBRARY_PATH = new URL("../runtime/library.user.template.js", import.meta.url);
const AUTHORING_PATH = new URL("../runtime/authoring.template.js", import.meta.url);

export interface BuildResult {
  readonly outDir: string;
  readonly pageDigest: string;
  readonly userscriptDigest: string;
  readonly lessonDigest: string;
  readonly lineCount: number;
}

export function buildLessonPage(
  lessonValue: unknown,
  outDir: string,
  template?: string,
  userscriptTemplate?: string,
): BuildResult {
  const lesson = validateLesson(lessonValue);
  const runtime = template ?? readFileSync(TEMPLATE_PATH, "utf8");
  const userscriptRuntime = userscriptTemplate ?? readFileSync(USERSCRIPT_PATH, "utf8");
  const page = compilePage(runtime, lesson);
  const userscript = compilePage(userscriptRuntime, lesson);
  const lessonJson = canonicalJson(lesson);
  const target = resolve(outDir);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "index.html"), page, "utf8");
  writeFileSync(join(target, "study.user.js"), userscript, "utf8");
  writeFileSync(join(target, "lesson.json"), `${lessonJson}\n`, "utf8");
  return {
    outDir: target,
    pageDigest: sha256Hex(page),
    userscriptDigest: sha256Hex(userscript),
    lessonDigest: sha256Hex(lessonJson),
    lineCount: lesson.lines.length,
  };
}

export interface LibraryResult {
  readonly path: string;
  readonly libraryDigest: string;
  readonly lessonCount: number;
}

/** Merge validated lessons into one installable library userscript. */
export function buildLibraryScript(
  lessonValues: readonly unknown[],
  outPath: string,
  libraryTemplate?: string,
): LibraryResult {
  const lessons = lessonValues.map(validateLesson);
  const runtime = libraryTemplate ?? readFileSync(LIBRARY_PATH, "utf8");
  const authoring = readFileSync(AUTHORING_PATH, "utf8");
  const script = compileLibrary(runtime, lessons, authoring);
  const target = resolve(outPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, script, "utf8");
  return { path: target, libraryDigest: sha256Hex(script), lessonCount: lessons.length };
}

function usage(): never {
  console.error(
    "usage: bun compiler/build.ts <lesson.json> <out-dir>\n" +
      "       bun compiler/build.ts --library <out.user.js> <lesson.json> [more.json...]",
  );
  process.exit(2);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--library") {
    const [, outPath, ...lessonPaths] = args;
    if (!outPath || lessonPaths.length === 0) usage();
    const lessons = lessonPaths.map((path) => JSON.parse(readFileSync(path, "utf8")));
    const result = buildLibraryScript(lessons, outPath);
    console.log(`built library of ${result.lessonCount} lessons -> ${result.path}\nsha256 ${result.libraryDigest}`);
  } else {
    const [lessonPath, outDir] = args;
    if (!lessonPath || !outDir) usage();
    const lessonValue = JSON.parse(readFileSync(lessonPath, "utf8"));
    const result = buildLessonPage(lessonValue, outDir);
    console.log(
      `built ${result.lineCount} lines -> ${result.outDir}\n` +
        `index.html sha256 ${result.pageDigest}\nlesson.json sha256 ${result.lessonDigest}`,
    );
  }
}
