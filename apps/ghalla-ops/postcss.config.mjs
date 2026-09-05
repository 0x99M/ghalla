/**
 * Tailwind v4 is a PostCSS plugin and nothing else — there is no
 * `tailwind.config.ts` in this version. The design tokens live in
 * `src/app/globals.css` under `@theme`, which IS the config: every value there
 * becomes both a CSS custom property and a utility class.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
