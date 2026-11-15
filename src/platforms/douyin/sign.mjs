import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {DOUYIN_ERRORS, DouyinError} from './errors.mjs';

/**
 * Douyin web-client signature helper.
 *
 * The public live page loads ByteDance's `webmssdk` and computes a signature
 * for the WebSocket handshake. This module executes the vendored (AGPL-3.0)
 * deobfuscated signature script in a minimal `node:vm` sandbox with no
 * filesystem, network, process or credential access. It only returns a string.
 *
 * If the vendored script cannot be loaded or throws, the adapter reports
 * DOUYIN_SIGNATURE_FAILED. It never falls back to an unsigned connection or a
 * fabricated signature.
 */

export const DOUYIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const SIGN_FILE = fileURLToPath(new URL('./vendor/sign.js', import.meta.url));

let signContext = null;

function loadSignContext() {
  if (signContext) return signContext;
  try {
    const source = readFileSync(SIGN_FILE, 'utf8');
    const context = vm.createContext({console, navigator: {userAgent: DOUYIN_UA}});
    vm.runInContext(source, context, {filename: 'douyin-sign.js', timeout: 10000});
    if (typeof context.get_sign !== 'function') {
      throw new Error('get_sign is missing');
    }
    signContext = context;
    return context;
  } catch (error) {
    throw new DouyinError(DOUYIN_ERRORS.SIGNATURE_FAILED, {
      messageKey: 'errors.douyinSignatureFailed',
      details: {reason: 'sign_script'},
      cause: error
    });
  }
}

/**
 * The exact parameter string the web client hashes before signing. Field order
 * is part of the protocol; do not reorder.
 */
export function signatureParams({roomId, userUniqueId}) {
  return [
    'live_id=1',
    'aid=6383',
    'version_code=180800',
    'webcast_sdk_version=1.0.14-beta.0',
    `room_id=${roomId}`,
    'sub_room_id=',
    'sub_channel_id=',
    'did_rule=3',
    `user_unique_id=${userUniqueId}`,
    'device_platform=web',
    'device_type=',
    'ac=',
    'identity=audience'
  ].join(',');
}

export function computeSignature({roomId, userUniqueId}) {
  if (!roomId) throw new DouyinError(DOUYIN_ERRORS.PROTOCOL, {details: {reason: 'missing_room_id'}});
  const context = loadSignContext();
  try {
    const digest = createHash('md5').update(signatureParams({roomId, userUniqueId: userUniqueId ?? roomId})).digest('hex');
    const signature = context.get_sign(digest);
    if (typeof signature !== 'string' || signature.length < 8) throw new Error('empty signature');
    return signature;
  } catch (error) {
    if (error instanceof DouyinError) throw error;
    throw new DouyinError(DOUYIN_ERRORS.SIGNATURE_FAILED, {
      messageKey: 'errors.douyinSignatureFailed',
      details: {reason: 'sign_call'},
      cause: error
    });
  }
}

/** Test helper: forget the cached VM context. */
export function resetSignatureCache() {
  signContext = null;
}

export const __internal = {SIGN_FILE};
