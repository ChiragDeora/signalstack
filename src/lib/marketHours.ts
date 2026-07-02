/**
 * NSE market-hours guard for the alert-sending layer.
 *
 * Used by the Telegram / email alert wrappers to suppress crossover and RSI
 * alerts that fire outside NSE trading hours (e.g. daily-timeframe candle
 * closes at midnight IST). Polling and signal detection are untouched — this
 * gate is only consulted immediately before a channel dispatch.
 *
 * Session guarded: regular equity 09:15–15:30 IST, Mon–Fri, non-holiday.
 * Muhurat / pre-open / block-deal windows are intentionally not included —
 * they are not relevant for the crossover/RSI alert use-case.
 */

const IST = 'Asia/Kolkata';

/**
 * NSE 2026 trading holidays. Best-effort list — verify against the official
 * NSE holiday calendar (https://www.nseindia.com/resources/exchange-communication-holidays)
 * before the start of the trading year and edit here as needed. Dates in
 * `YYYY-MM-DD` (IST calendar day) for cheap string comparison.
 */
export const NSE_HOLIDAYS_2026: readonly string[] = [
  '2026-01-26', // Republic Day (Mon)
  '2026-02-17', // Mahashivratri
  '2026-03-04', // Holi
  '2026-03-26', // Ram Navami
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-05-27', // Bakri Id
  '2026-08-15', // Independence Day (Sat — market closed regardless)
  '2026-08-25', // Ganesh Chaturthi
  '2026-10-02', // Gandhi Jayanti (Fri)
  '2026-10-20', // Dussehra
  '2026-11-09', // Diwali - Laxmi Pujan
  '2026-11-10', // Diwali - Balipratipada
  '2026-11-24', // Guru Nanak Jayanti
  '2026-12-25', // Christmas (Fri)
];

const IST_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: IST,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hour12: false,
});

const OPEN_MIN = 9 * 60 + 15;   // 09:15 IST
const CLOSE_MIN = 15 * 60 + 30; // 15:30 IST

/**
 * True only if the given instant falls inside an NSE regular trading session:
 * Mon–Fri, 09:15–15:30 IST, and not on a static NSE_HOLIDAYS_2026 date.
 *
 * `exchange` is accepted for backwards-compat with the previous signature;
 * anything other than NSE/BSE (case-insensitive) is treated as always open so
 * non-Indian symbols aren't silently gated.
 */
export function isMarketOpen(exchange?: string, now: Date = new Date()): boolean {
  const ex = (exchange || 'NSE').toUpperCase();
  if (ex !== 'NSE' && ex !== 'BSE') return true;

  const parts = IST_FMT.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

  const weekday = get('weekday'); // 'Mon' … 'Sun'
  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const dateISO = `${get('year')}-${get('month')}-${get('day')}`;
  if (NSE_HOLIDAYS_2026.includes(dateISO)) return false;

  const mins = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  return mins >= OPEN_MIN && mins <= CLOSE_MIN;
}
