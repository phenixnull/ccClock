const WINDOW_WIDTH = 420;
const MIN_WINDOW_HEIGHT = 160;
const MAX_WINDOW_HEIGHT = 500;
const SCREEN_MARGIN = 20;
const WINDOW_GAP = 12;

function getNotificationSpace(workArea) {
  return {
    x: workArea.x + SCREEN_MARGIN,
    y: workArea.y + SCREEN_MARGIN,
    width: Math.max(0, Math.min(WINDOW_WIDTH, workArea.width - SCREEN_MARGIN * 2)),
    height: Math.max(0, workArea.height - SCREEN_MARGIN * 2),
  };
}

function getStackHeight(entries) {
  return entries.reduce((height, entry) => height + entry.height, 0)
    + Math.max(0, entries.length - 1) * WINDOW_GAP;
}

// Entries are oldest first, so the first window sits against the bottom edge.
function getNotificationLayout(entries, workArea) {
  if (entries.length === 0) return [];
  const space = getNotificationSpace(workArea);
  if (
    space.width <= 20 || space.height < MIN_WINDOW_HEIGHT
    || entries.some(entry => !Number.isFinite(entry.height) || entry.height < MIN_WINDOW_HEIGHT)
    || getStackHeight(entries) > space.height
  ) return null;

  let bottom = workArea.y + workArea.height - SCREEN_MARGIN;
  return entries.map(entry => {
    bottom -= entry.height;
    const bounds = {
      x: workArea.x + workArea.width - SCREEN_MARGIN - space.width,
      y: bottom,
      width: space.width,
      height: entry.height,
    };
    bottom -= WINDOW_GAP;
    return bounds;
  });
}

module.exports = {
  MIN_WINDOW_HEIGHT,
  MAX_WINDOW_HEIGHT,
  getNotificationSpace,
  getStackHeight,
  getNotificationLayout,
};
