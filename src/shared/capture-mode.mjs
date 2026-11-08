/** How YouTube live chat is obtained. Official is the recommended, documented path. */
export const YOUTUBE_CAPTURE_MODES = Object.freeze(['official', 'anonymous']);
export const DEFAULT_YOUTUBE_CAPTURE_MODE = 'official';

export function normalizeYouTubeCaptureMode(value, fallback = DEFAULT_YOUTUBE_CAPTURE_MODE) {
  const mode = String(value ?? '').trim().toLowerCase();
  return YOUTUBE_CAPTURE_MODES.includes(mode) ? mode : fallback;
}
