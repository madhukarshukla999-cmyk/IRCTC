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
   A field it cannot fill is logged and skipped; Search is still clicked.
   The start time is read on **IRCTC's clock**, not your computer's (see "Server clock" below).
4. On the train list it selects your train, class and date and clicks Book Now. If Book Now is
   not enabled yet, it refreshes the class availability every 2 s for the "Retry Book Now for"
   time (30 s by default; 0 turns retrying off).
5. On the passenger page it fills the passengers and mobile number, and sets the booking options
   "Consider for auto upgradation" and "Book only if confirm berths are allotted" (both ticked by
   default; change them in the popup).

With "Continue automatically after passengers" on (default), it then:

6. Picks the BHIM/UPI payment mode and clicks Continue.
7. On the review page, focuses the captcha box. **You type the captcha**; Continue is clicked
   once you stop typing for a second. If the captcha was wrong, it waits for you to type the new one.
8. On the payment page, picks the BHIM/UPI option and clicks Pay & Book.
9. On the IRCTC iPay gateway, enters your UPI ID and clicks Pay. **You approve the request in your
   UPI app.** The extension then disarms.

With the option off, it stops after step 5 and you continue by hand.

A small status box at the bottom right shows progress. Click it to run the step for the current page.

Passenger format, one per line: `Name, Age, M/F/T, Berth, Food`. Berth (LB, MB, UB, SL, SU, WS)
and food (V, N, D = no food) are optional. Dates use `DD/MM/YYYY`.

## Saved trips
At the top of the popup: type a name and click **Save trip** to store the current form. Pick a
trip and click **Load** to fill the form with it (it also becomes the active settings), or
**Delete** to remove it.

## Dry run
**Dry run** runs the whole flow (search, train, passengers, review captcha, payment page) but
stops before Pay & Book, so nothing is booked or paid. It ignores the start time and checks the
page elements on each page. Use it the day before to confirm everything works.

## Server clock
When a start time is set, the extension sends a few small requests to irctc.co.in and reads the
time in the responses to work out how far your computer's clock is from IRCTC's (shown in the log,
e.g. `IRCTC clock is +1.24s vs this computer (±0.11s)`). It checks again about 45 s before the
start time. Your computer should be set to Indian time (IST).

## IRCTC pop-ups
While armed, the extension watches for IRCTC pop-ups and logs their text. It only closes
harmless ones: food/catering confirmations and notices with a single OK/Close button. Pop-ups
about logging out or sessions, and pop-ups with input fields (login), are left for you.

## Updating
After `git pull`, click reload on the extension card in `chrome://extensions`, then refresh the
IRCTC tab. The popup footer shows the loaded version.

## Activity log
The popup has an Activity panel that shows every step the extension takes on the page, with
errors in red. Buttons under it:
- **Run step now**: runs the step for the current page, even when not armed.
- **Check page**: lists which page elements the extension can find (e.g. `Search button: NOT FOUND`).
- **Copy log**: copies the log to the clipboard so you can share it.
- **Clear log**: empties the log.

The box above the log shows whether the popup is connected to an IRCTC tab. If the tab was open
before the extension was installed or reloaded, the popup injects the script automatically.

## Troubleshooting
- Box above the log is red: the current tab is not IRCTC, or the page needs a refresh.
- A step fails: click **Check page**, then **Copy log**, and share the copied text.

## Notes
- Selectors for IRCTC's Angular pages may need adjusting when IRCTC changes its site. Update them
  in `content.js`.
- The extension does not hide itself from IRCTC and does not solve captchas or approve payments.
- IRCTC's terms restrict automated booking. Use at your own risk.
- Settings are stored only in `chrome.storage.local`. No credentials are stored.
