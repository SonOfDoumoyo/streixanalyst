export default function manifest() {
  return {
    name: "StreixAnalyst",
    short_name: "StreixAnalyst",
    description: "The AI analyst that reads the chart with you.",
    start_url: "/terminal",
    display: "standalone",
    background_color: "#131722",
    theme_color: "#131722",
    orientation: "any",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
