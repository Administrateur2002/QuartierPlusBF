jest.mock("expo-sqlite", () => ({
  openDatabaseAsync: jest.fn(async () => {
    throw new Error("Native module ExpoSQLite is missing");
  }),
}));

const {
  cachePosts,
  enqueueOfflineAction,
  getCachedPosts,
  getPendingActions,
  initializeDatabase,
  removeSyncAction,
  updateSyncAction,
} = require("./db");
const SQLite = require("expo-sqlite");

describe("in-memory offline storage fallback", () => {
  beforeEach(() => {
    SQLite.openDatabaseAsync.mockClear();
  });

  it("keeps cached data and queued actions usable when SQLite initialization fails", async () => {
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(initializeDatabase()).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalledWith(
        "Cache SQLite indisponible.",
        expect.objectContaining({
          message: "Native module ExpoSQLite is missing",
        }),
      );
      await cachePosts([{ id: "post-1", caption: "en ligne" }]);
      await expect(getCachedPosts()).resolves.toEqual([
        { id: "post-1", caption: "en ligne" },
      ]);

      const id = await enqueueOfflineAction("create_post", "owner-1", {
        title: "Test",
      });
      await expect(getPendingActions("owner-1")).resolves.toEqual([
        expect.objectContaining({
          id,
          ownerId: "owner-1",
          status: "pending",
        }),
      ]);
      await updateSyncAction(id, "processing");
      await expect(getPendingActions("owner-1")).resolves.toEqual([]);
      await updateSyncAction(id, "failed");
      await expect(getPendingActions("owner-1")).resolves.toEqual([
        expect.objectContaining({ id, status: "failed", attempts: 1 }),
      ]);
      await removeSyncAction(id);
      await expect(getPendingActions("owner-1")).resolves.toEqual([]);
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });
});
