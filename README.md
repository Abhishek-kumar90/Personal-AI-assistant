# Personal AI Console

A personal AI assistant you run on your own laptop. Visitors can chat with an AI that answers
accurately about **you** — your background, skills, work, projects, and education — and can also
switch into **Career Roadmap**, **Mentor**, and **Just Chat** modes. It has a hands‑free
**voice mode** built around a glowing, animated orb (idle “breathing”, brighter/faster while it
listens, warm and wobbling while it speaks), using the browser’s built‑in speech engine.

Under the hood it’s a real **RAG (Retrieval‑Augmented Generation)** app, not a prompt‑stuffer:
your profile is split into chunks, embedded into vectors with Google’s embedding model, and stored
in a local index. Each question is embedded too, and only the most **semantically relevant** pieces
of your profile are retrieved and fed to the model. That keeps answers grounded and scales as your
profile grows. Every answer shows a small **“Grounded in …”** note listing what was retrieved.

All of your details live in **one file** — `data/profile.json` — so you never touch the app code
to make it yours.

- **Backend:** Node.js + Express
- **Frontend:** plain HTML/CSS/JS — no framework, no build step
- **LLM:** Google Gemini API (free tier, no credit card)
- **Retrieval (RAG):** `gemini-embedding-001` embeddings + a local vector index with cosine‑similarity search — no external vector database, no extra dependencies
- **Voice:** Web Speech API (speech‑to‑text + text‑to‑speech), free and built into the browser
- **Animations:** pure CSS (radial gradients + keyframes), no animation libraries

---

## 1. Requirements

- **Node.js 18 or newer** (needed for the built‑in `fetch`). Check with `node -v`.
  Get it at <https://nodejs.org> if you don’t have it.
- A free **Google Gemini API key** (instructions below).
- For voice mode: a **Chromium‑based browser** (Chrome or Edge) works best. See
  [Voice mode & browser support](#6-voice-mode--browser-support).

---

## 2. Get a free Gemini API key (about 1 minute)

1. Go to **Google AI Studio**: <https://aistudio.google.com/apikey>
2. Sign in with any Google account.
3. Click **“Create API key”** (you can create it in a new project).
4. Copy the key. It looks like a long string starting with `AIza…`.

No credit card is required for the free tier. Keep this key private — treat it like a password.

---

## 3. Install & run

From the project folder, in a terminal:

```bash
# 1. Install dependencies
npm install

# 2. Create your environment file from the template
cp .env.example .env       # macOS / Linux
# copy .env.example .env    # Windows (PowerShell/Command Prompt)

# 3. Open .env and paste your key
#    GEMINI_API_KEY=AIza...your...key...

# 4. Start it
npm start
```

Then open **<http://localhost:3000>** in your browser.

> The server prints a startup summary telling you whether your API key was detected, which chat and
> embedding models it’s using, and the state of the retrieval index.

**First start builds the retrieval index.** The very first time you run it (and any time you change
`data/profile.json`), the server automatically embeds your profile and writes the index to
`data/knowledge-base.json`. This takes a few seconds and happens in the background — the app is
usable immediately, and switches to full retrieval the moment the index is ready. You can also
build it manually at any time:

```bash
npm run ingest
```

To auto‑restart while you edit files, use `npm run dev` (Node 18.11+).

---

## 4. Make it *you* — edit `data/profile.json`

This is the **only** file you need to change. Open `data/profile.json` in any text editor and
replace the placeholder values with your real details.

It’s plain JSON, so:

- Keep the **quotes** and **commas** exactly as they are.
- Fields that start with an underscore (like `"_hint"`) are just guidance — the app ignores them,
  and you can delete them if you like.
- To **hide** a link, set its value to an empty string, e.g. `"twitter": ""`.
- After saving, **restart the server** (`Ctrl+C`, then `npm start`) to load the changes. The server
  notices the profile changed and **rebuilds the retrieval index automatically** (or run
  `npm run ingest` yourself).

What each section is for:

| Field | What it does |
|---|---|
| `name`, `preferredName` | Your name, and the shorter name the AI calls you. |
| `headline`, `tagline`, `bio` | Your one‑liner and a short intro. `bio` is the AI’s core sense of you. |
| `location`, `pronouns`, `availability` | Basic facts; `availability` is used when people ask if you’re open to work. |
| `links` | Email, LinkedIn, GitHub, portfolio, résumé, Twitter. Shared naturally when relevant. |
| `skills` | Grouped skill lists — add/rename groups freely. |
| `experience` | Your roles, with `highlights` (the concrete wins the AI can talk about). |
| `education` | Degrees / programs. |
| `projects` | Side projects / notable work, ideally with links. |
| `achievements` | Awards, talks, certifications, milestones. |
| `careerStory` | Your journey in your own words — this powers **Mentor** mode. Be specific. |
| `personality` | How the AI should sound (tone, quirks, values, what to avoid). |
| `faqs` | Pre‑written answers the AI prefers for common questions. |
| `suggestedQuestions` | The tappable starter chips shown in “Ask About Me”. |

**If the app won’t start after editing,** you probably have a stray comma or missing quote. Paste
the file into <https://jsonlint.com> to find the exact line.

---

## 5. The four modes

Switch modes with the bar under your name.

- **Ask About Me** — accurate Q&A about your background, grounded only in your profile. If it
  doesn’t know something, it says so and points to the right link instead of guessing.
- **Career Roadmap** — the visitor shares their own situation; the AI asks a couple of clarifying
  questions if needed, then builds a personalized roadmap (short / medium / long‑term milestones,
  skill gaps, and project ideas). Tuned for software engineering, but adapts to other fields.
- **Mentor** — grounded career/life advice that draws on your `careerStory`.
- **Just Chat** — warm, casual conversation, not an interview.

Each mode starts a fresh conversation so its behaviour stays clear.

---

## 6. Voice mode & browser support

Tap the **orb** button (bottom‑right of the chat) to enter voice mode. The orb:

- **breathes** gently when idle,
- **pulses faster and brighter** with expanding ripples while it listens,
- glows **warm and wobbles** while it speaks the reply.

Tap the orb to stop/start listening, or **Done** to return to normal chat.

Voice uses the browser’s built‑in **Web Speech API**:

- **Speech‑to‑text** (listening) is supported in **Chrome and Edge** (desktop and Android). Safari
  support is limited, and **Firefox does not support it** — in unsupported browsers the app tells
  you clearly and you can still type.
- **Text‑to‑speech** (speaking) works in most modern browsers.
- The browser will ask for **microphone permission** the first time — allow it.

Everything degrades gracefully: if a speech feature is missing, you get a plain message and the
typed chat keeps working.

---

## 7. How it works (architecture)

The project is small and deliberately dependency‑light. The interesting part is the RAG pipeline,
which has two phases: **ingest** (build the index) and **query** (retrieve + generate).

```
INGEST  (on first start, or when profile.json changes)
  data/profile.json ──► chunker ──► "chunks" (one per job, project, FAQ, skill group, …)
                                        │
                                        ▼
                             gemini-embedding-001  (taskType: RETRIEVAL_DOCUMENT)
                                        │  vectors (L2‑normalized)
                                        ▼
                             data/knowledge-base.json   ← the local vector index


QUERY  (every chat message)
  Browser (public/)                    Node + Express (server.js)                    Google
  ┌──────────────────────┐   POST      ┌───────────────────────────────────┐        ┌─────────┐
  │ chat UI + modes       │  /api/chat  │ 1. embed question                  │  HTTPS │ Gemini  │
  │ CSS voice orb         │ ──────────► │    (RETRIEVAL_QUERY)  ────────────────────►│ embed   │
  │ Web Speech (STT/TTS)  │ {mode,      │ 2. cosine‑similarity vs the index  │◄───────│         │
  │                       │  message,   │ 3. take top‑K chunks               │        │         │
  │                       │  history}   │ 4. build prompt = identity card +  │        │ generate│
  │                       │             │    retrieved chunks + mode  ──────────────►│  Content│
  │                       │ ◄────────── │ 5. return {reply, sources}         │◄───────│         │
  │  shows "Grounded in…" │ {reply,     └───────────────────────────────────┘  reply └─────────┘
  └──────────────────────┘  sources}
```

**Files**

| File | Role |
|---|---|
| `server.js` | Express app: static hosting, `/api/profile`, `/api/chat`, security, rate limit, prompt building, RAG orchestration. |
| `lib/chunker.js` | Turns `profile.json` into small natural‑language chunks (the documents). |
| `lib/embeddings.js` | Calls `gemini-embedding-001`; sets the right `taskType`; L2‑normalizes vectors. |
| `lib/rag.js` | The vector index: build, cache, freshness‑check, and top‑K cosine retrieval. |
| `scripts/ingest.js` | `npm run ingest` — build the index from the command line. |
| `public/` | The frontend (chat UI, modes, voice orb, safe rendering). |
| `data/profile.json` | **Your data** — the one file you edit. |
| `data/knowledge-base.json` | The generated index (git‑ignored; rebuilt automatically). |

**Why RAG here**

- Only the **relevant** slice of your profile is sent to the model per question, so answers stay
  focused and the app scales to a long profile without blowing up the prompt.
- Retrieval is **semantic**, not keyword — “what have you shipped?” finds your projects even if you
  never used the word “shipped”.
- If retrieval isn’t available yet (index still building, no key, or an error), the server
  **falls back** to a compact whole‑profile prompt so chat still works. You can check the current
  state any time at `GET /api/health`.

**Key safety points**

- Your **API key never reaches the browser** — only the server talks to Gemini.
- Your **full profile and the vector index stay on the server**; the browser only sees the small
  public slice (`GET /api/profile`) plus, per answer, the short **titles** of the retrieved chunks.
- Model replies are rendered as **text nodes, never raw HTML**, so a response can’t inject markup.
- Input is **validated and length‑capped**, and a small per‑IP **rate limit** protects your quota.
- The server sends a strict **Content‑Security‑Policy** and other security headers.

---

## 8. Configuration (`.env`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `GEMINI_API_KEY` | ✅ | — | Your key from Google AI Studio (used for both chat and embeddings). |
| `GEMINI_MODEL` | ❌ | `gemini-3.6-flash` | Chat model. Any free‑tier model, e.g. `gemini-3.8-flash`, `gemini-3.5-flash-lite`. |
| `GEMINI_EMBED_MODEL` | ❌ | `gemini-embedding-001` | Embedding model that powers retrieval. |
| `EMBED_DIM` | ❌ | `768` | Embedding size (e.g. `768`, `1536`, `3072`). Changing it triggers a reindex. |
| `RAG_TOP_K` | ❌ | `6` | How many profile chunks to retrieve per question. |
| `RAG_MIN_SCORE` | ❌ | `0.15` | Minimum similarity to include a chunk (best match is always kept). |
| `PORT` | ❌ | `3000` | Local port for the server. |

---

## 9. Troubleshooting

- **“No Gemini API key is configured”** — you didn’t create `.env`, or the key is still the
  placeholder. Copy `.env.example` to `.env`, paste your real key, and restart.
- **“Your Gemini API key appears to be invalid”** — re‑copy the key from AI Studio; watch for
  trailing spaces.
- **“The model … was not found” (404)** — set a valid `GEMINI_MODEL` in `.env`. Models change over
  time; if the default ever stops working, check the current model names at
  <https://ai.google.dev/gemini-api/docs/models> and update the value.
- **“You’ve hit the free‑tier rate limit” (429)** — wait a minute; the free tier limits requests
  per minute/day.
- **Voice doesn’t listen** — you’re probably in Firefox/Safari (limited/no speech‑to‑text). Use
  Chrome or Edge, and allow microphone access.
- **App won’t start after editing profile** — invalid JSON. Validate at <https://jsonlint.com>.
- **Answers don’t show “Grounded in …”** — the retrieval index isn’t ready. Check
  `GET /api/health` (look at `rag.state`). If it says `building`, wait a few seconds; if `error`,
  run `npm run ingest` and read the message — usually a rate limit (429) or a key not enabled for
  the Generative Language API (403). The app still answers via the fallback in the meantime.
- **Changed the profile but answers seem stale** — restart the server, or run `npm run ingest` to
  rebuild the index. You can also delete `data/knowledge-base.json`; it’s regenerated on next start.

---

## 10. Deploying (optional)

This runs great locally. If you later want it online, host the Node app anywhere that supports
Node 18+ (Render, Railway, Fly.io, a small VPS, etc.), set the `GEMINI_API_KEY` environment
variable in that host’s dashboard (never commit `.env`), and point it at `npm start`. On first boot
the server builds the retrieval index automatically; if the host has an ephemeral filesystem it
will simply rebuild on the next start (or run `npm run ingest` as part of your deploy step).

---

## License

MIT — do whatever you like. Make it yours.
