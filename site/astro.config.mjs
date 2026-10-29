import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';

const gh = 'https://github.com/dshakes/lantern';
const og = 'https://dshakes.github.io/lantern/og.png';

// Old flat doc slugs (pre-PAL docs) -> their new homes. Static redirect pages,
// not indexed by search or listed in the sitemap. Destinations must carry the
// base (/lantern); Astro does not add it to redirect targets.
const redirects = {
  '/docs/accounts': '/lantern/docs/build/accounts/',
  '/docs/agents': '/lantern/docs/build/agents/',
  '/docs/api': '/lantern/docs/reference/api/',
  '/docs/architecture': '/lantern/docs/runtime/architecture/',
  '/docs/budgets': '/lantern/docs/build/budgets/',
  '/docs/cli': '/lantern/docs/reference/cli/',
  '/docs/connectors': '/lantern/docs/build/connectors/',
  '/docs/demo': '/lantern/docs/start/demo/',
  '/docs/deployment': '/lantern/docs/operate/deployment/',
  '/docs/env-vars': '/lantern/docs/reference/env-vars/',
  '/docs/evaluations': '/lantern/docs/build/evaluations/',
  '/docs/examples': '/lantern/docs/start/examples/',
  '/docs/human-in-the-loop': '/lantern/docs/pal/human-in-the-loop/',
  '/docs/installation': '/lantern/docs/start/installation/',
  '/docs/knowledge': '/lantern/docs/pal/knowledge/',
  '/docs/marketplace': '/lantern/docs/build/marketplace/',
  '/docs/models': '/lantern/docs/build/models/',
  '/docs/operations': '/lantern/docs/operate/operations/',
  '/docs/personal': '/lantern/docs/pal/',
  '/docs/quickstart': '/lantern/docs/start/quickstart/',
  '/docs/scheduling': '/lantern/docs/build/scheduling/',
  '/docs/sdk': '/lantern/docs/reference/sdk/',
  '/docs/security': '/lantern/docs/runtime/security/',
  '/docs/stack': '/lantern/docs/runtime/stack/',
  '/docs/surfaces': '/lantern/docs/pal/surfaces/',
  '/docs/testing': '/lantern/docs/build/testing/',
  '/docs/triggers': '/lantern/docs/build/triggers/',
};

// Landing is src/pages/index.astro at /lantern/; Starlight docs live in
// src/content/docs/docs/** so they publish under /lantern/docs/<slug>/.
export default defineConfig({
  site: 'https://dshakes.github.io',
  base: '/lantern/',
  trailingSlash: 'ignore',
  redirects,
  integrations: [
    starlight({
      title: 'PAL',
      // Fails the build on any broken internal link or anchor in the docs.
      plugins: [starlightLinksValidator({ errorOnLocalLinks: false })],
      description: 'PAL, the Personal Agentic Layer: a personal agent that acts for you, and the runtime builders run their own agents on.',
      favicon: '/favicon.svg',
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: og } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: og } },
        // Label each table cell with its column header so starlight.css can stack
        // tables into cards on phones. ponytail: runs in the browser (a first try as
        // a markdown.rehypePlugins entry broke the build); a build-time rehype
        // plugin is the upgrade path if no-JS rendering of the cards matters.
        {
          tag: 'script',
          content: `document.addEventListener('DOMContentLoaded',()=>{for(const t of document.querySelectorAll('.sl-markdown-content table')){const h=[...t.querySelectorAll('thead th')].map(th=>th.textContent.trim());if(!h.length)continue;t.classList.add('stack');for(const tr of t.querySelectorAll('tbody tr'))[...tr.children].forEach((td,i)=>h[i]&&td.setAttribute('data-label',h[i]))}})`,
        },
      ],
      expressiveCode: {
        themes: ['github-dark-default', 'github-light'],
        styleOverrides: {
          borderRadius: '12px',
          borderColor: 'var(--sl-color-hairline-light)',
          codeFontFamily: 'var(--sl-font-mono)',
          codeFontSize: '0.86rem',
          codeLineHeight: '1.7',
          uiFontFamily: 'var(--sl-font)',
          codeBackground: ({ theme }) => (theme.type === 'dark' ? '#111317' : '#ffffff'),
          frames: {
            shadowColor: 'transparent',
            frameBoxShadowCssValue: 'none',
            editorTabBarBackground: ({ theme }) => (theme.type === 'dark' ? '#15171c' : '#f1f0ec'),
            editorActiveTabBackground: ({ theme }) => (theme.type === 'dark' ? '#111317' : '#ffffff'),
            terminalTitlebarBackground: ({ theme }) => (theme.type === 'dark' ? '#15171c' : '#f1f0ec'),
            terminalBackground: ({ theme }) => (theme.type === 'dark' ? '#111317' : '#ffffff'),
          },
        },
      },
      social: [{ icon: 'github', label: 'GitHub', href: gh }],
      editLink: { baseUrl: `${gh}/edit/master/site/` },
      customCss: [
        '@fontsource-variable/inter/wght.css',
        '@fontsource-variable/inter-tight/wght.css',
        '@fontsource-variable/jetbrains-mono/wght.css',
        './src/styles/tokens.css',
        './src/styles/starlight.css',
      ],
      components: { SiteTitle: './src/components/SiteTitle.astro' },
      // Groups follow the directories under src/content/docs/docs/, in this order.
      sidebar: [
        { label: 'Start', items: [{ autogenerate: { directory: 'docs/start' } }] },
        { label: 'PAL', items: [{ autogenerate: { directory: 'docs/pal' } }] },
        { label: 'PAL Runtime', items: [{ autogenerate: { directory: 'docs/runtime' } }] },
        { label: 'Build', items: [{ autogenerate: { directory: 'docs/build' } }] },
        { label: 'Reference', items: [{ autogenerate: { directory: 'docs/reference' } }], collapsed: true },
        { label: 'Operate', items: [{ autogenerate: { directory: 'docs/operate' } }], collapsed: true },
        { slug: 'docs/changelog' },
      ],
    }),
  ],
});
