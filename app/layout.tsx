import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { auth } from "@/auth";
import { AppTitleSync } from "@/components/app-title-sync";
import { AuthSessionProvider } from "@/components/auth/auth-session-provider";
import "./globals.css";
import "./project-map-sidebar.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Nodes",
    template: "%s | Nodes",
  },
  applicationName: "Nodes",
  description: "AI decision workspace for branching, comparison, and synthesis.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Nodes",
  },
  openGraph: {
    siteName: "Nodes",
    title: "Nodes",
    description: "AI decision workspace for branching, comparison, and synthesis.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Nodes",
    description: "AI decision workspace for branching, comparison, and synthesis.",
  },
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/icon.png", type: "image/png" },
    ],
    apple: [{ url: "/apple-icon.png", type: "image/png" }],
    shortcut: ["/favicon.ico"],
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await auth();

  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <AuthSessionProvider session={session}>{children}</AuthSessionProvider>
        <AppTitleSync />
        <SpeedInsights />
      </body>
    </html>
  );
}
