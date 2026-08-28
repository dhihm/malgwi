# Legal review — YouTube subtitles, copyright, open source

Status: working notes, not legal advice. Reviewed 2026-08-27.

## 1. Video playback

The generated page embeds videos exclusively through the official YouTube
IFrame Player API. That is the sanctioned embedding path under the YouTube
Terms of Service, provided the source video itself allows embedding. The
page never downloads, proxies, re-hosts, or re-encodes video or audio.

Consequences for the runtime:

- Keep the IFrame API as the only playback mechanism.
- Do not hide, overlay, or auto-mute YouTube advertising or branding.
- If a video owner disables embedding, the page must simply fail to play;
  we do not work around it.

## 2. Subtitle acquisition

The official YouTube Data API `captions.download` endpoint only works for
videos the authenticated user owns. There is no sanctioned API for
downloading caption tracks of arbitrary public videos, and scraping
`timedtext`/Innertube endpoints sits outside the API terms.

Policy adopted here:

- This repository contains no caption fetcher at all. It consumes caption
  data a host hands to the compiler.
- Hosts should prefer user-supplied subtitle files (`.vtt`/`.srt` exports,
  the user's own videos, openly licensed sources) and replay fixtures.
- Any unofficial network fetcher a host adds must stay an isolated,
  replaceable, off-by-default experiment, clearly labeled as such, so it
  can be removed without touching the schema, runtime, or compiler.

## 3. Copyright in captions and derived text

Caption text of a third-party video is generally a copyrighted work (or a
derivative of the script). Korean translations and pronunciation glosses
generated from it are derivative works.

Policy adopted here:

- Generated pages are private study material: built locally, kept locally.
  Nothing in this toolkit deploys, publishes, or shares a page, and the
  default host behavior must keep it that way.
- Fixtures in this repository use short synthetic dialogue written for the
  tests, not captured captions from a real video.
- Redistribution of a generated page containing third-party caption text
  would need permission from the rights holder; the README must not
  encourage it.

## 4. Open-source posture

- License: MIT (see LICENSE). The repository is private until the owner
  decides to open it; the code is ours to license, fixtures are original,
  and there are no vendored dependencies to audit (the library is
  zero-dependency, tests use Bun's built-in runner).
- The repository has no dependency on any private host project and never
  names one; host adapters integrate by producing lesson-v2 documents and
  pinning the runtime templates.
- The YouTube IFrame API is loaded at page view time from Google's
  servers under YouTube's terms; it is referenced, never vendored.

## 5. Open questions

- Whether per-user caption exports (e.g. a browser extension the user runs
  against their own session) change the ToS analysis for the host adapter.
- Whether publishing pages for openly licensed videos (CC BY) with caption
  attribution is worth supporting as an explicit opt-in path.
