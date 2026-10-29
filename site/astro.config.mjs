import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const gh = 'https://github.com/dshakes/lantern';
const og = 'https://dshakes.github.io/lantern/og.png';

// Landing is src/pages/index.astro at /lantern/; Starlight docs live in
// src/content/docs/docs/** so they publish under /lantern/docs/<slug>/.
export default defineConfig({
  site: 'https://dshakes.github.io',
  base: '/lantern/',
  trailingSlash: 'ignore',
  integrations: [
    starlight({
      title: 'PAL',
      description: 'PAL, the Personal Agentic Layer: a personal agent that acts for you, and the runtime builders run their own agents on.',
      favicon: '/favicon.svg',
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: og } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: og } },
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
      ],
    }),
  ],
});
