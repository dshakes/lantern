import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

// `glance` is the three-line lead every docs page opens with (rendered by
// components/MarkdownContent.astro): what it is, why you want it, how to use it.
export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        glance: z.object({ what: z.string(), why: z.string(), how: z.string() }).optional(),
      }),
    }),
  }),
};
