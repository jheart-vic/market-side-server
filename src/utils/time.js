import { LAGOS_TZ, SIGNAL_WINDOW } from '../config/constants.js';

const lagosFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: LAGOS_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Wall-clock parts of a Date in Africa/Lagos. */
export function lagosParts(date = new Date()) {
  const parts = Object.fromEntries(
    lagosFormatter.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** "YYYY-MM-DD" for the Lagos calendar day — used to group signals per release day. */
export function lagosDayKey(date = new Date()) {
  const { year, month, day } = lagosParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** True when the instant falls inside the daily signal release window [3pm, 5pm) Lagos time. */
export function isWithinSignalWindow(date = new Date()) {
  const { hour } = lagosParts(date);
  return hour >= SIGNAL_WINDOW.startHour && hour < SIGNAL_WINDOW.endHour;
}
