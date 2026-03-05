import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';
import { ServiceWorkerRegistration } from '@/components/ServiceWorkerRegistration';

const inter = Inter({ subsets: ['latin'] });

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
  themeColor: '#2563eb',
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
    <ClerkProvider
      appearance={{
        variables: {
          colorBackground: '#111827',
          colorInputBackground: '#1e293b',
          colorText: '#f8fafc',
          colorTextSecondary: '#94a3b8',
          colorInputText: '#f8fafc',
          borderRadius: '12px',
        },
        elements: {
          card: 'shadow-xl border border-[var(--border-subtle)]',
          header: 'hidden',
          navbar: 'hidden',
          navbarMobileMenuRow: 'hidden',
        },
      }}
    >
      <html lang="en">
        <head>
          <link rel="manifest" href="/manifest.json" />
          <link rel="apple-touch-icon" href="/signalstack-logo.png" />
          <meta name="apple-mobile-web-app-capable" content="yes" />
          <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
          <meta name="apple-mobile-web-app-title" content="SignalStack" />
          <meta name="mobile-web-app-capable" content="yes" />
        </head>
        <body className={inter.className}>
          {children}
          <ServiceWorkerRegistration />
        </body>
      </html>
    </ClerkProvider>
  );
}