import test from 'node:test';
import assert from 'node:assert/strict';
import {BilibiliService} from '../../src/platforms/bilibili/service.mjs';

function serviceFor(liveStatus) {
  const api = {
    loggedIn: false,
    async roomInit(id) {
      return {roomId: Number(id), shortId: null, uid: 9001, liveStatus, liveTime: null};
    },
    async roomInfo() {
      return {
        title: 'Test room',
        areaName: 'Area',
        parentAreaName: 'Parent',
        liveStatus,
        online: 12,
        anchorName: 'Anchor',
        anchorUid: 9001
      };
    }
  };
  const sessionManager = {
    status: () => ({recordings: []}),
    async startPlatform() {
      throw new Error('startPlatform must not run for a non-live room');
    }
  };
  return new BilibiliService({
    store: {load: () => null, cookie: () => '', status: () => ({stored: false})},
    sessionManager,
    api,
    logger: null
  });
}

test('a Bilibili room that is offline is rejected before creating a capture', async () => {
  const service = serviceFor(0);
  await assert.rejects(service.connect(5050), (error) => (
    error.code === 'BILIBILI_ROOM_OFFLINE'
    && error.messageKey === 'errors.bilibiliRoomNotLive'
    && error.httpStatus === 409
  ));
});

test('a carousel/replay room is not treated as a live broadcast', async () => {
  const service = serviceFor(2);
  await assert.rejects(service.connect(5050), (error) => (
    error.code === 'BILIBILI_ROOM_CAROUSEL'
    && error.messageKey === 'errors.bilibiliRoomCarousel'
    && error.httpStatus === 409
  ));
});
