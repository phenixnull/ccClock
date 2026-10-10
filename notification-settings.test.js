const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createNotificationSettings } = require('./notification-settings');

function settingsPath(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-notify-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'settings.json');
}

test('missing settings preserve the audible default', (t) => {
  assert.deepEqual(createNotificationSettings(settingsPath(t)).get(), { soundEnabled: true });
});

test('a saved mute survives a new service instance and can be enabled again', (t) => {
  const filePath = settingsPath(t);
  createNotificationSettings(filePath).setSoundEnabled(false);
  const second = createNotificationSettings(filePath);
  assert.deepEqual(second.get(), { soundEnabled: false });
  second.setSoundEnabled(true);
  assert.deepEqual(createNotificationSettings(filePath).get(), { soundEnabled: true });
  assert.equal(fs.existsSync(filePath + '.tmp'), false);
});

test('invalid saved settings use the default instead of disabling the service', (t) => {
  const filePath = settingsPath(t);
  for (const contents of ['{broken', 'null', '{"soundEnabled":"false"}']) {
    fs.writeFileSync(filePath, contents, 'utf8');
    assert.deepEqual(createNotificationSettings(filePath).get(), { soundEnabled: true });
  }
});

test('invalid switch values cannot overwrite the saved preference', (t) => {
  const filePath = settingsPath(t);
  const settings = createNotificationSettings(filePath);
  settings.setSoundEnabled(false);
  assert.throws(() => settings.setSoundEnabled('true'), /must be a boolean/);
  assert.deepEqual(createNotificationSettings(filePath).get(), { soundEnabled: false });
});

test('a failed save keeps the previous in-memory preference', (t) => {
  const filePath = path.join(settingsPath(t), 'missing', 'settings.json');
  const settings = createNotificationSettings(filePath);
  assert.throws(() => settings.setSoundEnabled(false), /ENOENT/);
  assert.deepEqual(settings.get(), { soundEnabled: true });
});

test('callers cannot mutate the preference without saving', (t) => {
  const settings = createNotificationSettings(settingsPath(t));
  settings.get().soundEnabled = false;
  assert.equal(settings.get().soundEnabled, true);
});
