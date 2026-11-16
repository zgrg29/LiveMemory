/**
 * Layout test fixture: the ten planned interface languages.
 *
 * This is intentionally **not** part of the product registry. It exists only to
 * render the header language control with ten long native names and prove the
 * layout does not clip, overlap or overflow. No code under `src/` may import
 * this file.
 */
export const TEN_LOCALE_FIXTURE = Object.freeze([
  Object.freeze({code: 'zh-CN', nativeName: '简体中文'}),
  Object.freeze({code: 'ja', nativeName: '日本語'}),
  Object.freeze({code: 'en', nativeName: 'English'}),
  Object.freeze({code: 'ko', nativeName: '한국어'}),
  Object.freeze({code: 'es', nativeName: 'Español'}),
  Object.freeze({code: 'pt-BR', nativeName: 'Português (Brasil)'}),
  Object.freeze({code: 'zh-TW', nativeName: '繁體中文'}),
  Object.freeze({code: 'fr', nativeName: 'Français'}),
  Object.freeze({code: 'de', nativeName: 'Deutsch'}),
  Object.freeze({code: 'id', nativeName: 'Bahasa Indonesia'})
]);
