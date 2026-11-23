const FIELDS = ['from', 'to', 'date', 'train', 'cls', 'quota', 'mobile', 'passengers', 'upi', 'start', 'retrySec'];
const CHECKS = ['autoContinue', 'autoUpgrade', 'confirmOnly']; // default: ticked
const $ = (id) => document.getElementById(id);
let sayTimer = null;
const say = (t) => {
  $('msg').textContent = t;
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => ($('msg').textContent = ''), 2500);
};
const IRCTC = /^https:\/\/(www\.irctc\.co\.in|([a-z0-9-]+\.)?irctcipay\.com)\//;

// ---------- settings ----------
function applyConfig(config = {}) {
  FIELDS.forEach((f) => { $(f).value = config[f] != null ? config[f] : ''; });
  if (!config.quota) $('quota').value = 'TATKAL';
  CHECKS.forEach((c) => { $(c).checked = config[c] !== false; });
}

chrome.storage.local.get(['config', 'armed', 'activity', 'trips'], ({ config = {}, armed, activity = [], trips = {} }) => {
  applyConfig(config);
  if (armed) say('Armed');
  renderLog(activity);
  renderTrips(trips);
});

// Accept "GD" or a pasted IRCTC name like "GONDA JN. - GD (GONDA)"; keep just the code.
function stationCode(value) {
  const v = value.toUpperCase().trim();
  const m = v.match(/-\s*([A-Z0-9]{1,5})\b/);
  return m ? m[1] : v.replace(/[^A-Z0-9]/g, '');
}

function collect() {
  const config = {};
  FIELDS.forEach((f) => (config[f] = $(f).value.trim()));
  config.from = stationCode(config.from);
  config.to = stationCode(config.to);
  config.cls = config.cls.toUpperCase();
  config.retrySec = config.retrySec === '' ? 30 : Math.min(120, Math.max(0, Number(config.retrySec) || 0));
  CHECKS.forEach((c) => (config[c] = $(c).checked));
  applyConfig(config); // show the cleaned-up values
  return config;
}

// Popup-side entries go into the same activity log as the page's entries.
function addLog(level, msg) {
  chrome.storage.local.get({ activity: [] }, ({ activity }) => {
    activity.push({ t: Date.now(), level, msg, page: 'popup' });
    chrome.storage.local.set({ activity: activity.slice(-300) });
  });
}

// ---------- saved trips ----------
function renderTrips(trips) {
  const sel = $('trips');
  const current = sel.value;
  sel.textContent = '';
  const first = document.createElement('option');
  first.value = '';
  first.textContent = Object.keys(trips).length ? 'Saved trips…' : 'No saved trips yet';
  sel.appendChild(first);
  for (const name of Object.keys(trips).sort()) {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    sel.appendChild(o);
  }
  if (trips[current]) sel.value = current;
}

$('saveTrip').onclick = () => {
  const name = $('tripName').value.trim();
  if (!name) return say('Enter a trip name');
  const config = collect();
  chrome.storage.local.get({ trips: {} }, ({ trips }) => {
    trips[name] = config;
    chrome.storage.local.set({ trips, config }, () => {
      renderTrips(trips);
      $('trips').value = name;
      say('Trip saved');
      addLog('info', `trip "${name}" saved`);
    });
  });
};

$('loadTrip').onclick = () => {
  const name = $('trips').value;
  if (!name) return say('Pick a trip');
  chrome.storage.local.get({ trips: {} }, ({ trips }) => {
    if (!trips[name]) return say('Trip not found');
    applyConfig(trips[name]);
    $('tripName').value = name;
    chrome.storage.local.set({ config: trips[name] }, () => { say('Trip loaded'); addLog('info', `trip "${name}" loaded`); });
  });
};

$('deleteTrip').onclick = () => {
  const name = $('trips').value;
  if (!name) return say('Pick a trip');
  chrome.storage.local.get({ trips: {} }, ({ trips }) => {
    delete trips[name];
    chrome.storage.local.set({ trips }, () => { renderTrips(trips); say('Trip deleted'); addLog('info', `trip "${name}" deleted`); });
  });
};

// ---------- IRCTC login (password encrypted with a PIN) ----------
// savedLogin in chrome.storage.local: { user, salt, iv, data } with the password AES-GCM encrypted
// using a key derived from the PIN (PBKDF2-SHA-256). The unlocked password is put only in
// chrome.storage.session, which is memory-only and not readable by content scripts.
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pinKey(pin, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function showLoginState() {
  const [{ savedLogin }, { login }] = await Promise.all([
    chrome.storage.local.get('savedLogin'), chrome.storage.session.get('login')]);
  const el = $('loginState');
  if (!savedLogin) { el.textContent = '(not saved)'; el.className = ''; return; }
  $('loginUser').value = savedLogin.user;
  const unlocked = login?.user === savedLogin.user;
  el.textContent = `(${savedLogin.user}: ${unlocked ? 'unlocked' : 'locked'})`;
  el.className = unlocked ? 'on' : 'off';
}

$('saveLogin').onclick = async () => {
  const user = $('loginUser').value.trim();
  const password = $('loginPass').value;
  const pin = $('loginPin').value;
  if (!user || !password) return say('Enter user ID and password');
  if (pin.length < 4) return say('PIN must be at least 4 characters');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await pinKey(pin, salt), enc.encode(password));
  await chrome.storage.local.set({ savedLogin: { user, salt: b64(salt), iv: b64(iv), data: b64(data) } });
  await chrome.storage.session.set({ login: { user, password } });
  $('loginPass').value = '';
  $('loginPin').value = '';
  say('Login saved and unlocked');
  addLog('info', `login saved for ${user} (password encrypted)`);
  send('login'); // fill the login pop-up now if it is already open
  showLoginState();
};

$('unlock').onclick = async () => {
  const { savedLogin } = await chrome.storage.local.get('savedLogin');
  if (!savedLogin) return say('No saved login');
  try {
    const key = await pinKey($('loginPin').value, unb64(savedLogin.salt));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(savedLogin.iv) }, key, unb64(savedLogin.data));
    await chrome.storage.session.set({ login: { user: savedLogin.user, password: new TextDecoder().decode(plain) } });
    $('loginPin').value = '';
    say('Unlocked');
    addLog('info', `login unlocked for ${savedLogin.user}`);
    send('login'); // fill the login pop-up now if it is already open
  } catch {
    say('Wrong PIN');
    addLog('error', 'unlock failed: wrong PIN');
  }
  showLoginState();
};

$('lock').onclick = async () => {
  await chrome.storage.session.remove('login');
  say('Locked');
  showLoginState();
};

$('forgetLogin').onclick = async () => {
  await chrome.storage.session.remove('login');
  await chrome.storage.local.remove('savedLogin');
  $('loginUser').value = '';
  say('Login removed');
  addLog('info', 'saved login removed');
  showLoginState();
};

// ---------- current tab ----------
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Make sure content.js is running in the IRCTC tab. Tabs opened before the extension was
// installed or reloaded do not have it, so inject it on demand.
async function ensureScript(tab) {
  if (!tab || !IRCTC.test(tab.url || '')) return false;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      addLog('info', 'script was not running in this tab; injected it');
      return true;
    } catch (e) {
      addLog('error', 'could not inject into tab: ' + e.message);
      return false;
    }
  }
}

async function showTabInfo() {
  const tab = await activeTab();
  const box = $('tabinfo');
  if (!tab || !IRCTC.test(tab.url || '')) {
    box.className = 'bad';
    box.textContent = 'This tab is not IRCTC. Open https://www.irctc.co.in/nget/train-search and click the extension again.';
    return;
  }
  const ok = await ensureScript(tab);
  box.className = ok ? 'good' : 'bad';
  box.textContent = ok ? 'Connected to IRCTC tab: ' + new URL(tab.url).pathname
    : 'Could not connect to the IRCTC tab. Refresh the page and try again.';
}

async function send(type) {
  const tab = await activeTab();
  if (!(await ensureScript(tab))) { say('Open the IRCTC tab first'); return false; }
  try { await chrome.tabs.sendMessage(tab.id, { type }); return true; }
  catch (e) { addLog('error', 'message to page failed: ' + e.message); return false; }
}

async function arm(dry) {
  const tab = await activeTab();
  await ensureScript(tab);
  chrome.storage.local.set({ config: collect(), armed: true, dryRun: dry }, () => {
    say(dry ? 'Dry run started' : 'Armed');
    const where = IRCTC.test((tab && tab.url) || '') ? '' : ' (now open the IRCTC train search page)';
    addLog('step', (dry ? 'dry run armed: full flow, stops before Pay & Book' : 'armed') + where);
  });
}

// ---------- buttons ----------
$('save').onclick = () => chrome.storage.local.set({ config: collect() }, () => { say('Saved'); addLog('info', 'settings saved'); });
$('arm').onclick = () => arm(false);
$('dry').onclick = () => arm(true);
$('disarm').onclick = () => chrome.storage.local.set({ armed: false, dryRun: false }, () => { say('Disarmed'); addLog('info', 'disarmed'); });
$('run').onclick = () => send('run');
$('check').onclick = () => send('check');
$('clear').onclick = () => chrome.storage.local.set({ activity: [] });
$('copy').onclick = () => chrome.storage.local.get({ activity: [] }, ({ activity }) => {
  const text = activity.map((e) => `${new Date(e.t).toLocaleTimeString()} [${e.level}] ${e.page}: ${e.msg}`).join('\n');
  navigator.clipboard.writeText(text).then(() => say('Log copied'), () => say('Copy failed'));
});

// ---------- activity log ----------
function renderLog(entries) {
  const box = $('log');
  box.textContent = '';
  if (!entries.length) { box.textContent = 'No activity yet.'; return; }
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = e.level;
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = new Date(e.t).toLocaleTimeString();
    row.append(t, e.msg);
    box.appendChild(row);
  }
  box.scrollTop = box.scrollHeight;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.activity) renderLog(changes.activity.newValue || []);
  if (changes.trips) renderTrips(changes.trips.newValue || {});
});

// ---------- IRCTC clock ----------
// The page measures IRCTC's clock and stores { offset, err, at }; show it live here.
let clock = null;
chrome.storage.local.get(['clock'], (r) => { clock = r.clock || null; });
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.clock) clock = c.clock.newValue; });
setInterval(() => {
  const el = $('irctcClock');
  if (!clock) { el.textContent = 'IRCTC time: open IRCTC to measure'; return; }
  const now = new Date(Date.now() + clock.offset).toTimeString().slice(0, 8);
  const off = clock.offset / 1000;
  const age = Math.round((Date.now() - clock.at) / 60000);
  el.textContent = `IRCTC ${now} | your clock ${off >= 0 ? 'behind' : 'ahead'} ${Math.abs(off).toFixed(2)}s` +
    (age >= 10 ? ` (measured ${age} min ago)` : '');
}, 250);
$('syncClock').onclick = async () => {
  $('irctcClock').textContent = 'IRCTC time: measuring…';
  if (await send('sync')) say('Clock synced');
};

$('ver').textContent = 'Version ' + chrome.runtime.getManifest().version;
showTabInfo();
showLoginState();
