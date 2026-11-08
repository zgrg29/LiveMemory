let counter = 0;

function nextExternalId(prefix) {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function chatEvent(overrides = {}) {
  return {
    platform: 'mock',
    event_type: 'chat',
    external_id: nextExternalId('chat'),
    viewer_uid: 'u_1001',
    display_name: 'Tester',
    occurred_at: Date.now(),
    content: 'hello world',
    ...overrides
  };
}

export function giftEvent(overrides = {}) {
  return {
    platform: 'mock',
    event_type: 'gift',
    external_id: nextExternalId('gift'),
    viewer_uid: 'u_1002',
    display_name: 'Gifter',
    occurred_at: Date.now(),
    gift_id: 'gift_lollipop',
    gift_name: '棒棒糖',
    gift_type: 'paid',
    gift_quantity: 1,
    unit_amount_minor: 100,
    currency: 'CNY',
    value_kind: 'actual',
    is_paid: true,
    ...overrides
  };
}

export function superChatEvent(overrides = {}) {
  return {
    platform: 'mock',
    event_type: 'super_chat',
    external_id: nextExternalId('sc'),
    viewer_uid: 'u_1003',
    display_name: 'Supporter',
    occurred_at: Date.now(),
    content: 'great stream',
    amount_minor: 3000,
    currency: 'CNY',
    value_kind: 'actual',
    is_paid: true,
    ...overrides
  };
}

export function guardEvent(overrides = {}) {
  return {
    platform: 'mock',
    event_type: 'guard',
    external_id: nextExternalId('guard'),
    viewer_uid: 'u_1004',
    display_name: 'Captain',
    occurred_at: Date.now(),
    gift_id: 'guard_captain',
    gift_name: '舰长',
    gift_type: 'paid',
    gift_quantity: 1,
    unit_amount_minor: 13800,
    currency: 'CNY',
    value_kind: 'actual',
    is_paid: true,
    ...overrides
  };
}
