/**
 * Print the pin record a host adapter embeds alongside its copy of the
 * runtime template: source commit plus SHA-256 of the exact bytes.
 *
 *   bun scripts/pin.ts
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { sha256Hex } from "../src/lesson.ts";

const template = readFileSync(new URL("../runtime/index.template.html", import.meta.url), "utf8");
const userscript = readFileSync(new URL("../runtime/study.user.template.js", import.meta.url), "utf8");
const library = readFileSync(new URL("../runtime/library.user.template.js", import.meta.url), "utf8");
let commit = "uncommitted";
try {
  commit = execSync("git rev-parse HEAD", { cwd: new URL("..", import.meta.url).pathname })
    .toString()
    .trim();
} catch {
  // Outside a git checkout the digest alone still pins the bytes.
}

console.log(
  JSON.stringify(
    {
      source_repository: "dhihm/malgwi",
      source_commit: commit,
      runtime_template: "runtime/index.template.html",
      runtime_sha256: sha256Hex(template),
      userscript_template: "runtime/study.user.template.js",
      userscript_sha256: sha256Hex(userscript),
      library_template: "runtime/library.user.template.js",
      library_sha256: sha256Hex(library),
    },
    null,
    2,
  ),
);
