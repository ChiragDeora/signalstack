/**
 * Clerk proxy — required for auth() to work in API routes and server components.
 * Without this, auth() returns null and no user/symbols get written to Supabase.
 */
import { NextResponse } from 'next/server';
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/webhooks(.*)',
  '/api/(fetch-price|search-symbols|status|warmup)(.*)', // allow some APIs to be called; monitor requires auth inside
]);

export default clerkMiddleware(async (auth, req) => {
  const path = req.nextUrl.pathname;
  // Signed-in users hitting sign-in/sign-up: redirect home so <SignIn/> never renders (avoids Clerk dev notice)
  const { userId } = await auth();
  if (userId && (path.startsWith('/sign-in') || path.startsWith('/sign-up'))) {
    return NextResponse.redirect(new URL('/', req.url));
  }
  // Protect pages only; API routes check auth() and return 401 when needed.
  if (isPublicRoute(req)) return;
  if (path.startsWith('/api/')) return;
  await auth.protect();
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
