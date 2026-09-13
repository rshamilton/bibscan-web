/* Turns whatever was pasted into "Add a race" into a resolved race,
   regardless of which timing service it names. An unprefixed spec (a bare
   id, or any URL that isn't RunSignUp's) keeps going to Athlinks/ChronoTrack
   exactly as it always has - this only adds a second path, it doesn't
   change the first one. */

import { resolveRace as resolveAthlinksRace } from './athlinks.js';
import { resolveRunSignUpRace, RUNSIGNUP_LINK_HOSTS, nativeId as runSignUpNativeId } from './runsignup.js';

// Races whose provider can be synced/refreshed from the timer, as opposed to
// a one-shot local import (CSV) or the built-in demo.
export const SYNCABLE_KINDS = new Set(['athlinks', 'runsignup']);

export const PROVIDER_LABELS = { athlinks: 'Athlinks', runsignup: 'RunSignUp' };

function isRunSignUp(spec) {
  const lower = spec.toLowerCase();
  if (lower.startsWith('runsignup:') || lower.startsWith('rsu:')) return true;
  if (!lower.startsWith('http')) return false;
  try {
    return RUNSIGNUP_LINK_HOSTS.has(new URL(spec).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/* `clients` is { athlinks, runsignup }. Returns { info, sourceUrl, kind }. */
export async function resolveAnyRace(spec, clients) {
  spec = String(spec || '').trim();
  if (isRunSignUp(spec)) {
    const { info, sourceUrl } = await resolveRunSignUpRace(spec, clients.runsignup);
    return { info, sourceUrl, kind: 'runsignup' };
  }
  const { info, sourceUrl } = await resolveAthlinksRace(spec, clients.athlinks);
  return { info, sourceUrl, kind: 'athlinks' };
}

/* The number a race's own timing service would show for it - undoes the
   offset runsignup.js applies to keep its ids out of Athlinks' range. */
export function nativeRaceId(race) {
  return race.kind === 'runsignup' ? runSignUpNativeId(race.event_id) : race.event_id;
}
