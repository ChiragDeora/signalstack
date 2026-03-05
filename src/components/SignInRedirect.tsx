'use client';

import { useAuth, useClerk } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

/**
 * If the user is already signed in, redirect to home immediately
 * so <SignIn/> / <SignUp/> never render (avoids Clerk dev notice and confusion).
 */
export function SignInRedirect({ children }: { children: ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();
  const router = useRouter();
  const { loaded } = useClerk();

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

  return <>{children}</>;
}
