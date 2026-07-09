import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "/sunlight-tracker/",
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Sunlight Tracker",
        short_name: "Sunlight",
        description: "See where the sun is, right now (or any date/time you pick), for any spot on the map.",
        theme_color: "#1e293b",
        background_color: "#1e293b",
        display: "standalone",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        ],
      },
      workbox: {
        runtimeCaching: [
          {
            // OSM's tile usage policy asks that clients not bulk-cache tiles; this only
            // caches tiles the user actually viewed, bounded to a normal browser-cache size.
            urlPattern: /^https:\/\/tile\.openstreetmap\.org\/.*/,
            handler: "CacheFirst",
            options: {
              cacheName: "osm-tiles",
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: /^https:\/\/overpass-api\.de\/api\/interpreter.*/,
            handler: "NetworkFirst",
            options: {
              cacheName: "overpass-buildings",
              networkTimeoutSeconds: 10,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 10 },
            },
          },
        ],
      },
    }),
  ],
});
