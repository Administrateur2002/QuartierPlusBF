import { FEED_FILTERS, matchesFeedFilter } from "./feedFilters";

test("feed filters include all requested discovery categories", () => {
  expect(FEED_FILTERS).toEqual([
    "Tout",
    "Actualités locales",
    "Annonces",
    "Commerce",
    "Événements",
    "Entraide",
    "Alliances",
    "Photos et vidéos",
  ]);
});

test.each([
  [{ category: "Actualités locales", kind: "post" }, "Actualités locales", true],
  [{ category: "Annonce", kind: "post" }, "Annonces", true],
  [{ category: "Produits", kind: "post" }, "Commerce", true],
  [{ category: "Événement local", kind: "post" }, "Événements", true],
  [{ category: "Entraide", kind: "post" }, "Entraide", true],
  [{ category: "Alliance", kind: "post" }, "Alliances", true],
  [{ category: "Photo", kind: "post", imageUrl: "https://example.test/photo.jpg" }, "Photos et vidéos", true],
  [{ category: "Urgence", kind: "alert" }, "Annonces", true],
  [{ category: "Annonce", kind: "post" }, "Alliances", false],
])("matches %s under %s", (entry, filter, expected) => {
  expect(matchesFeedFilter(entry, filter)).toBe(expected);
});
