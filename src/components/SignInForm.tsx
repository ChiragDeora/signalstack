'use client';

import { SignIn } from '@clerk/nextjs';
import { useAuth, useClerk } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

export function SignInForm() {
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
      <div className="min-h-dvh flex items-center justify-center">
        <p className="text-slate-600">Redirecting...</p>
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex items-center justify-center">
      <SignIn
        appearance={{
          variables: {
            colorPrimary: '#06b6d4',
            colorBackground: '#ffffff',
            colorInputBackground: '#f1f5f9',
            colorText: '#0f172a',
            colorInputText: '#0f172a',
          },
          elements: {
            rootBox: 'mx-auto',
            card: 'bg-white border border-slate-200 shadow-xl',
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
