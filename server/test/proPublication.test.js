import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const { normalizeProPublication } = await import("../services/proPublication.js");

test("Pro publication normalization preserves the existing minimal contract", () => {
  assert.deepEqual(
    normalizeProPublication({
      title: "Commerce",
      description: "Présentation",
    }),
    { title: "Commerce", description: "Présentation" },
  );
});

test("Pro publications retain opt-in map, contact, service, hours and offer data", () => {
  assert.deepEqual(
    normalizeProPublication({
      title: " Atelier local ",
      description: " Présentation ",
      services: "Réparation",
      opening_hours: "Lun-Sam 08:00-18:00",
      phone: "+225 01020304",
      whatsapp: "+225 01020304",
      offers: ["-10% cette semaine"],
      visible_on_map: true,
      latitude: 6.3,
      longitude: 2.4,
    }),
    {
      title: "Atelier local",
      description: "Présentation",
      services: "Réparation",
      opening_hours: "Lun-Sam 08:00-18:00",
      phone: "+225 01020304",
      whatsapp: "+225 01020304",
      offers: ["-10% cette semaine"],
      visible_on_map: true,
      latitude: 6.3,
      longitude: 2.4,
    },
  );
});

test("map visibility requires finite coordinates and a reachable contact", () => {
  const base = {
    title: "Commerce",
    description: "Présentation",
    visible_on_map: true,
  };
  assert.equal(normalizeProPublication(base), null);
  assert.equal(
    normalizeProPublication({
      ...base,
      latitude: "6.3",
      longitude: 2.4,
      phone: "01020304",
    }),
    null,
  );
  assert.equal(
    normalizeProPublication({
      ...base,
      latitude: 6.3,
      longitude: 2.4,
    }),
    null,
  );
});

test("invalid service data and oversized offers are rejected", () => {
  const base = { title: "Commerce", description: "Présentation" };
  assert.equal(normalizeProPublication({ ...base, services: 42 }), null);
  assert.equal(
    normalizeProPublication({ ...base, offers: Array.from({ length: 9 }, () => "Offre") }),
    null,
  );
});
