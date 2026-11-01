import { parsePhoneNumberFromString } from "libphonenumber-js";

export type FeedScope = "neighborhood" | "region" | "country" | "international";

export type FeedCoordinates = {
  latitude: number;
  longitude: number;
};

export const FEED_SCOPES: {
  id: FeedScope;
  label: string;
}[] = [
  { id: "neighborhood", label: "Quartier" },
  { id: "region", label: "Région" },
  { id: "country", label: "Pays" },
  { id: "international", label: "International" },
];

export const feedScopeBarVisibilityOnScroll = (
  currentOffset: number,
  previousOffset: number,
): boolean | null => {
  if (currentOffset <= 0 || currentOffset < previousOffset - 6) return true;
  if (currentOffset > previousOffset + 6) return false;
  return null;
};

export const isFeedCoordinates = (
  value: unknown,
): value is FeedCoordinates => {
  if (!value || typeof value !== "object") return false;
  const coordinates = value as Record<string, unknown>;
  return (
    typeof coordinates.latitude === "number" &&
    Number.isFinite(coordinates.latitude) &&
    Math.abs(coordinates.latitude) <= 90 &&
    typeof coordinates.longitude === "number" &&
    Number.isFinite(coordinates.longitude) &&
    Math.abs(coordinates.longitude) <= 180
  );
};

const localeCountryCode = (locale: string) =>
  locale.match(/(?:^|[-_])([A-Z]{2})(?:$|[-_])/i)?.[1]?.toUpperCase() ?? null;

export const resolveFeedCountryCode = ({
  userCountryCode,
  phoneNumber,
  deviceLocale,
  configuredCountryCode,
}: {
  userCountryCode?: string | null;
  phoneNumber?: string | null;
  deviceLocale?: string | null;
  configuredCountryCode?: string | null;
}) => {
  const userCode = userCountryCode?.trim().toUpperCase();
  if (userCode && /^[A-Z]{2,3}$/.test(userCode)) return userCode;

  if (phoneNumber) {
    const parsed = parsePhoneNumberFromString(phoneNumber);
    if (parsed?.country) return parsed.country;
  }

  const deviceCode = deviceLocale ? localeCountryCode(deviceLocale) : null;
  if (deviceCode) return deviceCode;

  const configuredCode = configuredCountryCode?.trim().toUpperCase();
  return configuredCode && /^[A-Z]{2,3}$/.test(configuredCode)
    ? configuredCode
    : "BF";
};
