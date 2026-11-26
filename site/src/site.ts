import pkg from '../../package.json';

export const REPO = 'Shubhdeep12/clogs';
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const VERSION = pkg.version as string;
export const TAGLINE = pkg.description as string;

/** Path under the configured base, e.g. url('icon-512.png'). */
export const url = (p = '') => `${import.meta.env.BASE_URL.replace(/\/$/, '')}/${p.replace(/^\//, '')}`;
