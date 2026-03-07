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
      <div className="min-h-dvh flex items-center justify-center">
        <p className="text-slate-600">Redirecting...</p>
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex items-center justify-center">
      <SignUp
        appearance={{
          variables: {
            colorPrimary: '#2563eb',
            colorBackground: '#ffffff',
            colorInputBackground: '#f1f5f9',
            colorText: '#0f172a',
            colorTextSecondary: '#475569',
            colorInputText: '#0f172a',
            borderRadius: '12px',
          },
          elements: {
            rootBox: 'mx-auto',
            card: '!bg-white !border !border-slate-200 !shadow-xl',
            cardBox: '!bg-white',
            header: 'hidden',
            navbar: 'hidden',
            formFieldInput: '!bg-slate-100 !text-slate-900 !border-slate-200 placeholder:!text-slate-500',
            formButtonPrimary: '!bg-blue-600 !text-white',
          },
        }}
        forceRedirectUrl={redirectUrl}
        fallbackRedirectUrl={redirectUrl}
      />
    </div>
  );
}
