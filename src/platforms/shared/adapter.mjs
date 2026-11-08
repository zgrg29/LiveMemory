/**
 * Adapter contract.
 *
 * A platform adapter owns the transport (WebSocket, polling, simulator) and
 * converts native payloads into canonical events. It never writes to the
 * database itself: the ingest pipeline does that, so dedupe and accounting stay
 * identical for every platform.
 */
export const CONNECTION_STATE = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  AUTH_REQUIRED: 'auth_required',
  FAILED: 'failed',
  STOPPED: 'stopped'
});

export class PlatformAdapter {
  constructor({id, platform, label, capabilities = []}) {
    this.id = id;
    this.platform = platform;
    this.label = label;
    this.capabilities = capabilities;
    this.state = CONNECTION_STATE.IDLE;
    this.detail = null;
  }

  setState(state, detail = null) {
    this.state = state;
    this.detail = detail;
    this.onStateChange?.({adapter: this.id, state, detail});
  }

  /** @param {{onEvent: Function, onStateChange: Function}} _context */
  async start(_context) {
    throw new Error('not implemented');
  }

  async stop() {
    this.setState(CONNECTION_STATE.STOPPED);
  }

  snapshot() {
    return {id: this.id, platform: this.platform, label: this.label, state: this.state, detail: this.detail, capabilities: this.capabilities};
  }
}
