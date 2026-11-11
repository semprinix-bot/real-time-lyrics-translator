'use strict';

// ---------- Stato ----------
const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d = null) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

// Nell'app desktop (protocollo app://) il redirect viene intercettato da main.js
const IS_DESKTOP = location.protocol === 'app:';
const REDIRECT_URI = IS_DESKTOP ? 'http://127.0.0.1:8888/' : location.origin + location.pathname;
const SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';

const state = {
  trackKey: null,      // id del brano caricato
  lines: [],           // [{t: ms, text, tr}]
  synced: false,
  activeIdx: -1,
  // orologio: posizione = baseProgress + (now - baseTime) se playing
  baseProgress: 0,
  baseTime: performance.now(),
  playing: false,
  duration: 0,
  mode: 'none',        // 'spotify' | 'manual' | 'none'
  offset: parseFloat(store.get('offset', '0')) || 0,
  // default = lingua del sistema, se supportata
  lang: store.get('lang', matchLang(navigator.language)),
  uiLang: store.get('uiLang', matchLang(navigator.language)),
  status: null,        // ultimo messaggio di stato {key, vars}, ritradotto al cambio lingua
  msgKey: 'placeholder', // messaggio mostrato al posto del testo
};

const APP_NAME = 'Real Time Lyrics Translator';
// key = chiave di STRINGS (i18n.js); un testo qualsiasi viene mostrato così com'è
const setStatus = (key, vars) => { state.status = key ? { key, vars } : null; $('status').textContent = key ? t(key, vars) : ''; };
const fmt = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const position = () => state.baseProgress + (state.playing ? performance.now() - state.baseTime : 0);
const setClock = (progress, playing) => { state.baseProgress = progress; state.baseTime = performance.now(); state.playing = playing; };

// ---------- Spotify: OAuth PKCE ----------
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function randomString(n = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const arr = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(arr, (x) => chars[x % chars.length]).join('');
}

async function login() {
  const clientId = $('clientId').value.trim();
  if (!clientId) { setStatus('enterClientId'); return; }
  store.set('clientId', clientId);
  const verifier = randomString(64);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const st = randomString(16);
  store.set('pkce_verifier', verifier);
  store.set('pkce_state', st);
  const params = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state: st,
  });
  location.href = 'https://accounts.spotify.com/authorize?' + params;
}

async function tokenRequest(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Token error');
  store.set('access_token', data.access_token);
  store.set('expires_at', String(Date.now() + data.expires_in * 1000 - 60000));
  if (data.refresh_token) store.set('refresh_token', data.refresh_token);
}

async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return;
  history.replaceState(null, '', location.pathname);
  if (q.get('error')) { setStatus('accessDenied', { e: q.get('error') }); return; }
  if (q.get('state') !== store.get('pkce_state')) { setStatus('invalidState'); return; }
  try {
    await tokenRequest({
      grant_type: 'authorization_code', code: q.get('code'), redirect_uri: REDIRECT_URI,
      client_id: store.get('clientId'), code_verifier: store.get('pkce_verifier'),
    });
    store.del('pkce_verifier'); store.del('pkce_state');
  } catch (e) { setStatus('loginFailed', { e: e.message }); }
}

async function getToken() {
  if (!store.get('access_token')) return null;
  if (Date.now() > Number(store.get('expires_at', 0))) {
    try {
      await tokenRequest({ grant_type: 'refresh_token', refresh_token: store.get('refresh_token'), client_id: store.get('clientId') });
    } catch (e) { logout(); setStatus('sessionExpired'); return null; }
  }
  return store.get('access_token');
}

function logout() {
  ['access_token', 'refresh_token', 'expires_at'].forEach(store.del);
  state.mode = 'none';
  updateAuthUi();
}

function updateAuthUi() {
  const logged = !!store.get('access_token');
  $('loginBtn').hidden = logged;
  $('logoutBtn').hidden = !logged;
  if (logged) setStatus('connected');
}

async function spotify(path, opts = {}) {
  const token = await getToken();
  if (!token) return null;
  const res = await fetch('https://api.spotify.com/v1' + path, { ...opts, headers: { Authorization: 'Bearer ' + token } });
  if (res.status === 401) { store.set('expires_at', '0'); return null; }
  if (res.status === 204 || res.status === 202) return { empty: true };
  if (res.status === 429) { setStatus('tooMany'); return null; }
  if (!res.ok) throw new Error('Spotify ' + res.status);
  return res.json().catch(() => ({ empty: true }));
}

// Polling del brano in riproduzione
let pollTimer = null;
async function poll() {
  clearTimeout(pollTimer);
  if (state.mode === 'manual') return;
  try {
    const t0 = performance.now();
    const data = await spotify('/me/player/currently-playing');
    const rtt = performance.now() - t0;
    if (data && !data.empty && data.item) {
      state.mode = 'spotify';
      const item = data.item;
      // compensa metà della latenza della richiesta
      setClock(data.progress_ms + (data.is_playing ? rtt / 2 : 0), data.is_playing);
      state.duration = item.duration_ms;
      if (item.id !== state.trackKey) {
        loadTrack({
          key: item.id,
          title: item.name,
          artist: item.artists.map((a) => a.name).join(', '),
          firstArtist: item.artists[0]?.name || '',
          album: item.album?.name || '',
          duration: item.duration_ms,
          cover: item.album?.images?.at(-1)?.url,
        });
      }
    } else if (data && data.empty && state.mode === 'spotify') {
      state.playing = false;
      setStatus('nothingPlaying');
    }
  } catch (e) {
    setStatus(e.message);
  }
  if (store.get('access_token')) pollTimer = setTimeout(poll, document.hidden ? 5000 : 2000);
}

// ---------- Testi: LRCLIB ----------
function parseLrc(lrc) {
  const out = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) out.push({ t: (parseInt(m[1]) * 60 + parseFloat(m[2])) * 1000, text });
  }
  return out.sort((a, b) => a.t - b.t);
}

async function fetchLyrics({ title, firstArtist, album, duration }) {
  const base = 'https://lrclib.net/api/';
  const cleanTitle = title.replace(/\s*[-–(].*(remaster|version|live|edit|mix|feat).*$/i, '').trim();
  const tries = [
    `get?${new URLSearchParams({ track_name: title, artist_name: firstArtist, album_name: album, duration: Math.round(duration / 1000) })}`,
    `search?${new URLSearchParams({ track_name: cleanTitle, artist_name: firstArtist })}`,
    `search?${new URLSearchParams({ q: `${firstArtist} ${cleanTitle}` })}`,
  ];
  let plainFallback = null;
  for (const path of tries) {
    if (!album && path.startsWith('get?')) continue;
    try {
      const res = await fetch(base + path);
      if (!res.ok) continue;
      const data = await res.json();
      const list = Array.isArray(data) ? data : [data];
      // preferisci il risultato sincronizzato con durata più vicina
      const synced = list.filter((r) => r.syncedLyrics)
        .sort((a, b) => Math.abs(a.duration * 1000 - duration) - Math.abs(b.duration * 1000 - duration));
      if (synced.length) return { synced: true, lines: parseLrc(synced[0].syncedLyrics), instrumental: false };
      const plain = list.find((r) => r.plainLyrics);
      if (plain && !plainFallback) plainFallback = plain.plainLyrics;
      if (list.some((r) => r.instrumental)) return { instrumental: true, lines: [] };
    } catch { /* prova il prossimo */ }
  }
  if (plainFallback) return { synced: false, lines: plainFallback.split(/\r?\n/).map((text) => ({ t: 0, text: text.trim() })) };
  return null;
}

// ---------- Traduzione ----------
const GT = 'https://translate.googleapis.com/translate_a/single';

async function gtx(text, tl, extra = '') {
  const res = await fetch(`${GT}?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t${extra}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: 'q=' + encodeURIComponent(text),
  });
  if (!res.ok) throw new Error('Translation ' + res.status);
  return res.json();
}

async function myMemory(text, tl) {
  const res = await fetch(`https://api.mymemory.translated.net/get?${new URLSearchParams({ q: text, langpair: `autodetect|${tl}` })}`);
  const d = await res.json();
  return d.responseData?.translatedText || '';
}

// Traduce un array di righe mantenendo l'allineamento 1:1
async function translateLines(texts, tl) {
  const cacheKey = `tr:${tl}:${hash(texts.join('\n'))}`;
  const cached = store.get(cacheKey);
  if (cached) { try { return JSON.parse(cached); } catch {} }

  const result = new Array(texts.length).fill('');
  const idx = texts.map((t, i) => (t ? i : -1)).filter((i) => i >= 0);
  // dedup: i ritornelli si ripetono
  const unique = [...new Set(idx.map((i) => texts[i]))];
  const map = new Map();

  const CHUNK = 40;
  for (let c = 0; c < unique.length; c += CHUNK) {
    const part = unique.slice(c, c + CHUNK);
    try {
      const data = await gtx(part.join('\n'), tl);
      const joined = (data[0] || []).map((s) => s[0] || '').join('');
      const out = joined.split('\n');
      if (out.length === part.length) {
        part.forEach((p, i) => map.set(p, out[i].trim()));
        continue;
      }
      // disallineato: riga per riga
      await Promise.all(part.map(async (p) => {
        const d = await gtx(p, tl);
        map.set(p, (d[0] || []).map((s) => s[0] || '').join('').trim());
      }));
    } catch {
      // fallback MyMemory
      for (const p of part) { try { map.set(p, await myMemory(p, tl)); } catch { map.set(p, ''); } }
    }
  }
  idx.forEach((i) => { result[i] = map.get(texts[i]) || ''; });
  store.set(cacheKey, JSON.stringify(result));
  return result;
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ---------- Caricamento e render ----------
let loadSeq = 0;
async function loadTrack(track) {
  const seq = ++loadSeq;
  state.trackKey = track.key;
  state.lines = [];
  state.activeIdx = -1;
  delete $('title').dataset.i18n;
  delete $('artist').dataset.i18n;
  $('title').textContent = track.title;
  $('artist').textContent = track.artist;
  $('cover').hidden = !track.cover;
  if (track.cover) $('cover').src = track.cover;
  document.title = `${track.title} — ${APP_NAME}`;
  renderMessage('lookingLyrics');

  const lyr = await fetchLyrics(track);
  if (seq !== loadSeq) return;
  if (!lyr) { renderMessage('notFound'); return; }
  if (lyr.instrumental) { renderMessage('instrumental'); return; }

  state.synced = lyr.synced;
  state.lines = lyr.lines;
  renderLines();
  setStatus(lyr.synced ? 'syncedTranslating' : 'unsyncedTranslating');
  await translateCurrent(seq);
}

async function translateCurrent(seq = loadSeq) {
  const texts = state.lines.map((l) => l.text);
  const lang = state.lang;
  try {
    const tr = await translateLines(texts, lang);
    if (seq !== loadSeq || lang !== state.lang) return;
    state.lines.forEach((l, i) => { l.tr = tr[i]; });
    document.querySelectorAll('.line').forEach((el, i) => {
      el.querySelector('.tr').textContent = state.lines[i].tr || '';
    });
    setStatus(state.synced ? 'inSync' : 'notSynced');
  } catch (e) {
    setStatus('translationUnavailable', { e: e.message });
  }
}

function renderMessage(key) {
  state.msgKey = key;
  $('lyrics').classList.remove('unsynced');
  $('lyrics').innerHTML = `<p class="placeholder"></p>`;
  $('lyrics').firstChild.textContent = t(key);
}

function renderLines() {
  state.msgKey = null;
  const main = $('lyrics');
  main.classList.toggle('unsynced', !state.synced);
  main.innerHTML = '';
  const frag = document.createDocumentFragment();
  state.lines.forEach((l, i) => {
    const div = document.createElement('div');
    div.className = 'line';
    div.dataset.i = i;
    const orig = document.createElement('div');
    orig.className = 'orig';
    if (!l.text) orig.textContent = '♪';
    else for (const part of l.text.split(/(\s+)/)) {
      if (!part.trim()) { orig.append(part); continue; }
      const w = document.createElement('span');
      w.className = 'w';
      w.textContent = part;
      orig.append(w);
    }
    const tr = document.createElement('div');
    tr.className = 'tr';
    tr.textContent = l.tr || '';
    div.append(orig, tr);
    frag.append(div);
  });
  main.append(frag);
  main.scrollTop = 0;
}

function currentIndex(pos) {
  const lines = state.lines;
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function tick() {
  const pos = position();
  if (state.mode === 'manual') $('clock').textContent = fmt(pos);
  if (state.synced && state.lines.length) {
    const i = currentIndex(pos + state.offset * 1000);
    if (i !== state.activeIdx) {
      const els = $('lyrics').children;
      for (let k = 0; k < els.length; k++) {
        els[k].classList.toggle('active', k === i);
        els[k].classList.toggle('past', k < i);
      }
      state.activeIdx = i;
      const el = els[Math.max(0, i)];
      if (el && !userScrolling) {
        const main = $('lyrics');
        main.scrollTop = el.offsetTop - main.clientHeight / 2 + el.clientHeight / 2;
      }
    }
  }
  requestAnimationFrame(tick);
}

// se l'utente scorre a mano, sospendi l'autoscroll per qualche secondo
let userScrolling = false, scrollTimer = null;
['wheel', 'touchmove'].forEach((ev) => $('lyrics').addEventListener(ev, () => {
  userScrolling = true;
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => { userScrolling = false; }, 4000);
}, { passive: true }));

// ---------- Click: parola → traduzione, riga → seek ----------
$('lyrics').addEventListener('click', async (e) => {
  const w = e.target.closest('.w');
  if (w) { e.stopPropagation(); showWord(w); return; }
  const line = e.target.closest('.line');
  if (!line || !state.synced) return;
  const t = state.lines[+line.dataset.i].t;
  if (state.mode === 'manual') setClock(t, state.playing);
  else if (state.mode === 'spotify') {
    setClock(t, state.playing);
    try { await spotify(`/me/player/seek?position_ms=${Math.round(t)}`, { method: 'PUT' }); }
    catch { setStatus('seekPremium'); }
  }
});

async function showWord(el) {
  const word = el.textContent.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
  if (!word) return;
  const pop = $('wordPop');
  const r = el.getBoundingClientRect();
  pop.innerHTML = '';
  const head = document.createElement('div');
  head.innerHTML = '<b></b> → <span>…</span>';
  head.querySelector('b').textContent = word;
  pop.append(head);
  pop.hidden = false;
  pop.style.left = Math.min(r.left, innerWidth - 290) + 'px';
  pop.style.top = (r.bottom + 6 + 160 > innerHeight ? r.top - 120 : r.bottom + 6) + 'px';
  try {
    const d = await gtx(word, state.lang, '&dt=bd');
    head.querySelector('span').textContent = (d[0] || []).map((s) => s[0]).join('');
    for (const entry of (d[1] || []).slice(0, 3)) {
      const p = document.createElement('div');
      p.className = 'pos';
      p.textContent = `${entry[0]}: ${(entry[1] || []).slice(0, 5).join(', ')}`;
      pop.append(p);
    }
  } catch { head.querySelector('span').textContent = `(${t('error')})`; }
}
document.addEventListener('click', (e) => { if (!e.target.closest('#wordPop')) $('wordPop').hidden = true; });

// ---------- Modalità manuale ----------
async function manualLoad() {
  const artist = $('manualArtist').value.trim();
  const title = $('manualTitle').value.trim();
  if (!title) { setStatus('enterTitle'); return; }
  state.mode = 'manual';
  clearTimeout(pollTimer);
  setClock(0, false);
  $('manualBar').hidden = false;
  $('playPause').textContent = '▶';
  $('settings').hidden = true;
  await loadTrack({ key: 'manual:' + artist + ':' + title, title, artist, firstArtist: artist, album: '', duration: 0 });
}

$('playPause').addEventListener('click', () => {
  setClock(position(), !state.playing);
  $('playPause').textContent = state.playing ? '⏸' : '▶';
});

// ---------- UI ----------
for (const sel of [$('lang'), $('uiLang')]) {
  for (const [code, name] of LANGS) sel.add(new Option(name, code));
}
$('uiLang').value = state.uiLang;

function setUiLang(lang) {
  state.uiLang = lang;
  store.set('uiLang', lang);
  applyI18n(lang, {
    link: '<a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a>',
    uri: `<code id="redirectUri" dir="ltr">${escapeHtml(REDIRECT_URI)}</code>`,
    lrclib: '<a href="https://lrclib.net" target="_blank" rel="noopener">LRCLIB</a>',
  });
  if (state.msgKey) renderMessage(state.msgKey);
  if (state.status) setStatus(state.status.key, state.status.vars);
}
setUiLang(state.uiLang);
$('uiLang').addEventListener('change', () => setUiLang($('uiLang').value));

// Link condivisibile con il Client ID già compilato: https://…/#cid=XXXX
const sharedCid = new URLSearchParams(location.hash.slice(1)).get('cid');
if (sharedCid && /^[a-zA-Z0-9]{16,64}$/.test(sharedCid)) {
  store.set('clientId', sharedCid);
  history.replaceState(null, '', location.pathname + location.search);
}
$('clientId').value = store.get('clientId', '');
$('lang').value = state.lang;
$('offset').value = state.offset;
$('offsetVal').textContent = state.offset.toFixed(1);
$('showOriginal').checked = store.get('showOriginal', '1') === '1';
$('lyrics').classList.toggle('hide-orig', !$('showOriginal').checked);

$('settingsBtn').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; });
$('loginBtn').addEventListener('click', login);
$('logoutBtn').addEventListener('click', logout);
$('manualBtn').addEventListener('click', manualLoad);
$('manualTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') manualLoad(); });
$('lang').addEventListener('change', () => {
  state.lang = $('lang').value;
  store.set('lang', state.lang);
  if (state.lines.length) { setStatus('translating'); translateCurrent(); }
});
$('offset').addEventListener('input', () => {
  state.offset = parseFloat($('offset').value);
  $('offsetVal').textContent = state.offset.toFixed(1);
  store.set('offset', String(state.offset));
  state.activeIdx = -2;
});
$('showOriginal').addEventListener('change', () => {
  const on = $('showOriginal').checked;
  store.set('showOriginal', on ? '1' : '0');
  $('lyrics').classList.toggle('hide-orig', !on);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.mode !== 'manual') poll(); });

// ---------- Avvio ----------
(async () => {
  if (location.hostname === 'localhost') {
    // Spotify accetta solo 127.0.0.1 come redirect di loopback
    location.replace(location.href.replace('//localhost', '//127.0.0.1'));
    return;
  }
  await handleRedirect();
  updateAuthUi();
  if (store.get('access_token')) poll();
  else $('settings').hidden = false;
  requestAnimationFrame(tick);
})();
