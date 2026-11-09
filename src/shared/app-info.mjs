/**
 * Application identity. Kept free of imports so the launcher, server and
 * packaging scripts can read it without touching the filesystem.
 */
export const APP_NAME = 'LiveMemory';
export const APP_ID = 'livememory';
export const APP_VERSION = '0.7.0';
export const APP_TAGLINE = 'Local-first livestream memory';
export const APP_HOMEPAGE = 'https://github.com/zgrg29/LiveMemory';

/** Minimum runtime version: node:sqlite is available from Node 22.5. */
export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 5;
