import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';
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
      // Halos-style IA: one "Start here" decision page, then getting started,
      // the personal agent, concepts, task guides, the deep dive and reference.
      // Starlight's Previous/Next links follow this order.
      sidebar: [
        { slug: 'docs', label: 'Start here' },
        { label: 'Getting started', items: [
          { slug: 'docs/capabilities', label: 'What PAL is' },
          { slug: 'docs/start/installation', label: 'Install' },
          { slug: 'docs/start/demo', label: 'Try it: the demo' },
          { slug: 'docs/start/sixty-seconds', label: 'Quickstart in 60 seconds' },
          { slug: 'docs/start/quickstart', label: 'Your first agent' },
          { slug: 'docs/start/local-dev', label: 'Develop locally' },
          { slug: 'docs/start/deploy', label: 'Deploy to the cloud' },
          { slug: 'docs/start/examples', label: 'Examples' },
        ] },
        { label: 'pal, your personal agent', items: [
          { slug: 'docs/pal', label: 'How pal works' },
          { slug: 'docs/pal/surfaces', label: 'Connect your channels' },
          { slug: 'docs/pal/voice', label: 'Teach it your voice' },
          { slug: 'docs/pal/human-in-the-loop', label: 'Holds and trust' },
          { slug: 'docs/pal/daily', label: 'Daily use' },
          { slug: 'docs/pal/knowledge', label: 'Knowledge and handoff' },
          { slug: 'docs/pal/privacy', label: 'Privacy and control' },
        ] },
        { label: 'Concepts', items: [
          { slug: 'docs/runtime', label: 'What PAL Runtime is' },
          { slug: 'docs/architecture/overview', label: 'How PAL Runtime works' },
          { slug: 'docs/build/agents', label: 'Agents' },
          { slug: 'docs/build/models', label: 'Models and routing' },
          { slug: 'docs/runtime/sessions-and-memory', label: 'Sessions and memory' },
          { slug: 'docs/runtime/streaming', label: 'Streaming' },
          { slug: 'docs/runtime/durable-execution', label: 'Durable execution' },
          { slug: 'docs/build/budgets', label: 'Budgets' },
          { slug: 'docs/build/evaluations', label: 'Evaluations' },
          { slug: 'docs/security', label: 'Security model' },
          { slug: 'docs/runtime/isolation', label: 'Isolation' },
          { slug: 'docs/security/egress', label: 'Egress' },
          { slug: 'docs/security/identity', label: 'Identity and secrets' },
          { slug: 'docs/security/receipts', label: 'Receipts' },
        ] },
        { label: 'Guides', items: [
          { label: 'Build agents', items: [
            { slug: 'docs/runtime/quickstart', label: 'Headless agent quickstart' },
            { slug: 'docs/runtime/invocation', label: 'Invoke an agent' },
            { slug: 'docs/build/connectors', label: 'Connectors' },
            { slug: 'docs/build/channels', label: 'Channels' },
            { slug: 'docs/build/knowledge', label: 'Knowledge and handoff' },
            { slug: 'docs/build/approvals', label: 'Approvals' },
            { slug: 'docs/build/triggers', label: 'Triggers' },
            { slug: 'docs/build/scheduling', label: 'Scheduling' },
            { slug: 'docs/build/testing', label: 'Testing' },
            { slug: 'docs/build/marketplace', label: 'Marketplace' },
            { slug: 'docs/build/accounts', label: 'Accounts and teams' },
          ] },
          { label: 'Run in production', items: [
            { slug: 'docs/runtime/local-microvms', label: 'microVMs on your machine' },
            { slug: 'docs/runtime/sandbox-lifecycle', label: 'Sandbox lifecycle' },
            { slug: 'docs/operate/deployment', label: 'Production deployment' },
            { slug: 'docs/observability', label: 'Observability' },
            { slug: 'docs/operate/operations', label: 'Operations' },
          ] },
        ] },
        { label: 'Architecture deep dive', collapsed: true, items: [
          { slug: 'docs/architecture/request-lifecycle', label: 'Request lifecycle' },
          { slug: 'docs/architecture/vm-lifecycle', label: 'microVM lifecycle' },
          { slug: 'docs/architecture/durability', label: 'Durability' },
          { slug: 'docs/architecture/security-boundaries', label: 'Security boundaries' },
          { slug: 'docs/architecture/deployment-topology', label: 'Deployment topology' },
          { slug: 'docs/architecture/pal', label: 'pal internals' },
          { slug: 'docs/runtime/architecture', label: 'Runtime internals' },
          { slug: 'docs/runtime/stack', label: 'Tech stack' },
        ] },
        { label: 'Reference', items: [
          { slug: 'docs/reference/api', label: 'REST API' },
          { slug: 'docs/sdks', label: 'SDKs' },
          { slug: 'docs/reference/cli', label: 'CLI' },
          { slug: 'docs/reference/env-vars', label: 'Environment variables' },
          { slug: 'docs/changelog', label: 'Changelog' },
        ] },
      ],
    }),
  ],
});
