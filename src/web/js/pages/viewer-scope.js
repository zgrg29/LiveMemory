import {platformLabel} from './shared.js';

/**
 * Pure broadcaster-scope helpers for the viewer pages.
 *
 * The list page scopes across all broadcasters. A single viewer's detail page
 * must only offer the broadcasters that viewer actually appeared for; deriving
 * those options from `/api/broadcasters` (every recorded channel) is the bug
 * this module prevents.
 */

export const SCOPE_ALL = 'all';
export const SCOPE_UNASSIGNED = 'unassigned';

export function readScope(query) {
  const raw = query?.get?.('broadcaster');
  if (!raw) return null;
  const value = String(raw).trim();
  return value || null;
}

export function scopeSuffix(scope) {
  return scope && scope !== SCOPE_ALL ? `?broadcaster=${encodeURIComponent(scope)}` : '';
}

export function broadcasterName(broadcaster) {
  return broadcaster?.displayName || broadcaster?.platformUid || broadcaster?.id || '—';
}

/**
 * @param {object} payload `/api/broadcasters` payload (list page only)
 * @param {Function} t translator
 * @param {{profile?:object|null, includeAll?:boolean}} options
 */
export function scopeOptions(payload, t, {profile = null, includeAll = true} = {}) {
  const options = [];
  if (includeAll) {
    options.push({value: SCOPE_ALL, label: t('viewers.scope.all'), searchText: t('viewers.scope.all')});
  }
  const broadcasters = profile ? (profile.broadcasters ?? []) : (payload?.broadcasters ?? []);
  for (const broadcaster of broadcasters) {
    const name = broadcasterName(broadcaster);
    const current = broadcaster.id === payload?.currentId;
    const label = [
      name,
      platformLabel(broadcaster.platform, t),
      current ? t('viewers.scope.currentBadge') : null
    ].filter(Boolean).join(' · ');
    options.push({
      value: broadcaster.id,
      label,
      searchText: `${name} ${broadcaster.platformUid} ${broadcaster.platform}`.toLowerCase()
    });
  }
  if (includeAll && (payload?.unassigned?.sessionCount ?? 0) > 0) {
    options.push({
      value: SCOPE_UNASSIGNED,
      label: `${t('viewers.scope.unassigned')} · ${payload.unassigned.sessionCount}`,
      searchText: t('viewers.scope.unassigned').toLowerCase()
    });
  }
  return options;
}

/** Scope resolution for the viewer list page (all broadcasters allowed). */
export function resolveScope(payload, raw, {profile = null} = {}) {
  const values = new Set([SCOPE_ALL]);
  for (const broadcaster of payload?.broadcasters ?? []) values.add(broadcaster.id);
  if ((payload?.unassigned?.sessionCount ?? 0) > 0) values.add(SCOPE_UNASSIGNED);
  if (raw === SCOPE_ALL) return SCOPE_ALL;
  if (raw && values.has(raw)) return raw;
  if (profile) {
    if (payload?.currentId && profile.broadcasters?.some((entry) => entry.id === payload.currentId)) {
      return payload.currentId;
    }
    if (profile.broadcasters?.length > 0) return profile.broadcasters[0].id;
    if ((payload?.unassigned?.sessionCount ?? 0) > 0 && (profile.sessions?.length ?? 0) > 0) {
      return SCOPE_UNASSIGNED;
    }
    return SCOPE_ALL;
  }
  if (payload?.currentId && values.has(payload.currentId)) return payload.currentId;
  return SCOPE_ALL;
}

/**
 * Scope resolution for one viewer's detail page.
 *
 * Only broadcasters in `profile.broadcasters` are valid. An unknown/removed
 * broadcaster query parameter falls back to the current broadcaster when it is
 * actually related, then to the first related broadcaster, then to `null`
 * (explicit "no related broadcaster" state). It never falls back to "all".
 */
export function resolveDetailScope(profile, raw, {currentId = null} = {}) {
  const ids = new Set((profile?.broadcasters ?? []).map((entry) => entry.id));
  const requested = String(raw ?? '').trim();
  if (requested && ids.has(requested)) return requested;
  if (currentId && ids.has(currentId)) return currentId;
  return profile?.broadcasters?.[0]?.id ?? null;
}
