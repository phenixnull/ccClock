const fs = require('fs');

function createNotificationSettings(filePath) {
  let settings = { soundEnabled: true };

  try {
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (typeof saved?.soundEnabled === 'boolean') settings.soundEnabled = saved.soundEnabled;
  } catch {
    // Missing or invalid settings retain the existing audible default.
  }

  return {
    get() {
      return { ...settings };
    },
    setSoundEnabled(soundEnabled) {
      if (typeof soundEnabled !== 'boolean') throw new TypeError('soundEnabled must be a boolean');
      const next = { soundEnabled };
      // Replace atomically so an interrupted write cannot lose a saved mute.
      const tempPath = filePath + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(next, null, 2), 'utf8');
      fs.renameSync(tempPath, filePath);
      settings = next;
      return { ...settings };
    },
  };
}

module.exports = { createNotificationSettings };
