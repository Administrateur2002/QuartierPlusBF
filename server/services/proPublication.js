export const normalizeProPublication = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const description =
    typeof value.description === "string" ? value.description.trim() : "";
  if (!title || title.length > 150 || !description || description.length > 500) {
    return null;
  }

  const publication = { title, description };
  for (const [key, maximum] of [
    ["services", 500],
    ["opening_hours", 160],
    ["phone", 30],
    ["whatsapp", 30],
  ]) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string" || value[key].trim().length > maximum) {
      return null;
    }
    publication[key] = value[key].trim();
  }

  if (value.offers !== undefined) {
    if (
      !Array.isArray(value.offers) ||
      value.offers.length > 8 ||
      value.offers.some(
        (offer) =>
          typeof offer !== "string" ||
          offer.trim().length === 0 ||
          offer.trim().length > 120,
      )
    ) {
      return null;
    }
    publication.offers = value.offers.map((offer) => offer.trim());
  }

  if (value.visible_on_map !== undefined) {
    if (typeof value.visible_on_map !== "boolean") return null;
    publication.visible_on_map = value.visible_on_map;
  }
  if (value.visible_on_map === true) {
    if (
      typeof value.latitude !== "number" ||
      !Number.isFinite(value.latitude) ||
      Math.abs(value.latitude) > 90 ||
      typeof value.longitude !== "number" ||
      !Number.isFinite(value.longitude) ||
      Math.abs(value.longitude) > 180 ||
      !(publication.phone?.length || publication.whatsapp?.length)
    ) {
      return null;
    }
    publication.latitude = value.latitude;
    publication.longitude = value.longitude;
  }
  return publication;
};
