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
    <div className="min-h-dvh flex items-center justify-center safe-area-inset">
      <SignIn
        appearance={{
          variables: {
            colorPrimary: '#22d3ee',
            colorBackground: '#080c14',
            colorInputBackground: '#1e293b',
            colorText: '#f8fafc',
            colorTextSecondary: '#cbd5e1',
            colorInputText: '#f8fafc',
            borderRadius: '12px',
          },
          elements: {
            rootBox: 'w-full max-w-md mx-auto',
            card: '!bg-transparent !border-0 !shadow-none',
            cardBox: '!bg-transparent',
            header: 'hidden',
            navbar: 'hidden',
            formFieldInput: '!bg-[#1e293b] !text-[#f8fafc] !border-[#334155]',
            formButtonPrimary: '!bg-[#22d3ee] !text-[#080c14]',
          },
        }}
        forceRedirectUrl={redirectUrl}
        fallbackRedirectUrl={redirectUrl}
      />
    </div>
  );
}
