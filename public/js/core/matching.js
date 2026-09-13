/* Turning noisy OCR text into a bib number we are willing to stand behind.

   The single biggest reliability win is that we already know every valid bib in
   the event. So instead of trusting the recogniser's raw string, we decode
   *against that set*: exact match first, then OCR-confusion repair, then a
   strictly-unique edit-distance-1 match. If two different runners are equally
   plausible we return nothing and wait for the next frame, because announcing
   the wrong name is worse than announcing nothing. */

// Glyphs the recogniser routinely emits in place of a digit.
export const LETTER_TO_DIGIT = {
  O: '0', o: '0', Q: '0', D: '0',
  I: '1', i: '1', l: '1', L: '1', '|': '1', '!': '1',
  Z: '2', z: '2',
  E: '3',
  A: '4',
  S: '5', s: '5',
  G: '6', b: '6',
  T: '7', t: '7',
  B: '8',
  g: '9', q: '9',
};

// Digit pairs that genuinely look alike on a printed bib, especially at an
// angle or through motion blur. A substitution inside this set is cheap;
// anything else is treated as a real disagreement.
const CONFUSABLE_DIGITS = new Set([
  '08', '06', '09', '05', '17', '14', '13', '28', '27', '38', '39', '35',
  '49', '41', '56', '58', '53', '68', '60', '79', '71', '89', '80',
]);

const DIGIT_RUN = /\d+/g;
// Tokens are split on anything that can't stand in for a digit. "|" and "!"
// stay because the recogniser emits them for a "1" on a narrow bib.
const TOKEN_SPLIT = /[^0-9A-Za-z|!]+/;
const MAPPABLE = new Set([...'0123456789', ...Object.keys(LETTER_TO_DIGIT)]);
const isDigit = (ch) => ch >= '0' && ch <= '9';

export function confusable(a, b) {
  if (a === b) return false;
  const key = a < b ? a + b : b + a;
  return CONFUSABLE_DIGITS.has(key);
}

/* Is this token plausibly a misread number rather than a word? Every character
   has to be a digit or a known look-alike, *and* at least one has to be a real
   digit. Without that second rule ordinary signage repairs straight into valid
   bibs - "GO" becomes 60, "GOLD" becomes 6010. */
function repairable(token) {
  if (!token) return false;
  for (const ch of token) if (!MAPPABLE.has(ch)) return false;
  return [...token].some(isDigit);
}

const translate = (token) => [...token].map((ch) => LETTER_TO_DIGIT[ch] ?? ch).join('');

/* Plausible bib strings found in one OCR line. Raw digit runs are offered
   first, so a clean read is never displaced by a speculative repair. */
export function digitRuns(text, minDigits, maxDigits) {
  const out = [];
  const offer = (run) => {
    if (run.length >= minDigits && run.length <= maxDigits) {
      if (!out.includes(run)) out.push(run);
    } else if (run.length > maxDigits) {
      // A bib fused to a stray mark. Offer both plausible-length ends.
      for (const end of [run.slice(0, maxDigits), run.slice(-maxDigits)]) {
        if (end.length >= minDigits && end.length <= maxDigits && !out.includes(end)) out.push(end);
      }
    }
  };
  for (const run of text.match(DIGIT_RUN) || []) offer(run);
  for (const token of text.split(TOKEN_SPLIT)) {
    if (repairable(token)) for (const run of translate(token).match(DIGIT_RUN) || []) offer(run);
  }
  return out;
}

function subDistance1(a, b) {
  if (a.length !== b.length) return [false, false];
  let diff = null;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      if (diff) return [false, false];
      diff = [a[i], b[i]];
    }
  }
  if (!diff) return [false, false];
  return [true, confusable(diff[0], diff[1])];
}

function indelDistance1(a, b) {
  if (Math.abs(a.length - b.length) !== 1) return false;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0, j = 0, skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i++; j++; }
    else if (skipped) return false;
    else { skipped = true; j++; }
  }
  return true;
}

/* Best bib for one OCR line as {bib, penalty, how}, or null if we can't commit.
   `how` is exact | normalized | repaired | unmatched. With no roster loaded we
   fall back to the first plausible digit run, so scanning still works before
   the first sync. */
export function resolve(text, validBibs, { minDigits = 2, maxDigits = 5, fuzzy = true, maxEditDistance = 1 } = {}) {
  const runs = digitRuns(text, minDigits, maxDigits);
  if (!runs.length) return null;
  if (!validBibs || !validBibs.size) return { bib: runs[0], penalty: 0, how: 'unmatched' };

  const rawRuns = text.match(DIGIT_RUN) || [];
  for (const run of runs) {
    if (validBibs.has(run)) return { bib: run, penalty: 0, how: rawRuns.includes(run) ? 'exact' : 'normalized' };
  }
  if (!fuzzy || maxEditDistance < 1) return null;

  // One edit away, and unambiguously so. Confusable substitutions are
  // preferred; a tie between two real runners is refused outright.
  const confusableHits = [];
  const otherHits = [];
  for (const run of runs) {
    const lo = run.length - 1, hi = run.length + 1;
    for (const bib of validBibs) {
      if (bib.length < lo || bib.length > hi) continue;
      const [isSub, isConf] = subDistance1(run, bib);
      if (isSub) (isConf ? confusableHits : otherHits).push(bib);
      else if (indelDistance1(run, bib)) otherHits.push(bib);
    }
    // Resolve per run: a repair on the first plausible run wins.
    if (new Set(confusableHits).size === 1) return { bib: confusableHits[0], penalty: 1.0, how: 'repaired' };
    if (!confusableHits.length && new Set(otherHits).size === 1) return { bib: otherHits[0], penalty: 1.5, how: 'repaired' };
    if (confusableHits.length || otherHits.length) return null; // ambiguous - refuse rather than guess
  }
  return null;
}
