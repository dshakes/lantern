// Shared links for the marketing pages. BASE ends with a slash ('/lantern/').
export const BASE = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
export const u = (p = '') => BASE + p.replace(/^\//, '');
export const GH = 'https://github.com/dshakes/lantern';
export const BLOB = `${GH}/blob/master`;
export const SITE = 'https://dshakes.github.io/lantern/';
export const DEMO = 'git clone https://github.com/dshakes/lantern.git && cd lantern && make demo';
