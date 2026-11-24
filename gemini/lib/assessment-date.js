const assessmentTimeZone = 'Asia/Shanghai';
const dateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: assessmentTimeZone,
  calendar: 'iso8601',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function assessmentToday(now = new Date()) {
  const parts = Object.fromEntries(dateFormatter.formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
