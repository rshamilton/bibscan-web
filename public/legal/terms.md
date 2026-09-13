Terms of use
============

bibscan-web is a free, open-source tool (MIT license — see LICENSE in the
repository) that reads race bib numbers from a camera and looks them up
against race data you choose to add. Using it means agreeing to the
following.

An informational tool, not an official result
-----------------------------------------------

bibscan-web's on-device OCR can misread a number, and the names, times and
places it shows are only as fresh and accurate as the last sync of the
underlying race data. Nothing it displays is an official result. For an
official time, place or award, use the race organizer's or timing company's
own published results.

No warranty
-----------

bibscan-web is provided "as is", without warranty of any kind, express or
implied, to the fullest extent the law allows — see the MIT license text in
LICENSE for the exact wording. You use it at your own risk. In particular,
don't rely on it for anything safety-critical (for example, course
management or emergency response during an event).

Third-party race data
----------------------

When you add a race, bibscan-web fetches roster and results data from the
timing service you point it at (currently Athlinks/ChronoTrack or
RunSignUp), through a small relay that exists only because those services'
APIs reject requests from arbitrary browser pages. That data:

- belongs to the timing service and/or the race organizer, not to
  bibscan-web, and is subject to *their* terms of use, not this one;
- is fetched only when you ask (adding a race, syncing, "keep results
  fresh", or looking up a bib) — bibscan-web does not crawl, scrape at
  scale, or redistribute it anywhere;
- may be incomplete, delayed, or wrong, and may stop being available at any
  time if the service changes or restricts its endpoints (both integrations
  use interfaces the services publish or otherwise make available for
  reading public results; neither is an official partnership).

You're responsible for using that data in a way that's consistent with the
timing service's and the race organizer's own terms — for example, don't
use bibscan-web to bulk-harvest a race's data for a purpose the organizer
hasn't agreed to.

Trademarks
----------

Athlinks, ChronoTrack, and RunSignUp are trademarks of their respective
owners. They're named here only to describe which services bibscan-web can
read results from. bibscan-web is an independent, unaffiliated project; it
is not sponsored by, endorsed by, or affiliated with any of them.

Camera and privacy
-------------------

bibscan-web asks for camera access to scan bibs, and that access is used
only locally — see [Privacy](privacy.md) for exactly what stays on your
device and what, if anything, leaves it.

Changes
-------

These terms may be updated as the project changes; the current version is
always the one shown in the app. Continuing to use bibscan-web after a
change means you accept the updated terms.

Contact
-------

bibscan-web is maintained on GitHub at
[rshamilton/bibscan-web](https://github.com/rshamilton/bibscan-web) — open
an issue there with questions or concerns.
