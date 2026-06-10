import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.string(),
    updated: z.string().optional(),
    author: z.string().default('Радио България'),
    tags: z.array(z.string()).default([]),
  }),
});

const stations = defineCollection({
  type: 'content',
  schema: z.object({
    name: z.string(),
    description: z.string(),
    founded: z.string().optional(),
    owner: z.string().optional(),
    headquarters: z.string().optional(),
    format: z.string(),
    frequencies: z.array(z.string()).default([]),
    website: z.string().optional(),
    language: z.string().default('български'),
    country: z.string().default('България'),
    slogan: z.string().optional(),
    /** Override for matching this station in the Radio Browser catalog
     *  (defaults to `name`, transliterated Cyrillic→Latin on the client). */
    playerQuery: z.string().optional(),
  }),
});

export const collections = { blog, stations };
