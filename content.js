// IRCTC Tatkal Autofill content script.
// Selectors follow IRCTC's Angular/PrimeNG pages. If a step fails, the status box
// and the DevTools console (prefix [Tatkal]) say which element was not found.
(() => {
  // The popup may inject this file into a tab that already has it; run only once per page.
  if (window.__tatkalAutofill) return;
  window.__tatkalAutofill = true;

  // ---------- activity log (shown in the popup) ----------
  const MAX_LOG = 200;
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

  async function waitFor(fn, timeout = 8000, step = 100) {
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
  async function typeSlowly(el, value, delay = 60) {
    el.focus();
    el.click();
    setValue(el, '');
    for (let i = 1; i <= value.length; i++) {
      setValue(el, value.slice(0, i));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: value[i - 1], bubbles: true }));
      await sleep(delay);
    }
  }

  const getStore = () => new Promise((r) => chrome.storage.local.get(['config', 'armed'], r));

  // ---------- status panel ----------
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;bottom:12px;right:12px;z-index:2147483647;background:#222;color:#fff;' +
    'font:12px system-ui;padding:8px 10px;border-radius:6px;max-width:280px;opacity:.92;cursor:pointer';
  panel.title = 'Click to run the step for this page now';
  document.documentElement.appendChild(panel);
  const status = (t, level = 'step') => { panel.textContent = 'Tatkal Autofill: ' + t; activity(level, t); };
  activity('info', 'extension loaded on ' + location.pathname);
  panel.textContent = 'Tatkal Autofill: idle';

  // ---------- step 1: journey search ----------
  const AUTOCOMPLETE_ITEMS = 'li.ui-autocomplete-list-item, .ui-autocomplete-items li, .ui-autocomplete-panel li, li[role="option"]';

  async function pickStation(id, code) {
    const input = await waitFor(() => $(`input#${id}, p-autocomplete#${id} input, #${id} input`));
    if (!input) throw new Error(`${id} station box not found`);
    await typeSlowly(input, code);
    const item = await waitFor(() => {
      const items = $$(AUTOCOMPLETE_ITEMS).filter(visible);
      return items.find((li) => new RegExp(`\\b${code}\\b`).test(text(li).toUpperCase())) || null;
    }, 5000);
    if (!item) throw new Error(`no suggestion for station ${code}`);
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    item.click();
    await sleep(300);
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
      for (let i = 0; i < 14; i++) {
        const title = text($('.ui-datepicker-title, .p-datepicker-title', picker)).toLowerCase();
        if (title.includes(MONTHS[m - 1]) || title.includes(MONTHS[m - 1].slice(0, 3))) {
          if (title.includes(String(y))) break;
        }
        const next = $('.ui-datepicker-next, .p-datepicker-next', picker);
        if (!next) break;
        next.click();
        await sleep(200);
      }
      const cell = $$('td:not(.ui-datepicker-other-month):not(.p-datepicker-other-month) a, ' +
        'td:not(.ui-datepicker-other-month):not(.p-datepicker-other-month) span', picker)
        .find((a) => text(a) === String(d) && !a.classList.contains('ui-state-disabled') && !a.classList.contains('p-disabled'));
      if (cell) {
        cell.click();
        await sleep(200);
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

  async function pickDropdown(name, matcher) {
    const root = await waitFor(() => $(`p-dropdown[formcontrolname="${name}"], p-dropdown#${name}, #${name}`));
    if (!root) throw new Error(`${name} dropdown not found`);
    if (root.tagName === 'SELECT') {
      const opt = [...root.options].find((o) => matcher(o.text.toUpperCase()));
      if (!opt) throw new Error(`no ${name} option matched`);
      return setValue(root, opt.value);
    }
    ($('div.ui-dropdown, div.p-dropdown, .ui-dropdown-trigger, .p-dropdown-trigger', root) || root).click();
    const item = await waitFor(() =>
      $$('p-dropdownitem li, li.ui-dropdown-item, li.p-dropdown-item, .ui-dropdown-items li')
        .filter(visible).find((li) => matcher(text(li).toUpperCase())), 3000);
    if (!item) {
      document.body.click();
      throw new Error(`no ${name} option matched`);
    }
    item.click();
    await sleep(200);
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

  function waitUntil(hhmmss) {
    const [h, m, s = 0] = hhmmss.split(':').map(Number);
    return new Promise((resolve) => {
      const tick = () => {
        const now = new Date();
        const target = new Date(now); target.setHours(h, m, s, 0);
        const diff = target - now;
        if (diff <= 0) return resolve();
        panel.textContent = `Tatkal Autofill: waiting ${Math.ceil(diff / 1000)}s until ${hhmmss}`;
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
    const card = await waitFor(() => $$('app-train-avl-enq').find((c) =>
      text($('.train-heading strong', c) || c).includes(cfg.train)), 20000);
    if (!card) return status(`train ${cfg.train} not in results`, 'error');
    card.scrollIntoView({ block: 'center' });

    // Pick the innermost matching element, since the click handler sits on div.pre-avl, not the td.
    const matches = $$('.pre-avl, td', card).filter((el) => text(el).includes(`(${cfg.cls})`));
    const classTile = matches.find((el) => !matches.some((o) => o !== el && el.contains(o)));
    if (!classTile) return status(`class ${cfg.cls} not offered on ${cfg.train}`, 'error');
    classTile.click();
    status('checking availability');

    const day = parseInt(cfg.date.split('/')[0], 10);
    const dayRe = new RegExp(`\\b0?${day}\\b`);
    const isDateCell = (el) => /\b(MON|TUE|WED|THU|FRI|SAT|SUN)\b/i.test(text(el.closest('td') || el));
    const dateCell = await waitFor(() => {
      const cells = $$('td.link div.pre-avl, div.pre-avl', card).filter((c) => !text(c).includes(`(${cfg.cls})`) && isDateCell(c));
      if (!cells.length) return null;
      return cells.find((c) => dayRe.test(text(c))) ||
        cells.find((c) => !/NOT AVAILABLE|REGRET/i.test(text(c.closest('td') || c)));
    }, 15000, 200);
    if (!dateCell) return status('availability did not load; click Refresh or the date yourself', 'error');
    dateCell.click();
    LOG('date cell =', text(dateCell.closest('td') || dateCell));

    const book = await waitFor(() => {
      const b = $$('button', card).find((x) => /BOOK NOW/i.test(text(x)));
      return b && !b.disabled && !b.classList.contains('disable-book') ? b : null;
    }, 8000, 150);
    if (!book) return status('Book Now not enabled (no seats or not open yet)', 'error');
    status('booking');
    book.click();
  }

  // ---------- step 3: passengers ----------
  function parsePassengers(raw) {
    return raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, age, gender, berth, food] = l.split(',').map((x) => (x || '').trim());
      return { name, age, gender: (gender || 'M').toUpperCase()[0], berth: berth.toUpperCase(), food: food.toUpperCase()[0] || '' };
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

  async function passengerStep(cfg) {
    const list = parsePassengers(cfg.passengers || '');
    if (!list.length) return status('no passengers saved', 'error');
    status('filling passengers');
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
      await sleep(150);
    }
    if (cfg.mobile) {
      const mob = $('input[formcontrolname="mobileNumber"], input#mobileNumber');
      if (mob) setValue(mob, cfg.mobile);
    }
    activity('ok', 'passengers filled');

    if (!cfg.autoContinue) {
      status('passengers filled. Check them, then click Continue yourself.', 'ok');
      return chrome.storage.local.set({ armed: false });
    }

    // Payment mode on this page: pick the radio whose label mentions UPI.
    const upiRadio = $$('input[type="radio"][name="paymentType"], input[type="radio"]').find((r) => {
      const label = r.closest('label, p-radiobutton, .ui-radiobutton-wrapper, div') || r.parentElement;
      return /BHIM|UPI/i.test(text(label)) && text(label).length < 200;
    });
    if (upiRadio) { upiRadio.click(); activity('info', 'payment mode: BHIM/UPI'); }
    else activity('info', 'UPI payment-mode option not found; leaving the default');

    await sleep(400);
    const cont = forwardButton(/CONTINUE|PROCEED|NEXT/);
    if (!cont) return status('Continue button not found on passenger page', 'error');
    status('passenger Continue clicked');
    cont.click();
  }

  // ---------- step 4: review booking (captcha) ----------
  async function reviewStep(cfg) {
    if (!cfg.autoContinue) return;
    const end = Date.now() + 3 * 60 * 1000;
    while (Date.now() < end && location.href.includes('reviewBooking')) {
      const input = await waitFor(() => $$('input#captcha, input[formcontrolname="captcha"], input[name="captcha"], input#nlpAnswer, input[placeholder*="aptcha"]').find(visible), 15000);
      if (!input) return status('captcha box not found on review page', 'error');
      input.scrollIntoView({ block: 'center' });
      input.focus();
      status('type the captcha; Continue is clicked when you stop typing');
      // Wait until at least 4 characters and no typing for 1 second.
      let last = input.value, changed = Date.now();
      while (Date.now() < end && location.href.includes('reviewBooking')) {
        await sleep(150);
        if (input.value !== last) { last = input.value; changed = Date.now(); }
        if (last.trim().length >= 4 && Date.now() - changed > 1000) break;
      }
      if (!location.href.includes('reviewBooking')) return;
      const cont = forwardButton(/CONTINUE|PROCEED|PAY/);
      if (!cont) return status('Continue button not found on review page', 'error');
      status('review Continue clicked');
      cont.click();
      // Wrong captcha: IRCTC stays on this page with a new captcha. Wait for the box to clear, then loop.
      await waitFor(() => !location.href.includes('reviewBooking') || !input.isConnected || input.value === '', 6000, 200);
      if (location.href.includes('reviewBooking')) activity('error', 'still on review page (wrong captcha?); type the new one');
    }
  }

  // ---------- step 5: payment options ----------
  async function paymentStep(cfg) {
    if (!cfg.autoContinue) return;
    status('choosing payment option');
    await waitFor(() => $('.bank-type, #pay-type, button'), 15000);
    await sleep(800);
    const option = $$('#pay-type .bank-type, .bank-type').filter(visible)
      .find((o) => /BHIM|UPI|IPAY/i.test(text(o)));
    if (option) { option.click(); activity('info', 'payment option: ' + text(option).slice(0, 60)); await sleep(600); }
    else activity('info', 'UPI payment option not found; using the default');
    const pay = await waitFor(() => forwardButton(/PAY\s*&\s*BOOK|PAY AND BOOK|PAY/), 8000, 200);
    if (!pay) return status('Pay & Book button not found', 'error');
    status('Pay & Book clicked');
    pay.click();
  }

  // ---------- step 6: IRCTC iPay gateway (UPI ID) ----------
  async function gatewayStep(cfg) {
    if (!cfg.autoContinue) return;
    if (!cfg.upi) return status('no UPI ID saved; enter it on this page yourself', 'error');
    status('filling UPI ID on payment gateway');
    const radio = await waitFor(() => $('input#mandateUPI, input[name="mandateType"][value="upiMandate"]') ||
      $$('input[type="radio"]').find((r) => {
        const t = text(r.closest('label') || r.parentElement);
        return /UPI/i.test(t) && t.length < 150;
      }), 15000);
    if (radio) { radio.click(); await sleep(800); }
    const vpa = await waitFor(() => $$('input#mndtVpa, input[placeholder*="UPI" i], input[placeholder*="VPA" i]').find(visible), 10000);
    if (!vpa) return status('UPI ID box not found on gateway', 'error');
    vpa.focus();
    setValue(vpa, cfg.upi);
    vpa.dispatchEvent(new Event('blur', { bubbles: true }));
    await sleep(600);
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
    const { config: cfg, armed } = await getStore();
    if (!cfg) return status('no saved settings (open the extension popup)', 'error');
    if (!armed && !force) return status(armed === false ? 'disarmed' : 'idle (not armed)', 'info');
    running = true;
    try {
      const url = location.href;
      if (location.hostname.includes('irctcipay')) await gatewayStep(cfg);
      else if (url.includes('train-list')) await trainListStep(cfg);
      else if (url.includes('psgninput')) await passengerStep(cfg);
      else if (url.includes('reviewBooking')) await reviewStep(cfg);
      else if (/bkgPaymentOptions|\/payment\//.test(url)) await paymentStep(cfg);
      else if (url.includes('train-search')) await searchStep(cfg);
      else status('this page is not handled: ' + location.pathname + ' (open the train search page)', 'error');
    } catch (e) {
      status('error: ' + e.message, 'error');
    } finally {
      running = false;
      // The page changed while a step was still finishing; run the new page's step now.
      if (rerun) { rerun = false; setTimeout(() => run(false), 0); }
    }
  }

  // ---------- page check (popup "Check page" button) ----------
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
    },
  };

  function checkPage() {
    const key = Object.keys(CHECKS).find((k) => location.href.includes(k));
    activity('step', 'page check: ' + location.href);
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
    else if (msg.type === 'run') { run(true); reply({ ok: true }); }
  });

  // Start as soon as the user arms from the popup.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.armed && changes.armed.newValue === true) run(false);
  });

  // IRCTC is a single-page app, so watch for route changes.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; run(false, true); }
  }, 300);

  panel.addEventListener('click', () => run(true));
  run(false);
})();
