export const isWithinQuietHours = (
  currentMinutes: number,
  start: string,
  end: string,
) => {
  const toMinutes = (time: string) => {
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
  };
  const startMinutes = toMinutes(start);
  const endMinutes = toMinutes(end);
  if (startMinutes === endMinutes) return false;
  return startMinutes < endMinutes
    ? currentMinutes >= startMinutes && currentMinutes < endMinutes
    : currentMinutes >= startMinutes || currentMinutes < endMinutes;
};
