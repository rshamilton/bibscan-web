// Decoding OCR text into a bib we're willing to announce.
import test from 'node:test';
import assert from 'node:assert/strict';
import { digitRuns, resolve } from '../../public/js/core/matching.js';
import { DEFAULTS } from '../../public/js/core/settings.js';

const VALID = new Set(['3476', '3477', '3478', '431', '11', '1955', '9', '20', '2026', '5936']);
const bibOf = (m) => (m ? m.bib : null);

for (const [text, expected] of [
  ['3477', '3477'], // clean read
  ['  3476  ', '3476'], // whitespace
  ['3476.', '3476'], // trailing punctuation
  ['bib 3477 5K', '3477'], // bib among other words
  ['M 431 F', '431'], // bib between gender markers
]) {
  test(`exact read ${JSON.stringify(text)}`, () => assert.equal(bibOf(resolve(text, VALID)), expected));
}

test('resolve() default shortest bib agrees with the settings default', () => {
  assert.equal(DEFAULTS.ocr.min_digits, 2);
  assert.equal(resolve('9', new Set(['9'])), null);
});

for (const [text, expected] of [['34T7', '3477'], ['l955', '1955'], ['34/7', null]]) {
  test(`letter repair ${text}`, () => assert.equal(bibOf(resolve(text, VALID)), expected));
}

test('confusable substitution is repaired', () => {
  // B/8 is a classic bib confusion and 3476 is the only candidate.
  const m = resolve('B476', VALID);
  assert.equal(m.bib, '3476');
  assert.equal(m.how, 'repaired');
});

test('ambiguous repair is refused', () => {
  // "3479" is one substitution from 3476, 3477 and 3478.
  assert.equal(resolve('3479', VALID), null);
});

test('unknown bib is refused', () => assert.equal(resolve('347', VALID), null));

for (const text of ['nothing here', 'GOLD', 'FINISH LINE', 'Boston', 'GO', 'OIL']) {
  test(`words never become bibs: ${text}`, () => assert.equal(resolve(text, VALID, { minDigits: 2 }), null));
}

test('single digits excluded by default min', () => assert.equal(resolve('MILE 3', VALID, { minDigits: 2 }), null));

test('no roster falls back to raw digits', () => {
  const m = resolve('4242', new Set(), { minDigits: 2 });
  assert.deepEqual([m.bib, m.how], ['4242', 'unmatched']);
});

test('digit runs trims overlong reads', () => {
  assert.deepEqual(digitRuns('34776', 2, 4), ['3477', '4776']);
});

test('fuzzy can be disabled', () => assert.equal(resolve('B476', VALID, { fuzzy: false }), null));

test('normalized vs exact is reported', () => {
  assert.equal(resolve('3477', VALID).how, 'exact');
  assert.equal(resolve('34T7', new Set(['3477'])).how, 'normalized');
});

test('insertion/deletion repair must be unique', () => {
  assert.equal(bibOf(resolve('59360', new Set(['5936']), { maxDigits: 5 })), '5936');
  assert.equal(resolve('1234', new Set(['123', '234'])), null);
});
