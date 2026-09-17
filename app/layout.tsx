import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./landing-transition.css";
import "./brand.css";
import "./app-system.css";
import Providers from "./providers";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

const brandIcon = "/assets/uploads/favicon-46bce9c075ad43a381f3d77bd6ca099b.png";

export const metadata: Metadata = {
  title: "Openweight Systems",
  description: "Curated open-weight intelligence with measured compute.",
  icons: {
    icon: brandIcon,
    shortcut: brandIcon,
    apple: brandIcon,
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${geistSans.variable} ${geistMono.variable} antialiased`}><Providers>{children}</Providers></body></html>;
}