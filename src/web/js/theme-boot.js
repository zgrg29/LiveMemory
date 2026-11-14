/**
 * Theme boot script (synchronous, loaded before any stylesheet paints).
 *
 * The server owns the preference (config/settings.json); localStorage is only a
 * mirror so the first paint can use the right theme without a flash. If the
 * mirror is missing we fall back to the system preference, which is also the
 * first-run behaviour.
 */
(function () {
  var STORAGE_KEY = 'livememory.theme';
  var preference = 'system';
  try {
    var stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') preference = stored;
  } catch (error) {
    /* storage may be unavailable in private modes */
  }
  var prefersDark = false;
  try {
    prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (error) {
    prefersDark = false;
  }
  var resolved = preference === 'system' ? (prefersDark ? 'dark' : 'light') : preference;
  var root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.setAttribute('data-theme-preference', preference);
  root.style.colorScheme = resolved;
})();
