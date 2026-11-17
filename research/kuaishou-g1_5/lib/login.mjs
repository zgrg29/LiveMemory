// Kuaishou G1.5 research prototype — browser-free QR login and live ticket.
//
// The whole session lives in memory. Nothing (cookie, passToken, authToken) is
// written to disk or logged. Only the QR PNG is written so a human can scan it.
//
// This code deliberately does NOT implement __NS_hxfalcon / __NS_sig3,
// webweapon/gdfp device fingerprints, slider solving or TLS impersonation.
// If Kuaishou requires any of those, the request fails and the failure is
// recorded — it is never worked around.

import {mkdir, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {KuaishouError, CODES, classifyResult} from './errors.mjs';
import {CookieJar, DESKTOP_UA, formBody, request, requestJson} from './http.mjs';

const ID_HOST = 'https://id.kuaishou.com';
const LIVE_HOST = 'https://live.kuaishou.com';
const WWW_HOST = 'https://www.kuaishou.com';
const SID_WWW = 'kuaishou.server.webday7';
const SID_LIVE = 'kuaishou.live.web';

const BASE_HEADERS = {
  'user-agent': DESKTOP_UA,
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9'
};

function jsonHeaders({referer, origin, json = false}) {
  return {
    ...BASE_HEADERS,
    ...(json ? {'content-type': 'application/json'} : {'content-type': 'application/x-www-form-urlencoded'}),
    referer,
    origin
  };
}

function safeResult(body) {
  const data = body?.data ?? body ?? {};
  return Number(data?.result ?? body?.result ?? NaN);
}

export class QrLoginSession {
  #jar = new CookieJar();

  constructor({requestImpl = request, qrPath = null, now = Date.now} = {}) {
    this.requestImpl = requestImpl;
    this.qrPath = qrPath;
    this.now = now;
    this.qr = null;
    this.stage = 'idle';
  }

  get cookieNames() {
    return this.#jar.names();
  }

  get hasCookies() {
    return this.#jar.size > 0;
  }

  async #post(host, path, fields, {referer, timeoutMs = 30000, json = false} = {}) {
    const res = await this.requestImpl(`${host}${path}`, {
      method: 'POST',
      headers: {
        ...jsonHeaders({referer, origin: new URL(referer).origin, json}),
        ...(this.#jar.size ? {cookie: this.#jar.header()} : {})
      },
      body: json ? JSON.stringify(fields) : formBody(fields),
      timeoutMs
    });
    this.#jar.absorb(res.setCookies);
    if (res.json === null) {
      throw new KuaishouError(CODES.UPSTREAM, `${path} 返回的不是 JSON`, {
        detail: {status: res.status, sample: res.text.slice(0, 120)}
      });
    }
    return res;
  }

  async startQr() {
    const res = await this.#post(ID_HOST, '/rest/c/infra/ks/qr/start', {
      sid: SID_WWW,
      channelType: 'UNKNOWN',
      isWebSig4: 'true'
    }, {referer: `${WWW_HOST}/`, timeoutMs: 20000});
    const body = res.json ?? {};
    const err = classifyResult(safeResult(body), body);
    if (err) throw err;
    const imageData = String(body.imageData ?? '');
    if (!imageData) throw new KuaishouError(CODES.UPSTREAM, 'qr/start 没有返回二维码图片');
    this.qr = {
      token: String(body.qrLoginToken ?? ''),
      signature: String(body.qrLoginSignature ?? ''),
      url: String(body.qrUrl ?? ''),
      expireTime: body.expireTime ? Number(body.expireTime) : null,
      imageData
    };
    this.stage = 'qr_ready';
    if (this.qrPath) await this.#writeQr(imageData);
    return {hasToken: Boolean(this.qr.token), expireTime: this.qr.expireTime, qrPath: this.qrPath};
  }

  async #writeQr(imageData) {
    await mkdir(dirname(this.qrPath), {recursive: true});
    await writeFile(this.qrPath, Buffer.from(imageData, 'base64'), {mode: 0o600});
  }

  async scan() {
    if (!this.qr) throw new KuaishouError(CODES.CONFIG, '还没有二维码');
    const res = await this.#post(ID_HOST, '/rest/c/infra/ks/qr/scanResult', {
      qrLoginToken: this.qr.token,
      qrLoginSignature: this.qr.signature,
      channelType: 'UNKNOWN',
      isWebSig4: 'true'
    }, {referer: `${WWW_HOST}/`, timeoutMs: 70000});
    return safeResult(res.json);
  }

  async accept() {
    if (!this.qr) throw new KuaishouError(CODES.CONFIG, '还没有二维码');
    const res = await this.#post(ID_HOST, '/rest/c/infra/ks/qr/acceptResult', {
      qrLoginToken: this.qr.token,
      qrLoginSignature: this.qr.signature,
      sid: SID_WWW,
      channelType: 'UNKNOWN',
      isWebSig4: 'true'
    }, {referer: `${WWW_HOST}/`, timeoutMs: 70000});
    const body = res.json ?? {};
    const qrToken = body.qrToken ?? body.qr_token;
    if (!qrToken) {
      const err = classifyResult(safeResult(body), body);
      throw err ?? new KuaishouError(CODES.UPSTREAM, 'acceptResult 没有返回 qrToken');
    }
    return {qrToken: String(qrToken)};
  }

  async callback(qrToken) {
    const res = await this.#post(ID_HOST, '/pass/kuaishou/login/qr/callback', {
      qrToken,
      sid: SID_WWW,
      channelType: 'UNKNOWN',
      isWebSig4: 'true'
    }, {referer: `${WWW_HOST}/`});
    const body = res.json ?? {};
    const passToken = String(body.passToken ?? this.#jar.get('passToken') ?? '');
    this.stage = passToken ? 'logged_in' : 'callback_without_pass_token';
    return {result: safeResult(body), hasPassToken: Boolean(passToken), passToken};
  }

  /**
   * Exchange the passport passToken for a live-site auth token.
   * This is the decisive unsigned step: catbus performs it after a signed
   * login; here we ask whether a plain session-backed request is accepted.
   */
  async exchangeLiveTicket(passToken) {
    if (!passToken) return {ok: false, stage: 'no_pass_token'};

    // Optional preflight used by the official live page. It only needs the
    // anonymous `did` visitor cookie, which is added lazily.
    if (!this.#jar.get('did')) {
      // A random visitor id, not a device fingerprint.
      this.#jar.absorb([`did=web_${Math.random().toString(16).slice(2).padEnd(16, '0')}; Path=/`]);
    }
    const preflight = await this.requestImpl(`${ID_HOST}/pass/kuaishou/getCdns`, {
      method: 'POST',
      headers: jsonHeaders({referer: `${LIVE_HOST}/`, origin: LIVE_HOST, json: true}),
      body: JSON.stringify({sid: SID_LIVE, did: this.#jar.get('did')}),
      timeoutMs: 20000
    }).catch((err) => ({status: 0, json: null, error: err?.code ?? 'NETWORK'}));
    this.#jar.absorb(preflight.setCookies ?? []);

    const res = await this.#post(ID_HOST, '/pass/kuaishou/login/passToken', {
      sid: SID_LIVE,
      channelType: 'UNKNOWN',
      encryptHeaders: ''
    }, {referer: `${LIVE_HOST}/`});
    const body = res.json ?? {};
    const result = safeResult(body);
    const authToken = String(body?.[`${SID_LIVE}.at`] ?? this.#jar.get(`${SID_LIVE}.at`) ?? '');
    return {
      ok: result === 1,
      result,
      hasAuthToken: Boolean(authToken),
      preflight: {status: preflight.status ?? 0, result: preflight.json?.result ?? null},
      cookieNames: this.#jar.names(),
      authToken
    };
  }

  async liveUserLogin(authToken) {
    if (!authToken) return {ok: false, reason: 'no_auth_token'};
    const res = await this.requestImpl(`${LIVE_HOST}/live_api/baseuser/userLogin`, {
      method: 'POST',
      headers: {
        ...jsonHeaders({referer: `${LIVE_HOST}/`, origin: LIVE_HOST, json: true}),
        cookie: this.#jar.header()
      },
      body: JSON.stringify({userLoginInfo: {authToken, sid: SID_LIVE}}),
      timeoutMs: 20000
    });
    this.#jar.absorb(res.setCookies);
    const result = safeResult(res.json);
    return {ok: result === 1, result, cookieNames: this.#jar.names()};
  }

  /** Generic authenticated GET used by the controlled re-probe. */
  async authedJson(path, {referer = `${LIVE_HOST}/`} = {}) {
    const res = await this.requestImpl(`${LIVE_HOST}${path}`, {
      method: 'GET',
      headers: {
        ...BASE_HEADERS,
        referer,
        origin: LIVE_HOST,
        cookie: this.#jar.header()
      },
      timeoutMs: 20000
    });
    const body = res.json ?? {};
    const data = body?.data ?? body ?? {};
    return {
      httpStatus: res.status,
      result: data?.result ?? body?.result ?? null,
      dataKeys: Object.keys(data).slice(0, 12),
      hasToken: Boolean(data?.token),
      hasLiveStream: Boolean(data?.liveStream?.id)
    };
  }

  async websocketInfo({liveStreamId, eid}) {
    const res = await this.requestImpl(
      `${LIVE_HOST}/live_api/liveroom/websocketinfo?liveStreamId=${encodeURIComponent(liveStreamId)}`,
      {
        method: 'GET',
        headers: {
          ...BASE_HEADERS,
          referer: `${LIVE_HOST}/u/${eid}`,
          origin: LIVE_HOST,
          cookie: this.#jar.header()
        },
        timeoutMs: 20000
      }
    );
    const body = res.json ?? {};
    const data = body?.data ?? {};
    const urls = data.websocketUrls ?? data.websocketUrl ?? data.url ?? [];
    return {
      httpStatus: res.status,
      result: data.result ?? body.result ?? null,
      hasToken: Boolean(data.token),
      urlCount: Array.isArray(urls) ? urls.length : (urls ? 1 : 0),
      token: data.token ? String(data.token) : '',
      urls: Array.isArray(urls) ? urls.map(String) : (urls ? [String(urls)] : []),
      errorMessage: data.error_msg ?? body.error_msg ?? null
    };
  }

  /** Best-effort server logout. Reports the platform answer instead of assuming success. */
  async logout() {
    try {
      const res = await this.#post(ID_HOST, '/pass/kuaishou/login/logout', {
        sid: SID_LIVE,
        channelType: 'UNKNOWN',
        encryptHeaders: ''
      }, {referer: `${LIVE_HOST}/`});
      return {attempted: true, status: res.status, result: safeResult(res.json)};
    } catch (err) {
      return {attempted: true, status: null, result: null, error: err?.code ?? 'NETWORK'};
    } finally {
      this.#jar.clear();
      this.stage = 'logged_out';
    }
  }

  /** Drop the in-memory session without contacting the platform. */
  clear() {
    this.#jar.clear();
    this.qr = null;
    this.stage = 'cleared';
  }
}

export const LOGIN_CONSTANTS = Object.freeze({ID_HOST, LIVE_HOST, SID_WWW, SID_LIVE});
export {requestJson};
