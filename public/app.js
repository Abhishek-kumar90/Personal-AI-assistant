/* =====================================================================
   Personal AI Portfolio — frontend logic
   - Multi-page (hash router): Home / Projects / Experience / Chat
   - Talks only to our own backend (/api/*), never to Gemini directly.
   - Model output is rendered as text nodes (never innerHTML).
   - Voice mode uses the browser's built-in Web Speech API (free) and is
     reachable from the nav, the home hero, and the chat composer.
   ===================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /* ---------- element handles ---------- */
  const navName = $('navName');
  const navLinks = Array.from(document.querySelectorAll('.navlink'));
  const talkBtn = $('talkBtn');
  const heroOrb = $('heroOrb');

  const stream = $('stream');
  const composer = $('composer');
  const input = $('input');
  const sendBtn = $('sendBtn');
  const voiceBtn = $('voiceBtn');
  const modeButtons = Array.from(document.querySelectorAll('.pill'));

  const voiceOverlay = $('voice');
  const voiceClose = $('voiceClose');
  const voiceTap = $('voiceTap');
  const voiceStage = document.querySelector('.voice__stage');
  const bigOrb = $('bigOrb');
  const voiceStatus = $('voiceStatus');
  const voiceTranscript = $('voiceTranscript');
  const toastEl = $('toast');

  /* ---------- state ---------- */
  let data = { preferredName: 'there', name: 'there', links: {}, suggestedQuestions: [] };
  let currentMode = 'ask_me';
  let history = [];
  let busy = false;
  let greetedFor = null;

  /* =================================================================
     ROUTER
     ================================================================= */
  const PAGES = ['home', 'projects', 'experience', 'chat'];

  function showPage(name) {
    if (!PAGES.includes(name)) name = 'home';
    PAGES.forEach((pg) => {
      const sec = $('page-' + pg);
      if (sec) {
        sec.hidden = pg !== name;
        sec.classList.toggle('is-active', pg === name);
      }
    });
    navLinks.forEach((a) => {
      const on = a.dataset.page === name;
      a.classList.toggle('is-active', on);
    });
    if (name === 'chat') {
      ensureGreeting();
      setTimeout(() => input && input.focus(), 40);
    }
    window.scrollTo(0, 0);
  }

  function routeFromHash() {
    const raw = (location.hash || '').replace(/^#\/?/, '').trim();
    showPage(raw || 'home');
  }
  window.addEventListener('hashchange', routeFromHash);

  /* =================================================================
     PORTFOLIO RENDERING
     ================================================================= */
  function renderLinksInto(nav, links, cls) {
    nav.textContent = '';
    const labels = {
      email: 'Email',
      linkedin: 'LinkedIn',
      github: 'GitHub',
      portfolio: 'Portfolio',
      resume: 'Résumé',
      twitter: 'Twitter'
    };
    Object.keys(labels).forEach((key) => {
      const val = links && links[key];
      if (!val) return;
      const a = document.createElement('a');
      a.className = cls;
      a.textContent = labels[key];
      a.href = key === 'email' ? 'mailto:' + val : val;
      if (key !== 'email') {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      nav.appendChild(a);
    });
  }

  function renderHome() {
    navName.textContent = data.name || 'Personal AI';
    $('heroName').textContent = data.name || 'Hello';
    $('heroHeadline').textContent = data.headline || '';
    $('heroTagline').textContent = data.tagline || data.bio || '';
    const avail = [data.location, data.availability].filter(Boolean).join(' · ');
    $('heroAvailability').textContent = avail;
    renderLinksInto($('heroLinks'), data.links, 'linkchip');
  }

  function renderProjects() {
    const grid = $('projectGrid');
    grid.textContent = '';
    const projects = Array.isArray(data.projects) ? data.projects : [];
    if (!projects.length) {
      const empty = document.createElement('p');
      empty.className = 'section-sub';
      empty.textContent = 'No projects added yet — add some in data/profile.json.';
      grid.appendChild(empty);
      return;
    }
    projects.forEach((proj) => {
      if (!proj || !proj.name) return;
      const card = document.createElement('article');
      card.className = 'project-card';

      const h = document.createElement('h3');
      h.className = 'project-card__name';
      h.textContent = proj.name;
      card.appendChild(h);

      if (proj.description) {
        const d = document.createElement('p');
        d.className = 'project-card__desc';
        d.textContent = proj.description;
        card.appendChild(d);
      }

      if (Array.isArray(proj.tech) && proj.tech.length) {
        const tech = document.createElement('div');
        tech.className = 'project-card__tech';
        proj.tech.forEach((t) => {
          if (!t) return;
          const chip = document.createElement('span');
          chip.className = 'tech-chip';
          chip.textContent = t;
          tech.appendChild(chip);
        });
        card.appendChild(tech);
      }

      if (proj.link) {
        const a = document.createElement('a');
        a.className = 'project-card__link';
        a.textContent = 'View project →';
        a.href = proj.link;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        card.appendChild(a);
      }
      grid.appendChild(card);
    });
  }

  function tlItem(role, at, period, summary, highlights) {
    const item = document.createElement('div');
    item.className = 'tl-item';

    const head = document.createElement('div');
    head.className = 'tl-item__head';
    const r = document.createElement('span');
    r.className = 'tl-item__role';
    r.textContent = role;
    head.appendChild(r);
    if (at) {
      const a = document.createElement('span');
      a.className = 'tl-item__at';
      a.textContent = at;
      head.appendChild(a);
    }
    if (period) {
      const p = document.createElement('span');
      p.className = 'tl-item__period';
      p.textContent = period;
      head.appendChild(p);
    }
    item.appendChild(head);

    if (summary) {
      const s = document.createElement('p');
      s.className = 'tl-item__summary';
      s.textContent = summary;
      item.appendChild(s);
    }
    if (Array.isArray(highlights) && highlights.length) {
      const ul = document.createElement('ul');
      ul.className = 'tl-item__highlights';
      highlights.forEach((h) => {
        if (!h) return;
        const li = document.createElement('li');
        li.textContent = h;
        ul.appendChild(li);
      });
      item.appendChild(ul);
    }
    return item;
  }

  function renderExperience() {
    const tl = $('timeline');
    tl.textContent = '';
    const jobs = Array.isArray(data.experience) ? data.experience : [];
    if (!jobs.length) {
      const empty = document.createElement('p');
      empty.className = 'section-sub';
      empty.textContent = 'No experience added yet — add some in data/profile.json.';
      tl.appendChild(empty);
    } else {
      jobs.forEach((job) => {
        if (!job) return;
        const at = job.company ? '@ ' + job.company : '';
        const period = [job.start, job.end].filter(Boolean).join(' – ');
        tl.appendChild(tlItem(job.role || 'Role', at, period, job.summary, job.highlights));
      });
    }

    // Education
    const edu = Array.isArray(data.education) ? data.education : [];
    const eduSection = $('eduSection');
    const eduTl = $('eduTimeline');
    eduTl.textContent = '';
    if (edu.length) {
      eduSection.hidden = false;
      edu.forEach((ed) => {
        if (!ed) return;
        const at = ed.institution ? '· ' + ed.institution : '';
        const period = [ed.start, ed.end].filter(Boolean).join(' – ');
        eduTl.appendChild(tlItem(ed.degree || 'Studies', at, period, ed.notes, null));
      });
    } else {
      eduSection.hidden = true;
    }

    // Skills
    const skills = data.skills && typeof data.skills === 'object' ? data.skills : {};
    const groups = Object.keys(skills).filter((k) => Array.isArray(skills[k]) && skills[k].length);
    const skillsSection = $('skillsSection');
    const wrap = $('skillGroups');
    wrap.textContent = '';
    if (groups.length) {
      skillsSection.hidden = false;
      groups.forEach((g) => {
        const box = document.createElement('div');
        box.className = 'skillgroup';
        const name = document.createElement('h4');
        name.className = 'skillgroup__name';
        name.textContent = g;
        box.appendChild(name);
        const chips = document.createElement('div');
        chips.className = 'skillgroup__chips';
        skills[g].forEach((s) => {
          if (!s) return;
          const chip = document.createElement('span');
          chip.className = 'tech-chip';
          chip.textContent = s;
          chips.appendChild(chip);
        });
        box.appendChild(chips);
        wrap.appendChild(box);
      });
    } else {
      skillsSection.hidden = true;
    }
  }

  /* =================================================================
     CHAT — greeting, safe rendering, send
     ================================================================= */
  function modeGreeting(mode) {
    const who = data.preferredName || 'me';
    switch (mode) {
      case 'roadmap':
        return {
          lead: 'Let’s map your path.',
          sub: 'Tell me where you are and where you want to go — your background, current role or studies, and your target. I’ll ask a couple of questions, then build you a personalized roadmap.',
          chips: [
            'I’m a CS student aiming for backend roles',
            'Self-taught dev trying to land a first job',
            'Help me go from mid-level to senior',
            'I want to switch careers into software'
          ]
        };
      case 'friend':
        return {
          lead: 'Hey — how’s it going?',
          sub: 'No agenda here. Let’s just talk.',
          chips: ['What are you into lately?', 'Tell me something fun', 'I had a rough day']
        };
      case 'ask_me':
      default:
        return {
          lead: `Hi, I’m ${who}.`,
          sub: 'Ask me anything about my background, projects, experience, or how to get in touch. Tap the orb any time to talk instead of type.',
          chips:
            data.suggestedQuestions && data.suggestedQuestions.length
              ? data.suggestedQuestions
              : ['What do you do?', 'What are you best at?', 'How can I reach you?']
        };
    }
  }

  function renderGreeting() {
    const g = modeGreeting(currentMode);
    stream.textContent = '';
    const block = document.createElement('div');
    block.className = 'greeting';

    const lead = document.createElement('h2');
    lead.className = 'greeting__lead';
    lead.textContent = g.lead;

    const sub = document.createElement('p');
    sub.className = 'greeting__sub';
    sub.textContent = g.sub;

    const chips = document.createElement('div');
    chips.className = 'chips';
    (g.chips || []).slice(0, 6).forEach((q) => {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'chip';
      c.textContent = q;
      c.addEventListener('click', () => { if (!busy) send(q); });
      chips.appendChild(c);
    });

    block.appendChild(lead);
    block.appendChild(sub);
    block.appendChild(chips);
    stream.appendChild(block);
    greetedFor = currentMode;
  }

  function ensureGreeting() {
    if (!stream.children.length) renderGreeting();
  }

  /* ---- safe rich text ---- */
  function appendInline(parent, text, bold) {
    const re = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|([\w.+-]+@[\w-]+\.[\w.-]+)/g;
    let last = 0;
    let m;
    const attach = (node) => {
      if (bold) {
        const b = document.createElement('strong');
        b.appendChild(node);
        parent.appendChild(b);
      } else parent.appendChild(node);
    };
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) attach(document.createTextNode(text.slice(last, m.index)));
      const raw = m[0];
      const a = document.createElement('a');
      if (m[2]) a.href = 'mailto:' + raw;
      else {
        a.href = raw;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      a.textContent = raw;
      attach(a);
      last = m.index + raw.length;
    }
    if (last < text.length) attach(document.createTextNode(text.slice(last)));
  }
  function renderInline(parent, text) {
    text.split(/\*\*(.+?)\*\*/g).forEach((chunk, i) => {
      if (chunk) appendInline(parent, chunk, i % 2 === 1);
    });
  }
  function renderRich(container, text) {
    container.textContent = '';
    String(text).replace(/\r\n/g, '\n').split(/\n{2,}/).forEach((block) => {
      const lines = block.split('\n');
      const nonEmpty = lines.filter((l) => l.trim());
      const bullets = lines.filter((l) => /^\s*[-*]\s+/.test(l));
      if (nonEmpty.length && bullets.length === nonEmpty.length) {
        const ul = document.createElement('ul');
        bullets.forEach((l) => {
          const li = document.createElement('li');
          renderInline(li, l.replace(/^\s*[-*]\s+/, ''));
          ul.appendChild(li);
        });
        container.appendChild(ul);
      } else {
        const p = document.createElement('p');
        lines.forEach((l, idx) => {
          if (idx > 0) p.appendChild(document.createElement('br'));
          renderInline(p, l);
        });
        container.appendChild(p);
      }
    });
  }

  function addMessage(role, text, sources) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg--' + (role === 'user' ? 'user' : 'assistant');
    const body = document.createElement('div');
    body.className = 'msg__body';
    renderRich(body, text);
    wrap.appendChild(body);
    if (role === 'assistant' && Array.isArray(sources) && sources.length) {
      wrap.appendChild(buildSources(sources));
    }
    stream.appendChild(wrap);
    scrollDown();
    return wrap;
  }

  function buildSources(sources) {
    const seen = new Set();
    const titles = [];
    for (const s of sources) {
      const label = s && typeof s.title === 'string' ? s.title.trim() : '';
      if (label && !seen.has(label)) { seen.add(label); titles.push(label); }
      if (titles.length >= 4) break;
    }
    const el = document.createElement('div');
    el.className = 'msg__sources';
    const dot = document.createElement('span');
    dot.className = 'msg__sources-dot';
    el.appendChild(dot);
    el.appendChild(document.createTextNode('Grounded in: ' + titles.join(' · ')));
    return el;
  }

  function addThinking() {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg--assistant';
    const t = document.createElement('div');
    t.className = 'thinking';
    for (let i = 0; i < 3; i++) t.appendChild(document.createElement('span'));
    wrap.appendChild(t);
    stream.appendChild(wrap);
    scrollDown();
    return wrap;
  }
  function scrollDown() {
    requestAnimationFrame(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    });
  }

  async function send(text) {
    text = (text || '').trim();
    if (!text || busy) return null;
    busy = true;
    updateSendState();

    const greeting = stream.querySelector('.greeting');
    if (greeting) greeting.remove();

    addMessage('user', text);
    const priorHistory = history.slice(-18);
    history.push({ role: 'user', text });
    const thinkingEl = addThinking();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: currentMode, message: text, history: priorHistory })
      });
      let payload = {};
      try { payload = await res.json(); } catch (_) {}
      thinkingEl.remove();

      if (!res.ok || payload.error) {
        const msg = payload.error || `Request failed (${res.status}). Please try again.`;
        addMessage('assistant', msg);
        showToast(msg, true);
        return null;
      }
      const reply = payload.reply || 'Sorry, I didn’t catch that. Could you try again?';
      const sources = payload.grounding === 'rag' ? payload.sources : null;
      addMessage('assistant', reply, sources);
      history.push({ role: 'model', text: reply });
      return reply;
    } catch (err) {
      thinkingEl.remove();
      const msg = 'Could not reach the server. Make sure it’s still running, then try again.';
      addMessage('assistant', msg);
      showToast(msg, true);
      return null;
    } finally {
      busy = false;
      updateSendState();
    }
  }

  /* ---- composer ---- */
  function autogrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }
  function updateSendState() { sendBtn.disabled = busy || input.value.trim().length === 0; }
  input.addEventListener('input', () => { autogrow(); updateSendState(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) submitComposer();
    }
  });
  function submitComposer() {
    const text = input.value;
    input.value = '';
    autogrow();
    updateSendState();
    send(text);
  }
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!sendBtn.disabled) submitComposer();
  });

  /* ---- mode pills ---- */
  function setMode(mode, btn) {
    if (mode === currentMode) return;
    currentMode = mode;
    modeButtons.forEach((b) => {
      const on = b === btn;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    history = [];
    renderGreeting();
    input.placeholder =
      mode === 'roadmap' ? 'Describe your background and goal…'
      : mode === 'friend' ? 'Say something…'
      : 'Ask me anything…';
  }
  modeButtons.forEach((btn) => btn.addEventListener('click', () => setMode(btn.dataset.mode, btn)));

  /* ---- toast ---- */
  let toastTimer;
  function showToast(msg, warn) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('toast--warn', !!warn);
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 6000);
  }

  /* =================================================================
     VOICE MODE (Web Speech API)
     ================================================================= */
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const synth = window.speechSynthesis;
  let recognition = null;
  let voiceActive = false;
  let listening = false;
  let vState = 'idle';

  function orbClass(state) { bigOrb.className = 'orb orb--big orb--' + state; }
  function setVoiceState(state, statusText) {
    vState = state;
    orbClass(state);
    if (statusText != null) voiceStatus.textContent = statusText;
  }

  function openVoice() {
    // Route to chat so the conversation is visible behind/after the overlay.
    if (location.hash !== '#/chat') location.hash = '#/chat';
    else showPage('chat');
    voiceOverlay.hidden = false;
    voiceOverlay.setAttribute('aria-hidden', 'false');
    voiceActive = true;
    voiceTranscript.textContent = '';

    const canTTS = 'speechSynthesis' in window;
    if (!SpeechRecognition) {
      setVoiceState('idle', 'Voice input isn’t supported here');
      voiceTranscript.textContent =
        'Your browser doesn’t support speech-to-text. Try Chrome or Edge on desktop or Android. ' +
        (canTTS ? 'I can still read replies aloud if you type.' : '');
      voiceTap.textContent = 'Close';
      return;
    }
    setVoiceState('idle', 'Getting ready…');
    startListening();
  }

  function closeVoice() {
    voiceActive = false;
    stopListening();
    if (synth) synth.cancel();
    voiceOverlay.hidden = true;
    voiceOverlay.setAttribute('aria-hidden', 'true');
    voiceTap.textContent = 'Tap orb to talk';
  }

  function buildRecognition() {
    const r = new SpeechRecognition();
    r.lang = navigator.language || 'en-US';
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    let finalText = '';
    r.onstart = () => {
      listening = true;
      finalText = '';
      setVoiceState('listening', 'Listening…');
      voiceTap.textContent = 'Tap orb to stop';
    };
    r.onresult = (event) => {
      let interim = '';
      finalText = '';
      for (let i = 0; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      voiceTranscript.textContent = (finalText || interim).trim();
    };
    r.onerror = (event) => {
      listening = false;
      if (event.error === 'no-speech') {
        setVoiceState('idle', 'Didn’t hear anything');
        voiceTap.textContent = 'Tap orb to talk';
        return;
      }
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setVoiceState('idle', 'Microphone blocked');
        voiceTranscript.textContent =
          'I need microphone permission to listen. Allow it in your browser and tap the orb again.';
        voiceTap.textContent = 'Tap orb to talk';
        return;
      }
      setVoiceState('idle', 'Something went wrong');
      voiceTap.textContent = 'Tap orb to talk';
    };
    r.onend = () => {
      listening = false;
      const said = finalText.trim();
      if (!voiceActive) return;
      if (said) handleVoiceUtterance(said);
      else if (vState === 'listening') {
        setVoiceState('idle', 'Tap the orb to talk');
        voiceTap.textContent = 'Tap orb to talk';
      }
    };
    return r;
  }

  function startListening() {
    if (!SpeechRecognition || !voiceActive) return;
    if (synth) synth.cancel();
    try {
      recognition = buildRecognition();
      recognition.start();
    } catch (err) {
      setVoiceState('idle', 'Tap the orb to talk');
    }
  }
  function stopListening() {
    if (recognition && listening) {
      try { recognition.stop(); } catch (_) {}
    }
    listening = false;
  }

  async function handleVoiceUtterance(text) {
    setVoiceState('thinking', 'Thinking…');
    voiceTap.textContent = '…';
    const reply = await send(text);
    if (!voiceActive) return;
    if (reply) speak(reply);
    else {
      setVoiceState('idle', 'Tap the orb to try again');
      voiceTap.textContent = 'Tap orb to talk';
    }
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) {
      setVoiceState('idle', 'Tap the orb to talk');
      voiceTap.textContent = 'Tap orb to talk';
      return;
    }
    setVoiceState('speaking', 'Speaking…');
    voiceTranscript.textContent = '';
    voiceTap.textContent = 'Tap orb to interrupt';
    const spoken = text.length > 700 ? text.slice(0, 700) + '…' : text;
    const u = new SpeechSynthesisUtterance(spoken);
    u.lang = navigator.language || 'en-US';
    u.onend = () => { if (voiceActive) startListening(); };
    u.onerror = () => {
      if (!voiceActive) return;
      setVoiceState('idle', 'Tap the orb to talk');
      voiceTap.textContent = 'Tap orb to talk';
    };
    synth.cancel();
    synth.speak(u);
  }

  function voiceTapToggle() {
    if (!SpeechRecognition) { closeVoice(); return; }
    if (vState === 'speaking') {
      if (synth) synth.cancel();
      startListening();
      return;
    }
    if (listening) stopListening();
    else startListening();
  }

  talkBtn.addEventListener('click', openVoice);
  heroOrb.addEventListener('click', openVoice);
  voiceBtn.addEventListener('click', openVoice);
  voiceClose.addEventListener('click', closeVoice);
  voiceTap.addEventListener('click', voiceTapToggle);
  if (voiceStage) voiceStage.addEventListener('click', voiceTapToggle);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && voiceActive) closeVoice();
  });

  /* =================================================================
     INIT
     ================================================================= */
  async function init() {
    try {
      const res = await fetch('/api/portfolio');
      if (res.ok) data = await res.json();
    } catch (_) {}

    renderHome();
    renderProjects();
    renderExperience();
    routeFromHash();

    if (data.apiKeyConfigured === false) {
      showToast(
        'Heads up: no Gemini API key is set yet. Add GEMINI_API_KEY to your .env file and restart the server, or chats won’t work.',
        true
      );
    }
  }

  init();
})();
