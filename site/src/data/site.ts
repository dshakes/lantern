// Shared links for the marketing pages. The repo name lives only in repo.config.mjs.
import { GH, REPO, SITE_URL } from '../../repo.config.mjs';
export { GH };
export const BASE = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
export const u = (p = '') => BASE + p.replace(/^\//, '');
export const BLOB = `${GH}/blob/master`;
export const SITE = SITE_URL;
export const DEMO = `git clone ${GH}.git && cd ${REPO.split('/')[1]} && make demo`;
