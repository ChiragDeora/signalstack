/**
 * Market hours check — used to avoid sending alert emails when the market is closed.
 * NSE/BSE: 9:15 AM–3:30 PM IST, Monday–Friday (no holiday calendar).
 */

const IST = 'Asia/Kolkata';

/**
 * Returns true if the given exchange is currently within regular trading hours.
 * NSE/BSE: 9:15–15:30 IST, Mon–Fri. Others: treated as open (no spam block).
 */
export function isMarketOpen(exchange: string): boolean {
  const ex = (exchange || 'NSE').toUpperCase();
  if (ex !== 'NSE' && ex !== 'BSE') return true;

  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-CA', { timeZone: IST, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const [hour, minute] = timeStr.split(':').map(Number);
  const weekday = now.toLocaleDateString('en-US', { timeZone: IST, weekday: 'short' }); // Mon, Tue, ..., Sun
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  if (isWeekend) return false;

  const mins = hour * 60 + minute;
  const openMins = 9 * 60 + 15; // 9:15
  const closeMins = 15 * 60 + 30; // 15:30
  return mins >= openMins && mins < closeMins;
}
