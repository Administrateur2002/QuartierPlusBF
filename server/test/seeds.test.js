import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const seeds = readFileSync(new URL("../db/seeds.sql", import.meta.url), "utf8");
const schema = readFileSync(new URL("../db/init.sql", import.meta.url), "utf8");
const authMigration = readFileSync(
  new URL("../db/auth-migration.sql", import.meta.url),
  "utf8",
);
const profilePhotoMigration = readFileSync(
  new URL("../../migrations/026_user_profile_photos.sql", import.meta.url),
  "utf8",
);
const postMediaMigration = readFileSync(
  new URL("../../migrations/029_post_media_carousel.sql", import.meta.url),
  "utf8",
);
const commerceGrowthMigration = readFileSync(
  new URL("../../migrations/025_commerce_growth_offers.sql", import.meta.url),
  "utf8",
);
const wholesalerMigration = readFileSync(
  new URL("../../migrations/027_wholesaler_optional_registration_fields.sql", import.meta.url),
  "utf8",
);
const voyageMigration = readFileSync(
  new URL("../../migrations/028_voyage_station_reservations.sql", import.meta.url),
  "utf8",
);
const grinModerationMigration = readFileSync(
  new URL("../../migrations/034_grin_live_moderation.sql", import.meta.url),
  "utf8",
);
const adminWorkspaceMigration = readFileSync(
  new URL("../../migrations/035_secure_admin_workspace.sql", import.meta.url),
  "utf8",
);
const deployGuide = readFileSync(
  new URL("../../docs/DEPLOY.md", import.meta.url),
  "utf8",
);
const countryRows = [
  ...seeds.matchAll(
    /^    \('([A-Z]{2,3})', '((?:[^']|'')*)', '(\+\d+)', '([^']*)', '([^']*)', '([^']*)'\)(,?)$/gm,
  ),
];
const countryCodes = new Set(countryRows.map((row) => row[1]));
const countryByCode = new Map(countryRows.map((row) => [row[1], row]));
const prefixRows = [
  ...seeds.matchAll(/^    \('([A-Z]{2,3})', '(\+\d+)'\)(,?)$/gm),
];
const prefixesByCountry = new Map();
const countriesByPrefix = new Map();
for (const [, code, prefix] of prefixRows) {
  const prefixes = prefixesByCountry.get(code) ?? new Set();
  prefixes.add(prefix);
  prefixesByCountry.set(code, prefixes);
  const countries = countriesByPrefix.get(prefix) ?? new Set();
  countries.add(code);
  countriesByPrefix.set(prefix, countries);
}

test("country seeds cover global countries with exact number-plan prefixes", () => {
  assert.equal(countryRows.length, 197);
  assert.equal(countryCodes.size, countryRows.length);
  assert.equal(prefixesByCountry.size, countryRows.length);
  assert.equal(prefixRows.length, 645);
  assert.equal(countryByCode.get("BF")?.[3], "+226");
  assert.equal(countryByCode.get("CI")?.[3], "+225");
  assert.equal(countryByCode.get("FR")?.[3], "+33");
  assert.equal(countryByCode.get("US")?.[3], "+1");
  assert.ok(prefixesByCountry.get("US")?.size > 100);
  assert.ok(prefixesByCountry.get("CA")?.size > 20);
  assert.deepEqual(
    [...prefixesByCountry.get("KZ")].sort(),
    ["+76", "+77"],
  );
  assert.deepEqual(
    [...prefixesByCountry.get("RU")].sort(),
    ["+73", "+74", "+75", "+78", "+79"],
  );
  assert.ok(prefixesByCountry.get("US")?.has("+1201"));
  assert.ok(prefixesByCountry.get("CA")?.has("+1204"));
  assert.ok([...countriesByPrefix.values()].every((countries) => countries.size === 1));
});

test("country seeds upsert by country code and channels are replay-safe", () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS country_phone_prefixes/);
  assert.match(schema, /is_active BOOLEAN NOT NULL DEFAULT TRUE/);
  assert.match(
    seeds,
    /UPDATE country_config\s+SET is_active = TRUE\s+WHERE code IN \('BF', 'CI', 'SN', 'ML'\)/,
  );
  assert.match(authMigration, /ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE/);
  for (const code of ["BF", "CI", "SN", "ML"]) {
    assert.ok(countryCodes.has(code), `missing country seed: ${code}`);
  }
  assert.match(authMigration, /ALTER COLUMN phone_number DROP NOT NULL/);
  assert.match(authMigration, /ADD COLUMN IF NOT EXISTS phone_verified_at/);
  assert.match(authMigration, /CREATE UNIQUE INDEX IF NOT EXISTS users_phone_e164_unique_idx/);
  assert.match(authMigration, /IF NOT EXISTS \([\s\S]*otp_verifications_channel_check/);
  assert.match(seeds, /ON CONFLICT \(code\) DO UPDATE SET/);
  assert.match(seeds, /ON CONFLICT \(country_code, phone_prefix\) DO NOTHING/);
  for (const channel of ["URGENCES", "ANNONCES"]) {
    assert.match(seeds, new RegExp(`\\('${channel}',`));
  }
  assert.match(seeds, /ON CONFLICT \(country_code, kind\)[\s\S]*DO UPDATE SET name/);
});

test("unknown emergency numbers are empty rather than invented", () => {
  assert.deepEqual(countryByCode.get("DE")?.slice(4, 7), ["", "", ""]);
});

test("profile photos and feed carousel migrations are additive and documented for deployment", () => {
  assert.match(profilePhotoMigration, /ADD COLUMN IF NOT EXISTS profile_photo_url TEXT/);
  assert.match(profilePhotoMigration, /ADD COLUMN IF NOT EXISTS profile_photo_public_id TEXT/);
  assert.doesNotMatch(profilePhotoMigration, /\b(DROP|DELETE|TRUNCATE)\b/i);
  assert.match(schema, /profile_photo_public_id TEXT/);
  assert.match(schema, /profile_photo_url TEXT/);
  assert.match(postMediaMigration, /CREATE TABLE IF NOT EXISTS post_media_items/);
  assert.match(grinModerationMigration, /CREATE TABLE IF NOT EXISTS grin_moderation_events/);
  assert.match(grinModerationMigration, /PAUSED_PENDING_REVIEW/);
  assert.match(grinModerationMigration, /APPEALED/);
  assert.match(adminWorkspaceMigration, /CREATE TABLE IF NOT EXISTS admin_audit_log/);
  assert.match(adminWorkspaceMigration, /CREATE TABLE IF NOT EXISTS admin_flash_broadcasts/);
  assert.match(adminWorkspaceMigration, /ADD COLUMN IF NOT EXISTS suspended_until/);
  assert.doesNotMatch(
    grinModerationMigration,
    /\b(DROP\s+TABLE|DELETE\s+FROM|TRUNCATE)\b/i,
  );
  for (const [migration, version] of [
    [commerceGrowthMigration, "025_commerce_growth_offers.sql"],
    [profilePhotoMigration, "026_user_profile_photos.sql"],
    [wholesalerMigration, "027_wholesaler_optional_registration_fields.sql"],
    [voyageMigration, "028_voyage_station_reservations.sql"],
    [postMediaMigration, "029_post_media_carousel.sql"],
    [grinModerationMigration, "034_grin_live_moderation.sql"],
    [adminWorkspaceMigration, "035_secure_admin_workspace.sql"],
  ]) {
    assert.ok(migration.includes(`VALUES ('${version}')`));
  }

  const versions = [
    "024_community_alliances.sql",
    "025_commerce_growth_offers.sql",
    "026_user_profile_photos.sql",
    "027_wholesaler_optional_registration_fields.sql",
    "028_voyage_station_reservations.sql",
    "029_post_media_carousel.sql",
    "034_grin_live_moderation.sql",
    "035_secure_admin_workspace.sql",
  ];
  const positions = versions.map((version) => deployGuide.indexOf(`migrations/${version}`));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
});
