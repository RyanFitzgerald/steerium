// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightThemeBlack from "starlight-theme-black";

export default defineConfig({
  site: "https://steerium.dev",
  integrations: [
    starlight({
      title: "steerium",
      favicon: "/favicon.png",
      description:
        "Open-source, local-first TypeScript workflow orchestration for deterministic code, AI calls, and coding agents.",
      head: [
        {
          tag: "link",
          attrs: {
            rel: "apple-touch-icon",
            href: "/favicon.png",
            sizes: "512x512",
          },
        },
        {
          tag: "meta",
          attrs: { name: "theme-color", content: "#070910" },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: "https://steerium.dev/og.png",
          },
        },
        {
          tag: "meta",
          attrs: { property: "og:image:width", content: "1200" },
        },
        {
          tag: "meta",
          attrs: { property: "og:image:height", content: "630" },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image:alt",
            content:
              "steerium — Local-first TypeScript workflows for code and AI agents. Open source under the MIT license.",
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:image",
            content: "https://steerium.dev/og.png",
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:image:alt",
            content:
              "steerium — Local-first TypeScript workflows for code and AI agents. Open source under the MIT license.",
          },
        },
      ],
      components: {
        ThemeProvider: "./src/components/DarkThemeProvider.astro",
      },
      plugins: [
        starlightThemeBlack({
          navLinks: [
            { label: "Docs", link: "/getting-started/" },
            { label: "Guides", link: "/guides/workflows/" },
            { label: "Reference", link: "/reference/cli/" },
          ],
          footerText:
            "Built by [Ryan Fitzgerald](https://github.com/RyanFitzgerald/steerium). The source code is available on [GitHub](https://github.com/RyanFitzgerald/steerium).",
        }),
      ],
      customCss: ["./src/styles/custom.css", "./src/styles/landing.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/RyanFitzgerald/steerium",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/RyanFitzgerald/steerium/edit/main/apps/docs/",
      },
      sidebar: [
        {
          label: "Start here",
          items: [{ label: "Getting started", slug: "getting-started" }],
        },
        { label: "Guides", autogenerate: { directory: "guides" } },
        { label: "Build your own", autogenerate: { directory: "extending" } },
        { label: "Reference", autogenerate: { directory: "reference" } },
      ],
    }),
  ],
});
