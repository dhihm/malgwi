/* Shared lesson validation and model merge logic for the browser runtime.
 * Injected by prepareAuthoringModule(); keep in parity with src/lesson.ts and src/authoring.ts. */
var LESSON_SCHEMA_VERSION = 2;
var VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;
var SHA256_HEX = /^[0-9a-f]{64}$/u;
var LANGUAGE_TAG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
var GLOSSARY_WORD = /^[\p{L}\p{N}][\p{L}\p{N}'’-]*(?: [\p{L}\p{N}'’-]+){0,3}$/u;

function lessonValidationFail(message) {
  var error = new Error(message);
  error.name = "LessonValidationError";
  throw error;
}

function lessonRequireString(value, label) {
  if (typeof value !== "string" || value.length === 0) lessonValidationFail(label + " must be a non-empty string");
  return value;
}

function lessonRequireMs(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    lessonValidationFail(label + " must be a non-negative integer of milliseconds");
  }
  return value;
}

function lessonRequireRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    lessonValidationFail(label + " must be an object");
  }
  return value;
}

function lessonRequireKeys(value, allowed, label) {
  for (var keyIndex = 0; keyIndex < Object.keys(value).length; keyIndex += 1) {
    var key = Object.keys(value)[keyIndex];
    if (allowed.indexOf(key) === -1) lessonValidationFail(label + ' has unknown key "' + key + '"');
  }
}

function upgradeLessonV1(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  if (value.schema_version !== 1) return value;
  var lines = Array.isArray(value.lines)
    ? value.lines.map(function (raw) {
        if (typeof raw !== "object" || raw === null) return raw;
        var next = {};
        for (var lineKey in raw) {
          if (Object.prototype.hasOwnProperty.call(raw, lineKey) && lineKey !== "pronunciation_ko" && lineKey !== "translation_ko") {
            next[lineKey] = raw[lineKey];
          }
        }
        if (raw.pronunciation_ko !== undefined) next.pronunciation = raw.pronunciation_ko;
        if (raw.translation_ko !== undefined) next.translation = raw.translation_ko;
        return next;
      })
    : value.lines;
  var glossary = Array.isArray(value.glossary)
    ? value.glossary.map(function (raw) {
        if (typeof raw !== "object" || raw === null) return raw;
        var next = {};
        for (var entryKey in raw) {
          if (Object.prototype.hasOwnProperty.call(raw, entryKey) && entryKey !== "meaning_ko") next[entryKey] = raw[entryKey];
        }
        if (raw.meaning_ko !== undefined) next.meaning = raw.meaning_ko;
        return next;
      })
    : value.glossary;
  var upgraded = {
    schema_version: 2,
    study_language: "ko",
    video: value.video,
    source_digest: value.source_digest,
    lines: lines,
  };
  if (glossary !== undefined) upgraded.glossary = glossary;
  if (value.display !== undefined) upgraded.display = value.display;
  return upgraded;
}

function validateLesson(value) {
  var root = lessonRequireRecord(upgradeLessonV1(value), "lesson");
  lessonRequireKeys(
    root,
    ["schema_version", "video", "study_language", "display", "source_digest", "lines", "glossary"],
    "lesson",
  );
  if (root.schema_version !== LESSON_SCHEMA_VERSION) lessonValidationFail("lesson.schema_version must be 2");

  var studyLanguage = lessonRequireString(root.study_language, "lesson.study_language");
  if (!LANGUAGE_TAG.test(studyLanguage)) lessonValidationFail("lesson.study_language must be a BCP 47-style tag");

  var display;
  if (root.display !== undefined) {
    var displayRecord = lessonRequireRecord(root.display, "lesson.display");
    lessonRequireKeys(displayRecord, ["mode"], "lesson.display");
    if (displayRecord.mode !== "embed" && displayRecord.mode !== "sheet") {
      lessonValidationFail('lesson.display.mode must be "embed" or "sheet"');
    }
    display = { mode: displayRecord.mode };
  }

  var video = lessonRequireRecord(root.video, "lesson.video");
  lessonRequireKeys(video, ["provider", "video_id", "source_language", "title"], "lesson.video");
  if (video.provider !== "youtube") lessonValidationFail('lesson.video.provider must be "youtube"');
  var videoId = lessonRequireString(video.video_id, "lesson.video.video_id");
  if (!VIDEO_ID.test(videoId)) lessonValidationFail("lesson.video.video_id must be an 11-character YouTube id");
  var language = lessonRequireString(video.source_language, "lesson.video.source_language");
  if (!LANGUAGE_TAG.test(language)) lessonValidationFail("lesson.video.source_language must be a BCP 47-style tag");
  if (video.title !== undefined) lessonRequireString(video.title, "lesson.video.title");

  var digest = lessonRequireString(root.source_digest, "lesson.source_digest");
  if (!SHA256_HEX.test(digest)) lessonValidationFail("lesson.source_digest must be lowercase SHA-256 hex");

  if (!Array.isArray(root.lines) || root.lines.length === 0) lessonValidationFail("lesson.lines must be a non-empty array");
  var lines = [];
  var previousStart = -1;
  for (var lineIndex = 0; lineIndex < root.lines.length; lineIndex += 1) {
    var rawLine = root.lines[lineIndex];
    var record = lessonRequireRecord(rawLine, "lesson.lines[" + lineIndex + "]");
    lessonRequireKeys(
      record,
      ["start_ms", "end_ms", "original", "pronunciation", "translation", "sentence_end"],
      "lesson.lines[" + lineIndex + "]",
    );
    if (record.sentence_end !== undefined && typeof record.sentence_end !== "boolean") {
      lessonValidationFail("lesson.lines[" + lineIndex + "].sentence_end must be a boolean when present");
    }
    var start = lessonRequireMs(record.start_ms, "lesson.lines[" + lineIndex + "].start_ms");
    var end = lessonRequireMs(record.end_ms, "lesson.lines[" + lineIndex + "].end_ms");
    if (end <= start) lessonValidationFail("lesson.lines[" + lineIndex + "] must end after it starts");
    if (start < previousStart) lessonValidationFail("lesson.lines[" + lineIndex + "] starts before the previous line");
    previousStart = start;
    var line = {
      start_ms: start,
      end_ms: end,
      original: lessonRequireString(record.original, "lesson.lines[" + lineIndex + "].original"),
      pronunciation: lessonRequireString(record.pronunciation, "lesson.lines[" + lineIndex + "].pronunciation"),
      translation: lessonRequireString(record.translation, "lesson.lines[" + lineIndex + "].translation"),
    };
    if (record.sentence_end !== undefined) line.sentence_end = record.sentence_end;
    lines.push(line);
  }

  var glossary;
  if (root.glossary !== undefined) {
    if (!Array.isArray(root.glossary)) lessonValidationFail("lesson.glossary must be an array");
    glossary = [];
    var seen = {};
    for (var glossaryIndex = 0; glossaryIndex < root.glossary.length; glossaryIndex += 1) {
      var rawEntry = root.glossary[glossaryIndex];
      var entry = lessonRequireRecord(rawEntry, "lesson.glossary[" + glossaryIndex + "]");
      lessonRequireKeys(entry, ["word", "meaning"], "lesson.glossary[" + glossaryIndex + "]");
      var word = lessonRequireString(entry.word, "lesson.glossary[" + glossaryIndex + "].word");
      if (!GLOSSARY_WORD.test(word) || word !== word.toLowerCase()) {
        lessonValidationFail("lesson.glossary[" + glossaryIndex + "].word must be a normalized lowercase word or short phrase");
      }
      if (seen[word]) lessonValidationFail('lesson.glossary[' + glossaryIndex + '] repeats "' + word + '"');
      seen[word] = true;
      glossary.push({
        word: word,
        meaning: lessonRequireString(entry.meaning, "lesson.glossary[" + glossaryIndex + "].meaning"),
      });
    }
  }

  var result = {
    schema_version: LESSON_SCHEMA_VERSION,
    video: {
      provider: "youtube",
      video_id: videoId,
      source_language: language,
    },
    study_language: studyLanguage,
    source_digest: digest,
    lines: lines,
  };
  if (video.title !== undefined) result.video.title = video.title;
  if (display !== undefined) result.display = display;
  if (glossary !== undefined && glossary.length > 0) result.glossary = glossary;
  return result;
}

function isLessonComplete(lesson) {
  if (!lesson || !Array.isArray(lesson.lines) || lesson.lines.length === 0) return false;
  for (var i = 0; i < lesson.lines.length; i += 1) {
    var line = lesson.lines[i];
    if (typeof line.pronunciation !== "string" || !line.pronunciation) return false;
    if (typeof line.translation !== "string" || !line.translation) return false;
  }
  return true;
}

function sealLesson(lesson) {
  if (!isLessonComplete(lesson)) throw new Error("lesson is incomplete");
  var lines = lesson.lines.map(function (line) {
    var sealed = {
      start_ms: line.start_ms,
      end_ms: line.end_ms,
      original: line.original,
      pronunciation: line.pronunciation,
      translation: line.translation,
    };
    if (line.sentence_end !== undefined) sealed.sentence_end = line.sentence_end;
    return sealed;
  });
  var payload = {
    schema_version: 2,
    video: lesson.video,
    study_language: lesson.study_language,
    source_digest: lesson.source_digest,
    lines: lines,
  };
  if (lesson.glossary !== undefined) payload.glossary = lesson.glossary;
  return validateLesson(payload);
}

function parseModelBatchResponse(value, expectedCount) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("model response must be an object");
  }
  if (!Array.isArray(value.lines)) throw new Error("model response.lines must be an array");
  var lines = [];
  for (var i = 0; i < Math.min(value.lines.length, expectedCount); i += 1) {
    var raw = value.lines[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("model response.lines[" + i + "] must be an object");
    }
    for (var keyIndex = 0; keyIndex < Object.keys(raw).length; keyIndex += 1) {
      var key = Object.keys(raw)[keyIndex];
      if (["pronunciation", "translation", "sentence_end"].indexOf(key) === -1) {
        throw new Error('model response.lines[' + i + '] has unknown key "' + key + '"');
      }
    }
    if (typeof raw.pronunciation !== "string" || !raw.pronunciation) {
      throw new Error("model response.lines[" + i + "].pronunciation must be a non-empty string");
    }
    if (typeof raw.translation !== "string" || !raw.translation) {
      throw new Error("model response.lines[" + i + "].translation must be a non-empty string");
    }
    if (raw.sentence_end !== undefined && typeof raw.sentence_end !== "boolean") {
      throw new Error("model response.lines[" + i + "].sentence_end must be a boolean when present");
    }
    var fields = {
      pronunciation: raw.pronunciation,
      translation: raw.translation,
    };
    if (raw.sentence_end !== undefined) fields.sentence_end = raw.sentence_end;
    lines.push(fields);
  }
  var glossary;
  if (value.glossary !== undefined) {
    if (!Array.isArray(value.glossary)) throw new Error("model response.glossary must be an array");
    glossary = [];
    for (var glossaryIndex = 0; glossaryIndex < value.glossary.length; glossaryIndex += 1) {
      var entry = value.glossary[glossaryIndex];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("model response.glossary[" + glossaryIndex + "] must be an object");
      }
      for (var entryKeyIndex = 0; entryKeyIndex < Object.keys(entry).length; entryKeyIndex += 1) {
        var entryKey = Object.keys(entry)[entryKeyIndex];
        if (entryKey !== "word" && entryKey !== "meaning") {
          throw new Error("model response.glossary[" + glossaryIndex + "] has unknown keys");
        }
      }
      if (typeof entry.word !== "string" || typeof entry.meaning !== "string") {
        throw new Error("model response.glossary[" + glossaryIndex + "] needs word and meaning strings");
      }
      glossary.push({ word: entry.word, meaning: entry.meaning });
    }
  }
  var response = { lines: lines };
  if (glossary !== undefined) response.glossary = glossary;
  return response;
}

function mergeModelBatch(lesson, startIndex, response) {
  var lines = lesson.lines.map(function (line) {
    return {
      start_ms: line.start_ms,
      end_ms: line.end_ms,
      original: line.original,
      pronunciation: line.pronunciation,
      translation: line.translation,
      sentence_end: line.sentence_end,
    };
  });
  for (var offset = 0; offset < response.lines.length; offset += 1) {
    var index = startIndex + offset;
    if (index >= lines.length) break;
    lines[index].pronunciation = response.lines[offset].pronunciation;
    lines[index].translation = response.lines[offset].translation;
    if (response.lines[offset].sentence_end !== undefined) {
      lines[index].sentence_end = response.lines[offset].sentence_end;
    }
  }
  var merged = {
    schema_version: 2,
    video: lesson.video,
    study_language: lesson.study_language,
    source_digest: lesson.source_digest,
    lines: lines,
  };
  if (response.glossary && response.glossary.length) merged.glossary = response.glossary;
  else if (lesson.glossary) merged.glossary = lesson.glossary;
  return isLessonComplete(merged) ? sealLesson(merged) : merged;
}
