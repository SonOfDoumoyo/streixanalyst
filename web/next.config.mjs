/** StreixAnalyst web. The browser talks to /api on this domain; Next forwards it to the FastAPI backend,
 *  so the session cookie stays first-party. Set BACKEND_URL to the backend's address. */
const backend = (process.env.BACKEND_URL || "http://localhost:8000").replace(/\/$/, "");

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // what the browser gets is minified code without source maps or debug logging: the page's structure can't be hidden
  // from the browser's inspector (no website can do that), but the source isn't handed out readable either
  productionBrowserSourceMaps: false,
  compiler: { removeConsole: process.env.NODE_ENV === "production" ? { exclude: ["error"] } : false },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // the app cannot be framed by another site (clickjacking), and plugins and <base> tricks are off
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
          // browsers that have seen the site over HTTPS refuse plain HTTP for a year
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;
