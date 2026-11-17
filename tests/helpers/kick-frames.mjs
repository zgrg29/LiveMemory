/**
 * Kick payload fixtures.
 *
 * The shapes mirror real Centrifugo publications captured on 2026-11-16/17,
 * but every username, user id, message id and body here is invented: tests
 * must not depend on a real person's chat history, and the repository must not
 * store it.
 */

export const KICK_TEST_CHATROOM = 2393554;
export const KICK_TEST_CHANNEL = 2401072;

export function kickChat(overrides = {}) {
  return {
    id: 'afc48273-912e-4c11-a32a-57e4b692423c',
    chatroom_id: KICK_TEST_CHATROOM,
    content: 'hello world',
    type: 'message',
    created_at: '2026-11-16T17:23:46+00:00',
    sender: {
      id: 3119475,
      username: 'Alice',
      slug: 'alice',
      identity: {
        color: '#1475E1',
        badges: [{type: 'subscriber', text: 'Subscriber', count: 21, sort_order: 9}]
      }
    },
    metadata: {},
    thread_parent_id: null,
    ...overrides
  };
}

/** Laravel-style publication payload: `{event, data}` with data stringified. */
export function kickPayload(event, data, {stringify = true} = {}) {
  return {
    event,
    data: stringify ? JSON.stringify(data) : data
  };
}

export function publicationFrame(event, data, {channel = `chatrooms.${KICK_TEST_CHATROOM}.v2`, stringify = true} = {}) {
  return {
    push: {
      channel,
      pub: {data: kickPayload(event, data, {stringify})}
    }
  };
}

export function connectAck(id = 1, overrides = {}) {
  return {
    id,
    connect: {
      client: 'fake-client',
      version: '6.9.7 PRO',
      expires: true,
      ttl: 2700,
      ping: 25,
      pong: true,
      ...overrides
    }
  };
}

export function subscribeAck(id) {
  return {id, subscribe: {}};
}

export function tokenExpiredFrame(code = 109) {
  return {disconnect: {code, reason: 'token expired'}};
}

/** Minimal JWT-shaped token with a readable payload (not signed, not secret). */
export function guestToken({ttlSec = 2700, iat = 1794849680, sub = 'guest:8e8f6f9c-0000-4000-8000-000000000000'} = {}) {
  const header = Buffer.from(JSON.stringify({alg: 'HS256', typ: 'JWT'})).toString('base64url');
  const payload = Buffer.from(JSON.stringify({sub, exp: iat + ttlSec, iat})).toString('base64url');
  return `${header}.${payload}.not-a-real-signature`;
}
