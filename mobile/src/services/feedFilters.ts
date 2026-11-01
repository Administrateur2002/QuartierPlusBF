export const FEED_FILTERS = [
  "Tout",
  "Actualités locales",
  "Annonces",
  "Commerce",
  "Événements",
  "Entraide",
  "Alliances",
  "Photos et vidéos",
] as const;

export type FeedFilter = (typeof FEED_FILTERS)[number];

export type FilterableFeedEntry = {
  category: string;
  kind: "post" | "alert";
  imageUrl?: string;
};

export const matchesFeedFilter = (
  entry: FilterableFeedEntry,
  filter: FeedFilter,
) => {
  if (filter === "Tout") return true;
  if (filter === "Photos et vidéos") return Boolean(entry.imageUrl);
  const category = entry.category.toLocaleLowerCase("fr-FR");
  if (filter === "Actualités locales") return category.includes("actual") || category.includes("local") || category.includes("news");
  if (filter === "Annonces") return category.includes("annon") || category.includes("alert") || entry.kind === "alert";
  if (filter === "Commerce") return category.includes("commerce") || category.includes("produit") || category.includes("service") || category.includes("market");
  if (filter === "Événements") return category.includes("évén") || category.includes("event");
  if (filter === "Entraide") return category.includes("entraide") || category.includes("aide") || category.includes("solidar");
  return category.includes("alliance");
};
