import type { Metadata, Viewport } from 'next';
import { Space_Grotesk, DM_Sans, JetBrains_Mono } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';
import { ServiceWorkerRegistration } from '@/components/ServiceWorkerRegistration';

const fontDisplay = Space_Grotesk({ subsets: ['latin'], variable: '--font-display' });
const fontBody = DM_Sans({ subsets: ['latin'], variable: '--font-body' });
const fontMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'SignalStack',
  description: 'SignalStack: Real-Time Multi-EMA Crossover Detection & Notifications',
  keywords: ['SignalStack', 'EMA', 'Trading', 'Alerts', 'Stock Market', 'Technical Analysis'],
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'SignalStack',
  },
};

export const viewport: Viewport = {
  themeColor: '#0ea5e9',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <html lang="en">
        <head>
          <link rel="manifest" href="/manifest.json" />
          {/* Favicon + apple-touch-icon are served automatically by Next from
              src/app/icon.png and src/app/apple-icon.png. */}
          <meta name="apple-mobile-web-app-capable" content="yes" />
          <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
          <meta name="apple-mobile-web-app-title" content="SignalStack" />
          <meta name="mobile-web-app-capable" content="yes" />
        </head>
        <body className={`${fontDisplay.variable} ${fontBody.variable} ${fontMono.variable} ${fontBody.className}`}>
          {children}
          <ServiceWorkerRegistration />
        </body>
      </html>
    </ClerkProvider>
  );
}