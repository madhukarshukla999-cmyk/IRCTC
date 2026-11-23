const FIELDS = ['from', 'to', 'date', 'train', 'cls', 'quota', 'mobile', 'passengers', 'start'];
const $ = (id) => document.getElementById(id);
const say = (t) => { $('msg').textContent = t; setTimeout(() => ($('msg').textContent = ''), 2000); };

chrome.storage.local.get(['config', 'armed'], ({ config = {}, armed }) => {
  FIELDS.forEach((f) => { if (config[f] != null) $(f).value = config[f]; });
  if (armed) say('Armed');
});

function collect() {
  const config = {};
  FIELDS.forEach((f) => (config[f] = $(f).value.trim()));
  config.from = config.from.toUpperCase();
  config.to = config.to.toUpperCase();
  config.cls = config.cls.toUpperCase();
  return config;
}

$('save').onclick = () => chrome.storage.local.set({ config: collect() }, () => say('Saved'));
$('arm').onclick = () => chrome.storage.local.set({ config: collect(), armed: true }, () => say('Armed'));
$('disarm').onclick = () => chrome.storage.local.set({ armed: false }, () => say('Disarmed'));
$('ver').textContent = 'Version ' + chrome.runtime.getManifest().version;