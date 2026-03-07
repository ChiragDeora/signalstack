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
      <div className="min-h-dvh flex items-center justify-center bg-slate-50">
        <p className="text-slate-500">Redirecting...</p>
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-slate-50">
      <SignIn
        forceRedirectUrl={redirectUrl}
        fallbackRedirectUrl={redirectUrl}
      />
    </div>
  );
}
