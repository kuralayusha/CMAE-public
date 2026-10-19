/**
 * Client-safe i18n exports only.
 * Server modules (pack / t / translate) must be imported from their own files.
 */
export { APP_LANGUAGE, type LocaleMeta, type LocalePack } from "./types";
export { interpolate, tFromPacks, type TVars } from "./lookup";
export { intlLocale } from "./intl-locale";
