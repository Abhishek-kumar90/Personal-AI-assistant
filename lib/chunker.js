/**
 * lib/chunker.js
 * --------------
 * Turns the structured profile (data/profile.json) into a flat list of small,
 * self-contained text "chunks" — the documents that get embedded and retrieved.
 *
 * Why chunk at all? RAG retrieves *pieces*, not the whole file. If we embedded
 * the entire profile as one blob, every question would match it equally and
 * retrieval would be meaningless. By splitting into one chunk per job, per
 * project, per FAQ, etc., a question like "what did you build at Acme?" can pull
 * back exactly the Acme experience chunk and ignore the rest.
 *
 * Each chunk is written as natural prose (not raw JSON) because embedding models
 * understand sentences far better than braces and keys.
 *
 * Any key beginning with "_" (the template's _README / _hint_* helper keys) is
 * ignored, and empty fields are skipped, so placeholder scaffolding never becomes
 * a chunk.
 */

'use strict';

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const clean = (v) => String(v).trim();

/**
 * @param {object} p  the parsed profile
 * @returns {Array<{id:string, type:string, title:string, text:string}>}
 */
function chunkProfile(p) {
  const chunks = [];
  const name = isStr(p.name) ? clean(p.name) : 'The host';
  const preferred = isStr(p.preferredName) ? clean(p.preferredName) : name;

  const push = (type, title, text) => {
    const t = clean(text);
    if (t) chunks.push({ id: `${type}-${chunks.length}`, type, title, text: t });
  };

  // --- Bio / overview ---
  if (isStr(p.bio)) {
    push('bio', `About ${preferred}`, `About ${name}. ${clean(p.bio)}`);
  }
  const overviewBits = [];
  if (isStr(p.headline)) overviewBits.push(`Headline: ${clean(p.headline)}`);
  if (isStr(p.tagline)) overviewBits.push(`Tagline: ${clean(p.tagline)}`);
  if (isStr(p.location)) overviewBits.push(`Based in ${clean(p.location)}`);
  if (isStr(p.availability)) overviewBits.push(`Availability: ${clean(p.availability)}`);
  if (overviewBits.length) {
    push('overview', `${preferred} at a glance`, `${name} — ${overviewBits.join('. ')}.`);
  }

  // --- Skills (one chunk per group so "do you know React?" hits the frontend group) ---
  if (p.skills && typeof p.skills === 'object') {
    for (const [group, list] of Object.entries(p.skills)) {
      if (group.startsWith('_') || !Array.isArray(list)) continue;
      const items = list.filter(isStr).map(clean);
      if (!items.length) continue;
      push(
        'skills',
        `Skills — ${group}`,
        `${preferred}'s skills in ${group}: ${items.join(', ')}.`
      );
    }
  }

  // --- Experience (one chunk per role) ---
  if (Array.isArray(p.experience)) {
    for (const job of p.experience) {
      if (!job || typeof job !== 'object') continue;
      const role = isStr(job.role) ? clean(job.role) : '';
      const company = isStr(job.company) ? clean(job.company) : '';
      if (!role && !company) continue;
      const period = [job.start, job.end].filter(isStr).map(clean).join(' to ');
      const header = [role, company].filter(Boolean).join(' at ');
      const parts = [`${preferred}'s experience: ${header}${period ? ` (${period})` : ''}.`];
      if (isStr(job.location)) parts.push(`Location: ${clean(job.location)}.`);
      if (isStr(job.summary)) parts.push(clean(job.summary));
      if (Array.isArray(job.highlights)) {
        const hs = job.highlights.filter(isStr).map((h) => `- ${clean(h)}`);
        if (hs.length) parts.push('Highlights:\n' + hs.join('\n'));
      }
      push('experience', header, parts.join('\n'));
    }
  }

  // --- Projects (one chunk per project) ---
  if (Array.isArray(p.projects)) {
    for (const proj of p.projects) {
      if (!proj || typeof proj !== 'object') continue;
      const pname = isStr(proj.name) ? clean(proj.name) : '';
      if (!pname) continue;
      const parts = [`Project by ${preferred}: ${pname}.`];
      if (isStr(proj.description)) parts.push(clean(proj.description));
      if (Array.isArray(proj.tech)) {
        const tech = proj.tech.filter(isStr).map(clean);
        if (tech.length) parts.push(`Built with: ${tech.join(', ')}.`);
      }
      if (isStr(proj.link)) parts.push(`Link: ${clean(proj.link)}`);
      push('project', pname, parts.join('\n'));
    }
  }

  // --- Education (one chunk per entry) ---
  if (Array.isArray(p.education)) {
    for (const ed of p.education) {
      if (!ed || typeof ed !== 'object') continue;
      const degree = isStr(ed.degree) ? clean(ed.degree) : '';
      const inst = isStr(ed.institution) ? clean(ed.institution) : '';
      if (!degree && !inst) continue;
      const period = [ed.start, ed.end].filter(isStr).map(clean).join(' to ');
      const header = [degree, inst].filter(Boolean).join(', ');
      const parts = [`${preferred}'s education: ${header}${period ? ` (${period})` : ''}.`];
      if (isStr(ed.notes)) parts.push(clean(ed.notes));
      push('education', header, parts.join('\n'));
    }
  }

  // --- Achievements (grouped into one chunk) ---
  if (Array.isArray(p.achievements)) {
    const ach = p.achievements.filter(isStr).map((a) => `- ${clean(a)}`);
    if (ach.length) {
      push('achievements', `${preferred}'s achievements`, `Achievements and recognition:\n${ach.join('\n')}`);
    }
  }

  // --- Career story (split into paragraphs so long stories retrieve granularly) ---
  if (isStr(p.careerStory)) {
    const paras = clean(p.careerStory)
      .split(/\n\s*\n/)
      .map(clean)
      .filter(Boolean);
    if (paras.length <= 1) {
      push('career_story', `${preferred}'s career story`, `Career story, in ${preferred}'s own words: ${clean(p.careerStory)}`);
    } else {
      paras.forEach((para, i) =>
        push('career_story', `${preferred}'s career story (part ${i + 1})`, `Career story (part ${i + 1}): ${para}`)
      );
    }
  }

  // --- FAQs (one chunk per Q/A) ---
  if (Array.isArray(p.faqs)) {
    for (const f of p.faqs) {
      if (!f || !isStr(f.q) || !isStr(f.a)) continue;
      push('faq', clean(f.q), `Frequently asked — Q: ${clean(f.q)}\nA: ${clean(f.a)}`);
    }
  }

  return chunks;
}

module.exports = { chunkProfile };
