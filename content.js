// IRCTC Tatkal Autofill content script.
// Selectors target IRCTC's Angular site and may need updating when it changes.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeout = 8000, step = 100) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  function setValue(el, value) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  const byText = (selector, text, root = document) =>
    [...root.querySelectorAll(selector)].find((e) => e.textContent.toLowerCase().includes(text.toLowerCase()));

  const getStore = () => new Promise((r) => chrome.storage.local.get(['config', 'armed'], r));

  // ---------- status panel ----------
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;bottom:12px;right:12px;z-index:99999;background:#222;color:#fff;' +
    'font:12px system-ui;padding:8px 10px;border-radius:6px;max-width:260px;opacity:.92';
  panel.textContent = 'Tatkal Autofill: idle';
  document.documentElement.appendChild(panel);
  const status = (t) => (panel.textContent = 'Tatkal Autofill: ' + t);

  // ---------- step 1: journey search ----------
  async function pickStation(rootSel, code) {
    const input = await waitFor(() => document.querySelector(rootSel + ' input'));
    if (!input) throw new Error('station input not found: ' + rootSel);
    input.focus();
    setValue(input, code);
    const item = await waitFor(() =>
      [...document.querySelectorAll('.ui-autocomplete-items li, .ui-autocomplete-panel li')]
        .find((li) => li.textContent.toUpperCase().includes('- ' + code) || li.textContent.toUpperCase().includes(code)));
    if (!item) throw new Error('station ' + code + ' not in suggestions');
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    item.click();
    await sleep(300);
  }

  async function pickDropdown(rootSel, matcher) {
    const root = await waitFor(() => document.querySelector(rootSel));
    if (!root) throw new Error('dropdown not found: ' + rootSel);
    (root.querySelector('div[role="button"], .ui-dropdown-trigger, div') || root).click();
    const item = await waitFor(() =>
      [...document.querySelectorAll('p-dropdownitem li, .ui-dropdown-items li')].find((li) => matcher(li.textContent)));
    if (!item) throw new Error('dropdown option not found in ' + rootSel);
    item.click();
  }

  async function fillSearch(cfg) {
    status('filling journey');
    await pickStation('#origin', cfg.from);
    await pickStation('#destination', cfg.to);
    const date = await waitFor(() => document.querySelector('#jDate input'));
    if (date) { date.focus(); setValue(date, cfg.date); }
    if (cfg.cls) await pickDropdown('#journeyClass', (t) => t.includes('(' + cfg.cls + ')'));
    if (cfg.quota) await pickDropdown('#journeyQuota', (t) => t.trim().toUpperCase() === cfg.quota.toUpperCase());
  }

  function clickSearch() {
    const btn = document.querySelector('button.search_btn') || byText('button', 'Search');
    if (btn) btn.click();
  }

  function waitUntil(hhmmss) {
    const [h, m, s = 0] = hhmmss.split(':').map(Number);
    return new Promise((resolve) => {
      const tick = () => {
        const now = new Date();
        const target = new Date(now); target.setHours(h, m, s, 0);
        const diff = target - now;
        if (diff <= 0) return resolve();
        status('waiting ' + Math.ceil(diff / 1000) + 's until ' + hhmmss);
        setTimeout(tick, Math.min(diff, 250));
      };
      tick();
    });
  }

  async function searchStep(cfg) {
    await fillSearch(cfg);
    if (cfg.start) await waitUntil(cfg.start);
    status('searching');
    clickSearch();
  }

  // ---------- step 2: train list ----------
  async function trainListStep(cfg) {
    status('looking for train ' + cfg.train);
    const card = await waitFor(() =>
      [...document.querySelectorAll('app-train-avl-enq')].find((c) => c.textContent.includes('(' + cfg.train + ')')), 20000);
    if (!card) return status('train ' + cfg.train + ' not found');
    const tile = byText('.pre-avl, .tbis-div td', '(' + cfg.cls + ')', card);
    if (tile) tile.click();
    await sleep(500);
    // pick the date tile that matches the searched date, else the first available one
    const day = parseInt(cfg.date.split('/')[0], 10);
    const dateTile = await waitFor(() =>
      [...card.querySelectorAll('td .pre-avl, td')].find((t) => new RegExp('\\b0?' + day + '\\b').test(t.textContent) && /,|\w{3}/.test(t.textContent)));
    if (dateTile) dateTile.click();
    await sleep(500);
    const book = await waitFor(() => byText('button', 'Book Now', card), 6000);
    if (book && !book.disabled) { status('booking'); book.click(); }
    else status('Book Now not available; check seats');
  }

  // ---------- step 3: passengers ----------
  function parsePassengers(text) {
    return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, age, gender, berth] = l.split(',').map((x) => x.trim());
      return { name, age, gender: (gender || 'M').toUpperCase(), berth: (berth || '').toUpperCase() };
    });
  }

  const BERTH_LABEL = { LB: 'Lower', MB: 'Middle', UB: 'Upper', SL: 'Side Lower', SU: 'Side Upper', WS: 'Window' };

  async function passengerStep(cfg) {
    const list = parsePassengers(cfg.passengers || '');
    if (!list.length) return status('no passengers saved');
    status('filling passengers');
    for (let i = 0; i < list.length; i++) {
      if (i > 0) {
        const add = await waitFor(() => byText('a, span, button', 'Add Passenger'));
        if (add) add.click();
      }
      const rows = await waitFor(() => {
        const r = document.querySelectorAll('app-passenger');
        return r.length > i ? r : null;
      });
      if (!rows) return status('passenger row ' + (i + 1) + ' not found');
      const row = rows[i];
      const p = list[i];
      const name = row.querySelector('p-autocomplete input, input[placeholder="Name"]');
      if (name) { name.focus(); setValue(name, p.name); }
      const age = row.querySelector('input[formcontrolname="passengerAge"]');
      if (age) setValue(age, p.age);
      const gender = row.querySelector('select[formcontrolname="passengerGender"]');
      if (gender) setValue(gender, p.gender);
      const berth = row.querySelector('select[formcontrolname="passengerBerthChoice"]');
      if (berth && p.berth && BERTH_LABEL[p.berth]) {
        const opt = [...berth.options].find((o) => o.text.includes(BERTH_LABEL[p.berth]));
        if (opt) setValue(berth, opt.value);
      }
    }
    if (cfg.mobile) {
      const mob = document.querySelector('input#mobileNumber, input[formcontrolname="mobileNumber"]');
      if (mob) setValue(mob, cfg.mobile);
    }
    status('passengers filled. Review, then continue, solve captcha and pay yourself.');
    chrome.storage.local.set({ armed: false });
  }

  // ---------- router ----------
  let running = false;
  async function run(force) {
    if (running) return;
    const { config: cfg, armed } = await getStore();
    if (!cfg) return status('no saved settings (open the extension popup)');
    if (!armed && !force) return status(armed === false ? 'disarmed' : 'idle');
    running = true;
    try {
      const url = location.href;
      if (url.includes('train-list')) await trainListStep(cfg);
      else if (url.includes('psgninput')) await passengerStep(cfg);
      else if (url.includes('train-search')) await searchStep(cfg);
      else status('open the train search page');
    } catch (e) {
      status('error: ' + e.message);
    } finally {
      running = false;
    }
  }

  // Start immediately when the user arms from the popup on an already-open page.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.armed && changes.armed.newValue === true) run(false);
  });

  // The site is a single-page app, so watch for route changes.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; run(false); }
  }, 500);

  panel.style.cursor = 'pointer';
  panel.title = 'Click to run the step for this page now';
  panel.addEventListener('click', () => run(true));

  run(false);
})();
