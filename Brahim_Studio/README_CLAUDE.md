# Brahim Studio — handoff to Claude

Prepared: 8 November 2026. Owner: Brahim Amzil.

## رسالة لصاحب التطبيق

هذا الملف يجمع وصف التطبيق الحالي، المزايا التي تعمل، المزايا غير المفعلة، تفاصيل الكود، وخطة الإكمال. أرفق معه `Brahim_Studio_Source.zip` في Claude. الكود يحتوي نسخة التطبيق الحالية، دون مفاتيح API أو بيانات مشاريعك المحفوظة في المتصفح.

## Start here — instruction for Claude

You are continuing an existing application for me. Read this handoff and the attached source archive first. Audit the actual implementation before changing it. Continue the existing product rather than replacing it with another mockup. Explain progress and questions in Moroccan Arabic; keep code and generation prompts in English. Implement and verify real integrations where credentials and hosting allow it. Mark disconnected features honestly. Never say image, video, or MP3 generation is working until an actual result has been verified. Do not ask me to paste secrets into chat.

The immediate goal is my PRIVATE personal AI creative tool, inspired by the capabilities of Higgsfield, with my own identity. It is not a public SaaS at this stage. Do not add subscriptions, customer billing, public sharing, or multi-tenant features without asking. Preserve owner-only access and existing data. Work within existing authorization; ask only for missing information or consequential decisions.

## 0. Progress update — 8 November 2026 (Claude, second session)

Source now lives in `Brahim_Studio/` of the GitHub repo `ai-youtube-video-generator`, branch `claude/brahim-studio-development-4w0a34`. It is NOT deployed: this session had no access to the ChatGPT Sites project or its secrets.

**Implemented (code complete, mocked tests + browser test with a simulated provider):**

| Feature | Route | Provider call |
| --- | --- | --- |
| Writing (fixed) | `POST /api/ai/generate` | OpenAI `/v1/responses`; Claude `/v1/messages` now with `x-api-key` (was wrongly `Authorization: Bearer`) and `anthropic-version: 2026-10-21`, `max_tokens 16000`, `output_config.effort` (`ANTHROPIC_EFFORT`, default `medium`), refusal handling |
| Downloadable narration | `POST /api/tts` → MP3/WAV bytes | OpenAI `/v1/audio/speech` (`OPENAI_TTS_MODEL`, default `gpt-4o-mini-tts`), 13 preset voices, ≤4000 chars, language/pace/style via `instructions` |
| Images | `POST /api/image` → base64 JPEG | `/v1/images/generations`; with character/scene references `/v1/images/edits` (`image[]`, ≤4 refs, signature-checked). `OPENAI_IMAGE_MODEL`, default `gpt-image-2`. Sizes 1024x1536 / 1536x1024 / 1024x1024, quality low/medium/high |
| Video (text→video, image→video) | `POST /api/video` → job id; `GET /api/video/status?id=`; `GET /api/video/content?id=` | `/v1/videos` multipart (`OPENAI_VIDEO_MODEL`, default `sora-2`), seconds 4/8/12, sizes 720x1280 / 1280x720, `input_reference` cropped client-side to the exact size |

Other changes: paid actions require a confirm dialog; client request IDs reject replays (409); per-instance rate limits (`RATE_LIMIT_*`); generated media stored in browser IndexedDB with download buttons; video jobs stored in the project and resumed after reload; projects keep full draft fields (mode code, duration, character, raw prompt, quality) and reopen into the form; v1 localStorage data migrates automatically (verified in the browser test); stricter backup validation with schema `version: 2`; delete for saved scripts; frontend split into `public/js/*.js` (bundled by `scripts/bundle.mjs`); connection panel in Settings.

**NOT verified live** (no keys and `api.openai.com` blocked in the build environment): every model ID default, real OpenAI/Claude responses, real image/audio/video output, prices, Sora content rules. Run `BRAHIM_LIVE_LOCAL=1 npm run smoke` (and `-- --video`) on the owner's machine with keys exported in the terminal, or test in the deployed site after adding secrets.

**To activate on the existing Site:** add `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` as server secrets in the Sites project (`appgprj_6af0a9ca2838819190fa29c10d3c6440`), `npm run build`, deploy `dist/` through the Sites workflow without changing access. Set monthly spend limits in the OpenAI and Anthropic dashboards — in-app limits are best effort only.

Commands: `npm test` (13 mocked tests), `npm run check` (build + syntax), `npm run dev` (UI only, no provider calls), `BRAHIM_LIVE_LOCAL=1 npm run live` (real Worker on 127.0.0.1 with your exported keys).

Still open: longer narrations than 4000 chars (split into parts); multi-turn chat; a host-side durable budget (KV/D1) instead of per-instance limits; iPhone Safari check on the real site.

## 0b. Cross-device sync — 8 November 2026 (Claude, third session)

Opt-in per device (Settings → «تفعيل المزامنة على هذا الجهاز»). Requires two bindings on the host: Cloudflare **D1** as `DB` and **R2** as `MEDIA`. `.openai/hosting.json` now declares `"d1": "DB", "r2": "MEDIA"`. That schema comes from secondary reporting on Sites, not official docs: if a deploy rejects it, bind the storage through the Sites UI/workflow with those names. Without the bindings the server reports `sync.available: false` and the app works exactly as before.

- **Server** (`worker/sync.js`, inlined into the Worker by `scripts/build.mjs`): `GET /api/sync/status`, `GET /api/sync/pull?since=<rev>`, `POST /api/sync/push`, `PUT|GET|DELETE /api/assets/<uuid>`. Tables are created on first use. Every row is scoped to a SHA-256 of the authenticated user id. Last-writer-wins on the client `updatedAt`, with a per-owner increasing `rev` used as the pull cursor. Records over 800 KB are stored as R2 JSON. Media files are signature-checked and served with byte-range support (iPhone video). There is a quota (`SYNC_QUOTA_BYTES`, default 5 GB).
- **Client** (`public/js/06-sync.js`): change detection by hashing each record against its last synced version, so every existing edit path is covered. Tombstones for deletes. Auto sync 4 s after a save, when the page becomes visible, and every 60 s. Local media are uploaded once; media missing on a device load from `/api/assets/<id>`. A backup file is downloaded before the first sync, and on the first sync the cloud copy wins conflicts. Video jobs are polled only by the device that started them.
- **Limits:** whole-record last-writer-wins (two simultaneous edits of the same project: the later one stays). There is no offline queue beyond "push on next sync".
- **Verified with mocks only:** `scripts/sync.test.mjs` (8 tests, SQLite-backed D1 mock + in-memory R2) and a two-browser Playwright run (desktop + iPhone 13) through the built Worker. It covered a character with image, project, image, narration, video with range playback, and delete propagation. Not yet run on real D1/R2.

## 1. Product intent and user context

- Product name: **Brahim Studio** (temporary working name, not a final branding decision).
- Live site: https://brahim-creative-studio.brahimamzil980.chatgpt.site
- Main use: create and organize images, image-to-video and text-to-video work, character references, narration, and AI writing in one private workspace.
- Main device: iPhone. Make the interface mobile-friendly, touch-friendly, and responsive.
- UI language: Arabic / RTL. English content generation is especially important for the creator brands below; Arabic and French narration are also offered.
- Visual direction: dark charcoal backgrounds, green accents, rounded workspace cards, desktop sidebar and compact navigation on mobile.
- Final desired workflow: idea → GPT/Claude script → scenes and prompts → reference-based images → animation/video → downloadable narration → organized project/results.
- This final workflow is a target, not a description of current end-to-end capability.

### Brand context

**Origins Drawn:** English finance, money psychology, and consumer psychology stories. Recurring protagonist Drew: messy dark brown hair, expressive round face, navy hoodie, black stick limbs. Hand-drawn black ink, cream paper, cross-hatching, subtle watercolor accents. Rich backgrounds, meaningful objects, supporting characters, and expressive action; avoid visually empty scenes. Use original reference images when provided. The code only contains a textual Drew description, NOT his original reference image.

**Little Hearts:** warm English family stories. Preserve established family character designs when original references are supplied. No original Little Hearts character images are bundled.

## 2. Current implementation status

| Feature | Current behavior | Remaining work |
| --- | --- | --- |
| Private access | Deployed as an owner-private ChatGPT Site | Preserve audience and authentication |
| Scene workbench | Select image / image-to-video / text-to-video, brand, character, ratio, and duration; prepare prompt | Actual media-provider calls |
| Character references | Add name, fixed description, optional local image; delete character | Cloud persistence, multiple references, robust validation |
| Projects | Save prepared prompt and reference; view list, open prompt, delete | Editable full project state, generated output assets, scene timeline |
| Image upload | FileReader data URL, maximum 2,000,000 bytes per selected image | Validate actual MIME/decoded media; durable blob storage |
| Backup | Export JSON and restore with overwrite confirmation | Full versioned schema validation and migrations |
| Voice studio | Text, language, device voice, speech speed, play/stop preview | Professional TTS provider and downloadable MP3/WAV |
| Voice script storage | Save/open text and settings; download TXT | Delete/edit library entries, cloud sync |
| AI writing UI | OpenAI / Claude selector, task, brand, prompt, result area, transfer answer to scene/voice | Provision secrets and verify real requests |
| AI writing server | Real HTTP implementations for OpenAI Responses API and Claude Messages API | Live credentials, live output tests, spending controls |
| Full conversation | Not implemented; each request is independent | Optional persisted multi-turn history |
| Image/video generation | NOT connected | Provider selection, API integration, async jobs, output handling |
| MP3 generation | NOT connected | Server TTS and audio download |
| Cross-device sync | NOT implemented | Database plus media/object storage |

Do not confuse browser speech preview with an exported audio file. Device voices vary; the test browser had no voices available.

## 3. Source code and architecture

The attached ZIP is the current editable source snapshot of commit:
`4b884be39cbd4be3b4dd83bb943cdcda73f32bc8`.

The original working checkout was `/workspace/sites/brahim-studio`; this path will not exist in your own environment. Unzip into your own workspace.

| File | Purpose |
| --- | --- |
| `public/index.html` | Single-page Arabic UI with inline CSS; sections for scenes, assistant, voice, characters, projects, settings |
| `public/app.js` | Vanilla client JS; local data management, UI, speechSynthesis preview, AI requests |
| `worker/index.js` | Cloudflare-compatible Worker fetch handler, API routes, embedded static-asset responses |
| `scripts/build.mjs` | Reads HTML/JS, embeds them as constants in Worker build; copies hosting manifest |
| `scripts/dev.mjs` | Local UI preview server; deliberately disables real provider writes |
| `scripts/api.test.mjs` | Five Node tests using mocked provider responses |
| `package.json` | ESM package, no third-party dependencies; dev/build/test scripts |
| `.env.example` | Environment variable NAMES and model defaults only; no real keys |
| `.openai/hosting.json` | Existing ChatGPT Sites project binding; no `static` field because it is now server-backed |

Build output is `dist/server/index.js` and `dist/.openai/hosting.json`. Edit `public/` and `worker/`, then rebuild. Do not edit the generated output as source.

Build embeds `HTML` and `APP_JS` constants above Worker code. Importing `worker/index.js` directly only works for API tests; static responses require the built module.

### Commands

```bash
npm run dev
npm test
npm run build
node --check public/app.js
node --check dist/server/index.js
```

Local preview defaults to `127.0.0.1:4173`, or `PORT` if supplied. No dependency installation is needed for the current source.

IMPORTANT: `scripts/dev.mjs` serves UI and the unconfigured provider status. It inserts a local-preview identity only for that status route, passes an empty environment, and refuses other `/api/` requests. It neither loads `.env` nor runs live generation. Creating `.env` alone will NOT enable live API calls in this preview. Use an authenticated Worker runtime adapter for real local integration tests; keep the preview identity behavior out of production.

## 4. Existing deployment

- Host: ChatGPT Sites, server-backed Cloudflare Worker format.
- Existing project ID: `appgprj_6af0a9ca2838819190fa29c10d3c6440`.
- Latest deployment at handoff: version 3, confirmed successful by hosting service.
- Access: owner-private, custom access with owner only.
- Source repository is managed by Sites; its credentials are temporary and are NOT in the archive.
- No OpenAI or Anthropic secret was configured at the last environment inspection.

If continuing in the same Sites environment, reuse the existing project ID and follow its authenticated source/publishing workflow. Do not create a duplicate Site or change sharing simply to deploy. The ZIP alone does not grant permission or credentials to push to the existing host.

If moving to another host, prepare the migration explicitly. Replace the Sites binding appropriately and implement real authentication for that host BEFORE enabling paid provider routes. The identity header described below is trusted only behind the Sites authentication boundary; checking an arbitrary incoming header on an exposed Worker is NOT authentication.

## 5. AI server contract

### `GET /api/ai/status`

Requires trusted authenticated visitor identity. Returns:

```json
{
  "providers": {
    "openai": {"configured": false, "model": "gpt-6-astra"},
    "anthropic": {"configured": false, "model": "claude-sonnet-5-5"}
  }
}
```

`configured` means a corresponding secret exists, not that credentials, credit, model permissions, or network access have been verified. UI intentionally labels this distinction.

### `POST /api/ai/generate`

Requires authenticated identity, same-origin `Origin`, and JSON content type.

```json
{
  "provider": "openai",
  "task": "script",
  "brand": "Origins Drawn",
  "prompt": "Write a 45-second English story about Drew getting a raise."
}
```

Allowed provider: `openai`, `anthropic`.
Allowed task: `script`, `prompt`, `narration`, `general`.
Allowed brand: `Origins Drawn`, `Little Hearts`, `مشروع شخصي`.
Prompt limit: 12,000 JavaScript string characters. Request body limit: 60,000 bytes.

Success:

```json
{"text":"Provider response text","provider":"OpenAI","model":"configured-model","truncated":false}
```

Errors use `{"error":"Arabic error message"}`. Implemented responses include 400, 401, 403, 404, 405, 415, 429, 502, 503, and 504. Errors do not echo raw provider messages or keys.

### Provider implementation

**OpenAI:** POST `https://api.openai.com/v1/responses`; Bearer auth; body includes `model`, `instructions`, `input`, `max_output_tokens: 3000`, `store: false`. Extracts message content with `type: output_text`.

**Claude:** POST `https://api.anthropic.com/v1/messages`; Bearer auth; `anthropic-version: 2026-10-21`; body includes `model`, `system`, one user message, `max_tokens: 3000`. Extracts content blocks with `type: text`.

Both requests use a 60-second timeout. The client disables repeat submission while awaiting a response. No automatic retry is performed. A timeout can leave upstream billing/completion uncertain.

These are the exact current implementation choices, not promises of account access. Before activation, verify current provider documentation, authentication/version requirements, model availability, and account permissions. Model defaults are configurable; do not hard-code assumptions about the newest or cheapest model.

Environment variables:

```text
OPENAI_API_KEY       secret, required for OpenAI
ANTHROPIC_API_KEY    secret, required for Claude
OPENAI_MODEL        optional server override
ANTHROPIC_MODEL     optional server override
```

Only use server-side secret storage. Never place real keys in browser JS, HTML, localStorage, source control, exported backups, URLs, logs, or chat. The `.env.example` file is documentation only, not a provisioned integration.

OpenAI Developers was suggested in ChatGPT and became available after installation. The API credential setup workflow had NOT yet been executed. Follow that environment's secure key-provisioning process when available; do not assume the installed plugin means an API key or credits exist.

This connects provider APIs, not the user's existing ChatGPT/Claude conversation history. It does not implement OAuth linking to those consumer accounts.

Official implementation references consulted:
- https://developers.openai.com/api/docs/quickstart
- https://developers.openai.com/api/reference/resources/responses/methods/create
- https://platform.claude.com/docs/en/api/messages/create

## 6. Data model and persistence

Browser key: `brahim-studio-v1`.

```ts
type Database = {
  characters: Array<{
    id: string;
    name: string;
    description: string;
    image: string; // optional data URL represented by empty string when absent
  }>;
  projects: Array<{
    id: string;
    title: string;
    brand: string;
    mode: string; // Arabic UI label
    ratio: string;
    text: string; // prepared full prompt
    reference: string; // data URL or empty string
  }>;
  voiceScripts?: Array<{
    id: string;
    title: string;
    text: string;
    language: string; // en / ar / fr
    rate: string; // 0.85 / 1 / 1.15
    voice: string; // device-specific voiceURI
  }>;
};
```

New IDs use `crypto.randomUUID()`. Character seed: Drew text description only. Browser storage is local to the origin, browser, and device. The ZIP does not contain user records or uploaded reference pictures. Back up via the app before domain changes, storage migrations, or clearing browser data.

The project stores the prepared prompt and one chosen reference, but not a fully structured scene draft. Duration, character ID, and original raw scene prompt are not stored in dedicated fields. Opening a project shows its prompt/reference without restoring every original form control.

AI answers are held in memory only; the UI can copy or transfer them to scene/narration fields. They are not a persistent conversation or automatically saved generation history.

## 7. Verification completed and limits

Completed before handoff:
- JS syntax checks and Worker build.
- Five Node API tests passed: unauthenticated rejection; origin/provider validation; unconfigured status and no secret exposure; request routing/parsing for BOTH providers with mock responses; sanitized provider failures and no automatic replay.
- UI checked in browser: prepared project and fixed Drew description; saving a voice script; AI selector and explicit unconfigured states for OpenAI and Claude.
- All three app versions deployed successfully.

NOT verified:
- Real OpenAI or Anthropic request, credentials, model permissions, billing, or response quality.
- Hosted paid API calls as the signed-in owner.
- Speech playback: test browser had no voices. iPhone playback remains to be verified.
- Image/video/MP3 generation: no implementation exists yet.
- Full mobile browser workflow, backup migration, cross-device persistence, generated-asset download reliability.

Mocked API tests and successful deployment are not evidence that a provider integration is live.

## 8. Known cleanup and reliability work

1. Format and split the compact frontend and Worker code into maintainable modules without breaking behavior.
2. Strengthen backup import: validate IDs, types, lengths, arrays, all project fields, voiceScripts, and total size. Add schema versioning. Current validation is partial.
3. Replace the delayed voice-list refresh after import with an explicit awaited state update.
4. Validate image MIME and decoded file content; current client size check does not validate real media content.
5. Preserve all draft fields when reopening/editing a project; store duration and character relation explicitly.
6. Add server-side rate limits, spending controls, durable idempotency/job tracking before enabling real paid generation. Disabling the button is not durable duplicate protection.
7. Add persistent draft/history and support deliberate multi-turn conversations only if useful.
8. Clarify 401/403 auth UI and provide the host's supported sign-in flow.
9. Keep owner-private access; the server currently relies on Sites to supply trusted `oai-authenticated-user-id`. Never trust a self-supplied identity header after moving hosts.
10. Separate text-only assistant context from image-aware generation: currently no uploaded references or local character records are sent to GPT/Claude. Only prompt, task, brand, and fixed server instructions are sent.
11. The available voice rates and voiceURI are device-specific. Handle missing stored voices gracefully.
12. Audit current generated-media and settings copy as features become connected. Never leave “connected” labels based on placeholder data.

## 9. Recommended implementation order

### Priority 1 — activate real writing

Provision OpenAI and/or Anthropic secrets through a secure supported flow. Verify current model IDs and provider API contracts. Add spending controls and real authenticated smoke tests. Keep response errors actionable. Preserve provider selection and send-to-scene/send-to-voice behavior.

### Priority 2 — downloadable narration

Add a server-side TTS provider with actual audio output, character/length limits, language/voice options, job/result state, audio player and MP3/WAV download. Clearly distinguish this from free device speech preview. Show any provider charge before an intentional paid action when appropriate. Use only preset or authorized voices.

### Priority 3 — images and video

Choose supported providers with available APIs. Implement image generation and reference-conditioned generation first, then image-to-video/text-to-video. Discover each provider's actual model schema, prices, duration and ratio limits. Add durable job IDs, progress/status polling, errors, output URLs, retries that do not duplicate billing, and downloads. Never use a browser connector token as an app API secret.

### Priority 4 — persistence and complete projects

Introduce a database and object storage so iPhone and desktop share projects and assets. Migrate existing localStorage safely and preserve a backup. Use ownership checks on every record and asset. Build scene lists, reusable character references, and an exportable project package.

### Priority 5 — polish

Verify iPhone Safari, RTL layout, touch navigation, downloads, accessibility labels, editing, recovery, and network failure behavior. Keep private tool scope; avoid unnecessary billing/public-SaaS work.

## 10. Acceptance criteria for the next deliverable

- Existing app opens privately and existing local drafts are preserved.
- A real authenticated text request succeeds with each provider that has been provisioned; unconfigured providers are clearly marked.
- One narration script produces an actual playable downloadable audio file when TTS is connected.
- One image and one short video can be generated and downloaded when the corresponding providers are connected.
- Missing credentials, quota errors, timeouts, and failed jobs have honest statuses without fabricated outputs or silent retries.
- No secrets in browser code or backups; paid operations require deliberate user action.
- Report exactly which live flows were tested, which were mocked, and which still require user setup.
