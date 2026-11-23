const FIELDS = ['from', 'to', 'date', 'train', 'cls', 'quota', 'mobile', 'passengers', 'upi', 'start'];
const $ = (id) => document.getElementById(id);
const say = (t) => { $('msg').textContent = t; setTimeout(() => ($('msg').textContent = ''), 2500); };
const IRCTC = /^https:\/\/(www\.irctc\.co\.in|([a-z0-9-]+\.)?irctcipay\.com)\//;

// ---------- settings ----------
chrome.storage.local.get(['config', 'armed', 'activity'], ({ config = {}, armed, activity = [] }) => {
  FIELDS.forEach((f) => { if (config[f] != null) $(f).value = config[f]; });
  $('autoContinue').checked = config.autoContinue !== false;
  if (armed) say('Armed');
  renderLog(activity);
});

function collect() {
  const config = {};
  FIELDS.forEach((f) => (config[f] = $(f).value.trim()));
  config.from = config.from.toUpperCase();
  config.to = config.to.toUpperCase();
  config.cls = config.cls.toUpperCase();
  config.autoContinue = $('autoContinue').checked;
  return config;
}

// Popup-side entries go into the same activity log as the page's entries.
function addLog(level, msg) {
  chrome.storage.local.get({ activity: [] }, ({ activity }) => {
    activity.push({ t: Date.now(), level, msg, page: 'popup' });
    chrome.storage.local.set({ activity: activity.slice(-200) });
  });
}

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

// ---------- buttons ----------
$('save').onclick = () => chrome.storage.local.set({ config: collect() }, () => { say('Saved'); addLog('info', 'settings saved'); });
$('arm').onclick = async () => {
  const tab = await activeTab();
  await ensureScript(tab);
  chrome.storage.local.set({ config: collect(), armed: true }, () => {
    say('Armed');
    addLog('step', IRCTC.test((tab && tab.url) || '') ? 'armed' : 'armed (now open the IRCTC train search page)');
  });
};
$('disarm').onclick = () => chrome.storage.local.set({ armed: false }, () => { say('Disarmed'); addLog('info', 'disarmed'); });
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
  if (area === 'local' && changes.activity) renderLog(changes.activity.newValue || []);
});

$('ver').textContent = 'Version ' + chrome.runtime.getManifest().version;
showTabInfo();
