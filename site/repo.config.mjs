// The ONLY place the repository name lives. When the GitHub repo is renamed,
// change these two lines; the Pages base path, every GitHub link in the pages
// and docs (markdown links written as `repo:/blob/...`), redirects and the
// OG/canonical URLs all follow.
export const REPO = 'dshakes/pal';
export const BASE_PATH = '/pal'; // GitHub Pages serves a project site under /<repo>

export const GH = `https://github.com/${REPO}`;
export const SITE_ORIGIN = 'https://dshakes.github.io';
export const SITE_URL = `${SITE_ORIGIN}${BASE_PATH}/`;

// Vite plugin for docs MDX, applied before the MDX compiles:
//   [text](repo:/blob/master/x)  ->  ${GH}/blob/master/x
//   [text](/docs/x/)             ->  ${BASE_PATH}/docs/x/   (same for href="...")
// so docs source never spells the repo name or the Pages base.
// ponytail: a source rewrite, because Astro 7's default Markdown processor
// (Satteri) takes no remark plugins; a Satteri plugin is the upgrade path.
export const repoLinks = {
  name: 'pal-repo-links',
  enforce: 'pre',
  transform(code, id) {
    if (!id.split('?')[0].endsWith('.mdx')) return null;
    return { code: code.replace(/(\]\(|href=")repo:/g, `$1${GH}`).replace(/(\]\(|href=")\/docs\//g, `$1${BASE_PATH}/docs/`), map: null };
  },
};
