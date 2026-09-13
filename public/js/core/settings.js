/* Scanner settings: defaults, the allowlist the Setup page may change, and
   validation. Deliberately an allowlist rather than "anything in the config":
   a settings page that can set arbitrary fields can wedge the scanner. */

import { parseRoi } from '../ocr/geometry.js';

export const DEFAULTS = Object.freeze({
  tracker: {
    window_sec: 3.0,
    min_votes: 3,
    min_mean_conf: 0.65,
    cooldown_sec: 30.0,
    fuzzy_match: true,
    max_edit_distance: 1,
    static_suppress_px: 8.0,
    static_grace_sec: 6.0,
    trust_window_sec: 20.0,
    trusted_min_votes: 1,
    trusted_cooldown_sec: 3.0,
  },
  ocr: {
    det_long_side: 448,
    det_long_side_fallback: 960,
    min_digits: 2,
    max_digits: 5,
    min_text_conf: 0.5,
    min_box_height_px: 14,
    max_boxes: 10,
    max_aspect: 6.0,
    charset: 'ascii',
    box_thresh: 0.45,
    unclip_ratio: 1.8,
    multiscale: true,
    angle_retry: true,
    threads: 0,
  },
  capture: {
    roi: '',
    long_side: 1280,
    width: 1920,
    height: 1080,
  },
  display: {
    highlight_sec: 5,
    speak_names: false,
  },
  live: {
    results_every_sec: 60,
    entrants_every_sec: 900,
  },
});

const S = (section, name, kind, low, high, label, help, applies = 'now') => ({ section, name, kind, low, high, label, help, applies });

export const EDITABLE = [
  S('tracker', 'min_votes', 'int', 1, 15, 'Frames to confirm',
    'How many frames must agree before a runner is announced. Higher is safer, slower.'),
  S('tracker', 'window_sec', 'float', 0.5, 30, 'Vote window (s)',
    'Those frames must all fall inside this many seconds.'),
  S('tracker', 'min_mean_conf', 'float', 0.1, 1.0, 'Min confidence',
    'Average recognition confidence needed across those frames.'),
  S('tracker', 'cooldown_sec', 'float', 0, 600, 'Re-announce cooldown (s)',
    "Don't announce the same bib again within this time."),
  S('tracker', 'trust_window_sec', 'float', 0, 300, 'Trust a bib for (s)',
    'After a bib is confirmed it is trusted this long. Seeing it again inside the window is believed straight away instead of re-earning every vote. 0 disables.'),
  S('tracker', 'trusted_min_votes', 'int', 1, 10, 'Frames to reconfirm',
    'Frames needed to show a trusted bib again. 1 means it reappears instantly.'),
  S('tracker', 'trusted_cooldown_sec', 'float', 0, 120, 'Trusted cooldown (s)',
    'Shorter re-announce gap for a bib we already trust.'),
  S('tracker', 'static_suppress_px', 'float', 0, 200, 'Static filter (px)',
    'Movement below this is treated as fixed signage. 0 turns the filter off.'),
  S('tracker', 'static_grace_sec', 'float', 0, 120, 'Static grace (s)',
    "How long something motionless may sit in frame before it's called signage."),
  S('tracker', 'fuzzy_match', 'bool', null, null, 'Repair misreads',
    'Allow OCR-confusion repair against the roster (34T7 to 3477).'),
  S('ocr', 'det_long_side', 'int', 256, 1920, 'Detect size (px)',
    'Frame is downscaled to this for detection. Lower is faster, misses distant bibs.'),
  S('ocr', 'min_text_conf', 'float', 0.1, 1.0, 'Min read confidence',
    'Discard individual text reads below this.'),
  S('ocr', 'box_thresh', 'float', 0.1, 0.95, 'Detector strictness',
    'Higher finds fewer text regions - faster in a cluttered scene, but above about 0.65 it starts missing distant bibs.'),
  S('ocr', 'min_box_height_px', 'int', 6, 200, 'Min bib height (px)',
    'Ignore text smaller than this - too small to trust.'),
  S('ocr', 'max_boxes', 'int', 1, 60, 'Max text boxes/frame',
    'Cap on how many text regions are recognised per frame, tallest first.'),
  S('ocr', 'max_aspect', 'float', 1.0, 40.0, 'Widest bib shape',
    'Ignore text boxes wider than this many times their height. A bib is only a few digits; a sentence is 15-20x wider and costs far more to read.'),
  S('ocr', 'charset', 'str', null, null, 'Character set',
    "ascii = letters and digits only (recommended); digits = digits only, can turn a word into a number; all = the model's full 6,625 characters, which hallucinates foreign text on ordinary scenery."),
  S('ocr', 'min_digits', 'int', 1, 6, 'Shortest bib',
    "Fewest digits that counts as a bib. 2 avoids reading 'MILE 3' as bib 3."),
  S('ocr', 'max_digits', 'int', 1, 8, 'Longest bib', 'Most digits that counts as a bib.'),
  S('ocr', 'multiscale', 'bool', null, null, 'Retry at high res',
    'If a frame yields nothing, try again at higher detection resolution.'),
  S('ocr', 'angle_retry', 'bool', null, null, 'Retry angled reads',
    'Re-read steeply angled or low-confidence boxes from a straightened crop.'),
  S('ocr', 'threads', 'int', 0, 16, 'Engine threads',
    'WebAssembly threads for recognition. 0 picks automatically from your CPU.', 'engine'),
  S('capture', 'roi', 'str', null, null, 'Region of interest',
    'Limit scanning to part of the frame: x,y,w,h as fractions, e.g. 0.1,0.2,0.8,0.7. Blank = whole frame.'),
  S('capture', 'long_side', 'int', 320, 3840, 'Scan resolution (px)',
    'Camera frames are scaled so their long side is at most this before reading. Recognition works from these pixels.'),
  S('capture', 'width', 'int', 160, 3840, 'Camera width', 'Resolution to ask the camera for.', 'camera'),
  S('capture', 'height', 'int', 120, 2160, 'Camera height', 'Resolution to ask the camera for.', 'camera'),
  S('display', 'highlight_sec', 'float', 1, 60, 'Highlight for (s)',
    'A runner stays green this long after they were last read.'),
  S('display', 'speak_names', 'bool', null, null, 'Say names aloud',
    'Speak each newly announced runner through the device speaker.'),
  S('live', 'results_every_sec', 'int', 15, 3600, 'Results refresh (s)',
    'While "Keep results fresh" is on, pull new finishers this often.'),
  S('live', 'entrants_every_sec', 'int', 60, 86400, 'Entrants refresh (s)',
    'While "Keep results fresh" is on, re-pull the entrant roster this often.'),
];

export const BY_KEY = new Map(EDITABLE.map((s) => [`${s.section}.${s.name}`, s]));

export function defaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

/* Validate and convert one incoming value. Throws Error if unusable. */
export function coerce(setting, value) {
  if (setting.kind === 'bool') {
    if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    return !!value;
  }
  if (setting.kind === 'str') {
    const text = String(value ?? '').trim();
    if (setting.name === 'roi' && text) parseRoi(text, 1000, 1000); // throws if malformed
    if (setting.name === 'charset' && !['ascii', 'digits', 'all'].includes(text)) {
      throw new Error('Character set must be one of: ascii, digits, all');
    }
    return text;
  }
  let number;
  if (setting.kind === 'int') {
    if (typeof value === 'number' && Number.isInteger(value)) number = value;
    else if (typeof value === 'string' && /^\s*[-+]?\d+\s*$/.test(value)) number = parseInt(value, 10);
    else throw new Error(`${setting.label}: '${value}' is not a whole number`);
  } else {
    number = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
    if (!Number.isFinite(number)) throw new Error(`${setting.label}: '${value}' is not a number`);
  }
  if (setting.low !== null && number < setting.low) throw new Error(`${setting.label}: must be at least ${setting.low}`);
  if (setting.high !== null && number > setting.high) throw new Error(`${setting.label}: must be at most ${setting.high}`);
  return number;
}

/* Defaults with saved overrides layered on. Unknown or invalid saved values
   are ignored rather than crashing the scanner. */
export function build(overrides = {}) {
  const cfg = defaults();
  for (const [key, value] of Object.entries(overrides || {})) {
    const setting = BY_KEY.get(key);
    if (!setting) continue;
    try {
      cfg[setting.section][setting.name] = coerce(setting, value);
    } catch {
      /* keep the default */
    }
  }
  return cfg;
}

/* Validate a batch from the Setup page. Returns {cleaned, applies}; throws on the first bad value. */
export function validate(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('settings must be an object');
  const cleaned = {};
  const applies = new Set();
  for (const [key, raw] of Object.entries(values)) {
    const setting = BY_KEY.get(key);
    if (!setting) throw new Error(`unknown setting '${key}'`);
    cleaned[key] = coerce(setting, raw);
    applies.add(setting.applies);
  }
  return { cleaned, applies: [...applies] };
}

export function describe(cfg) {
  return EDITABLE.map((s) => ({
    key: `${s.section}.${s.name}`,
    section: s.section,
    label: s.label,
    help: s.help,
    type: s.kind,
    min: s.low,
    max: s.high,
    applies: s.applies,
    value: cfg[s.section][s.name],
    default: DEFAULTS[s.section][s.name],
  }));
}
