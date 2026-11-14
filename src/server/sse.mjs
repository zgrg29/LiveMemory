/**
 * Server-sent events hub for the live console.
 *
 * Only live status and freshly inserted events are pushed. The console re-reads
 * aggregates over HTTP, so a reconnecting browser never depends on replaying the
 * stream to stay correct.
 */
export class EventStream {
  constructor({heartbeatMs = 15000} = {}) {
    this.clients = new Set();
    this.heartbeatMs = heartbeatMs;
    this.sequence = 0;
    this.timer = setInterval(() => this.#heartbeat(), heartbeatMs);
    this.timer.unref?.();
  }

  get size() {
    return this.clients.size;
  }

  add(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
    });
    res.write('retry: 3000\n\n');
    const client = {res};
    this.clients.add(client);
    const cleanup = () => {
      this.clients.delete(client);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);
    this.send(client, 'hello', {at: Date.now()});
    return client;
  }

  send(client, event, data) {
    try {
      this.sequence += 1;
      client.res.write(`id: ${this.sequence}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.clients.delete(client);
    }
  }

  broadcast(event, data) {
    if (this.clients.size === 0) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of [...this.clients]) {
      try {
        client.res.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  #heartbeat() {
    for (const client of [...this.clients]) {
      try {
        client.res.write(': ping\n\n');
      } catch {
        this.clients.delete(client);
      }
    }
  }

  closeAll() {
    clearInterval(this.timer);
    for (const client of [...this.clients]) {
      try {
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}
