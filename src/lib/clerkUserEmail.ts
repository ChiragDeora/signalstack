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
    if (!res.ok) return null;
    const user = (await res.json()) as {
      primary_email_address_id?: string;
      email_addresses?: Array<{ id: string; email_address?: string; emailAddress?: string }>;
    };
    const primaryId = user.primary_email_address_id;
    const list = user.email_addresses || [];
    const primary = primaryId
      ? list.find((e) => e.id === primaryId)
      : list[0];
    const email = primary?.email_address ?? (primary as { emailAddress?: string })?.emailAddress;
    return email ?? null;
  } catch {
    return null;
  }
}
