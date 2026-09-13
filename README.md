# bibscan-web

Point a camera at runners, read the numbers off their race bibs, and show who
they are — during the race, not just after it.

This is the browser version of [bibscan](https://github.com/rshamilton/bibscan).
**Everything runs on your own device**: the OCR models, the matching, the
voting, the roster and the history all live in the browser. No cloud OCR, no
API keys, no accounts. A tiny local server with no dependencies serves the page
and, when you ask it to, fetches race rosters for you.

```
┌ ☰  Demo 5K & 10K             Both│Names│Camera  ● ┐
│ ┌─────────────────────────────────────────────────┐ │
│ │     [ camera, with boxes drawn over the bibs ]  │ │
│ └─────────────────────────────────────────────────┘ │
│ 1147  Cameron Ingram                        23:41   │
│       5K · #12 overall · M34 · Maple Grove, CT      │
│ 1049  Theo Alder                        on course   │
└─────────────────────────────────────────── [Stop] ──┘
```

## Quick start

You need [Node.js](https://nodejs.org) 20 or newer and a current browser
(Firefox, Chrome, Edge or Safari). Nothing to install:

```bash
git clone https://github.com/rshamilton/bibscan-web.git
cd bibscan-web
node server.mjs
```

Open **http://localhost:8780**.

**Try it with no race and no camera:** Setup → **Add the demo race**, then back
on Live open ☰ → Camera → **Demo runners** and press **Start**. Made-up runners
cross a synthetic scene and are read, voted on and named, exactly as a real
camera's would be.

## At a race

1. **Setup → Add a race.** Paste the results link from the race's website
   (ChronoTrack, Athlinks or RunSignUp), or an Athlinks event id. For
   ChronoTrack and Athlinks races this switches to the race and pulls the
   entrant roster straight away — before the gun, so runners are named the
   moment their bib is read, with "on course" where the time will go.
   RunSignUp doesn't publish an entrant roster for anyone to read anonymously
   (only results, once a timer posts them), so a RunSignUp runner is named
   the moment they finish rather than before the start.
2. **Keep results fresh** (Setup) pulls new finishers every 60 seconds while the
   page is open, so "on course" turns into a finish time.
3. **Live → Start.** Your laptop's webcam, a USB camera, a phone, or a video
   file.

Do step 1 while you still have good Wi-Fi. After that, scanning needs no network
at all.

### A phone as the camera

Phones only share their camera with a secure (https) page, so start the server
for your network:

```bash
node server.mjs --lan
```

```
  Open            http://localhost:8780/
  On your network http://192.168.1.20:8780/   (viewing; cameras need https)
  Phone camera    https://192.168.1.20:8781/   (accept the certificate warning once)
```

Open the https address on the phone and accept the certificate warning once. It
uses a self-signed certificate made with `openssl` for your machine's addresses
(stored in `data/tls/`, never committed); pass `--cert` and `--key` to use your
own.

The phone then runs **the whole scanner itself** — its camera, its copy of the
models, its own roster and history — so it is only as busy as its own CPU.
Because each browser keeps its own data, add the race on the phone too, or use
Setup → **Export backup** on one device and **Import backup** on the other.

### Offline

After the first visit the app, the engine and the models are cached by a service
worker. With the server stopped, the page still opens, the engine starts, and
runners are still read and named from the roster already stored. Only adding or
syncing an Athlinks race needs the server and the internet.

### No internet at all

Setup → **Import roster CSV**. Any timing spreadsheet works if it has a **bib**
column and a **name** column (or first and last name). Also understood: age,
gender/sex, city, state, country, team, race/course/distance, chip time, place.
Rows without a bib or name are skipped and counted.

## The three pages

**Live** is a fixed screen of panes, built for a phone first:

* **Both / Names / Camera** picks the view. Names-only keeps scanning.
* **Drag the bar** between camera and names to resize them (side by side on a
  wide screen). Your size and view are remembered.
* **Fit / Fill** on the picture switches between the exact frame being scanned
  and filling the pane.
* **The names pane scrolls on its own.** New runners land at the top without
  moving what you are reading, and a "↑ 3 new" pill says what arrived.
* **Green means read in the last 5 seconds**, timed from the frame that showed
  the runner. In Camera view the runners in shot float over the picture.
* **☰** has the race and camera choice, a flip button for devices with more than
  one camera, the counts, and the engine status.
* While scanning, the screen is kept awake, and the camera resumes after the
  phone was locked.

**History** — everyone seen in this race, filterable, exportable as CSV, and a
box to look up any bib by hand (optionally asking the timer for the latest).

**Setup** — add, sync, switch and remove races; CSV import; the demo race; 30
scanner settings, each explained; the recognition engine and an **accuracy
self-test**; the phone link; backup, restore and delete.

History and Setup slide over Live, so scanning carries on while you use them.

## How it works

```
camera frame ──▶ Web Worker ─────────────────────────────────────────────────┐
                 detect text on a 448px copy        (PP-OCRv4 det, WASM)     │
                 recognise full-resolution crops    (PP-OCRv4 rec + angle)   │
                 decode against the roster          exact / repair / unique  │
                 vote across frames                 3 frames in 3s, moving   │
page ◀───────────────────────────────────────────────────────────────────────┘
      look up the name in IndexedDB ──▶ card, sighting, (optional) spoken name
```

This is bibscan's pipeline, ported line for line to JavaScript and run in the
browser on [ONNX Runtime Web](https://onnxruntime.ai/) with the same three
PP-OCR models. The decisions that carry the reliability are unchanged:

**Detect small, recognise large.** Detection cost scales with image area,
recognition quality with crop resolution — so detection runs on a 448px
downscale and the boxes are read from the full-resolution frame.

**Judge the shape before paying to read it.** A bib is a few digits, so a box
more than 6× wider than tall is prose and is skipped before recognition.

**Only emit characters a bib could contain.** The recogniser has 6,625 output
classes and 95 are ASCII; the rest are excluded before decoding, or ordinary
scenery decodes as confident-looking CJK text.

**Decode against the real roster.** Exact, then OCR-confusion repair (`34T7` →
`3477`), then a *strictly unique* one-edit match. Two equally plausible runners
means nothing is announced.

**Never announce on one frame.** Three agreeing frames within three seconds. A
runner confirmed moments ago is trusted for 20 seconds and comes straight back.

**Ignore things that don't move.** A "20K" banner is bib 20. Anything whose box
stays within 8px for 6 seconds is scenery.

### What is different in the browser

* **The models run in a Web Worker** on WebAssembly with SIMD and multiple
  threads. The server sends the cross-origin isolation headers that make
  threads available; without them the engine still works on one thread.
* **OpenCV is gone.** The dozen image operations the models need — area and
  linear resampling, cubic perspective warps, CLAHE, 8-bit Lab — are
  reimplemented in `public/js/ocr/image.js`, and the detector's contour
  post-processing in `dbpost.js`. Each is tested against OpenCV's own output.
* **SQLite became IndexedDB**, with the same two-phase runner rows: a name from
  the entrant roster, a time from results, either useful alone.
* **Two processes became one page.** bibscan kept the camera process off the
  network by sandboxing; here the frames never leave the browser at all, and
  race data arrives only through the relay described below.

### Why a server at all

The race-data API behind Athlinks sits behind CloudFront, which answers a
browser calling it from any other site with HTTP 403 (measured: `Origin:
http://localhost` → 403, `Origin: https://www.athlinks.com` → 200). So the page
cannot fetch rosters itself. RunSignUp's API has no such block (it answers
any origin), but requests still go through the same relay rather than being
fetched directly, so there is one audited egress path instead of two.
`server.mjs` relays those requests, and nothing else:

* only `reignite-api.athlinks.com`, `sites.chronotrack.com`,
  `api.runsignup.com` and `runsignup.com`, GET only;
* redirects are refused, `..` in any form is refused, the target is re-checked
  after parsing, responses are size-capped and time-limited;
* it listens on `127.0.0.1` unless you pass `--lan`;
* every page is served with a strict Content-Security-Policy (no inline
  scripts, no third-party anything), `Permissions-Policy: camera=(self)` and
  `nosniff`.

Frames, names and history are never sent to the server.

## Measured

All on a Raspberry Pi 5 (4 cores, CPU only) in Firefox 142 — the slow end of
what this runs on.

**Same answers as bibscan.** On 17 frames rendered by bibscan's own synthetic
generator, the browser engine finds the same text boxes (within 9px at
1280×720), reads the same strings, and gives confidences within 0.03 of
bibscan's RapidOCR — every frame, including the angled and motion-blurred ones.
The reimplemented image operations match OpenCV to within 1–3 levels, and
8-bit Lab exactly.

**Self-test, hard** (`npm run bench`: 30 runners × 5 frames; perspective up to
45°, roll up to 25°, motion blur, noise, JPEG 55–85, uneven light, signage in
the background):

| | bibscan-web (browser) | bibscan (Python) |
|---|---|---|
| Single frame read correctly | 96.0% | 97.3% |
| Single frame read **wrong** | 0.0% | 1.3% |
| **Runners announced correctly** | **100%** | **100%** |
| **Runners announced wrong** | **0%** | **0%** |
| False alarms from signage | 0 | 0 |
| Median frame time | 825 ms (1.2 fps) | 432 ms (2.3 fps) |

The two draw their synthetic bibs differently (canvas fonts here, Pillow there),
so compare the shape of the numbers rather than the decimals. The browser is
about half the Python speed on the same CPU; the models load in about 1.4 s.

## Testing

```bash
npm install          # dev only: the same onnxruntime-web release, for Node
npm test             # unit tests: matching, voting, index, sync, CSV, settings, relay, app files
npm run test:ocr     # the real models in Node, compared with bibscan and OpenCV
npm run test:ui      # the whole app in headless Firefox (NETWORK=0 skips Athlinks/RunSignUp)
```

TESTING_PLACEHOLDER

The parity fixtures in `tests/fixtures/` are generated by the original Python
bibscan — its synthetic-bib generator, its RapidOCR reader, and OpenCV:

```bash
/path/to/bibscan/.venv/bin/python tools/make_fixtures.py --bibscan /path/to/bibscan
```

## Settings

All in Setup, each with an explanation; saved in the browser. The ones that
matter most:

| Setting | Default | Effect |
|---|---|---|
| Frames to confirm | 3 | Frames of agreement before announcing. |
| Re-announce cooldown | 30 s | Don't re-announce the same runner within this. |
| Static filter | 8 px | Motion below this is signage. 0 disables. |
| Detect size | 448 px | Detection resolution. Lower is faster. |
| Widest bib shape | 6.0 | Skip text boxes wider than this × their height. |
| Shortest bib | 2 | A lone digit is nearly always signage. |
| Region of interest | whole frame | Scan only part of the frame. |
| Scan resolution | 1280 px | Long side of the frame handed to recognition. |
| Say names aloud | off | Speak each new runner through the speaker. |

## Layout

```
server.mjs              static files, the relay, optional HTTPS   (no dependencies)
public/
  index.html            the page: Live, History, Setup
  sw.js                 offline cache
  js/app.js             orchestration and the Live view
  js/views/             History and Setup
  js/engine.js          the page's side of the worker
  js/engine.worker.js   loads the models, runs frames
  js/synth.js           demo camera and self-test imagery
  js/store-idb.js       IndexedDB storage
  js/core/              matching, tracker, index, sync, races, athlinks, runsignup, relay, csv, settings, demo
  js/ocr/               reader, scanner, image ops, detector post-processing, CTC
  models/               PP-OCR det / cls / rec (ONNX) and the character list
  vendor/ort/           onnxruntime-web 1.29.0
tests/unit/             node --test
tests/ocr/              real models vs bibscan and OpenCV
tests/ui/               headless Firefox over WebDriver BiDi
tools/make_fixtures.py  regenerates the parity fixtures from bibscan
```

## Caveats

* The certificate for `--lan` is self-signed, so each device warns once. Some
  phone browsers are stricter than others about this.
* Speed depends on the device doing the scanning, and was only measured here on
  a Raspberry Pi 5 (above). A phone runs the scanner on its own CPU.
* The Athlinks endpoints are not a documented public API and can change without
  notice. CSV import is the fallback.
* RunSignUp's API is public and documented, but doesn't allow anonymous access
  to a race's entrant roster (only results) — see "At a race" above.
* The strict Content-Security-Policy described above is enforced everywhere —
  as a response header from `server.mjs`, or as a `<meta>` tag in the page on
  a statically-hosted copy (GitHub Pages, say), since static hosts can't send
  custom headers. The one gap is `frame-ancestors`, which browsers only honor
  as a header, so a statically-hosted copy can be framed by another site. The
  cross-origin-isolation headers (COOP/COEP) have no `<meta>` equivalent at
  all, so a static copy also runs single-threaded, without that particular
  hardening.
* Tested here in Firefox (desktop and phone-sized viewports, headless). The
  code avoids anything Safari lacks, but it was not run on a physical iPhone.

## Licensing

MIT — see [LICENSE](LICENSE). The PP-OCR models are Apache-2.0 and ONNX Runtime
Web is MIT; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Race results
come from public endpoints, for personal use. See
[Terms of use](public/legal/terms.md) and [Privacy](public/legal/privacy.md)
for the rest — in short, nothing but the race-data request you trigger ever
leaves your device.
