import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const basePath = process.env.APP_BASE_PATH ?? "";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.PUBLIC_SITE_URL ?? "https://8.137.116.27:9443"),
  title: "GPT-Live Remote",
  description: "从手机安全连接 Mac 上的 GPT-Live",
  applicationName: "GPT-Live Remote",
  manifest: `${basePath}/manifest.webmanifest`,
  icons: { icon: `${basePath}/icon.svg` },
  openGraph: {
    title: "GPT-Live Remote",
    description: "从手机安全连接 Mac 上的 GPT-Live",
    type: "website",
    images: [{ url: `${basePath}/og.png`, width: 1200, height: 630, alt: "GPT-Live Remote" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "GPT-Live Remote",
    description: "从手机安全连接 Mac 上的 GPT-Live",
    images: [`${basePath}/og.png`],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "GPT-Live Remote",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
