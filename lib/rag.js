/**
 * lib/rag.js
 * ----------
 * The retrieval engine — the heart of the RAG (Retrieval-Augmented Generation)
 * system.
 *
 * Pipeline:
 *   INGEST (once, or whenever the profile changes)
 *     profile.json → chunkProfile() → embedText(RETRIEVAL_DOCUMENT) for each chunk
 *                  → save vectors to data/knowledge-base.json
 *
 *   QUERY (every chat message)
 *     question → embedText(RETRIEVAL_QUERY) → cosine-similarity vs every stored
 *              chunk → return the top-K most relevant chunks → those (and only
 *              those) are injected into the model's prompt.
 *
 * The knowledge base is stored on disk so we don't re-embed on every restart,
 * and it's stamped with a hash of the profile so we can tell when it's stale and
 * needs rebuilding. Embeddings for unchanged chunks are reused to save API calls.
 *
 * Security / privacy notes:
 *   - The knowledge base contains your personal data (as vectors + the source
 *     text). It stays on your machine and is git-ignored. It is never sent to the
 *     browser — only the small text of the *retrieved* chunks reaches the model,
 *     server-side.
 *   - We never log chunk contents; only counts and generic type labels.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { embedText, dot, EMBED_MODEL, EMBED_DIM } = require('./embeddings');
const { chunkProfile } = require('./chunker');

const KB_PATH = path.join(__dirname, '..', 'data', 'knowledge-base.json');
const KB_VERSION = 1;

const TOP_K = Math.max(1, Number(process.env.RAG_TOP_K) || 6);
const MIN_SCORE = Number.isFinite(Number(process.env.RAG_MIN_SCORE))
  ? Number(process.env.RAG_MIN_SCORE)
  : 0.15;

// In-memory index (loaded from disk or freshly built).
let index = null; // { version, model, dim, profileHash, createdAt, chunks: [{id,type,title,text,values}] }

/* ------------------------------------------------------------------ *
 * Small utilities.
 * ------------------------------------------------------------------ */
function hashProfile(profile) {
  // Hash the meaningful content, not formatting, so re-saving with different
  // whitespace doesn't force a rebuild.
  return crypto.createHash('sha256').update(JSON.stringify(profile)).digest('hex');
}

function readKbFile() {
  try {
    const raw = fs.readFileSync(KB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeKbFile(kb) {
  fs.writeFileSync(KB_PATH, JSON.stringify(kb), 'utf8');
}

/** Is a saved KB usable for this profile + embedding config? */
function isFresh(kb, profile) {
  return (
    kb &&
    kb.version === KB_VERSION &&
    kb.model === EMBED_MODEL &&
    kb.dim === EMBED_DIM &&
    kb.profileHash === hashProfile(profile) &&
    Array.isArray(kb.chunks) &&
    kb.chunks.length > 0
  );
}

/* ------------------------------------------------------------------ *
 * Build the knowledge base (the ingest step).
 * ------------------------------------------------------------------ */
/**
 * Embed every chunk of the profile and persist the result.
 * Reuses existing vectors for chunks whose text is unchanged.
 *
 * @param {object} profile
 * @param {(msg:string)=>void} [log]  optional progress callback (no personal data)
 * @returns {Promise<object>} the built knowledge base
 */
async function buildKnowledgeBase(profile, log = () => {}) {
  const chunks = chunkProfile(profile);
  if (!chunks.length) {
    throw new Error(
      'No content to index. Fill in data/profile.json (bio, experience, projects, etc.) before ingesting.'
    );
  }

  // Reuse cache: map of text-hash → vector from any existing KB.
  const prior = readKbFile();
  const reuse = new Map();
  if (prior && prior.model === EMBED_MODEL && prior.dim === EMBED_DIM && Array.isArray(prior.chunks)) {
    for (const c of prior.chunks) {
      if (c && typeof c.text === 'string' && Array.isArray(c.values)) {
        reuse.set(textHash(c.text), c.values);
      }
    }
  }

  const built = [];
  let embedded = 0;
  let reused = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const h = textHash(c.text);
    const cached = reuse.get(h);
    let values;
    if (cached) {
      values = cached;
      reused++;
    } else {
      values = await embedText(c.text, { taskType: 'RETRIEVAL_DOCUMENT', title: c.title });
      embedded++;
      // Be gentle with the free-tier rate limit when embedding many new chunks.
      if (embedded % 8 === 0) await sleep(250);
    }
    built.push({ id: c.id, type: c.type, title: c.title, text: c.text, values });
    log(`  [${i + 1}/${chunks.length}] ${c.type} ${cached ? '(cached)' : 'embedded'}`);
  }

  const kb = {
    version: KB_VERSION,
    model: EMBED_MODEL,
    dim: EMBED_DIM,
    profileHash: hashProfile(profile),
    createdAt: new Date().toISOString(),
    chunks: built
  };
  writeKbFile(kb);
  index = kb;
  log(`  Done: ${embedded} embedded, ${reused} reused, ${built.length} total chunks.`);
  return kb;
}

function textHash(t) {
  return crypto.createHash('sha1').update(String(t)).digest('hex');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ *
 * Load into memory (used at server startup).
 * ------------------------------------------------------------------ */
/**
 * Try to load a fresh KB from disk. Returns true if an in-memory index is ready.
 */
function loadIfFresh(profile) {
  const kb = readKbFile();
  if (isFresh(kb, profile)) {
    index = kb;
    return true;
  }
  return false;
}

function isReady() {
  return Boolean(index && Array.isArray(index.chunks) && index.chunks.length);
}

function stats() {
  if (!isReady()) return { ready: false, chunks: 0, model: EMBED_MODEL, dim: EMBED_DIM };
  return {
    ready: true,
    chunks: index.chunks.length,
    model: index.model,
    dim: index.dim,
    createdAt: index.createdAt
  };
}

/* ------------------------------------------------------------------ *
 * Retrieve (the query step).
 * ------------------------------------------------------------------ */
/**
 * Embed the query and return the most relevant chunks.
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.topK]
 * @param {number} [opts.minScore]
 * @returns {Promise<Array<{id,type,title,text,score}>>}
 */
async function retrieve(query, opts = {}) {
  if (!isReady()) throw new Error('Knowledge base is not ready.');
  const topK = Math.max(1, opts.topK || TOP_K);
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : MIN_SCORE;

  const qVec = await embedText(query, { taskType: 'RETRIEVAL_QUERY' });

  const scored = index.chunks.map((c) => ({
    id: c.id,
    type: c.type,
    title: c.title,
    text: c.text,
    score: dot(qVec, c.values) // cosine similarity (vectors are L2-normalized)
  }));

  scored.sort((a, b) => b.score - a.score);

  // Keep the top-K, then drop anything clearly irrelevant — but always return at
  // least the single best match so the model has something to work with.
  const top = scored.slice(0, topK);
  const filtered = top.filter((c) => c.score >= minScore);
  return filtered.length ? filtered : top.slice(0, 1);
}

module.exports = {
  buildKnowledgeBase,
  loadIfFresh,
  retrieve,
  isReady,
  stats,
  hashProfile,
  KB_PATH,
  TOP_K
};
