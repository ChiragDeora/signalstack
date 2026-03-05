'use client';

import { SignUp } from '@clerk/nextjs';
import { useAuth, useClerk } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

export function SignUpForm() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const { loaded } = useClerk();
  const [redirectUrl, setRedirectUrl] = useState('/');

  useEffect(() => {
    setRedirectUrl(typeof window !== 'undefined' ? `${window.location.origin}/` : '/');
  }, []);

  useEffect(() => {
    if (!loaded || !isLoaded) return;
    if (isSignedIn) {
      router.replace('/');
    }
  }, [loaded, isLoaded, isSignedIn, router]);

  if (loaded && isLoaded && isSignedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg-primary)]">
        <p className="text-[var(--text-muted)]">Redirecting...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg-primary)]">
      <SignUp
        appearance={{
          variables: {
            colorPrimary: '#22d3ee',
            colorBackground: '#111827',
            colorInputBackground: '#1e293b',
            colorText: '#f8fafc',
            colorInputText: '#f8fafc',
          },
          elements: {
            rootBox: 'mx-auto',
            card: 'bg-[var(--bg-card)] border border-[var(--border-subtle)] shadow-xl',
            header: 'hidden',
            navbar: 'hidden',
          },
        }}
        forceRedirectUrl={redirectUrl}
        fallbackRedirectUrl={redirectUrl}
      />
    </div>
  );
}
