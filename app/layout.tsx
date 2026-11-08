import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./landing-transition.css";
import "./brand.css";
import "./app-system.css";
import "./coverage.css";
import "./dashboard-dark.css";
import "./workspace-shell.css";
import Providers from "./providers";
import { BRAND_ICONS, BRAND_LOGO_CSS_VARS } from "../lib/brand";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Openweight Systems",
  description: "Curated open-weight intelligence with measured compute.",
  // Same shared mark as the landing + workspace headers (lib/brand.ts).
  icons: BRAND_ICONS,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" style={BRAND_LOGO_CSS_VARS}>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
