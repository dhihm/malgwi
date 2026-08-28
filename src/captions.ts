/**
 * Parse local caption files into the neutral capture shape used by authoring.
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { type CaptionLine, validateCaptions } from "./lesson.ts";

function parseTimestamp(value: string): number {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":");
  if (parts.length === 3) {
    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    const seconds = Number(parts[2]);
    return Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
  }
  if (parts.length === 2) {
    const minutes = Number(parts[0]);
    const seconds = Number(parts[1]);
    return Math.round((minutes * 60 + seconds) * 1000);
  }
  throw new Error(`invalid timestamp: ${value}`);
}

function parseSrt(content: string): CaptionLine[] {
  const blocks = content
    .replace(/\uFEFF/u, "")
    .split(/\r?\n\r?\n/u)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  const lines: CaptionLine[] = [];
  for (const block of blocks) {
    const rows = block.split(/\r?\n/u);
    if (rows.length < 2) continue;
    const timingIndex = /^\d+$/u.test(rows[0]!) ? 1 : 0;
    const timing = rows[timingIndex];
    if (!timing || !timing.includes("-->")) continue;
    const [startRaw, endRaw] = timing.split("-->").map((part) => part.trim());
    const text = rows.slice(timingIndex + 1).join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push({
      start_ms: parseTimestamp(startRaw!),
      end_ms: parseTimestamp(endRaw!.split(/\s+/u)[0]!),
      text,
    });
  }
  return validateCaptions(lines);
}

function parseVtt(content: string): CaptionLine[] {
  const body = content.replace(/\uFEFF/u, "").replace(/^WEBVTT[^\n]*\n+/u, "");
  const blocks = body
    .split(/\r?\n\r?\n/u)
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && block.includes("-->"));
  const lines: CaptionLine[] = [];
  for (const block of blocks) {
    const rows = block.split(/\r?\n/u);
    let timingIndex = 0;
    if (!rows[0]!.includes("-->")) timingIndex = 1;
    const timing = rows[timingIndex];
    if (!timing || !timing.includes("-->")) continue;
    const [startRaw, endRaw] = timing.split("-->").map((part) => part.trim());
    const text = rows
      .slice(timingIndex + 1)
      .join(" ")
      .replace(/<[^>]+>/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    lines.push({
      start_ms: parseTimestamp(startRaw!),
      end_ms: parseTimestamp(endRaw!.split(/\s+/u)[0]!),
      text,
    });
  }
  return validateCaptions(lines);
}

/** Read and validate captions from a local .json, .vtt, or .srt file. */
export function parseCaptionsFile(path: string): CaptionLine[] {
  const content = readFileSync(path, "utf8");
  const ext = extname(path).toLowerCase();
  if (ext === ".json") return validateCaptions(JSON.parse(content));
  if (ext === ".vtt") return parseVtt(content);
  if (ext === ".srt") return parseSrt(content);
  throw new Error("captions file must use .json, .vtt, or .srt");
}
