import {
  FEED_SCOPES,
  feedScopeBarVisibilityOnScroll,
  isFeedCoordinates,
  resolveFeedCountryCode,
} from "./feedScopes";

describe("feed scopes", () => {
  it("offers the four ordered scopes", () => {
    expect(FEED_SCOPES.map(({ id }) => id)).toEqual([
      "neighborhood",
      "region",
      "country",
      "international",
    ]);
  });

  it("uses the authenticated country before phone, locale and configuration", () => {
    expect(
      resolveFeedCountryCode({
        userCountryCode: "ci",
        phoneNumber: "+221771234567",
        deviceLocale: "fr-FR",
        configuredCountryCode: "BF",
      }),
    ).toBe("CI");
  });

  it("derives the country from the phone, device locale, or saved configuration", () => {
    expect(
      resolveFeedCountryCode({ phoneNumber: "+221771234567" }),
    ).toBe("SN");
    expect(resolveFeedCountryCode({ deviceLocale: "fr-FR" })).toBe("FR");
    expect(
      resolveFeedCountryCode({ configuredCountryCode: "ml" }),
    ).toBe("ML");
    expect(resolveFeedCountryCode({})).toBe("BF");
  });

  it("accepts only valid coordinate pairs", () => {
    expect(isFeedCoordinates({ latitude: 12, longitude: -1 })).toBe(true);
    expect(isFeedCoordinates({ latitude: 91, longitude: -1 })).toBe(false);
    expect(isFeedCoordinates({ latitude: 12, longitude: "0" })).toBe(false);
  });

  it("hides scope filters while scrolling down and restores them while scrolling up", () => {
    expect(feedScopeBarVisibilityOnScroll(20, 10)).toBe(false);
    expect(feedScopeBarVisibilityOnScroll(10, 20)).toBe(true);
    expect(feedScopeBarVisibilityOnScroll(0, 10)).toBe(true);
    expect(feedScopeBarVisibilityOnScroll(14, 10)).toBeNull();
  });
});
