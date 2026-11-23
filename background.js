// Hands the unlocked IRCTC login to the content script on irctc.co.in tabs only.
// The unlocked password lives in chrome.storage.session (memory only, cleared when the browser
// closes), which content scripts cannot read directly.
const IRCTC_TAB = /^https:\/\/www\.irctc\.co\.in\//;

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== 'getLogin') return;
  const url = sender?.tab?.url || sender?.url || '';
  if (sender?.id !== chrome.runtime.id || !IRCTC_TAB.test(url)) {
    reply({ error: 'refused: not an IRCTC tab' });
    return;
  }
  Promise.all([
    chrome.storage.session.get('login'),
    chrome.storage.local.get('savedLogin'),
  ]).then(([{ login }, { savedLogin }]) => {
    if (login?.user && login?.password) reply({ user: login.user, password: login.password });
    else if (savedLogin?.user) reply({ user: savedLogin.user, locked: true });
    else reply({ none: true });
  });
  return true; // reply asynchronously
});
