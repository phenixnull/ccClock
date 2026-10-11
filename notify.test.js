const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, 'notify.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function createCard(options = {}) {
  const elements = {};
  const callbacks = {};
  const intervals = new Map();
  const contexts = [];
  const timeouts = [];
  const heights = [];
  const revisions = [];
  const style = {};
  const saved = [];
  let dismissed = 0;

  function element(id) {
    if (!elements[id]) {
      const classes = new Set();
      const listeners = {};
      elements[id] = {
        hidden: id === 'settings-panel',
        disabled: false,
        textContent: '',
        attributes: {},
        classList: {
          add(value) { classes.add(value); },
          toggle(value, enabled) { enabled ? classes.add(value) : classes.delete(value); },
          contains(value) { return classes.has(value); },
        },
        addEventListener(name, callback) { listeners[name] = callback; },
        setAttribute(name, value) { this.attributes[name] = value; },
        getBoundingClientRect() { return { height: element('settings-panel').hidden ? 140 : 310 }; },
        focus() {},
        contains(target) { return target === this; },
        click() { return listeners.click?.(); },
      };
    }
    return elements[id];
  }

  class AudioContext {
    constructor() {
      if (options.audioUnavailable) throw new Error('Audio unavailable');
      this.state = 'running';
      this.currentTime = 0;
      this.beeps = 0;
      contexts.push(this);
    }
    createOscillator() {
      return { connect() {}, frequency: {}, start: () => { this.beeps++; }, stop() {} };
    }
    createGain() {
      return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } };
    }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }

  const bridge = {
    onShowNotification(callback) { callbacks.show = callback; },
    onSettingsChanged(callback) { callbacks.settings = callback; },
    onLayoutChanged(callback) { callbacks.layout = callback; },
    onNotificationVisibility(callback) { callbacks.visibility = callback; },
    async setDefaultSoundEnabled(enabled) {
      saved.push(enabled);
      return options.saveFailure
        ? { success: false, error: 'Save failed' }
        : { success: true, settings: { soundEnabled: enabled } };
    },
    reportHeight(height, revision) { heights.push(height); revisions.push(revision); },
    dismiss() { dismissed++; },
  };

  vm.runInNewContext(script, {
    document: {
      getElementById: element,
      documentElement: { style: { setProperty(name, value) { style[name] = value; } } },
      addEventListener(name, callback) { callbacks[name] = callback; },
    },
    window: { ccNotify: bridge, AudioContext, addEventListener(name, callback) { callbacks[name] = callback; } },
    ResizeObserver: class { constructor(callback) { this.callback = callback; } observe() { this.callback(); } },
    setInterval(callback) { const id = Symbol(); intervals.set(id, callback); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback) { timeouts.push(callback); },
  });

  return {
    elements, callbacks, intervals, contexts, heights, revisions, style, saved,
    prepare(data = {}) {
      callbacks.show({ title: 'Task', message: 'Done', revision: 1, maxCardHeight: 480, ...data });
    },
    show(data = {}) {
      this.prepare(data);
      callbacks.visibility({ active: true });
    },
    flushTimeouts() { timeouts.splice(0).forEach(callback => callback()); },
    dismissed() { return dismissed; },
  };
}

test('muting immediately clears the buzzer and enabling creates just one new buzzer', () => {
  const card = createCard();
  card.show();
  assert.equal(card.intervals.size, 1);
  card.elements['sound-toggle'].click();
  assert.equal(card.intervals.size, 0);
  assert.equal(card.contexts[0].state, 'closed');
  card.elements['sound-toggle'].click();
  assert.equal(card.intervals.size, 1);
  assert.equal(card.elements['sound-toggle'].attributes['aria-checked'], 'true');
});

test('a saved mute and an explicit silent request create no audio context', () => {
  for (const data of [{ soundEnabled: false, defaultSoundEnabled: false }, { silent: true }]) {
    const card = createCard();
    card.show(data);
    assert.equal(card.contexts.length, 0);
    assert.equal(card.intervals.size, 0);
    card.elements['sound-toggle'].click();
    assert.equal(card.intervals.size, 1);
  }
});

test('muting one card leaves another card sounding', () => {
  const first = createCard();
  const second = createCard();
  first.show();
  second.show();
  first.elements['sound-toggle'].click();
  assert.equal(first.intervals.size, 0);
  assert.equal(second.intervals.size, 1);
});

test('saving and broadcasting a new default do not change the current card sound', async () => {
  const card = createCard();
  card.show();
  await card.elements['default-sound-toggle'].click();
  assert.deepEqual(card.saved, [false]);
  assert.equal(card.elements['default-sound-toggle'].attributes['aria-checked'], 'false');
  assert.equal(card.intervals.size, 1);
  card.callbacks.settings({ soundEnabled: true });
  assert.equal(card.elements['default-sound-toggle'].attributes['aria-checked'], 'true');
  assert.equal(card.intervals.size, 1);
});

test('failed saves retain the switch state and make it usable again', async () => {
  const card = createCard({ saveFailure: true });
  card.show();
  await card.elements['default-sound-toggle'].click();
  assert.equal(card.elements['default-sound-toggle'].attributes['aria-checked'], 'true');
  assert.equal(card.elements['default-sound-toggle'].disabled, false);
  assert.equal(card.elements['settings-status'].classList.contains('error'), true);
});

test('settings expansion reports its height and Escape collapses the panel', () => {
  const card = createCard();
  card.show({ soundEnabled: false });
  card.elements['settings-button'].click();
  assert.equal(card.elements['settings-panel'].hidden, false);
  assert.equal(card.heights.at(-1), 330);
  card.callbacks.keydown({ key: 'Escape' });
  assert.equal(card.elements['settings-panel'].hidden, true);
  assert.equal(card.heights.at(-1), 160);
});

test('dismiss and unload stop audio and double dismissal closes only once', () => {
  const card = createCard();
  card.show();
  card.elements.b.click();
  card.elements.x.click();
  assert.equal(card.intervals.size, 0);
  card.flushTimeouts();
  assert.equal(card.dismissed(), 1);
  card.callbacks.beforeunload();
  assert.equal(card.contexts[0].state, 'closed');
});

test('audio failure leaves the switch visibly off without scheduling beeps', () => {
  const card = createCard({ audioUnavailable: true });
  card.show();
  assert.equal(card.intervals.size, 0);
  assert.equal(card.elements['sound-toggle'].attributes['aria-checked'], 'false');
  assert.equal(card.elements['settings-status'].classList.contains('error'), true);
});

test('background measurement reports actual height but never creates a buzzer', () => {
  const card = createCard();
  assert.deepEqual(card.heights, []);
  card.prepare({ soundEnabled: true });
  assert.equal(card.heights.at(-1), 160);
  assert.equal(card.revisions.at(-1), 1);
  assert.equal(card.contexts.length, 0);
  assert.equal(card.intervals.size, 0);
  card.callbacks.visibility({ active: true, soundEnabled: false, defaultSoundEnabled: false });
  assert.equal(card.contexts.length, 0);
  assert.equal(card.elements['sound-toggle'].attributes['aria-checked'], 'false');
});

test('returning a card to the queue stops audio and resuming preserves its sound choice', () => {
  const card = createCard();
  card.show();
  card.callbacks.visibility({ active: false });
  assert.equal(card.intervals.size, 0);
  assert.equal(card.contexts[0].state, 'closed');
  card.callbacks.visibility({ active: true });
  assert.equal(card.intervals.size, 1);
  card.elements['sound-toggle'].click();
  card.callbacks.visibility({ active: false });
  card.callbacks.visibility({ active: true });
  assert.equal(card.intervals.size, 0);
});

test('display changes update the maximum height and tag the new measurement revision', () => {
  const card = createCard();
  card.prepare();
  card.callbacks.layout({ revision: 2, maxCardHeight: 280 });
  assert.equal(card.style['--card-max-height'], '280px');
  assert.equal(card.revisions.at(-1), 2);
  assert.equal(card.intervals.size, 0);
});
