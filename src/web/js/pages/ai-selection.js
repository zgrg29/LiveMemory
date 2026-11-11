/**
 * Select the initial broadcast by stable `session_id`, never by title or list
 * index. The requested id may come from the history page's `?session=` hash.
 */
export function chooseInitialSessionId(sessions, requestedId) {
  if (requestedId && sessions.some((session) => session.id === requestedId)) return requestedId;
  return sessions[0]?.id ?? null;
}
