import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';
import react from '@astrojs/react';
import { GH as gh, SITE_ORIGIN, SITE_URL, BASE_PATH, repoLinks } from './repo.config.mjs';

const og = `${SITE_URL}og.png`;

// Old flat doc slugs (pre-PAL docs) -> their new homes. Static redirect pages,
// not indexed by search or listed in the sitemap. Astro does not add the base
// to redirect targets, so it is prefixed here.
const redirects = Object.fromEntries(Object.entries({
  '/docs/accounts': '/docs/build/accounts/',
  '/docs/agents': '/docs/build/agents/',
  '/docs/api': '/docs/reference/api/',
  '/docs/architecture': '/docs/architecture/overview/',
  '/docs/budgets': '/docs/build/budgets/',
  '/docs/cli': '/docs/reference/cli/',
  '/docs/connectors': '/docs/build/connectors/',
  '/docs/demo': '/docs/start/demo/',
  '/docs/deployment': '/docs/operate/deployment/',
  '/docs/env-vars': '/docs/reference/env-vars/',
  '/docs/evaluations': '/docs/build/evaluations/',
  '/docs/examples': '/docs/start/examples/',
  '/docs/human-in-the-loop': '/docs/pal/human-in-the-loop/',
  '/docs/installation': '/docs/start/installation/',
  '/docs/knowledge': '/docs/pal/knowledge/',
  '/docs/marketplace': '/docs/build/marketplace/',
  '/docs/models': '/docs/build/models/',
  '/docs/operations': '/docs/operate/operations/',
  '/docs/personal': '/docs/pal/',
  '/docs/quickstart': '/docs/start/quickstart/',
  '/docs/scheduling': '/docs/build/scheduling/',
  '/docs/sdk': '/docs/sdks/',
  '/docs/stack': '/docs/runtime/stack/',
  '/docs/surfaces': '/docs/pal/surfaces/',
  '/docs/testing': '/docs/build/testing/',
  '/docs/triggers': '/docs/build/triggers/',
  // site/v2 IA: security, observability and SDKs got their own sections.
  '/docs/runtime/security': '/docs/security/',
  '/docs/runtime/egress': '/docs/security/egress/',
  '/docs/runtime/identity': '/docs/security/identity/',
  '/docs/runtime/receipts': '/docs/security/receipts/',
  '/docs/runtime/observability': '/docs/observability/',
  '/docs/reference/sdk': '/docs/sdks/',
}).map(([from, to]) => [from, BASE_PATH + to]));

// Landing is src/pages/index.astro at the base; Starlight docs live in
// src/content/docs/docs/** so they publish under <base>/docs/<slug>/.
export default defineConfig({
  site: SITE_ORIGIN,
  base: `${BASE_PATH}/`,
  trailingSlash: 'ignore',
  redirects,
  vite: { plugins: [repoLinks] },
  integrations: [
    react(),
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
        './src/styles/diagrams.css',
        './src/styles/starlight.css',
      ],
      components: { SiteTitle: './src/components/SiteTitle.astro', MarkdownContent: './src/components/MarkdownContent.astro' },
      // The sidebar is a story, read top to bottom: see it run, then the personal
      // agent, then build -> make reliable -> make safe -> ship -> operate -> go deeper.
      // Starlight's Previous/Next links follow this order, so every page ends on the next step.
      sidebar: [
        { label: 'Start here', items: [
          { slug: 'docs', label: 'Overview' },
          { slug: 'docs/capabilities' },
          { slug: 'docs/start/sixty-seconds', label: 'Quickstart in 60 seconds' },
          { slug: 'docs/start/quickstart', label: 'Your first agent' },
          { slug: 'docs/start/local-dev' },
          { slug: 'docs/start/deploy' },
          { slug: 'docs/start/demo' },
          { slug: 'docs/start/installation' },
          { slug: 'docs/start/examples' },
        ] },
        { label: 'pal: your personal agent', items: [
          { slug: 'docs/pal', label: 'Meet pal' },
          { slug: 'docs/pal/surfaces', label: 'Connect your channels' },
          { slug: 'docs/pal/voice', label: 'Teach it your voice' },
          { slug: 'docs/pal/human-in-the-loop', label: 'Trust and holds' },
          { slug: 'docs/pal/daily', label: 'Daily use' },
          { slug: 'docs/pal/knowledge', label: 'Knowledge and handoff' },
          { slug: 'docs/pal/privacy', label: 'Privacy and control' },
        ] },
        { label: 'Build agents', items: [
          { slug: 'docs/runtime', label: 'What PAL Runtime is' },
          { slug: 'docs/build/agents' },
          { slug: 'docs/runtime/quickstart', label: 'Headless agent quickstart' },
          { slug: 'docs/runtime/invocation' },
          { slug: 'docs/build/models' },
          { slug: 'docs/build/connectors' },
          { slug: 'docs/build/triggers' },
          { slug: 'docs/build/scheduling' },
          { slug: 'docs/runtime/sessions-and-memory' },
          { slug: 'docs/runtime/streaming' },
          { slug: 'docs/build/marketplace' },
          { slug: 'docs/build/accounts' },
        ] },
        { label: 'Make it reliable', items: [
          { slug: 'docs/runtime/durable-execution' },
          { slug: 'docs/build/budgets' },
          { slug: 'docs/build/evaluations' },
          { slug: 'docs/build/testing' },
        ] },
        { label: 'Make it safe', items: [
          { slug: 'docs/security', label: 'Security model' },
          { slug: 'docs/runtime/isolation' },
          { slug: 'docs/runtime/sandbox-lifecycle' },
          { slug: 'docs/security/egress' },
          { slug: 'docs/security/identity' },
          { slug: 'docs/security/receipts' },
        ] },
        { label: 'Ship it', items: [
          { slug: 'docs/runtime/local-microvms' },
          { slug: 'docs/operate/deployment', label: 'Production deployment' },
        ] },
        { label: 'Operate it', items: [
          { slug: 'docs/observability' },
          { slug: 'docs/operate/operations' },
        ] },
        { label: 'Go deeper', collapsed: true, items: [
          { slug: 'docs/architecture/overview' },
          { slug: 'docs/architecture/request-lifecycle' },
          { slug: 'docs/architecture/vm-lifecycle' },
          { slug: 'docs/architecture/security-boundaries' },
          { slug: 'docs/architecture/durability' },
          { slug: 'docs/architecture/deployment-topology' },
          { slug: 'docs/architecture/pal', label: 'pal internals' },
          { slug: 'docs/runtime/architecture', label: 'Runtime internals' },
          { slug: 'docs/runtime/stack' },
        ] },
        { label: 'Reference', collapsed: true, items: [
          { slug: 'docs/reference/api' },
          { slug: 'docs/sdks' },
          { slug: 'docs/reference/cli' },
          { slug: 'docs/reference/env-vars' },
          { slug: 'docs/changelog' },
        ] },
      ],
    }),
  ],
});
