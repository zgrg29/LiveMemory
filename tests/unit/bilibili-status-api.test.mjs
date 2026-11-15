import test from 'node:test';
import assert from 'node:assert/strict';
import {BilibiliApi} from '../../src/platforms/bilibili/api.mjs';

function client(payload, {status = 200} = {}) {
  return new BilibiliApi({
    fetchImpl: async () => new Response(JSON.stringify(payload), {
      status,
      headers: {'content-type': 'application/json'}
    })
  });
}

test('room status parses the public live_status values 0, 1 and 2', async () => {
  for (const liveStatus of [0, 1, 2]) {
    const api = client({
      code: 0,
      message: 'ok',
      data: {room_id: 5050, live_status: liveStatus, live_time: '2026-11-09 10:00:00', title: 'Room'}
    });
    const result = await api.roomStatus(5050);
    assert.equal(result.roomId, 5050);
    assert.equal(result.liveStatus, liveStatus);
    assert.equal(result.title, 'Room');
  }
});

test('a missing or unknown live_status is a failure, never an implicit offline', async () => {
  for (const data of [{room_id: 5050}, {room_id: 5050, live_status: 9}]) {
    const api = client({code: 0, data});
    await assert.rejects(api.roomStatus(5050), (error) => error.code === 'STATUS_INVALID');
  }
});

test('HTTP 429 and platform risk control stay distinguishable from an offline room', async () => {
  const rateLimited = client({code: 0, data: {}}, {status: 429});
  await assert.rejects(rateLimited.roomStatus(5050), (error) => (
    error.code === 'HTTP' && error.status === 429
  ));

  const riskControl = client({code: -352, message: '-352', data: null});
  await assert.rejects(riskControl.roomStatus(5050), (error) => (
    error.code === 'PLATFORM' && error.biliCode === -352
  ));
});
