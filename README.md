# Malgwi

**Malgwi** (Korean 말귀, "an ear for words"; pronounced *mal-gwee* — from
the idiom *malgwiga teuida*, "when your ears finally open to a
language") turns any YouTube video into a language-study experience.

![The Malgwi study panel over a YouTube lecture: original lines with pronunciation and translation, per-line jump and repeat buttons, and the control chips](docs/screenshot.png)

<sub>\* The screenshot shows the panel over a publicly available Stanford
Online lecture, for demonstration only. If you believe this screenshot
infringes any copyright or other rights, please open an issue — it will
be corrected or removed immediately.</sub>

A study panel appears right on the YouTube watch page you already use:

- **Original subtitles** with **pronunciation** rendered in your script
  and a natural **translation** in your language
- The current line highlights and follows playback
- **Jump** (`▶`) to any line; **repeat** (`↺`) a line or the whole
  spoken sentence — once, in a loop, or off
- **Vocabulary book**: drag any word in the original text to save it,
  with its meaning, real usage examples from the video, and a
  one-click dictionary lookup
- Playback speed, panel opacity, drag-to-move, resize — all remembered

A lesson pairs one source-language video with one **study language**
(Korean learners watching English lectures, English or Chinese learners
watching Korean videos, and so on). The panel UI follows your system
language (English, Korean, Chinese, Japanese).

Everything runs locally in your browser. No account, no server, no AI
at view time, and nothing leaves your machine.

---

## Studying with Malgwi

You need a lesson userscript — a single `.user.js` file built for the
videos you study (see [Building lessons](#building-lessons) below).

### 1. Install a userscript manager

| Browser | Install |
|---|---|
| Chrome / Edge / Firefox | [Tampermonkey](https://www.tampermonkey.net/) |
| Safari (macOS/iOS) | [Userscripts](https://apps.apple.com/app/userscripts/id1463298887) (free, App Store) |

### 2. Install your lesson file

- **Tampermonkey**: dashboard → Utilities → import the `.user.js` file
  (or drag it into the dashboard).
- **Userscripts (Safari)**: enable the extension in Safari settings,
  pick a scripts folder in the Userscripts app, and copy the `.user.js`
  file into that folder.

Use `study-library.user.js` (all your videos in one install) rather
than per-video files; rebuilding the library and replacing that one
file updates everything.

### 3. Open the video on YouTube

Visit the video on `youtube.com` as usual. The Malgwi panel appears on
the right for any video in your library, and disappears on videos you
have not studied.

### Panel controls

| Control | What it does |
|---|---|
| `▶ 0:42` | Jump to that line and play (cancels any active repeat) |
| `↺` | Repeat: 1st press replays the sentence once, 2nd press loops it, 3rd press turns it off |
| Sentence chip | Toggle repeat scope: full spoken sentence (default) or single caption cue |
| Pronunciation / Translation chips | Show or hide those lines |
| Follow chip | Auto-scroll to the current line |
| `1×` | Cycle playback speed 1× → 0.75× → 0.5× |
| `100%` | Cycle panel opacity 100 → 85 → 65 → 45% |
| Vocabulary chip | Switch between subtitles and your vocabulary book |
| Drag a word in the original text | Offers one-click capture into the vocabulary book |
| Drag the header | Move the panel anywhere (it undocks) |
| `◢` bottom-right grip | Resize the panel |
| Collapse chip | Fold the panel into a side tab |

Vocabulary entries and panel placement live in your browser's
`localStorage` only.

---

## Building lessons

Malgwi deliberately contains **no AI and no network code**. It is the
deterministic half of a two-part system:

1. **A host** (an AI agent you run, or any script) captures subtitles
   from a file you provide and authors the `pronunciation` and
   `translation` fields — typically with a language model.
2. **This toolkit** validates the lesson, binds the original text to
   the capture with a SHA-256 digest so it cannot be silently altered,
   and compiles the static artifacts.

```
subtitles (.vtt/.srt/json)          lesson-v2 JSON            static artifacts
        │  capture                        │  compile                 │
        └────────► originals + digest ────┴──► index.html            │
                        ▲                      study.user.js  ◄──────┘
   model authors only:  │                      study-library.user.js
   pronunciation,       │
   translation ─────────┘
```

### The lesson-v2 document

The full contract is
[`schema/lesson-v2.schema.json`](schema/lesson-v2.schema.json). The
shape:

```jsonc
{
  "schema_version": 2,
  "video": { "provider": "youtube", "video_id": "abc123XYZ_-",
             "source_language": "en", "title": "…" },
  "study_language": "ko",
  "source_digest": "…",            // sha256 of the canonical caption list
  "lines": [
    { "start_ms": 400, "end_ms": 2100,
      "original": "What are you doing here?",   // verbatim capture
      "pronunciation": "왓 아 유 두잉 히어?",      // source speech, learner's script
      "translation": "여기서 뭐 하고 있어?",       // learner's language
      "sentence_end": true }                     // optional: sentence boundary
  ],
  "glossary": [                                  // optional: vocabulary meanings
    { "word": "town", "meaning": "마을, 동네" }
  ]
}
```

Rules that make a lesson trustworthy:

- `original`, `start_ms`, `end_ms` come verbatim from the captured
  subtitles; `source_digest` (SHA-256 over the canonical capture) lets
  any host verify nothing was silently altered.
- The model authors **only** `pronunciation`, `translation`, optional
  `sentence_end` flags, and optional glossary meanings.
- See [`fixtures/lesson.sample.json`](fixtures/lesson.sample.json) for
  a complete synthetic example.

### Compile

Requires [Bun](https://bun.sh).

```sh
# one video -> out/index.html + out/study.user.js + out/lesson.json
bun compiler/build.ts lesson.json out/

# every studied video -> one installable library userscript
bun compiler/build.ts --library study-library.user.js \
    lesson1.json lesson2.json lesson3.json
```

Builds are deterministic: same input, byte-identical output.

### Getting subtitles

Subtitle acquisition is out of scope by design: bring your own subtitle
files (`.vtt`, `.srt`, or a neutral
`[{"start_ms","end_ms","text"}]` JSON) — exports of your own videos,
files you legitimately have, or openly licensed sources. Read
[`LEGAL_REVIEW.md`](LEGAL_REVIEW.md) before adding any automated
fetcher to a host.

### The standalone page

`out/index.html` is a self-contained study page with an embedded
player. Serve it over HTTP (`python3 -m http.server`) rather than
opening the file directly — YouTube requires a referrer for embedded
playback. When a video's owner disables embedding, the page degrades
gracefully to a floating video window driven by the same jump buttons.

---

## Repository layout

- `schema/` — the lesson-v2 JSON Schema (legacy v1 upgrades
  transparently)
- `runtime/` — the three pinned templates (page, per-video userscript,
  library userscript); no build step, the compiler injects escaped JSON
  into a fixed slot
- `compiler/build.ts` — deterministic builders and the CLI
- `src/lesson.ts` — validation, canonicalization, digests, injection
  (zero dependencies)
- `scripts/pin.ts` — emits the commit + SHA-256 pin record a host embeds
  next to its frozen template copies
- `fixtures/`, `tests/` — synthetic dialogue fixtures; contract tests,
  injection-safety tests, and a DOM-stub smoke test that executes the
  compiled userscript

## Design rules

1. The model never writes HTML or JavaScript. It fills data fields in
   `lesson-v2`; every artifact is a pinned template plus injected,
   escaped JSON.
2. `original` is verbatim capture output; the digest makes silent edits
   detectable.
3. Lesson text reaches the DOM through `textContent` only, and the
   inline JSON escapes `<`, U+2028, and U+2029, so hostile subtitle
   text cannot escape the script block.
4. Generated artifacts are local, personal study material; nothing here
   deploys, publishes, or shares them.
5. Playback always stays on youtube.com — the official IFrame player in
   the page, or the real watch page under the userscripts. No stream
   extraction, ever.

## Contributing

Malgwi is developed solo: **pull requests are not accepted** and are
closed automatically (see
[CONTRIBUTING.md](.github/CONTRIBUTING.md)). Bug reports and ideas are
very welcome through
[issues](https://github.com/dhihm/malgwi/issues/new/choose) — the forms
ask for the screenshot and environment details that make problems
fixable. Forks are always fine under the MIT license.

## License

[MIT](LICENSE)
