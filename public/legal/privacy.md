Privacy
=======

The short version: bibscan-web has no accounts, no analytics, no
advertising, and no server-side database. Camera frames, the roster,
history and your settings all stay on your device. Below is exactly what
that means and where the few real exceptions are.

What never leaves your device
------------------------------

- **Camera frames.** The recognition engine runs entirely in your browser
  (WebAssembly, in a Web Worker). A frame is read into memory, processed,
  and discarded — it is never uploaded anywhere, saved to disk, or sent to
  any server, including bibscan-web's own.
- **Race data, history and settings.** The roster, every runner you've seen,
  and your scanner settings are stored in your browser's IndexedDB, on your
  device. Nothing is synced to any account, because there is no account.
- **Backups.** "Export backup" writes a file straight from your browser to
  your downloads folder; "Import backup" reads a file you choose. Neither
  touches the network.

What does leave your device, and when
---------------------------------------

- **Adding or syncing a race, or looking up a bib, sends one request** to
  the timing service you named (Athlinks/ChronoTrack or RunSignUp), through
  a small relay: either your own local server (`server.mjs`, if you're
  running the app that way) or, if the page was loaded from the hosted
  version, a Cloudflare Worker that does the same narrow job. That relay
  only ever forwards a plain `GET` to the fixed timing-service hosts listed
  in the app's source (`relay_hosts.mjs`); it doesn't add your camera
  frames, roster, or history to the request, and it doesn't log or store
  what you asked for beyond what's needed to answer it. The timing service
  will see that a request was made — including the IP address it came
  from — the same way it would if you'd opened their results page in a
  browser tab yourself.
- **The app's own files** (the page, the OCR models, the offline service
  worker) are fetched from wherever you're hosting or loading bibscan-web
  from, same as any website.
- **"Say names aloud"**, if you turn it on, uses your browser's built-in
  speech synthesis. On some platforms/browsers, that feature uses a
  network-based voice rather than an on-device one, in which case the
  runner's name is sent to *your browser's* speech provider (e.g. the
  browser vendor), not to bibscan-web or the timing service. Leave the
  setting off if you'd rather avoid that.

No third parties in the page
------------------------------

The app itself contains no analytics, no advertising, and no third-party
embeds or tracking cookies of any kind — you can read every line of it. When
you run it with `node server.mjs` (or an equivalent host that forwards its
response headers), the page also arrives with a strict
Content-Security-Policy restricting it to its own origin; you can read the
exact policy in `server.mjs`. A statically-hosted copy (for example, on
GitHub Pages) can't carry that same header — static hosts don't send custom
headers — so that particular protection is specific to running your own
server.

Your choices
------------

Everything above is local: clearing your browser's site data for
bibscan-web (or using "Delete everything" in Setup) removes all of it.
Because there's no account and no server-side copy, there is nothing else
to request, export, or delete on bibscan-web's end — what's on your device
is the only copy.

Changes
-------

This notice is updated as the project changes; the current version is
always the one shown in the app.

Contact
-------

Questions go to
[rshamilton/bibscan-web](https://github.com/rshamilton/bibscan-web) on
GitHub.
