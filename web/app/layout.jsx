import { Inter, Sora } from "next/font/google";
import Providers from "@/components/Providers";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const sora = Sora({ subsets: ["latin"], variable: "--font-sora", weight: ["600", "700", "800"], display: "swap" });

export const metadata = {
  metadataBase: new URL(process.env.SITE_URL || "https://streixanalyst.com"),
  title: { default: "StreixAnalyst — the AI analyst that reads the chart with you", template: "%s · StreixAnalyst" },
  description:
    "Charts for every market — crypto, forex, gold, indices and stocks — with an AI analyst that draws structure, liquidity, " +
    "key levels and a full trade plan, checks the news, and teaches you as you trade. By Streixcorp.",
  applicationName: "StreixAnalyst",
  openGraph: {
    title: "StreixAnalyst",
    description: "The AI analyst that reads the chart with you.",
    images: ["/brand/og.png"],
    type: "website",
  },
  twitter: { card: "summary_large_image", images: ["/brand/og.png"] },
  appleWebApp: { capable: true, title: "StreixAnalyst", statusBarStyle: "black-translucent" },
};

export const viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" data-theme="dark" className={`${inter.variable} ${sora.variable}`} suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
