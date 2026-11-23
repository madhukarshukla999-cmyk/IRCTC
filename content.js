// IRCTC Tatkal Autofill content script.
// Selectors follow IRCTC's Angular/PrimeNG pages. Every step is written to the activity log in
// the popup (and to the DevTools console with the prefix [Tatkal]).
(() => {
  // The popup may inject this file into a tab that already has it; run only once per page.
  if (window.__tatkalAutofill) return;
  window.__tatkalAutofill = true;

  // ---------- activity log (shown in the popup) ----------
  const MAX_LOG = 300;
  let pending = [];
  let flushTimer = null;
  function activity(level, msg) {
    console.log('[Tatkal]', msg);
    pending.push({ t: Date.now(), level, msg, page: location.pathname });
    if (!flushTimer) flushTimer = setTimeout(flush, 100);
  }
  function flush() {
    flushTimer = null;
    const batch = pending;
    pending = [];
    chrome.storage.local.get({ activity: [] }, ({ activity: log }) => {
      chrome.storage.local.set({ activity: log.concat(batch).slice(-MAX_LOG) });
    });
  }
  const LOG = (...a) => activity('info', a.map(String).join(' '));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeout = 8000, step = 50) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  // getClientRects also works for elements inside position:fixed overlays (offsetParent does not).
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  function setValue(el, value) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Type one character at a time so PrimeNG autocomplete fires its search.
  async function typeSlowly(el, value, delay = 30) {
    el.focus();
    el.click();
    setValue(el, '');
    for (let i = 1; i <= value.length; i++) {
      setValue(el, value.slice(0, i));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: value[i - 1], bubbles: true }));
      await sleep(delay);
    }
  }

  const getStore = () => new Promise((r) => chrome.storage.local.get(['config', 'armed', 'dryRun'], r));
  let dryRun = false;

  // ---------- status panel ----------
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;bottom:12px;right:12px;z-index:2147483647;background:#222;color:#fff;' +
    'font:12px system-ui;padding:8px 10px;border-radius:6px;max-width:280px;opacity:.92;cursor:pointer';
  panel.title = 'Click to run the step for this page now';
  document.documentElement.appendChild(panel);
  const status = (t, level = 'step') => { panel.textContent = 'Tatkal Autofill: ' + (dryRun ? '[dry run] ' : '') + t; activity(level, t); };
  activity('info', 'extension loaded on ' + location.pathname);
  panel.textContent = 'Tatkal Autofill: idle';

  // ---------- server clock ----------
  // Each response's Date header (1 s resolution) bounds the offset between IRCTC's clock and
  // this computer's clock: offset is in [Date - received, Date + 1000 - sent]. Intersecting the
  // bounds of several requests sent at different sub-second moments narrows it down.
  let clockOffset = 0;
  async function syncServerTime(samples = 6) {
    let lo = -Infinity, hi = Infinity, best = null;
    for (let i = 0; i < samples; i++) {
      try {
        const sent = Date.now();
        const res = await fetch(`${location.origin}/nget/train-search?_t=${sent}`, { method: 'HEAD', cache: 'no-store' });
        const received = Date.now();
        const date = Date.parse(res.headers.get('date') || '');
        if (Number.isNaN(date)) continue;
        lo = Math.max(lo, date - received);
        hi = Math.min(hi, date + 1000 - sent);
        const mid = date + 500 - (sent + received) / 2;
        if (!best || received - sent < best.rtt) best = { rtt: received - sent, mid };
      } catch (e) { /* network hiccup: skip this sample */ }
      await sleep(170 + Math.random() * 120); // spread samples across the second
    }
    if (!best) { activity('error', 'could not read IRCTC server time; using this computer\'s clock'); return false; }
    let offset, err;
    if (lo <= hi) { offset = (lo + hi) / 2; err = (hi - lo) / 2; } else { offset = best.mid; err = 500 + best.rtt / 2; }
    clockOffset = Math.round(offset);
    const sign = clockOffset >= 0 ? '+' : '-';
    activity('info', `IRCTC clock is ${sign}${(Math.abs(clockOffset) / 1000).toFixed(2)}s vs this computer (±${(err / 1000).toFixed(2)}s)`);
    return true;
  }
  const serverNow = () => Date.now() + clockOffset;

  // ---------- IRCTC pop-ups ----------
  // Only harmless notices are closed automatically. Anything about logging out or sessions,
  // or with input fields (login), is left for the user.
  const seenDialogs = new WeakSet();
  function handleDialogs() {
    const dialogs = $$('p-confirmdialog .ui-confirmdialog, .ui-dialog, .p-dialog, .modal.show .modal-content').filter(visible);
    for (const d of dialogs) {
      if (seenDialogs.has(d) || d.contains(panel)) continue;
      if ($(LOGIN_USER, d)) continue; // the login form is handled by handleLogin
      const msg = text($('.ui-confirmdialog-message, .ui-dialog-content, .p-dialog-content, .modal-body', d) || d).slice(0, 200);
      const buttons = $$('button', d).filter(visible).filter((b) => text(b));
      if (!msg && !buttons.length) continue;
      seenDialogs.add(d);
      activity('info', `IRCTC pop-up: "${msg}"`);
      if ($$('input[type="text"], input[type="password"]', d).some(visible)) {
        activity('step', 'pop-up asks for input (login?). Fill it in yourself; the extension continues afterwards.');
        continue;
      }
      if (/log ?out|session|expired|timed? ?out|sign ?in again/i.test(msg)) {
        activity('error', 'session pop-up: answer it yourself');
        continue;
      }
      let btn = null;
      if (/food|catering/i.test(msg)) btn = buttons.find((b) => /^(OK|YES)$/i.test(text(b)));
      else if (buttons.length === 1 && /^(OK|CLOSE|GOT IT|CONTINUE)$/i.test(text(buttons[0]))) btn = buttons[0];
      if (btn) { activity('info', `closed pop-up with "${text(btn)}"`); btn.click(); }
      else activity('step', 'pop-up needs your answer: ' + buttons.map(text).join(' / '));
    }
  }
  // ---------- IRCTC login ----------
  // When a login form is visible, fill the saved user ID and password (if unlocked in the popup),
  // focus the captcha, and click Sign In after the user has typed it. Never logs the password.
  const LOGIN_USER = 'input[formcontrolname="userid"], input[placeholder="User Name"]';
  const LOGIN_PASS = 'input[formcontrolname="password"], input[type="password"]';
  const LOGIN_CAPTCHA = 'input[formcontrolname="captcha"], input#captcha, input#nlpAnswer, input[placeholder*="aptcha"]';
  let handledLogins = new WeakSet();
  const retryLogin = () => { handledLogins = new WeakSet(); handleLogin(); };
  let loginBusy = false;

  // Fill a login box and confirm the value stays. IRCTC can reset the form just after the pop-up
  // opens, which wipes values filled too early, so re-fill up to 5 times.
  async function fillAndKeep(el, value) {
    for (let i = 0; i < 5; i++) {
      el.focus();
      setValue(el, value);
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      await sleep(250);
      if (el.value === value) return true;
    }
    return false;
  }

  // Wait until the user has typed at least 4 characters and paused for 1 s.
  async function waitForTyping(input, ms = 3 * 60 * 1000) {
    const end = Date.now() + ms;
    let last = input.value, changed = Date.now();
    while (Date.now() < end && input.isConnected && visible(input)) {
      await sleep(100);
      if (input.value !== last) { last = input.value; changed = Date.now(); }
      if (last.trim().length >= 4 && Date.now() - changed > 1000) return true;
    }
    return false;
  }

  async function handleLogin() {
    if (loginBusy) return;
    const user = $$(LOGIN_USER).find(visible);
    if (!user || handledLogins.has(user)) return;
    handledLogins.add(user);
    loginBusy = true;
    try {
      activity('step', 'login pop-up found');
      const form = user.closest('form, app-login, .ui-dialog, .modal-content') || document;
      const pass = $$(LOGIN_PASS, form).find(visible);
      let login;
      try { login = await chrome.runtime.sendMessage({ type: 'getLogin' }); } catch (e) { login = { error: e.message }; }
      if (!login || login.none) return activity('error', 'login: no saved login. Open the popup > IRCTC login > Save login.');
      if (login.error) return activity('error', 'login: could not get saved login (' + login.error + '). Reload the extension and refresh this page.');

      if (!(await fillAndKeep(user, login.user))) return activity('error', 'login: user ID box keeps clearing; type it yourself');
      if (login.locked) return activity('error', `login: filled user ID ${login.user}; password is locked. Open the popup, enter your PIN and click Unlock; the pop-up is then filled and signed in automatically.`);
      if (!pass) return activity('error', 'login: password box not found');
      if (!(await fillAndKeep(pass, login.password))) return activity('error', 'login: password box keeps clearing; type it yourself');
      activity('ok', `login: filled user ID ${login.user} and password`);

      const signInButton = () => $$('button', form).filter(visible)
        .find((b) => /^\s*(SIGN ?IN|LOG ?IN)\s*$/i.test(text(b)) && !b.disabled);
      const errorText = () => text($$('.loginError, .error, .text-danger, .alert-danger, .invalid-feedback', form).find(visible));

      // Up to 3 rounds: click Sign In; if IRCTC then asks for a captcha, wait for the user to type it.
      for (let round = 1; round <= 3; round++) {
        const captcha = $$(LOGIN_CAPTCHA, form).find(visible);
        if (captcha) {
          captcha.scrollIntoView({ block: 'center' });
          captcha.focus();
          status('type the login captcha; Sign In is clicked when you stop typing');
          if (!(await waitForTyping(captcha))) {
            return activity(user.isConnected && visible(user) ? 'error' : 'ok', user.isConnected && visible(user) ? 'login: no captcha typed in 3 minutes' : 'logged in');
          }
        }
        const signIn = signInButton();
        if (!signIn) return activity('error', 'login: Sign In button not found; click it yourself');
        signIn.click();
        activity('step', `login: Sign In clicked${captcha ? ' (with captcha)' : ''}`);

        // Wait for: pop-up closed (done), a captcha box appearing, or an error message.
        const seenCaptcha = captcha;
        const outcome = await waitFor(() => {
          if (!user.isConnected || !visible(user)) return 'closed';
          const c = $$(LOGIN_CAPTCHA, form).find(visible);
          if (c && (c !== seenCaptcha || c.value === '')) return 'captcha';
          if (errorText()) return 'error';
          return null;
        }, 8000, 100);
        if (outcome === 'closed') return activity('ok', 'logged in');
        if (outcome === 'error') activity('error', 'login: IRCTC says "' + errorText().slice(0, 120) + '"');
        if (outcome === 'captcha') { activity('step', 'login: IRCTC asks for a captcha'); continue; }
        if (!outcome) return activity('error', 'login: no response after Sign In; check the pop-up');
        // Error message shown: refill the password in case IRCTC cleared it, then let the captcha round run.
        if (pass.value !== login.password) await fillAndKeep(pass, login.password);
        if (!$$(LOGIN_CAPTCHA, form).find(visible)) return activity('error', 'login: fix the error above and click Sign In yourself');
      }
      activity('error', 'login: still not signed in after 3 tries; finish it yourself');
    } finally {
      loginBusy = false;
    }
  }

  // Watch for pop-ups while a step runs and for as long as the extension is armed.
  // The login form is handled whenever it appears.
  let armedNow = false;
  chrome.storage.local.get(['armed'], ({ armed }) => { armedNow = !!armed; });
  setInterval(() => {
    if (location.hostname.includes('irctc.co.in')) handleLogin();
    if (running || armedNow) handleDialogs();
  }, 400);

  // ---------- step 1: journey search ----------
  const AUTOCOMPLETE_ITEMS = 'li.ui-autocomplete-list-item, .ui-autocomplete-items li, .ui-autocomplete-panel li, li[role="option"]';

  // Accept "GD" or a pasted IRCTC name like "GONDA JN. - GD (GONDA)"; return just the code.
  function stationCode(value) {
    const v = String(value).toUpperCase().trim();
    const m = v.match(/-\s*([A-Z0-9]{1,5})\b/);
    return m ? m[1] : v.replace(/[^A-Z0-9]/g, '');
  }

  async function pickStation(id, value) {
    const code = stationCode(value);
    if (!code) throw new Error(`empty station code "${value}"`);
    const input = await waitFor(() => $(`input#${id}, p-autocomplete#${id} input, #${id} input`));
    if (!input) throw new Error(`${id} station box not found`);
    await typeSlowly(input, code);
    // Prefer "NAME - CODE" (exact code), then the code as a separate word anywhere.
    const exact = new RegExp(`-\\s*${code}\\b`);
    const word = new RegExp(`\\b${code}\\b`);
    const item = await waitFor(() => {
      const items = $$(AUTOCOMPLETE_ITEMS).filter(visible);
      if (!items.length) return null;
      return items.find((li) => exact.test(text(li).toUpperCase())) ||
        items.find((li) => word.test(text(li).toUpperCase())) || null;
    }, 6000);
    if (!item) throw new Error(`no suggestion for station code ${code}`);
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    item.click();
    await waitFor(() => input.value.toUpperCase().length > code.length, 400, 20);
    LOG(id, '=', input.value);
  }

  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december'];

  async function pickDate(ddmmyyyy) {
    const [d, m, y] = ddmmyyyy.split('/').map(Number);
    if (!d || !m || !y) throw new Error('date must be DD/MM/YYYY');
    const input = await waitFor(() => $('p-calendar input, input#jDate'));
    if (!input) throw new Error('date box not found');
    input.click();
    input.focus();
    const picker = await waitFor(() => $('.ui-datepicker, .p-datepicker'), 2000);
    if (picker) {
      const titleOf = () => text($('.ui-datepicker-title, .p-datepicker-title', picker)).toLowerCase();
      for (let i = 0; i < 14; i++) {
        const title = titleOf();
        if ((title.includes(MONTHS[m - 1]) || title.includes(MONTHS[m - 1].slice(0, 3))) && title.includes(String(y))) break;
        const next = $('.ui-datepicker-next, .p-datepicker-next', picker);
        if (!next) break;
        next.click();
        await waitFor(() => titleOf() !== title, 400, 20);
      }
      const cell = $$('td:not(.ui-datepicker-other-month):not(.p-datepicker-other-month) a, ' +
        'td:not(.ui-datepicker-other-month):not(.p-datepicker-other-month) span', picker)
        .find((a) => text(a) === String(d) && !a.classList.contains('ui-state-disabled') && !a.classList.contains('p-disabled'));
      if (cell) {
        cell.click();
        await waitFor(() => input.value, 300, 20);
        LOG('date =', input.value);
        return;
      }
      LOG('day not clickable in calendar, typing date instead');
    }
    // Fallback: type the date (works when the input is not read-only).
    setValue(input, ddmmyyyy);
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    LOG('date typed =', input.value);
  }

  const CLASS_NAMES = {
    '1A': 'AC FIRST CLASS', '2A': 'AC 2 TIER', '3A': 'AC 3 TIER', '3E': 'AC 3 ECONOMY',
    SL: 'SLEEPER', CC: 'AC CHAIR CAR', EC: 'EXEC. CHAIR CAR', '2S': 'SECOND SITTING',
  };
  const DROPDOWN_ITEMS = 'p-dropdownitem li, li.ui-dropdown-item, li.p-dropdown-item, .ui-dropdown-items li';

  async function pickDropdown(name, matcher) {
    const root = await waitFor(() => $(`p-dropdown[formcontrolname="${name}"], p-dropdown#${name}, #${name}`));
    if (!root) throw new Error(`${name} dropdown not found`);
    if (root.tagName === 'SELECT') {
      const opt = [...root.options].find((o) => matcher(o.text.toUpperCase()));
      if (!opt) throw new Error(`no ${name} option matched`);
      return setValue(root, opt.value);
    }
    ($('div.ui-dropdown, div.p-dropdown, .ui-dropdown-trigger, .p-dropdown-trigger', root) || root).click();
    const item = await waitFor(() => $$(DROPDOWN_ITEMS).filter(visible).find((li) => matcher(text(li).toUpperCase())), 3000);
    if (!item) {
      document.body.click();
      throw new Error(`no ${name} option matched`);
    }
    item.click();
    await waitFor(() => !$$(DROPDOWN_ITEMS).some(visible), 300, 20);
    LOG(name, '=', text(item));
  }

  // Each field is tried on its own. A failure is logged and the rest still runs, so a field
  // you filled by hand does not stop the search.
  async function tryField(label, fn) {
    try { await fn(); return true; } catch (e) {
      activity('error', `${label}: ${e.message} (skipped)`);
      document.body.click();
      return false;
    }
  }

  async function fillSearch(cfg) {
    status('filling journey');
    const started = Date.now();
    let failed = 0;
    if (cfg.from && !(await tryField('From', () => pickStation('origin', cfg.from)))) failed++;
    if (cfg.to && !(await tryField('To', () => pickStation('destination', cfg.to)))) failed++;
    if (cfg.date && !(await tryField('Date', () => pickDate(cfg.date)))) failed++;
    document.body.click();
    if (cfg.cls) {
      const full = CLASS_NAMES[cfg.cls];
      if (!(await tryField('Class', () => pickDropdown('journeyClass', (t) => t.includes(`(${cfg.cls})`) || (full && t.includes(full)))))) failed++;
    }
    if (cfg.quota && !(await tryField('Quota', () => pickDropdown('journeyQuota', (t) => t === cfg.quota.toUpperCase())))) failed++;
    if (failed) activity('error', `${failed} field(s) not filled; check the form before the search runs`);
    activity('info', `journey filled in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }

  function clickSearch() {
    const btn = $('button.search_btn.train_Search') || $('button.search_btn') ||
      $$('button').find((b) => /SEARCH|FIND TRAINS/.test(text(b).toUpperCase()));
    if (!btn) throw new Error('Search button not found');
    btn.scrollIntoView({ block: 'center' });
    btn.click();
    activity('ok', 'Search clicked');
  }

  // Find a visible, enabled forward button (Continue / Pay & Book) and never Back / Modify / Cancel.
  function forwardButton(pattern) {
    return $$('button, input[type="submit"], input[type="button"]').filter(visible).find((b) => {
      const t = (text(b) || b.value || '').toUpperCase();
      return !b.disabled && pattern.test(t) && !/BACK|MODIFY|CANCEL|RESET/.test(t);
    }) || null;
  }

  // Wait for hh:mm:ss on IRCTC's clock. Re-syncs once about 45 s before the target.
  async function waitUntil(hhmmss) {
    const [h, m, s = 0] = hhmmss.split(':').map(Number);
    const targetLocal = () => { const t = new Date(serverNow()); t.setHours(h, m, s, 0); return t.getTime(); };
    const target = targetLocal();
    if (target <= serverNow()) return activity('info', `${hhmmss} has already passed on IRCTC's clock; searching now`);
    let resynced = target - serverNow() < 60000;
    while (true) {
      const diff = target - serverNow();
      if (diff <= 0) break;
      if (!resynced && diff < 45000) { resynced = true; await syncServerTime(4); continue; }
      panel.textContent = `Tatkal Autofill: waiting ${Math.ceil(diff / 1000)}s until ${hhmmss} (IRCTC time)`;
      await sleep(Math.min(diff, diff > 2000 ? 250 : 10));
    }
  }

  async function searchStep(cfg) {
    await fillSearch(cfg);
    if (cfg.start && dryRun) activity('info', `dry run: ignoring start time ${cfg.start}`);
    else if (cfg.start) {
      activity('step', `waiting until ${cfg.start} IRCTC time to click Search (countdown in the box at the bottom right of the page)`);
      await syncServerTime();
      await waitUntil(cfg.start);
    }
    status('searching');
    clickSearch();
  }

  // ---------- step 2: train list ----------
  // Picks the train, class and date, then waits for Book Now. If seats are not shown yet
  // (common in the first seconds of Tatkal), it refreshes the class every 2 s up to the retry limit.
  async function trainListStep(cfg) {
    status('looking for train ' + cfg.train);
    const card = await waitFor(() => $$('app-train-avl-enq').find((c) =>
      text($('.train-heading strong', c) || c).includes(cfg.train)), 20000);
    if (!card) return status(`train ${cfg.train} not in results`, 'error');
    card.scrollIntoView({ block: 'center' });

    // Pick the innermost matching element, since the click handler sits on div.pre-avl, not the td.
    const findClassTile = () => {
      const matches = $$('.pre-avl, td', card).filter((el) => text(el).includes(`(${cfg.cls})`));
      return matches.find((el) => !matches.some((o) => o !== el && el.contains(o)));
    };
    const day = parseInt(cfg.date.split('/')[0], 10);
    const dayRe = new RegExp(`\\b0?${day}\\b`);
    const isDateCell = (el) => /\b(MON|TUE|WED|THU|FRI|SAT|SUN)\b/i.test(text(el.closest('td') || el));
    const findDateCell = () => {
      const cells = $$('td.link div.pre-avl, div.pre-avl', card).filter((c) => !text(c).includes(`(${cfg.cls})`) && isDateCell(c));
      if (!cells.length) return null;
      return cells.find((c) => dayRe.test(text(c))) ||
        cells.find((c) => !/NOT AVAILABLE|REGRET/i.test(text(c.closest('td') || c)));
    };
    const findBook = () => {
      const b = $$('button', card).find((x) => /BOOK NOW/i.test(text(x)));
      return b && !b.disabled && !b.classList.contains('disable-book') ? b : null;
    };

    const retryMs = Math.max(0, Number(cfg.retrySec ?? 30)) * 1000;
    const deadline = Date.now() + retryMs;
    for (let attempt = 1; ; attempt++) {
      const classTile = findClassTile();
      if (!classTile) return status(`class ${cfg.cls} not offered on ${cfg.train}`, 'error');
      // Remember the current cells so a refresh is not judged on the old, not-yet-updated ones.
      const before = findDateCell();
      const beforeText = before ? text(before.closest('td') || before) : null;
      classTile.click();
      status(attempt === 1 ? 'checking availability' : `refresh ${attempt}: checking availability`);
      if (before) {
        await waitFor(() => !before.isConnected || text(before.closest('td') || before) !== beforeText, 3000, 50);
      }
      // If nothing changed within 3 s, the availability is genuinely the same; use what is shown.
      const dateCell = await waitFor(findDateCell, attempt === 1 ? 15000 : 3000, 50);
      if (dateCell) {
        dateCell.click();
        const avail = text(dateCell.closest('td') || dateCell);
        LOG('availability:', avail);
        const book = await waitFor(findBook, 1500, 50);
        if (book) {
          status('booking');
          book.click();
          return;
        }
        if (/REGRET|NOT AVAILABLE|TRAIN DEPARTED/i.test(avail)) activity('info', 'no seats shown yet: ' + avail);
      }
      if (Date.now() >= deadline) {
        return status(retryMs ? `Book Now still not enabled after ${retryMs / 1000}s of refreshing` : 'Book Now not enabled (no seats or not open yet)', 'error');
      }
      await sleep(2000);
    }
  }

  // ---------- step 3: passengers ----------
  function parsePassengers(raw) {
    return raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      // Berth and food are optional, so missing columns default to ''.
      const [name = '', age = '', gender = '', berth = '', food = ''] = l.split(',').map((x) => x.trim());
      return { name, age, gender: (gender || 'M').toUpperCase()[0], berth: berth.toUpperCase(), food: (food.toUpperCase()[0] || '') };
    });
  }

  const BERTH_LABEL = { LB: 'LOWER', MB: 'MIDDLE', UB: 'UPPER', SL: 'SIDE LOWER', SU: 'SIDE UPPER', WS: 'WINDOW' };
  const FOOD_LABEL = { V: 'VEG', N: 'NON VEG', D: 'NO FOOD' };

  function selectOption(sel, code, labels) {
    if (!sel || !code) return;
    const opts = [...sel.options];
    const label = labels[code];
    const opt = opts.find((o) => o.value === code) ||
      (label && opts.find((o) => o.text.toUpperCase().replace(/-/g, ' ').trim() === label)) ||
      (label && opts.find((o) => o.text.toUpperCase().replace(/-/g, ' ').startsWith(label)));
    if (opt) setValue(sel, opt.value);
  }

  // Set an IRCTC checkbox to the wanted state. Only clicks when it differs, so it never untoggles.
  async function setCheckbox(id, label, want) {
    const box = $(`input#${id}`);
    if (!box) return activity('error', `${label}: checkbox not found`);
    if (box.checked !== want) {
      box.click();
      await waitFor(() => box.checked === want, 200, 20);
      // PrimeNG may keep the real input hidden; fall back to its visible box or label.
      if (box.checked !== want) {
        const alt = box.closest('p-checkbox, .ui-chkbox, div')?.querySelector('.ui-chkbox-box, label') ||
          $(`label[for="${id}"]`);
        if (alt) { alt.click(); await waitFor(() => box.checked === want, 200, 20); }
      }
    }
    activity(box.checked === want ? 'info' : 'error', `${label}: ${box.checked ? 'ticked' : 'not ticked'}`);
  }

  // "Pay through BHIM/UPI" and not the card option, whose text also contains "UPI_CC / UPI_CL".
  const isBhimUpi = (t) => /BHIM/i.test(t) && !/CREDIT|DEBIT|NET ?BANKING|UPI_C/i.test(t);

  // Text shown next to a radio. PrimeNG hides the real input in a wrapper without text, so use
  // the p-radiobutton component, a <label for>, or the nearest ancestor that has short text.
  function radioLabel(r) {
    const comp = r.closest('p-radiobutton');
    if (comp && text(comp)) return { text: text(comp), target: $('.ui-radiobutton-box, .p-radiobutton-box, label', comp) };
    const forLabel = r.id && $(`label[for="${r.id}"]`);
    if (forLabel) return { text: text(forLabel), target: forLabel };
    for (let el = r.parentElement; el && el !== document.body; el = el.parentElement) {
      const t = text(el);
      if (t) return t.length < 200 ? { text: t, target: el.querySelector('.ui-radiobutton-box, label') } : null;
    }
    return null;
  }

  const radioChecked = (r) => r.checked ||
    !!r.closest('p-radiobutton')?.querySelector('.ui-radiobutton-box.ui-state-active, .p-radiobutton-box.p-highlight');

  async function choosePaymentMode() {
    const radios = $$('input[type="radio"][name="paymentType"]');
    const pool = radios.length ? radios : $$('input[type="radio"]');
    const options = pool.map((r) => ({ r, label: radioLabel(r) })).filter((o) => o.label);
    const upi = options.find((o) => isBhimUpi(o.label.text));
    if (!upi) {
      activity('error', 'payment mode "Pay through BHIM/UPI" not found; options seen: ' +
        (options.map((o) => `"${o.label.text.slice(0, 40)}"`).join(', ') || 'none'));
      return;
    }
    if (!radioChecked(upi.r)) {
      // Click what the user would click (the circle or label); fall back to the hidden input.
      if (upi.label.target) upi.label.target.click();
      await waitFor(() => radioChecked(upi.r), 300, 20);
      if (!radioChecked(upi.r)) { upi.r.click(); await waitFor(() => radioChecked(upi.r), 300, 20); }
    }
    activity(radioChecked(upi.r) ? 'info' : 'error',
      radioChecked(upi.r) ? 'payment mode: Pay through BHIM/UPI' : 'could not select "Pay through BHIM/UPI"; select it yourself');
  }

  async function passengerStep(cfg) {
    const list = parsePassengers(cfg.passengers || '');
    if (!list.length) return status('no passengers saved', 'error');
    status('filling passengers');
    const started = Date.now();
    await waitFor(() => $('app-passenger'), 15000);
    for (let i = 0; i < list.length; i++) {
      if ($$('app-passenger').length <= i) {
        const add = $('button.add_psgn, a.add_psgn_btn') ||
          $$('a, span, button').find((e) => /^\+?\s*ADD PASSENGER/i.test(text(e)));
        if (!add) return status('Add Passenger link not found', 'error');
        add.click();
      }
      const row = await waitFor(() => $$('app-passenger')[i]);
      if (!row) return status(`passenger row ${i + 1} not found`, 'error');
      const p = list[i];
      const name = $('input[formcontrolname="passengerName"], p-autocomplete input, input[placeholder="Name"]', row);
      if (name) { name.focus(); setValue(name, p.name); name.dispatchEvent(new Event('blur', { bubbles: true })); }
      const age = $('input[formcontrolname="passengerAge"], input[placeholder="Age"]', row);
      if (age) { age.focus(); setValue(age, p.age); age.dispatchEvent(new Event('blur', { bubbles: true })); }
      const gender = $('select[formcontrolname="passengerGender"]', row);
      if (gender) setValue(gender, p.gender);
      selectOption($('select[formcontrolname="passengerBerthChoice"]', row), p.berth, BERTH_LABEL);
      selectOption($('select[formcontrolname="passengerFoodChoice"]', row), p.food, FOOD_LABEL);
      LOG('passenger', i + 1, p.name);
      await sleep(30);
    }
    if (cfg.mobile) {
      const mob = $('input[formcontrolname="mobileNumber"], input#mobileNumber');
      if (mob) setValue(mob, cfg.mobile);
    }

    // Booking options. Missing settings (saved by older versions) default to ticked.
    await setCheckbox('autoUpgradation', 'Consider for auto upgradation', cfg.autoUpgrade !== false);
    await setCheckbox('confirmberths', 'Book only if confirm berths are allotted', cfg.confirmOnly !== false);
    activity('ok', `passengers filled in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    if (dryRun) checkPage();

    if (!cfg.autoContinue && !dryRun) {
      status('passengers filled. Check them, then click Continue yourself.', 'ok');
      return chrome.storage.local.set({ armed: false });
    }

    await choosePaymentMode();

    await sleep(150);
    const cont = forwardButton(/CONTINUE|PROCEED|NEXT/);
    if (!cont) return status('Continue button not found on passenger page', 'error');
    status('passenger Continue clicked');
    cont.click();
  }

  // ---------- step 4: review booking (captcha) ----------
  // IRCTC sometimes shows a captcha here and sometimes not (often not when you logged in with one).
  // No captcha: click Continue straight away. Captcha: wait for the user to type it, then Continue.
  const REVIEW_CAPTCHA = 'input#captcha, input[formcontrolname="captcha"], input[name="captcha"], input#nlpAnswer, input[placeholder*="aptcha"]';
  async function reviewStep(cfg) {
    if (!cfg.autoContinue && !dryRun) return;
    const onReview = () => location.href.includes('reviewBooking');
    const end = Date.now() + 3 * 60 * 1000;
    status('review page: waiting for Continue');
    for (let round = 1; round <= 5 && Date.now() < end && onReview(); round++) {
      const cont0 = await waitFor(() => forwardButton(/CONTINUE|PROCEED|PAY/), 15000, 100);
      if (!cont0) return status('Continue button not found on review page', 'error');
      // Give a captcha box a moment to render before deciding there is none.
      const captcha = await waitFor(() => $$(REVIEW_CAPTCHA).find(visible), round === 1 ? 1200 : 300, 50);
      if (captcha) {
        captcha.scrollIntoView({ block: 'center' });
        captcha.focus();
        status('type the captcha; Continue is clicked when you stop typing');
        if (!(await waitForTyping(captcha, end - Date.now()))) {
          if (!onReview()) return;
          return status('no captcha typed in 3 minutes', 'error');
        }
        if (!onReview()) return;
      }
      const cont = forwardButton(/CONTINUE|PROCEED|PAY/);
      if (!cont) return status('Continue button not found on review page', 'error');
      status(captcha ? 'review Continue clicked' : 'review Continue clicked (no captcha on this page)');
      cont.click();
      // Leaves the page: done. Stays with an empty or new captcha: wrong captcha, or IRCTC now wants one.
      const left = await waitFor(() => !onReview() || ($$(REVIEW_CAPTCHA).find(visible)?.value === '' && (!captcha || !captcha.isConnected || captcha.value === '')), 8000, 100);
      if (!onReview()) return;
      if (!left) return status('still on review page after Continue; check the page for a message', 'error');
      activity('error', captcha ? 'still on review page (wrong captcha?); type the new one' : 'IRCTC now asks for a captcha; type it');
    }
  }

  // ---------- step 5: payment options ----------
  // Payment Methods page: left column = methods (#pay-type .bank-type), right side = providers
  // (#bank-type .bank-text). Choose "IRCTC iPay" then the "IRCTC iPay New" tile, then Pay & Book.
  const PAY_METHODS = '#pay-type .bank-type, .bank-type';
  const PAY_PROVIDERS = '#bank-type .bank-text, #bank-type .pay_tax_text, .bank-text';
  const isActive = (el) => /active|selected/i.test(el.className) || !!el.querySelector('[class*="active"], [class*="selected"]');

  async function paymentStep(cfg) {
    if (!cfg.autoContinue && !dryRun) return;
    status('choosing payment method');
    await waitFor(() => $$(PAY_METHODS).some(visible), 15000);
    await sleep(200);

    // 1. Method: IRCTC iPay (fallback: a BHIM/UPI method). Click only if not already selected.
    const methods = $$(PAY_METHODS).filter(visible);
    const method = methods.find((m) => /IRCTC\s*i-?Pay/i.test(text(m))) ||
      methods.find((m) => isBhimUpi(text(m)) || (/UPI/i.test(text(m)) && !/CREDIT|DEBIT|NET ?BANKING|UPI_C/i.test(text(m))));
    if (method) {
      if (!isActive(method)) { method.click(); await sleep(300); }
      activity('info', 'payment method: ' + text(method).slice(0, 60));
    } else {
      activity('error', 'IRCTC iPay method not found; methods seen: ' + methods.map((m) => `"${text(m).slice(0, 40)}"`).join(', '));
    }

    // 2. Provider tile: "IRCTC iPay New" (fallbacks: any "IRCTC iPay" tile, or the only tile shown).
    const providers = () => $$(PAY_PROVIDERS).filter(visible).filter((p) => text(p));
    const provider = await waitFor(() => {
      const list = providers();
      return list.find((p) => /IRCTC\s*i-?Pay\s*New/i.test(text(p))) ||
        list.find((p) => /IRCTC\s*i-?Pay/i.test(text(p))) || (list.length === 1 ? list[0] : null);
    }, 5000, 100);
    if (provider) {
      provider.click();
      activity('info', 'payment provider: ' + text(provider).slice(0, 60));
      await sleep(300);
    } else {
      activity('error', 'IRCTC iPay New tile not found; tiles seen: ' + (providers().map((p) => `"${text(p).slice(0, 40)}"`).join(', ') || 'none'));
    }

    // 3. Pay & Book.
    const pay = await waitFor(() => $$('button.btn-primary, button').filter(visible)
      .find((b) => /PAY\s*&\s*BOOK|PAY AND BOOK/i.test(text(b)) && !b.disabled) || forwardButton(/PAY\s*&\s*BOOK|PAY AND BOOK|PAY/), 8000, 100);
    if (!pay) return status('Pay & Book button not found', 'error');
    if (dryRun) {
      status(`dry run finished: found "${text(pay) || pay.value}" and did NOT click it. Nothing was booked or paid.`, 'ok');
      return chrome.storage.local.set({ armed: false, dryRun: false });
    }
    status('Pay & Book clicked');
    pay.click();
  }

  // ---------- step 6: IRCTC iPay gateway (UPI ID) ----------
  async function gatewayStep(cfg) {
    if (dryRun) return status('dry run: on payment gateway, doing nothing', 'error');
    if (!cfg.autoContinue) return;
    if (!cfg.upi) return status('no UPI ID saved; enter it on this page yourself', 'error');
    status('filling UPI ID on payment gateway');
    const radio = await waitFor(() => $('input#mandateUPI, input[name="mandateType"][value="upiMandate"]') ||
      $$('input[type="radio"]').find((r) => {
        const t = text(r.closest('label') || r.parentElement);
        return /UPI/i.test(t) && t.length < 150;
      }), 15000);
    if (radio) radio.click();
    const vpa = await waitFor(() => $$('input#mndtVpa, input[placeholder*="UPI" i], input[placeholder*="VPA" i]').find(visible), 10000);
    if (!vpa) return status('UPI ID box not found on gateway', 'error');
    vpa.focus();
    setValue(vpa, cfg.upi);
    vpa.dispatchEvent(new Event('blur', { bubbles: true }));
    await sleep(200);
    const pay = $('input#autoDebitBtn, .payment-btn-autoDebit') || forwardButton(/PAY|PROCEED|VERIFY/);
    if (!pay) return status('Pay button not found on gateway', 'error');
    pay.click();
    status('UPI request sent. Approve the payment in your UPI app.', 'ok');
    chrome.storage.local.set({ armed: false });
  }

  // ---------- router ----------
  let running = false;
  let rerun = false;
  async function run(force, fromRouteChange = false) {
    if (running) { if (fromRouteChange) rerun = true; return; }
    const { config: cfg, armed, dryRun: dry } = await getStore();
    if (!cfg) return status('no saved settings (open the extension popup)', 'error');
    if (!armed && !force) return status(armed === false ? 'disarmed' : 'idle (not armed)', 'info');
    dryRun = !!dry;
    running = true;
    try {
      handleDialogs();
      const url = location.href;
      if (location.hostname.includes('irctcipay')) await gatewayStep(cfg);
      else if (url.includes('train-list')) await trainListStep(cfg);
      else if (url.includes('psgninput')) await passengerStep(cfg);
      else if (url.includes('reviewBooking')) await reviewStep(cfg);
      else if (/bkgPaymentOptions|\/payment\//.test(url)) await paymentStep(cfg);
      else if (url.includes('train-search')) { if (dryRun) checkPage(); await searchStep(cfg); }
      else status('this page is not handled: ' + location.pathname + ' (open the train search page)', 'error');
    } catch (e) {
      status('error: ' + e.message, 'error');
    } finally {
      running = false;
      // The page changed while a step was still finishing; run the new page's step now.
      if (rerun) { rerun = false; setTimeout(() => run(false), 0); }
    }
  }

  // ---------- page check (popup "Check page" button, and every page in a dry run) ----------
  const CHECKS = {
    'train-search': {
      'From station box': 'input#origin, p-autocomplete#origin input',
      'To station box': 'input#destination, p-autocomplete#destination input',
      'Date box': 'p-calendar input, input#jDate',
      'Class dropdown': 'p-dropdown[formcontrolname="journeyClass"], p-dropdown#journeyClass, #journeyClass',
      'Quota dropdown': 'p-dropdown[formcontrolname="journeyQuota"], p-dropdown#journeyQuota, #journeyQuota',
      'Search button': 'button.search_btn',
    },
    'train-list': {
      'Train cards': 'app-train-avl-enq',
      'Train headings': '.train-heading strong',
      'Class / date tiles': '.pre-avl',
    },
    psgninput: {
      'Passenger rows': 'app-passenger',
      'Name box': 'app-passenger input[formcontrolname="passengerName"], app-passenger p-autocomplete input, app-passenger input[placeholder="Name"]',
      'Age box': 'input[formcontrolname="passengerAge"], input[placeholder="Age"]',
      'Gender select': 'select[formcontrolname="passengerGender"]',
      'Berth select': 'select[formcontrolname="passengerBerthChoice"]',
      'Mobile box': 'input[formcontrolname="mobileNumber"], input#mobileNumber',
      'Auto upgradation checkbox': 'input#autoUpgradation',
      'Confirm berths only checkbox': 'input#confirmberths',
      'Payment mode options': 'input[type="radio"][name="paymentType"]',
    },
  };

  function checkPage() {
    const key = Object.keys(CHECKS).find((k) => location.href.includes(k));
    activity('step', 'page check: ' + location.href);
    if ($$(LOGIN_USER).some(visible)) {
      const n = (sel) => $$(sel).filter(visible).length;
      activity('step', 'login pop-up is open');
      activity(n(LOGIN_USER) ? 'ok' : 'error', `Login user ID box: ${n(LOGIN_USER)} found`);
      activity(n(LOGIN_PASS) ? 'ok' : 'error', `Login password box: ${n(LOGIN_PASS)} found`);
      activity('info', `Login captcha box: ${n(LOGIN_CAPTCHA)} found (IRCTC may only show it after Sign In)`);
      const btn = $$('button').filter(visible).find((b) => /^\s*(SIGN ?IN|LOG ?IN)\s*$/i.test(text(b)));
      activity(btn ? 'ok' : 'error', `Sign In button: ${btn ? 'found' : 'NOT FOUND'}`);
      const u = $$(LOGIN_USER).find(visible);
      activity('info', 'user ID box attributes: ' + [...u.attributes].map((a) => `${a.name}="${a.value}"`).join(' ').slice(0, 200));
    }
    if (!key) {
      activity('error', 'not a page this extension fills. Open https://www.irctc.co.in/nget/train-search');
      return;
    }
    let missing = 0;
    for (const [label, sel] of Object.entries(CHECKS[key])) {
      const n = $$(sel).length;
      if (!n) missing++;
      activity(n ? 'ok' : 'error', `${label}: ${n ? n + ' found' : 'NOT FOUND'}`);
    }
    activity(missing ? 'error' : 'ok', missing ? `${missing} element(s) missing on this page` : 'all elements found');
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'ping') reply({ ok: true, page: location.pathname });
    else if (msg.type === 'check') { checkPage(); reply({ ok: true }); }
    else if (msg.type === 'run') { retryLogin(); run(true); reply({ ok: true }); }
    else if (msg.type === 'login') { retryLogin(); reply({ ok: true }); }
    else if (msg.type === 'sync') { syncServerTime().then(() => reply({ ok: true, offset: clockOffset })); return true; }
  });

  // Start as soon as the user arms from the popup.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.armed) return;
    armedNow = !!changes.armed.newValue;
    if (armedNow) run(false);
  });

  // IRCTC is a single-page app, so watch for route changes.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; run(false, true); }
  }, 200);

  panel.addEventListener('click', () => { retryLogin(); run(true); });
  run(false);
})();
