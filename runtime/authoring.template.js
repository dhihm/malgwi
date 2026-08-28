/* Browser-side watch-page lesson authoring. Injected by the compiler
 * into library.user.template.js; idle until the user presses Create lesson. */
var LOCAL_LESSON_PREFIX = "ysp:lesson:v2:";
var LOCAL_LESSON_INDEX_KEY = "ysp:local-lessons:v1";
var AUTHORING_SETTINGS_KEY = "ysp:authoring:v1";
var AUTHORING_CONFIRM_KEY = "ysp:authoring:confirm:v1";
var LINE_CAP = 200;
var BATCH_SIZE = 40;

/*__CANONICAL_JSON__*/

function sha256Hex(text) {
  if (!window.crypto || !window.crypto.subtle) {
    return Promise.reject(new Error("crypto unavailable"));
  }
  return window.crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then(function (buffer) {
      return Array.from(new Uint8Array(buffer))
        .map(function (byte) { return byte.toString(16).padStart(2, "0"); })
        .join("");
    });
}

function captionDigest(captions) {
  return sha256Hex(canonicalJson(captions));
}

function localLessonStorageKey(videoId, studyLanguage, sourceDigest) {
  return LOCAL_LESSON_PREFIX + videoId + ":" + studyLanguage + ":" + sourceDigest;
}

function loadLocalIndex() {
  try {
    var parsed = JSON.parse(window.localStorage.getItem(LOCAL_LESSON_INDEX_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function saveLocalIndex(index) {
  try {
    window.localStorage.setItem(LOCAL_LESSON_INDEX_KEY, JSON.stringify(index));
  } catch (error) {
    /* quota / private mode */
  }
}

function upsertLocalIndex(entry) {
  var index = loadLocalIndex().filter(function (candidate) {
    return !(candidate.video_id === entry.video_id && candidate.study_language === entry.study_language);
  });
  index.push(entry);
  saveLocalIndex(index);
}

function loadStoredLesson(key) {
  try {
    var raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

function saveStoredLesson(key, lesson) {
  try {
    window.localStorage.setItem(key, JSON.stringify(lesson));
  } catch (error) {
    /* quota / private mode */
  }
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

function isAuthoringEndpointAllowed(endpoint) {
  try {
    var url = new URL(endpoint);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

function loadAuthoringSettings() {
  try {
    var value = JSON.parse(window.localStorage.getItem(AUTHORING_SETTINGS_KEY) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch (error) {
    return {};
  }
}

function saveAuthoringSettings(patch) {
  try {
    var value = loadAuthoringSettings();
    for (var key in patch) value[key] = patch[key];
    window.localStorage.setItem(AUTHORING_SETTINGS_KEY, JSON.stringify(value));
  } catch (error) {
    /* private mode */
  }
}

function confirmedForVideo(videoId) {
  try {
    var map = JSON.parse(window.localStorage.getItem(AUTHORING_CONFIRM_KEY) || "{}");
    return !!(map && map[videoId]);
  } catch (error) {
    return false;
  }
}

function markConfirmed(videoId) {
  try {
    var map = JSON.parse(window.localStorage.getItem(AUTHORING_CONFIRM_KEY) || "{}");
    if (!map || typeof map !== "object") map = {};
    map[videoId] = true;
    window.localStorage.setItem(AUTHORING_CONFIRM_KEY, JSON.stringify(map));
  } catch (error) {
    /* private mode */
  }
}

function stripCueText(html) {
  var div = document.createElement("div");
  div.textContent = String(html || "").replace(/<[^>]+>/g, " ");
  return div.textContent.replace(/\s+/g, " ").trim();
}

/** Read cues already loaded in this watch-page session. */
function readSessionCaptions() {
  var video = document.querySelector("#movie_player video") || document.querySelector("video");
  if (!video) return { error: "no_video" };
  var track = null;
  var tracks = video.textTracks;
  if (!tracks) return { error: "no_captions" };
  for (var i = 0; i < tracks.length; i += 1) {
    if (tracks[i].mode === "showing" || tracks[i].mode === "hidden") track = tracks[i];
  }
  if (!track) {
    for (var j = 0; j < tracks.length; j += 1) {
      if (tracks[j].cues && tracks[j].cues.length > 0) {
        track = tracks[j];
        break;
      }
    }
  }
  if (!track || !track.cues || track.cues.length === 0) return { error: "no_captions" };
  var captions = [];
  var previousStart = -1;
  for (var k = 0; k < track.cues.length; k += 1) {
    var cue = track.cues[k];
    var text = stripCueText(cue.text);
    if (!text) continue;
    var startMs = Math.round(cue.startTime * 1000);
    var endMs = Math.round(cue.endTime * 1000);
    if (endMs <= startMs) continue;
    if (startMs < previousStart) continue;
    previousStart = startMs;
    captions.push({ start_ms: startMs, end_ms: endMs, text: text });
  }
  if (captions.length === 0) return { error: "no_captions" };
  return { captions: captions, language: track.language || "" };
}

function buildLessonDraft(captions, videoId, studyLanguage, sourceLanguage, title) {
  return captionDigest(captions).then(function (digest) {
    return {
      schema_version: 2,
      video: {
        provider: "youtube",
        video_id: videoId,
        source_language: sourceLanguage || "en",
        title: title || undefined,
      },
      study_language: studyLanguage,
      source_digest: digest,
      lines: captions.map(function (caption) {
        return {
          start_ms: caption.start_ms,
          end_ms: caption.end_ms,
          original: caption.text,
        };
      }),
    };
  });
}

function resolveLocalLesson(videoId) {
  var index = loadLocalIndex();
  for (var i = 0; i < index.length; i += 1) {
    var entry = index[i];
    if (entry.video_id !== videoId) continue;
    var key = localLessonStorageKey(entry.video_id, entry.study_language, entry.source_digest);
    var lesson = loadStoredLesson(key);
    if (lesson) return { entry: entry, lesson: lesson, key: key };
  }
  return null;
}

function storeLocalLesson(lesson, complete) {
  var key = localLessonStorageKey(lesson.video.video_id, lesson.study_language, lesson.source_digest);
  saveStoredLesson(key, lesson);
  upsertLocalIndex({
    video_id: lesson.video.video_id,
    study_language: lesson.study_language,
    source_digest: lesson.source_digest,
    complete: !!complete,
  });
  return key;
}

function batchIndices(lineCount) {
  var capped = Math.min(lineCount, LINE_CAP);
  var batches = [];
  for (var start = 0; start < capped; start += BATCH_SIZE) {
    var batch = [];
    for (var index = start; index < Math.min(start + BATCH_SIZE, capped); index += 1) batch.push(index);
    batches.push(batch);
  }
  return batches;
}

function parseModelBatchResponse(value, expectedCount) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid model response");
  }
  if (!Array.isArray(value.lines)) throw new Error("missing lines");
  var lines = [];
  for (var i = 0; i < Math.min(value.lines.length, expectedCount); i += 1) {
    var raw = value.lines[i];
    if (!raw || typeof raw !== "object") throw new Error("bad line");
    if (typeof raw.pronunciation !== "string" || !raw.pronunciation) throw new Error("bad pronunciation");
    if (typeof raw.translation !== "string" || !raw.translation) throw new Error("bad translation");
    lines.push({
      pronunciation: raw.pronunciation,
      translation: raw.translation,
      sentence_end: typeof raw.sentence_end === "boolean" ? raw.sentence_end : undefined,
    });
  }
  var glossary = undefined;
  if (Array.isArray(value.glossary)) {
    glossary = value.glossary.map(function (entry) {
      return { word: String(entry.word || ""), meaning: String(entry.meaning || "") };
    });
  }
  return { lines: lines, glossary: glossary };
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
  return merged;
}

function authoringPromptForBatch(lesson, indices) {
  var originals = indices.map(function (index) {
    var line = lesson.lines[index];
    return { index: index, original: line.original, start_ms: line.start_ms, end_ms: line.end_ms };
  });
  return {
    system:
      "You author study fields for a language-learning lesson. " +
      "Return JSON only: {\"lines\":[{\"pronunciation\":\"…\",\"translation\":\"…\",\"sentence_end\":true|false?},…],\"glossary\":[{\"word\":\"…\",\"meaning\":\"…\"}]?}. " +
      "Fill pronunciation (source speech in the learner's script) and translation (learner's language). " +
      "Optional sentence_end marks sentence boundaries. Optional glossary lists lowercase vocabulary meanings. " +
      "Never change original text or timecodes. Never output HTML or JavaScript.",
    user:
      "Study language: " + lesson.study_language + "\nSource language: " + lesson.video.source_language + "\n" +
      "Lines:\n" + JSON.stringify(originals),
  };
}

function callModelBatch(settings, lesson, indices, retry) {
  var endpoint = String(settings.endpoint || "").replace(/\/+$/u, "");
  var apiKey = String(settings.apiKey || "");
  var model = String(settings.model || "gpt-4o-mini");
  if (!endpoint || !apiKey) return Promise.reject(new Error("missing_settings"));
  if (!isAuthoringEndpointAllowed(endpoint)) return Promise.reject(new Error("insecure_endpoint"));
  var prompt = authoringPromptForBatch(lesson, indices);
  return window.fetch(endpoint + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model: model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
    }),
  }).then(function (response) {
    if (response.status === 429 && !retry) {
      return new Promise(function (resolve) {
        window.setTimeout(function () {
          resolve(callModelBatch(settings, lesson, indices, true));
        }, 1500);
      });
    }
    if (!response.ok) {
      var err = new Error("api_error");
      err.status = response.status;
      throw err;
    }
    return response.json();
  }).then(function (payload) {
    var content = payload.choices && payload.choices[0] && payload.choices[0].message
      ? payload.choices[0].message.content
      : "";
    var parsed = typeof content === "string" ? JSON.parse(content) : content;
    return parseModelBatchResponse(parsed, indices.length);
  });
}

function runAuthoringBatches(lesson, settings, onProgress) {
  var batches = batchIndices(lesson.lines.length);
  var current = lesson;
  var chain = Promise.resolve();
  batches.forEach(function (indices, batchNumber) {
    chain = chain.then(function () {
      if (onProgress) onProgress("batch", batchNumber + 1, batches.length);
      return callModelBatch(settings, current, indices, false).then(function (response) {
        current = mergeModelBatch(current, indices[0], response);
        storeLocalLesson(current, isLessonComplete(current));
      });
    });
  });
  return chain.then(function () { return current; });
}

function exportLessonJson(lesson) {
  var blob = new Blob([JSON.stringify(lesson, null, 2) + "\n"], { type: "application/json" });
  var url = URL.createObjectURL(blob);
  var link = document.createElement("a");
  link.href = url;
  link.download = lesson.video.video_id + "-lesson-v2.json";
  link.click();
  URL.revokeObjectURL(url);
}

/* Test hook: replace caption reader without touching the network. */
var readSessionCaptionsImpl = readSessionCaptions;
if (typeof window !== "undefined") {
  window.__yspTestHooks = {
    setReadSessionCaptions: function (fn) { readSessionCaptionsImpl = fn; },
    captionDigest: captionDigest,
    storeLocalLesson: storeLocalLesson,
    resolveLocalLesson: resolveLocalLesson,
  };
}
