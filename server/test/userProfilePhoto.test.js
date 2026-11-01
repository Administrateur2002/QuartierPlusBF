import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??=
  "unit-test-secret-that-is-longer-than-thirty-two-characters";

const { updateCurrentUserPhoto } = await import("../controllers/userController.js");
const { pool } = await import("../db/pool.js");

const createResponse = () => ({
  statusCode: 200,
  payload: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.payload = payload;
    return this;
  },
});

test("profile photo update rejects a public ID that does not belong to the user", async (context) => {
  context.mock.method(pool, "query", async () => {
    throw new Error("Unowned uploads must not be checked or saved.");
  });
  const response = createResponse();

  await updateCurrentUserPhoto(
    {
      auth: { userId: "user-1" },
      body: { profile_photo_public_id: "another-user_profile-photo" },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 400);
  assert.equal(
    response.payload.error,
    "La photo téléversée ne vous appartient pas.",
  );
});
