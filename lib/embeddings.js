/**
 * lib/embeddings.js
 * -----------------
 * Thin wrapper around Google's Gemini embedding model (gemini-embedding-001).
 *
 * This is the "vectorize" half of the RAG system: it turns a piece of text into
 * a numeric vector so we can measure how semantically similar two texts are.
 *
 * Two things matter for retrieval quality and are handled here:
 *   1. taskType — the model embeds a *document to be stored* differently from a
 *      *question being asked*. We use RETRIEVAL_DOCUMENT when indexing the profile
 *      and RETRIEVAL_QUERY when embedding the visitor's question.
 *   2. L2 normalization — Google requires vectors shorter than 3072 dims to be
 *      normalized manually. We normalize everything, which also lets us treat the
 *      dot product of two vectors as their cosine similarity.
 *
 * No secrets live here: the API key is read from the environment by the caller
 * and passed in, or read from process.env at call time. It is never logged.
 */

'use strict';

const EMBED_MODEL = (process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001').trim();
const EMBED_DIM = clampDim(Number(process.env.EMBED_DIM) || 768);
const EMBED_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
  EMBED_MODEL
)}:embedContent`;

const REQUEST_TIMEOUT_MS = 30000;

function clampDim(d) {
  // gemini-embedding-001 supports 128–3072; we recommend 768/1536/3072.
  if (!Number.isFinite(d)) return 768;
  return Math.min(3072, Math.max(128, Math.round(d)));
}

function apiKey() {
  const k = process.env.GEMINI_API_KEY;
  if (!k || k === 'your_gemini_api_key_here') {
    const err = new Error('GEMINI_API_KEY is not configured.');
    err.code = 'NO_API_KEY';
    throw err;
  }
  return k;
}

/**
 * L2-normalize a vector in place-safe fashion (returns a new array).
 * After this, cosineSimilarity(a, b) === dotProduct(a, b).
 */
function l2normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const mag = Math.sqrt(sum);
  if (!mag) return vec.slice();
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / mag;
  return out;
}

/** Dot product — equals cosine similarity for L2-normalized vectors. */
function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * Embed a single piece of text.
 * @param {string} text
 * @param {object} opts
 * @param {'RETRIEVAL_DOCUMENT'|'RETRIEVAL_QUERY'|'SEMANTIC_SIMILARITY'} opts.taskType
 * @param {string} [opts.title]  Optional title (only used for RETRIEVAL_DOCUMENT; improves quality).
 * @returns {Promise<number[]>} an L2-normalized embedding vector
 */
async function embedText(text, opts = {}) {
  const taskType = opts.taskType || 'RETRIEVAL_DOCUMENT';
  const clean = String(text || '').slice(0, 8000); // stay well under the model's input limit
  if (!clean.trim()) throw new Error('Cannot embed empty text.');

  const body = {
    model: `models/${EMBED_MODEL}`,
    content: { parts: [{ text: clean }] },
    taskType,
    outputDimensionality: EMBED_DIM
  };
  // A title only helps (and is only accepted) for documents being stored.
  if (taskType === 'RETRIEVAL_DOCUMENT' && opts.title) {
    body.title = String(opts.title).slice(0, 200);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let apiRes;
  try {
    apiRes = await fetch(EMBED_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey()
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!apiRes.ok) {
    let detail = '';
    try {
      const j = await apiRes.json();
      detail = j?.error?.message || '';
    } catch {
      /* ignore parse errors */
    }
    const err = new Error(`Embedding request failed (${apiRes.status}). ${detail}`.trim());
    err.status = apiRes.status;
    throw err;
  }

  const data = await apiRes.json();
  const values = data?.embedding?.values;
  if (!Array.isArray(values) || !values.length) {
    throw new Error('Embedding response did not contain a vector.');
  }
  return l2normalize(values);
}

module.exports = {
  embedText,
  l2normalize,
  dot,
  EMBED_MODEL,
  EMBED_DIM
};
