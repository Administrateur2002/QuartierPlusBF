import { isWithinQuietHours } from "./notificationPreferences";

describe("isWithinQuietHours", () => {
  it("supports periods that cross midnight", () => {
    expect(isWithinQuietHours(23 * 60, "22:00", "07:00")).toBe(true);
    expect(isWithinQuietHours(6 * 60 + 59, "22:00", "07:00")).toBe(true);
    expect(isWithinQuietHours(7 * 60, "22:00", "07:00")).toBe(false);
    expect(isWithinQuietHours(12 * 60, "22:00", "07:00")).toBe(false);
  });

  it("supports daytime periods and a disabled interval", () => {
    expect(isWithinQuietHours(13 * 60, "12:00", "14:00")).toBe(true);
    expect(isWithinQuietHours(14 * 60, "12:00", "14:00")).toBe(false);
    expect(isWithinQuietHours(13 * 60, "08:00", "08:00")).toBe(false);
  });
});
