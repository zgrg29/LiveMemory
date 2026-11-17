// LiveMemory Kuaishou G0 — anonymous browser observation probe (research only).
//
// Purpose: determine whether a *logged-out* Chromium visiting a public Kuaishou
// live room receives the realtime danmaku WebSocket, and what the normal client
// sends/receives. It does not log in, does not send chat, does not bypass any
// challenge, and makes exactly one page navigation.
//
// Usage:
//   node research/kuaishou-g0/cdp-probe.mjs --room yl123565 --seconds 35
//
// Requires a local Chrome/Edge (auto-detected) and Node >= 22 (global WebSocket).

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const room = argOf('--room', 'yl123565')
const seconds = Number(argOf('--seconds', '35'))
const port = Number(argOf('--port', '9333'))
const url = /^\d+$/.test(room) || /^https?:/.test(room) ? room : `https://live.kuaishou.com/u/${room}`

const candidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const browser = candidates.find((p) => existsSync(p))
if (!browser) {
  console.error('no Chromium browser found')
  process.exit(2)
}

const profile = mkdtempSync(join(tmpdir(), 'lm-ks-g0-'))
const child = spawn(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--mute-audio',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,800',
    url,
  ],
  { stdio: 'ignore', windowsHide: true },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let wsUrl = null
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find((t) => t.type === 'page')
    if (page?.webSocketDebuggerUrl) {
      wsUrl = page.webSocketDebuggerUrl
      break
    }
  } catch {}
  await sleep(250)
}
if (!wsUrl) {
  console.error('devtools endpoint not ready')
  child.kill()
  process.exit(3)
}

const ws = new WebSocket(wsUrl)
let nextId = 1
const send = (method, params = {}) => ws.send(JSON.stringify({ id: nextId++, method, params }))
const sockets = new Map()
const frames = []
const responses = []

ws.onopen = () => {
  send('Network.enable', { maxTotalBufferSize: 50_000_000, maxResourceBufferSize: 5_000_000 })
  send('Page.enable')
  send('Runtime.enable')
}
ws.onmessage = (ev) => {
  let msg
  try {
    msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'))
  } catch {
    return
  }
  const { method, params } = msg
  if (method === 'Network.webSocketCreated') {
    sockets.set(params.requestId, { url: params.url, frames: 0, first: null })
    console.log('[ws created]', params.url)
  } else if (method === 'Network.webSocketFrameReceived') {
    const s = sockets.get(params.requestId)
    const data = params.response?.payloadData ?? ''
    if (s) {
      s.frames++
      if (!s.first) s.first = data
    }
    frames.push({ id: params.requestId, opcode: params.response?.opcode, len: data.length, at: Date.now() })
  } else if (method === 'Network.webSocketClosed') {
    console.log('[ws closed]', sockets.get(params.requestId)?.url ?? params.requestId)
  } else if (method === 'Network.responseReceived') {
    const r = params.response
    if (/websocketinfo|byUser|liveroom|livedetail|live_api|\.graphql/i.test(r.url)) {
      responses.push({ status: r.status, url: r.url.slice(0, 200) })
    }
  } else if (method === 'Runtime.consoleAPICalled') {
    const text = (params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
    if (/websocket|ws|danmu|live|login|error/i.test(text)) console.log('[console]', text.slice(0, 200))
  }
}

await sleep(seconds * 1000)

console.log('\n=== summary ===')
console.log('target:', url)
console.log('sockets:', sockets.size)
for (const [id, s] of sockets) console.log(`- ${s.url} frames=${s.frames} firstLen=${s.first?.length ?? 0}`)
console.log('matched responses:', responses.length)
for (const r of responses.slice(0, 20)) console.log(`- ${r.status} ${r.url}`)
const binary = frames.filter((f) => f.opcode === 2)
console.log('frames total:', frames.length, 'binary:', binary.length)
if (binary.length) {
  const first = sockets.values().next().value?.first ?? ''
  console.log('first binary frame (base64, first 120):', String(first).slice(0, 120))
}

try {
  ws.close()
} catch {}
child.kill()
await sleep(800)
try {
  rmSync(profile, { recursive: true, force: true })
} catch {}
process.exit(0)
