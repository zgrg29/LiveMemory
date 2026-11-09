/**
 * API client for the local server.
 *
 * All requests are same-origin and carry JSON. Server errors are converted into
 * ApiError instances that keep the stable error code and i18n message key, so
 * the UI never has to parse English prose from the server.
 */
export class ApiError extends Error {
  constructor({code = 'INTERNAL', messageKey = 'errors.generic', details = null, status = 0} = {}) {
    super(code);
    this.name = 'ApiError';
    this.code = code;
    this.messageKey = messageKey;
    this.details = details;
    this.status = status;
  }
}

async function request(path, {method = 'GET', body = undefined, signal = undefined} = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      signal,
      headers: body === undefined ? {} : {'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store'
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError({code: 'NETWORK', messageKey: 'errors.network', status: 0});
  }
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    throw new ApiError({
      code: payload?.error?.code ?? 'INTERNAL',
      messageKey: payload?.error?.messageKey ?? 'errors.generic',
      details: payload?.error?.details ?? null,
      status: response.status
    });
  }
  return payload;
}

export const api = {
  get: (path, options) => request(path, {...options, method: 'GET'}),
  post: (path, body = {}, options) => request(path, {...options, method: 'POST', body}),
  patch: (path, body = {}, options) => request(path, {...options, method: 'PATCH', body}),
  delete: (path, body = {}, options) => request(path, {...options, method: 'DELETE', body}),
  download(path) {
    const anchor = document.createElement('a');
    anchor.href = path;
    anchor.rel = 'noopener';
    anchor.download = '';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }
};
