/**
 * Header language control.
 *
 * Options are generated from `/api/bootstrap`'s locale list, which is built
 * from the single registry in `src/shared/locales.mjs`. No fixed language list
 * lives here, so adding languages never requires editing this control.
 *
 * The three currently shipped languages keep the existing segmented buttons;
 * larger sets (ten planned languages) automatically use the compact native
 * <select>. This keeps today's interaction unchanged while removing the
 * three-item assumption.
 */

/** At most this many short native names stay usable as segmented buttons. */
export const SEGMENTED_MAX_ITEMS = 3;
/** Longer combined labels would crowd the top bar even with 3 items. */
export const SEGMENTED_MAX_CHARS = 24;

export function languageControlMode(locales) {
  const list = Array.isArray(locales) ? locales : [];
  if (list.length > SEGMENTED_MAX_ITEMS) return 'menu';
  const chars = list.reduce((sum, entry) => sum + String(entry?.nativeName ?? entry?.code ?? '').length, 0);
  return chars > SEGMENTED_MAX_CHARS ? 'menu' : 'segmented';
}

/** System option first, then every available language in registry order. */
export function languageOptions(locales, {systemLabel = 'System'} = {}) {
  const list = Array.isArray(locales) ? locales : [];
  return [
    {value: 'system', label: systemLabel, lang: null},
    ...list.map((entry) => ({
      value: entry.code,
      label: entry.nativeName || entry.code,
      lang: entry.code
    }))
  ];
}

/**
 * Render both header controls (segmented + compact select) from one list.
 * @param {{
 *   root?: HTMLElement|null,
 *   segmented?: HTMLElement|null,
 *   systemButton?: HTMLElement|null,
 *   select?: HTMLSelectElement|null,
 *   locales: Array<{code: string, nativeName?: string}>,
 *   preference?: string,
 *   systemLabel?: string,
 *   systemAriaLabel?: string,
 *   ariaLabel?: string,
 *   onChange?: (value: string) => void
 * }} options
 */
export function renderLanguageControl({
  root = null,
  segmented = null,
  systemButton = null,
  select = null,
  locales = [],
  preference = 'system',
  systemLabel = 'System',
  systemAriaLabel = null,
  ariaLabel = null,
  onChange = null
} = {}) {
  const doc = root?.ownerDocument ?? segmented?.ownerDocument ?? select?.ownerDocument ?? globalThis.document;
  if (!doc) throw new Error('renderLanguageControl requires a document');
  const list = Array.isArray(locales) ? locales : [];
  const mode = languageControlMode(list);
  if (root) {
    root.dataset.mode = mode;
    if (ariaLabel) root.setAttribute('aria-label', ariaLabel);
  }

  if (segmented) {
    if (ariaLabel) segmented.setAttribute('aria-label', ariaLabel);
    const buttons = list.map((entry) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = entry.nativeName || entry.code;
      button.setAttribute('aria-pressed', String(preference === entry.code));
      button.dataset.locale = entry.code;
      button.lang = entry.code;
      button.title = entry.nativeName || entry.code;
      button.addEventListener('click', () => onChange?.(entry.code));
      return button;
    });
    segmented.replaceChildren(...buttons);
  }

  if (systemButton) {
    systemButton.setAttribute('aria-pressed', String(preference === 'system'));
    const label = systemAriaLabel || systemLabel;
    systemButton.setAttribute('aria-label', label);
    systemButton.title = label;
    systemButton.onclick = () => onChange?.('system');
  }

  if (select) {
    const options = languageOptions(list, {systemLabel});
    const nodes = options.map((option) => {
      const node = doc.createElement('option');
      node.value = option.value;
      node.textContent = option.label;
      if (option.lang) node.lang = option.lang;
      return node;
    });
    select.replaceChildren(...nodes);
    const known = options.some((option) => option.value === preference);
    select.value = known ? preference : 'system';
    select.dataset.preference = known ? 'available' : 'unavailable';
    if (ariaLabel) select.setAttribute('aria-label', ariaLabel);
    select.onchange = () => onChange?.(select.value);
  }

  return mode;
}
