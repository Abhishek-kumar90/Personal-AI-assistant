/**
 * Personal AI Console — backend server
 * -------------------------------------
 * Responsibilities:
 *   1. Serve the static frontend (public/).
 *   2. Expose a small, safe public slice of your profile to the browser (GET /api/profile).
 *   3. Accept chat messages, build a grounded system prompt from data/profile.json + the
 *      selected mode, and relay the conversation to the Google Gemini API (POST /api/chat).
 *
 * Design notes:
 *   - The Gemini API key is read from the environment (.env). It never reaches the browser.
 *   - The full profile stays on the server; only a curated public subset is sent to the client.
 *   - User input is validated and length-capped before it is used.
 *   - Errors return a short, friendly message; details are logged to the server console only.
 */

'use strict';

require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');

const rag = require('./lib/rag');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-3.6-flash').trim();
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
  GEMINI_MODEL
)}:generateContent`;

// The conversation modes the UI can request. Anything outside this allowlist is rejected.
const MODES = ['ask_me', 'roadmap', 'mentor', 'friend'];

// Input limits (defense against oversized / abusive requests).
const MAX_MESSAGE_CHARS = 4000;
const MAX_HISTORY_TURNS = 20;
const MAX_TURN_CHARS = 6000;

/* ------------------------------------------------------------------ *
 * Load profile data once at startup.
 * ------------------------------------------------------------------ */
const PROFILE_PATH = path.join(__dirname, 'data', 'profile.json');

function loadProfile() {
  const raw = fs.readFileSync(PROFILE_PATH, 'utf8');
  return JSON.parse(raw);
}

let profile;
try {
  profile = loadProfile();
} catch (err) {
  console.error('\n[FATAL] Could not read data/profile.json.');
  console.error('        Make sure the file exists and is valid JSON (try https://jsonlint.com).');
  console.error('        Details:', err.message, '\n');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * RAG readiness.
 *
 * The retrieval index (data/knowledge-base.json) is what makes this a real
 * retrieval-augmented app rather than a prompt-stuffer. We prepare it here:
 *   - If a fresh index already exists on disk, load it instantly.
 *   - If it's missing or stale (profile changed) and a key is present, build it
 *     in the background so `npm start` "just works" after editing your profile.
 *   - While it builds — or if there's no key / a build error — chat still works
 *     via a safe fallback that injects a compact whole-profile context.
 * ------------------------------------------------------------------ */
const KEY_OK = Boolean(GEMINI_API_KEY && GEMINI_API_KEY !== 'your_gemini_api_key_here');
let ragState = 'disabled'; // 'ready' | 'building' | 'disabled' | 'error'

function prepareKnowledgeBase() {
  if (!KEY_OK) {
    ragState = 'disabled';
    return;
  }
  if (rag.loadIfFresh(profile)) {
    ragState = 'ready';
    console.log(`  ▸ Retrieval    index ready (${rag.stats().chunks} chunks) ✓`);
    return;
  }
  // Needs building. Do it in the background so the server starts responding now.
  ragState = 'building';
  console.log('  ▸ Retrieval    building index from profile… (first run or profile changed)');
  rag
    .buildKnowledgeBase(profile)
    .then(() => {
      ragState = 'ready';
      console.log(`  ▸ Retrieval    index built (${rag.stats().chunks} chunks) ✓`);
    })
    .catch((err) => {
      ragState = 'error';
      console.error('  ▸ Retrieval    index build FAILED:', err.message);
      console.error('                 Falling back to whole-profile context until it succeeds.');
      console.error('                 Fix the issue and run `npm run ingest` to retry.');
    });
}

/* ------------------------------------------------------------------ *
 * Middleware: security headers + JSON body parsing.
 * ------------------------------------------------------------------ */
app.disable('x-powered-by');

app.use((req, res, next) => {
  // A conservative Content-Security-Policy. Scripts run only from our own origin;
  // fonts come from Google Fonts. No inline scripts are used anywhere in the app.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'"
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.use(express.json({ limit: '64kb' }));

/* ------------------------------------------------------------------ *
 * A tiny in-memory rate limiter (per IP). Not bulletproof, but a sane
 * guard for a personal app so one client can't hammer your Gemini quota.
 * ------------------------------------------------------------------ */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30; // requests per window per IP
const hits = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  entry.count += 1;
  hits.set(ip, entry);
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({
      error: 'You are sending messages a little too fast. Give it a few seconds and try again.'
    });
  }
  next();
}

// Occasionally sweep the map so it doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) {
    if (now > entry.resetAt) hits.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

/* ------------------------------------------------------------------ *
 * Serve the frontend.
 * ------------------------------------------------------------------ */
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ *
 * GET /api/profile — the public slice the browser is allowed to see.
 * (Name, links, starter questions — never the raw career story etc.,
 *  which only ever exist inside the server-side system prompt.)
 * ------------------------------------------------------------------ */
app.get('/api/profile', (req, res) => {
  const links = profile.links || {};
  const publicLinks = {};
  for (const key of ['email', 'linkedin', 'github', 'portfolio', 'resume', 'twitter']) {
    if (links[key] && String(links[key]).trim() && !String(links[key]).startsWith('_')) {
      publicLinks[key] = links[key];
    }
  }
  res.json({
    name: profile.name || 'Your Name',
    preferredName: profile.preferredName || profile.name || 'the host',
    headline: profile.headline || '',
    tagline: profile.tagline || '',
    links: publicLinks,
    suggestedQuestions: Array.isArray(profile.suggestedQuestions)
      ? profile.suggestedQuestions.filter((q) => typeof q === 'string').slice(0, 8)
      : [],
    apiKeyConfigured: Boolean(GEMINI_API_KEY && GEMINI_API_KEY !== 'your_gemini_api_key_here')
  });
});

/* ------------------------------------------------------------------ *
 * GET /api/portfolio — richer public data used to render the portfolio
 * pages (Home / Projects / Experience). This is content you want shown
 * publicly on your site. Server-only grounding fields (careerStory,
 * personality, faqs) are deliberately NOT included here.
 * ------------------------------------------------------------------ */
function stripUnderscore(obj) {
  if (Array.isArray(obj)) return obj.map(stripUnderscore);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue;
      out[k] = stripUnderscore(v);
    }
    return out;
  }
  return obj;
}

app.get('/api/portfolio', (req, res) => {
  const p = profile;
  const links = {};
  const rawLinks = p.links || {};
  for (const key of ['email', 'linkedin', 'github', 'portfolio', 'resume', 'twitter']) {
    if (rawLinks[key] && String(rawLinks[key]).trim() && !String(rawLinks[key]).startsWith('_')) {
      links[key] = rawLinks[key];
    }
  }
  res.json({
    name: p.name || 'Your Name',
    preferredName: p.preferredName || p.name || 'me',
    headline: p.headline || '',
    tagline: p.tagline || '',
    location: p.location || '',
    availability: p.availability || '',
    bio: p.bio || '',
    links,
    skills: p.skills && typeof p.skills === 'object' ? stripUnderscore(p.skills) : {},
    experience: Array.isArray(p.experience) ? stripUnderscore(p.experience) : [],
    education: Array.isArray(p.education) ? stripUnderscore(p.education) : [],
    projects: Array.isArray(p.projects) ? stripUnderscore(p.projects) : [],
    achievements: Array.isArray(p.achievements)
      ? p.achievements.filter((a) => typeof a === 'string' && a.trim())
      : [],
    suggestedQuestions: Array.isArray(p.suggestedQuestions)
      ? p.suggestedQuestions.filter((q) => typeof q === 'string').slice(0, 8)
      : [],
    apiKeyConfigured: KEY_OK
  });
});

/* ------------------------------------------------------------------ *
 * POST /api/chat — the main endpoint.
 * Body: { mode: string, message: string, history: [{role, text}] }
 * ------------------------------------------------------------------ */
app.post('/api/chat', rateLimit, async (req, res) => {
  // Fail closed if the key isn't configured.
  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_gemini_api_key_here') {
    return res.status(503).json({
      error:
        'No Gemini API key is configured yet. Add GEMINI_API_KEY to your .env file (see .env.example) and restart the server.'
    });
  }

  const body = req.body || {};

  // --- Validate mode (allowlist) ---
  const mode = MODES.includes(body.mode) ? body.mode : 'ask_me';

  // --- Validate message ---
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return res.status(400).json({ error: 'Message cannot be empty.' });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return res
      .status(400)
      .json({ error: `Message is too long (max ${MAX_MESSAGE_CHARS} characters).` });
  }

  // --- Validate + sanitize history ---
  const rawHistory = Array.isArray(body.history) ? body.history : [];
  const history = rawHistory
    .filter(
      (turn) =>
        turn &&
        (turn.role === 'user' || turn.role === 'model') &&
        typeof turn.text === 'string' &&
        turn.text.trim().length > 0
    )
    .slice(-MAX_HISTORY_TURNS)
    .map((turn) => ({
      role: turn.role,
      parts: [{ text: turn.text.slice(0, MAX_TURN_CHARS) }]
    }));

  // --- Retrieve the most relevant profile chunks (RAG), then build the prompt ---
  // When the index is ready we embed the question, pull back only the top matches,
  // and ground the model on those. If retrieval isn't available (still building,
  // no key, or an error) we degrade gracefully to a compact whole-profile prompt
  // so the assistant still answers.
  let systemPrompt;
  let sources = [];
  let grounding = 'fallback';
  if (ragState === 'ready') {
    try {
      const retrieved = await rag.retrieve(message, { topK: mode === 'ask_me' ? 7 : 5 });
      systemPrompt = buildGroundedPrompt(profile, mode, retrieved);
      sources = retrieved.map((c) => ({
        type: c.type,
        title: c.title,
        score: Number(c.score.toFixed(3))
      }));
      grounding = 'rag';
    } catch (err) {
      console.error('[RAG] Retrieval failed; using whole-profile fallback:', err.message);
      systemPrompt = buildSystemPrompt(profile, mode);
    }
  } else {
    systemPrompt = buildSystemPrompt(profile, mode);
  }

  // --- Build the request for Gemini ---
  const contents = [...history, { role: 'user', parts: [{ text: message }] }];

  const payload = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      maxOutputTokens: 2048
    }
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const apiRes = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!apiRes.ok) {
      const detail = await safeReadError(apiRes);
      // Log the real detail server-side only.
      console.error(`[Gemini ${apiRes.status}]`, detail);
      return res.status(502).json({ error: friendlyApiError(apiRes.status, detail) });
    }

    const data = await apiRes.json();
    const reply = extractText(data);

    if (!reply) {
      const reason =
        data?.promptFeedback?.blockReason ||
        data?.candidates?.[0]?.finishReason ||
        'unknown';
      console.error('[Gemini] Empty reply. Reason:', reason, JSON.stringify(data).slice(0, 800));
      if (String(reason).toUpperCase().includes('SAFETY')) {
        return res.status(200).json({
          reply:
            "I can't respond to that one — it tripped the safety filter. Try rephrasing, and I'll do my best."
        });
      }
      return res.status(502).json({
        error: 'The model returned an empty response. Please try again.'
      });
    }

    return res.json({ reply, sources, grounding });
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[Gemini] Request timed out.');
      return res.status(504).json({ error: 'The request timed out. Please try again.' });
    }
    console.error('[Gemini] Network/other error:', err.message);
    return res.status(502).json({
      error: 'Could not reach the Gemini API. Check your internet connection and try again.'
    });
  }
});

// Health check — also reports retrieval status so you can confirm RAG is live.
app.get('/api/health', (req, res) =>
  res.json({
    ok: true,
    apiKeyConfigured: KEY_OK,
    model: GEMINI_MODEL,
    rag: { state: ragState, ...rag.stats() }
  })
);

/* ------------------------------------------------------------------ *
 * Helpers.
 * ------------------------------------------------------------------ */

function extractText(data) {
  const cand = data && data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  return parts
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim();
}

async function safeReadError(apiRes) {
  try {
    const json = await apiRes.json();
    return json?.error?.message || JSON.stringify(json).slice(0, 500);
  } catch {
    try {
      return (await apiRes.text()).slice(0, 500);
    } catch {
      return 'no error body';
    }
  }
}

function friendlyApiError(status, detail) {
  const d = (detail || '').toLowerCase();
  if (status === 400 && (d.includes('api key not valid') || d.includes('api_key_invalid'))) {
    return 'Your Gemini API key appears to be invalid. Double-check GEMINI_API_KEY in your .env file.';
  }
  if (status === 429) {
    return "You've hit the Gemini free-tier rate limit. Wait a minute and try again.";
  }
  if (status === 403) {
    return 'Access was denied by the Gemini API (403). Make sure your API key is enabled for the Generative Language API.';
  }
  if (status === 404) {
    return `The model "${GEMINI_MODEL}" was not found. Set a valid GEMINI_MODEL in your .env (e.g. gemini-3.6-flash).`;
  }
  return 'The Gemini API returned an error. Please try again in a moment.';
}

/**
 * The always-on "identity card": a small, cheap block of context included in
 * every prompt regardless of retrieval, so the assistant can always introduce
 * itself, sound like the right person, and share the right links. Facts that
 * answer questions (experience, projects, story, FAQs…) are NOT here — those come
 * from retrieval so we only pay for what's relevant to the question.
 */
function identityCard(p) {
  const name = p.name || 'the host';
  const preferred = p.preferredName || name;
  const lines = [];
  lines.push(
    `You are the personal AI of ${name} — think of yourself as ${preferred}'s warm, well-informed digital stand-in, speaking with visitors to ${preferred}'s personal site. ` +
      `When it feels natural you may speak in the first person as ${preferred} ("I built…"), but everything you say must be true to the grounded context you are given.`
  );
  lines.push('\n=== WHO YOU ARE ===');
  if (p.headline) lines.push(`Headline: ${p.headline}`);
  if (p.tagline) lines.push(`Tagline: ${p.tagline}`);
  if (p.location) lines.push(`Location: ${p.location}`);
  if (p.pronouns) lines.push(`Pronouns: ${p.pronouns}`);
  if (p.availability) lines.push(`Availability: ${p.availability}`);

  const links = p.links || {};
  const linkLines = Object.entries(links)
    .filter(([k, v]) => !k.startsWith('_') && v && String(v).trim())
    .map(([k, v]) => `  - ${k}: ${v}`);
  if (linkLines.length) lines.push('Contact & links (share naturally when relevant):\n' + linkLines.join('\n'));

  if (p.personality && typeof p.personality === 'object') {
    const per = p.personality;
    const bits = [];
    if (per.tone) bits.push(`Tone: ${per.tone}`);
    if (per.quirks) bits.push(`Quirks: ${per.quirks}`);
    if (per.values) bits.push(`Values: ${per.values}`);
    if (per.avoid) bits.push(`Avoid: ${per.avoid}`);
    if (bits.length) lines.push('\n=== VOICE & PERSONALITY ===\n' + bits.join('\n'));
  }
  return lines.join('\n');
}

/** The universal behavior rules, shared by the RAG and fallback prompts. */
function behaviorRulesLines(preferred) {
  return [
    `- Be accurate. Only state facts supported by the context you were given. If you don't know something about ${preferred}, say so honestly and point the person to the relevant link or email.`,
    '- Never invent jobs, dates, projects, or credentials. It is always better to say "I\'m not sure" than to guess.',
    '- Share the relevant link (LinkedIn, GitHub, portfolio, email) naturally whenever someone asks how to connect, hire, collaborate, or see the work. Weave it into the sentence; don\'t dump every link every time.',
    '- Keep replies conversational and reasonably concise. Use short paragraphs. Use a bulleted list only when it genuinely helps.',
    '- Match the personality above. Sound like a real person, not a brochure.',
    '- Your responses may be read aloud by a text-to-speech voice, so write in a way that sounds natural spoken: avoid tables, code blocks, and long URLs when a short phrase will do.'
  ];
}

/**
 * The grounded (RAG) prompt: identity card + ONLY the retrieved chunks + rules.
 * This is the primary path — the model sees the slice of the profile that is
 * actually relevant to the current question, not the whole file.
 */
function buildGroundedPrompt(p, mode, retrieved) {
  const preferred = p.preferredName || p.name || 'the host';
  const lines = [identityCard(p)];

  lines.push('\n=== RETRIEVED CONTEXT ===');
  lines.push(
    'The following are the most relevant excerpts from the profile for the current question, ' +
      'selected by semantic search. Treat them as your ground truth. If they do not contain the ' +
      'answer, say you are not certain rather than inventing details.'
  );
  retrieved.forEach((c, i) => {
    lines.push(`\n[${i + 1}] ${c.title}\n${c.text}`);
  });

  lines.push('\n=== HOW TO BEHAVE ===');
  lines.push(behaviorRulesLines(preferred).join('\n'));

  lines.push('\n=== CURRENT MODE ===');
  lines.push(modeInstructions(mode, preferred));

  return lines.join('\n');
}

/**
 * Turn the profile + selected mode into a single system prompt string.
 * Only non-underscore, non-empty fields are included so the template's
 * "_hint" keys never leak into the model context.
 *
 * This is the FALLBACK path, used when the retrieval index isn't ready yet
 * (first-run build in progress, no API key, or a build error). It injects a
 * compact version of the whole profile so the assistant still works.
 */
function buildSystemPrompt(p, mode) {
  const name = p.name || 'the host';
  const preferred = p.preferredName || name;
  const lines = [];

  lines.push(
    `You are the personal AI of ${name}. Think of yourself as ${preferred}'s warm, well-informed digital stand-in. ` +
      `You speak with visitors to ${preferred}'s personal site. When it feels natural you may speak in the first person as ${preferred} ("I built…"), but everything you say must be true to the profile below.`
  );

  lines.push('\n=== GROUND TRUTH: PROFILE OF ' + name.toUpperCase() + ' ===');
  if (p.headline) lines.push(`Headline: ${p.headline}`);
  if (p.tagline) lines.push(`Tagline: ${p.tagline}`);
  if (p.location) lines.push(`Location: ${p.location}`);
  if (p.pronouns) lines.push(`Pronouns: ${p.pronouns}`);
  if (p.availability) lines.push(`Availability: ${p.availability}`);
  if (p.bio) lines.push(`\nBio: ${p.bio}`);

  if (p.skills && typeof p.skills === 'object') {
    const skillLines = Object.entries(p.skills)
      .filter(([k, v]) => !k.startsWith('_') && Array.isArray(v) && v.length)
      .map(([k, v]) => `  - ${k}: ${v.join(', ')}`);
    if (skillLines.length) lines.push('\nSkills:\n' + skillLines.join('\n'));
  }

  if (Array.isArray(p.experience) && p.experience.length) {
    lines.push('\nExperience:');
    for (const job of p.experience) {
      if (!job || typeof job !== 'object') continue;
      const period = [job.start, job.end].filter(Boolean).join('–');
      lines.push(
        `  • ${[job.role, job.company].filter(Boolean).join(' @ ')}${
          period ? ` (${period})` : ''
        }${job.location ? `, ${job.location}` : ''}`
      );
      if (job.summary) lines.push(`      ${job.summary}`);
      if (Array.isArray(job.highlights)) {
        for (const h of job.highlights) if (h) lines.push(`      - ${h}`);
      }
    }
  }

  if (Array.isArray(p.education) && p.education.length) {
    lines.push('\nEducation:');
    for (const ed of p.education) {
      if (!ed || typeof ed !== 'object') continue;
      const period = [ed.start, ed.end].filter(Boolean).join('–');
      lines.push(
        `  • ${[ed.degree, ed.institution].filter(Boolean).join(', ')}${
          period ? ` (${period})` : ''
        }`
      );
      if (ed.notes) lines.push(`      ${ed.notes}`);
    }
  }

  if (Array.isArray(p.projects) && p.projects.length) {
    lines.push('\nProjects:');
    for (const proj of p.projects) {
      if (!proj || typeof proj !== 'object') continue;
      lines.push(
        `  • ${proj.name || 'Untitled'}${
          Array.isArray(proj.tech) && proj.tech.length ? ` [${proj.tech.join(', ')}]` : ''
        }${proj.link ? ` — ${proj.link}` : ''}`
      );
      if (proj.description) lines.push(`      ${proj.description}`);
    }
  }

  if (Array.isArray(p.achievements) && p.achievements.length) {
    const ach = p.achievements.filter((a) => typeof a === 'string' && a.trim());
    if (ach.length) lines.push('\nAchievements:\n' + ach.map((a) => `  - ${a}`).join('\n'));
  }

  if (p.careerStory) lines.push(`\nCareer story (in ${preferred}'s own words):\n${p.careerStory}`);

  if (Array.isArray(p.faqs) && p.faqs.length) {
    const faqLines = p.faqs
      .filter((f) => f && f.q && f.a)
      .map((f) => `  Q: ${f.q}\n  A: ${f.a}`);
    if (faqLines.length) lines.push('\nPre-written FAQ answers to prefer when relevant:\n' + faqLines.join('\n'));
  }

  const links = p.links || {};
  const linkLines = Object.entries(links)
    .filter(([k, v]) => !k.startsWith('_') && v && String(v).trim())
    .map(([k, v]) => `  - ${k}: ${v}`);
  if (linkLines.length) lines.push('\nContact & links:\n' + linkLines.join('\n'));

  if (p.personality && typeof p.personality === 'object') {
    const per = p.personality;
    lines.push('\n=== VOICE & PERSONALITY ===');
    if (per.tone) lines.push(`Tone: ${per.tone}`);
    if (per.quirks) lines.push(`Quirks: ${per.quirks}`);
    if (per.values) lines.push(`Values: ${per.values}`);
    if (per.avoid) lines.push(`Avoid: ${per.avoid}`);
  }

  // Universal grounding rules (shared with the RAG prompt).
  lines.push('\n=== HOW TO BEHAVE ===');
  lines.push(behaviorRulesLines(preferred).join('\n'));

  // Mode-specific instructions.
  lines.push('\n=== CURRENT MODE ===');
  lines.push(modeInstructions(mode, preferred));

  return lines.join('\n');
}

function modeInstructions(mode, preferred) {
  switch (mode) {
    case 'roadmap':
      return [
        'MODE: CAREER ROADMAP.',
        `The visitor wants a personalized career roadmap. Draw on ${preferred}'s own journey and experience as grounding and inspiration.`,
        'Step 1 — If you are missing information you truly need (their current role/level, target role, timeline, location or constraints, existing skills), ask 2–4 focused clarifying questions FIRST and stop there. Do not pad with a generic roadmap before you have the basics.',
        'Step 2 — Once you have enough, produce a structured, personalized roadmap with these sections:',
        '   • Where you are now (a one-paragraph honest read of their starting point).',
        '   • Short term (next 0–3 months): concrete, checkable actions.',
        '   • Medium term (3–12 months): skills to build, projects to ship, systems/patterns to learn.',
        '   • Long term (1–3 years): the trajectory and the senior/target-role competencies to grow into.',
        '   • Skill gaps: what to close, honestly.',
        '   • Project ideas: 2–4 portfolio-worthy projects tailored to their goal.',
        'Default to Software Engineering framing, but adapt fully if their goal is a different field.',
        'Be specific and realistic. Prefer concrete resources/skills over vague encouragement.'
      ].join('\n');
    case 'mentor':
      return [
        'MODE: MENTOR.',
        `Give grounded, honest career and life advice as a mentor would, drawing on ${preferred}'s real career story, mistakes, and lessons above.`,
        'Be warm but candid. Share relevant lived experience from the career story when it applies. Ask a clarifying question when the situation is unclear rather than giving generic advice. It is okay to gently challenge assumptions.'
      ].join('\n');
    case 'friend':
      return [
        'MODE: JUST CHAT (FRIEND).',
        `Be a warm, easygoing friend. Casual, curious, and human — banter, ask questions back, react. This is a conversation, not a Q&A or an interview.`,
        `You can still draw on ${preferred}'s personality and interests, but you don't need to steer everything back to career or credentials. Keep it light and genuine.`
      ].join('\n');
    case 'ask_me':
    default:
      return [
        'MODE: ASK ABOUT ME.',
        `Answer the visitor's questions about ${preferred} — background, skills, experience, projects, education, availability — accurately and warmly, using only the profile above.`,
        'Keep answers focused and friendly. When someone asks how to reach or hire you, share the right link naturally.'
      ].join('\n');
  }
}

/* ------------------------------------------------------------------ *
 * Start.
 * ------------------------------------------------------------------ */
app.listen(PORT, () => {
  const embedModel = (process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001').trim();
  console.log('\n  Personal AI Console  ·  RAG-powered');
  console.log('  ──────────────────────────────────');
  console.log(`  ▸ Running at   http://localhost:${PORT}`);
  console.log(`  ▸ Profile      data/profile.json  (name: ${profile.name || 'unset'})`);
  console.log(`  ▸ Chat model   ${GEMINI_MODEL}`);
  console.log(`  ▸ Embeddings   ${embedModel}`);
  console.log(`  ▸ API key      ${KEY_OK ? 'configured ✓' : 'MISSING ✗  → add it to .env'}`);

  // Load or build the retrieval index (prints its own status line).
  prepareKnowledgeBase();

  if (!KEY_OK) {
    console.log('\n  The app will load, but chats and retrieval need a key. Add GEMINI_API_KEY to .env.');
  }
  console.log('');
});
