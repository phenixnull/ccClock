const test = require('node:test');
const assert = require('node:assert/strict');
const { getNotificationSpace, getStackHeight, getNotificationLayout } = require('./notification-layout');

test('measured heights, gaps and screen margins determine capacity', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 552 };
  const entries = [{ height: 160 }, { height: 340 }];
  assert.equal(getStackHeight(entries), 512);
  assert.deepEqual(getNotificationLayout(entries, workArea), [
    { x: 1480, y: 372, width: 420, height: 160 },
    { x: 1480, y: 20, width: 420, height: 340 },
  ]);
  assert.equal(getNotificationLayout(entries, { ...workArea, height: 551 }), null);
});

test('narrow work areas adapt the card width and negative monitor origins remain valid', () => {
  const workArea = { x: -360, y: -600, width: 360, height: 600 };
  const entries = [{ height: 200 }, { height: 300 }];
  const layout = getNotificationLayout(entries, workArea);
  assert.deepEqual(getNotificationSpace(workArea), { x: -340, y: -580, width: 320, height: 560 });
  assert.equal(layout[0].width, 320);
  for (const bounds of layout) {
    assert.ok(bounds.x >= workArea.x + 20);
    assert.ok(bounds.y >= workArea.y + 20);
    assert.ok(bounds.x + bounds.width <= workArea.x + workArea.width - 20);
    assert.ok(bounds.y + bounds.height <= workArea.y + workArea.height - 20);
  }
});

test('the oldest remaining card moves down after the bottom card is acknowledged', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const entries = [{ height: 200 }, { height: 160 }, { height: 300 }];
  const before = getNotificationLayout(entries, workArea);
  const after = getNotificationLayout(entries.slice(1), workArea);
  assert.equal(after[0].y - before[1].y, 212);
  assert.equal(after[1].y - before[2].y, 212);
});

test('unknown dimensions or a work area too small for one card cannot be admitted', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 199 };
  assert.equal(getNotificationLayout([{ height: 160 }], workArea), null);
  assert.equal(getNotificationLayout([{}], { ...workArea, height: 1080 }), null);
  assert.equal(getNotificationLayout([{ height: NaN }], { ...workArea, height: 1080 }), null);
  assert.equal(getNotificationLayout([{ height: 160 }], { ...workArea, width: 60, height: 1080 }), null);
  assert.deepEqual(getNotificationLayout([], workArea), []);
});
