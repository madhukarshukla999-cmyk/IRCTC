# IRCTC Tatkal Autofill (Chrome/Edge extension)

Browser-extension version of the UiPath workflow in `IRCTC-tatkal-booking`. It autofills the
journey search, picks the train, and fills passenger details, with an optional timed start.
You still log in, solve the captcha, and approve payment yourself.

## Install
1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on Developer mode.
3. Click "Load unpacked" and choose this folder.

## Use
1. Click the extension icon, fill in the details, then "Save & arm".
2. Log in to https://www.irctc.co.in yourself and open the train search page.
3. The extension fills the search form, waits for the start time (if set), and clicks Search.
4. On the train list it selects your train, class and date and clicks Book Now.
5. On the passenger page it fills the passengers and mobile number, then disarms.
6. You review, continue, solve the captcha, and pay.

A small status box at the bottom right shows progress. Click it to run the step for the current page.

## Notes
- Selectors for IRCTC's Angular pages were written without access to the live site and will need
  adjusting. Update them in `content.js`.
- IRCTC's terms restrict automated booking. Use at your own risk.
- Settings are stored only in `chrome.storage.local`. No credentials are stored.
