// LiveMemory Kuaishou G0 — anonymous H5 live-chat feed probe (research only).
//
// Verifies, against real public live rooms and without any login/cookie:
//   1. whether the public H5 feed endpoint returns live chat;
//   2. which identity/timestamp fields each message carries;
//   3. whether the cursor yields incremental, non-duplicated messages;
//   4. which event types appear (comment / gift / like / enter / ...);
//   5. whether a public room page exposes live/offline state without login.
//
// It does not log in, does not send anything, and polls at the server-advertised
// cadence (pullCycleSeconds, normally 3s). It prints aggregates and masked
// samples only; it does not persist chat content.
//
// Usage:
//   node research/kuaishou-g0/feed-probe.mjs --room yl123565 --seconds 60
//   node research/kuaishou-g0/feed-probe.mjs --live-stream-id zJp09dz0hoI --seconds 60

import { createHash } from 'node:crypto'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const roomArg = argOf('--room', '')
const directStreamId = argOf('--live-stream-id', '')
const topRoom = args.includes('--top')
const seconds = Number(argOf('--seconds', '60'))
const desktopUA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const mobileUA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fetchT = (url, opts = {}, ms = 15000) => fetch(url, { ...opts, signal: AbortSignal.timeout(ms) })
const mask = (s) => {
  const str = String(s ?? '')
  if (!str) return ''
  return `${str.slice(0, 1)}***${str.slice(-1)}(${str.length})`
}
const shortHash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 10)

async function resolveRoom(room) {
  const res = await fetchT(`https://live.kuaishou.com/u/${encodeURIComponent(room)}`, {
    headers: { 'user-agent': desktopUA, accept: 'text/html' },
  })
  const html = await res.text()
  const live = html.match(/"playList":\[\{"liveStream":\{"id":"([^"]+)"/)
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/)
  const author = html.match(/"name":"([^"]{1,40})","avatar"/)
  return {
    httpStatus: res.status,
    bytes: html.length,
    liveStreamId: live?.[1] ?? null,
    pageTitle: title?.[1] ?? null,
    authorHint: author?.[1] ?? null,
  }
}

/** Pick the most-watched room from the public anonymous home list. */
async function resolveTopRoom() {
  const res = await fetchT('https://live.kuaishou.com/live_api/home/list', {
    headers: { 'user-agent': mobileUA, accept: 'application/json, text/plain, */*', referer: 'https://live.kuaishou.com/' },
  })
  const body = await res.json()
  const rooms = []
  for (const section of body?.data?.list ?? []) {
    for (const group of section?.gameLiveInfo ?? []) {
      for (const item of group?.liveInfo ?? []) if (item?.id && item?.author?.id) rooms.push(item)
    }
  }
  rooms.sort((a, b) => Number(b.watchingCount ?? 0) - Number(a.watchingCount ?? 0))
  return rooms[0] ?? null
}

async function pullFeed(liveStreamId, cursor) {
  const url = `https://livev.m.chenzhongtech.com/wap/live/feed?liveStreamId=${encodeURIComponent(liveStreamId)}${
    cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
  }`
  const res = await fetchT(url, {
    headers: {
      'user-agent': mobileUA,
      accept: 'application/json, text/plain, */*',
      referer: 'https://livev.m.chenzhongtech.com/',
    },
  })
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
    // The endpoint has historically double-encoded its JSON.
    if (typeof body === 'string') body = JSON.parse(body)
  } catch {
    body = null
  }
  return { status: res.status, bytes: text.length, body }
}

const out = {
  startedAt: new Date().toISOString(),
  roomArg,
  directStreamId,
  seconds,
  resolve: null,
  polls: 0,
  pollErrors: 0,
  resultCodes: {},
  pullCycleSeconds: null,
  watching: [],
  feeds: 0,
  types: {},
  fieldCoverage: { userName: 0, userId: 0, time: 0, headurl: 0, messageId: 0 },
  uniqueUserIds: new Set(),
  userIdNicknames: new Map(),
  userIdMessageCounts: new Map(),
  perPollCounts: [],
  duplicateKeyHits: 0,
  latencyMs: [],
  samples: [],
  cursorReplay: null,
  keySets: {},
}

let liveStreamId = directStreamId || null
if (topRoom) {
  const top = await resolveTopRoom()
  if (top) {
    out.resolve = { source: 'home/list top', liveStreamId: top.id, authorId: top.author?.id ?? null, watching: top.watchingCount ?? null }
    liveStreamId = top.id
  }
}
if (!liveStreamId && roomArg) {
  out.resolve = await resolveRoom(roomArg)
  liveStreamId = out.resolve.liveStreamId
}
if (!liveStreamId) {
  console.log(JSON.stringify({ ...out, uniqueUserIds: 0, error: 'no liveStreamId (room offline or not found)' }, null, 2))
  process.exit(4)
}

const seen = new Set()
const deadline = Date.now() + seconds * 1000
let cursor = ''
let intervalMs = 3000

while (Date.now() < deadline) {
  const t0 = Date.now()
  const { status, bytes, body } = await pullFeed(liveStreamId, cursor)
  out.polls++
  if (status !== 200 || !body) {
    out.pollErrors++
  } else {
    out.resultCodes[String(body.result)] = (out.resultCodes[String(body.result)] ?? 0) + 1
    if (body.pullCycleSeconds) intervalMs = Math.max(1000, Number(body.pullCycleSeconds) * 1000)
    if (body.currentWatchingCount != null) out.watching.push(Number(body.currentWatchingCount))
    const feeds = Array.isArray(body.liveStreamFeeds) ? body.liveStreamFeeds : []
    out.perPollCounts.push(feeds.length)
    for (const f of feeds) {
      out.feeds++
      const type = String(f.type ?? '(none)')
      out.types[type] = (out.types[type] ?? 0) + 1
      const author = f.author ?? {}
      if (author.userName) out.fieldCoverage.userName++
      if (author.userId != null && String(author.userId) !== '') out.fieldCoverage.userId++
      if (f.time != null) out.fieldCoverage.time++
      if (author.headurl) out.fieldCoverage.headurl++
      if (f.id != null || f.feedId != null) out.fieldCoverage.messageId++
      if (author.userId != null) {
        const uid = String(author.userId)
        out.uniqueUserIds.add(uid)
        out.userIdMessageCounts.set(uid, (out.userIdMessageCounts.get(uid) ?? 0) + 1)
        const names = out.userIdNicknames.get(uid) ?? new Set()
        names.add(String(author.userName ?? ''))
        out.userIdNicknames.set(uid, names)
      }
      if (f.time != null) out.latencyMs.push(t0 - Number(f.time))
      const key = `${author.userId ?? ''}|${f.time ?? ''}|${shortHash(f.content ?? '')}`
      if (seen.has(key)) out.duplicateKeyHits++
      seen.add(key)
      const keys = Object.keys(f).sort().join(',')
      out.keySets[keys] = (out.keySets[keys] ?? 0) + 1
      if (out.samples.length < 3 && type === 'comment') {
        out.samples.push({
          type,
          nick: mask(author.userName),
          userId: String(author.userId ?? '') ? `present(${String(author.userId).length} digits)` : 'missing',
          contentLen: String(f.content ?? '').length,
          time: f.time ?? null,
          keys,
        })
      }
    }
    if (body.cursor) cursor = body.cursor
  }
  const elapsed = Date.now() - t0
  await sleep(Math.max(0, intervalMs - elapsed) + 120)
}

// Replay the last cursor once: a well-behaved incremental feed returns no new rows.
try {
  const replay = await pullFeed(liveStreamId, cursor)
  out.cursorReplay = {
    status: replay.status,
    result: replay.body?.result ?? null,
    feeds: Array.isArray(replay.body?.liveStreamFeeds) ? replay.body.liveStreamFeeds.length : null,
  }
} catch (err) {
  out.cursorReplay = { error: String(err?.message ?? err) }
}

const sortedLatency = out.latencyMs.slice().sort((a, b) => a - b)
const pct = (p) => (sortedLatency.length ? sortedLatency[Math.min(sortedLatency.length - 1, Math.floor((p / 100) * sortedLatency.length))] : null)
const nickChanges = [...out.userIdNicknames.entries()].filter(([, names]) => names.size > 1)
const repeatUsers = [...out.userIdMessageCounts.values()].filter((n) => n > 1)
console.log(
  JSON.stringify(
    {
      ...out,
      userIdNicknames: undefined,
      userIdMessageCounts: undefined,
      uniqueUserIds: out.uniqueUserIds.size,
      usersWithMoreThanOneNickname: nickChanges.length,
      repeatUsers: repeatUsers.length,
      maxMessagesPerPoll: out.perPollCounts.length ? Math.max(...out.perPollCounts) : 0,
      pollsWithZeroMessages: out.perPollCounts.filter((n) => n === 0).length,
      watching: out.watching.length ? { min: Math.min(...out.watching), max: Math.max(...out.watching), last: out.watching.at(-1) } : null,
      latencyMs: sortedLatency.length
        ? { p50: pct(50), p95: pct(95), max: sortedLatency.at(-1), negative: out.latencyMs.filter((v) => v < 0).length }
        : null,
      fieldCoveragePct: Object.fromEntries(
        Object.entries(out.fieldCoverage).map(([k, v]) => [k, out.feeds ? Math.round((v / out.feeds) * 1000) / 10 : 0]),
      ),
    },
    null,
    2,
  ),
)
