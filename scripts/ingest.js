/**
 * scripts/ingest.js
 * -----------------
 * Builds (or rebuilds) the RAG knowledge base from data/profile.json.
 *
 * Run it with:   npm run ingest
 *
 * You normally don't have to run this by hand — the server auto-builds the
 * knowledge base on startup whenever it detects that profile.json has changed.
 * But running it explicitly is handy after a big profile edit, or to see the
 * chunk breakdown and confirm your API key works.
 */

'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const rag = require('../lib/rag');

const PROFILE_PATH = path.join(__dirname, '..', 'data', 'profile.json');

async function main() {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === 'your_gemini_api_key_here') {
    console.error('\n[ingest] No GEMINI_API_KEY found.');
    console.error('         Copy .env.example to .env and add your key, then run again.\n');
    process.exit(1);
  }

  let profile;
  try {
    profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
  } catch (err) {
    console.error('\n[ingest] Could not read data/profile.json — is it valid JSON?');
    console.error('         Details:', err.message, '\n');
    process.exit(1);
  }

  console.log('\n  Building knowledge base from data/profile.json …');
  console.log('  (embedding with', (process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001') + ')\n');

  const started = Date.now();
  try {
    const kb = await rag.buildKnowledgeBase(profile, (msg) => console.log(msg));
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`\n  ✓ Knowledge base written to data/knowledge-base.json`);
    console.log(`    ${kb.chunks.length} chunks · ${kb.dim} dims · ${secs}s\n`);
  } catch (err) {
    console.error('\n  ✗ Ingest failed:', err.message);
    if (err.code === 'NO_API_KEY') {
      console.error('    Add GEMINI_API_KEY to your .env file.');
    } else if (err.status === 429) {
      console.error('    You hit the free-tier rate limit. Wait a minute and try again.');
    } else if (err.status === 403) {
      console.error('    The key was rejected. Make sure the Generative Language API is enabled for it.');
    }
    console.error('');
    process.exit(1);
  }
}

main();
