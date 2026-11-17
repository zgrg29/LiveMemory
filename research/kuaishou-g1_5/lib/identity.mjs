// Kuaishou G1.5 research prototype — identity mapping and evidence.
//
// The product rule is: nickname is never an identity, and two routes are never
// merged just because the ids look alike. This module keeps raw ids separated
// by namespace and only links them when a caller supplies concrete evidence
// (for example, the same operator account sending one comment in each route).

import {NAMESPACE, qualifyUid} from './normalize.mjs';

const VALID_NAMESPACES = new Set(Object.values(NAMESPACE));

export class IdentityRegistry {
  #observations = [];
  #links = [];

  observe({namespace, rawUid, nickname = '', room = null, liveStreamId = null, at = Date.now()}) {
    if (!VALID_NAMESPACES.has(namespace)) throw new Error(`未知命名空间：${namespace}`);
    const uid = qualifyUid(namespace, rawUid);
    this.#observations.push({namespace, rawUid: uid ? String(rawUid) : null, uid, nickname, room, liveStreamId, at});
    return uid;
  }

  /**
   * Record proof that two namespace-local ids are the same person.
   * `evidence` must name how it was established; a bare assertion is rejected.
   */
  link({h5Uid, wsUid, evidence}) {
    if (!evidence || !evidence.kind) throw new Error('合并没有证据：必须说明 kind');
    const a = qualifyUid(NAMESPACE.H5, h5Uid);
    const b = qualifyUid(NAMESPACE.WS, wsUid);
    if (!a || !b) throw new Error('合并需要两个命名空间都有有效 ID');
    const link = {h5: a, ws: b, evidence: {...evidence}, at: Date.now()};
    this.#links.push(link);
    return link;
  }

  /** Merge is allowed only for an explicitly linked pair. */
  canMerge(namespaceA, rawA, namespaceB, rawB) {
    const a = qualifyUid(namespaceA, rawA);
    const b = qualifyUid(namespaceB, rawB);
    if (!a || !b) return false;
    return this.#links.some((l) => (l.h5 === a && l.ws === b) || (l.h5 === b && l.ws === a));
  }

  get links() {
    return this.#links.map((l) => ({...l, evidence: {...l.evidence}}));
  }

  get observations() {
    return this.#observations.slice();
  }

  /**
   * Per-namespace evidence summary used by the report. Deliberately does not
   * produce a "stable identity" verdict: it only reports what was observed.
   */
  stats() {
    const byNamespace = {};
    for (const ns of VALID_NAMESPACES) {
      const rows = this.#observations.filter((o) => o.namespace === ns);
      const ids = new Map();
      for (const row of rows) {
        if (!row.uid) continue;
        const entry = ids.get(row.uid) ?? {uid: row.uid, nicknames: new Set(), rooms: new Set(), count: 0};
        entry.nicknames.add(row.nickname);
        if (row.room) entry.rooms.add(row.room);
        entry.count += 1;
        ids.set(row.uid, entry);
      }
      const multiRoom = [...ids.values()].filter((e) => e.rooms.size > 1);
      const multiNickname = [...ids.values()].filter((e) => e.nicknames.size > 1);
      byNamespace[ns] = {
        messages: rows.length,
        distinctIds: ids.size,
        missingIds: rows.filter((r) => !r.uid).length,
        idsSeenInMoreThanOneRoom: multiRoom.length,
        idsWithMoreThanOneNickname: multiNickname.length,
        rooms: [...new Set(rows.map((r) => r.room).filter(Boolean))]
      };
    }
    return {
      byNamespace,
      linkedPairs: this.#links.length,
      // Cross-route merging is never derived automatically.
      crossRouteMerge: this.#links.length > 0 ? 'evidence-linked' : 'not-established'
    };
  }
}
