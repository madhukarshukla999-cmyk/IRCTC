const FIELDS = ['from', 'to', 'date', 'train', 'cls', 'quota', 'mobile', 'passengers', 'upi', 'start', 'retrySec'];
const CHECKS = ['autoContinue', 'autoUpgrade', 'confirmOnly']; // default: ticked
const $ = (id) => document.getElementById(id);
const say = (t) => { $('msg').textContent = t; setTimeout(() => ($('msg').textContent = ''), 2500); };
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

$('ver').textContent = 'Version ' + chrome.runtime.getManifest().version;
showTabInfo();
