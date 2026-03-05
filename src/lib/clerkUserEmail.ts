/**
 * Fetch a user's primary email from Clerk (for server-side use, e.g. alert emails).
 * Uses CLERK_SECRET_KEY; no request context required.
 */

const CLERK_API_BASE = 'https://api.clerk.com/v1';

export async function getClerkUserEmail(userId: string): Promise<string | null> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey || !userId) return null;
  try {
    const res = await fetch(`${CLERK_API_BASE}/users/${userId}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    if (!res.ok) {
      console.warn('Clerk getUser failed:', res.status, await res.text());
      return null;
    }
    const user = (await res.json()) as Record<string, unknown>;
    // Clerk API can return snake_case or camelCase
    const primaryId = (user.primary_email_address_id ?? user.primaryEmailAddressId) as string | undefined;
    const list = (user.email_addresses ?? user.emailAddresses) as Array<{ id: string; email_address?: string; emailAddress?: string }> | undefined;
    if (!list?.length) return null;
    const primary = primaryId ? list.find((e) => e.id === primaryId) : list[0];
    const email = primary?.email_address ?? primary?.emailAddress ?? null;
    return email ?? null;
  } catch (e) {
    console.warn('getClerkUserEmail error:', e);
    return null;
  }
}
