jest.mock("react-native-compressor", () => ({
  getVideoMetaData: jest.fn(),
}));

const { getVideoMetaData } = require("react-native-compressor");
const {
  exceedsVideoDurationLimit,
  readVideoDurationSeconds,
} = require("./videoDuration");

describe("video duration limit", () => {
  beforeEach(() => {
    getVideoMetaData.mockReset();
  });

  it("accepts videos lasting only a few seconds", () => {
    expect(exceedsVideoDurationLimit(3, 420)).toBe(false);
  });

  it("accepts videos exactly at the seven-minute maximum", () => {
    expect(exceedsVideoDurationLimit(420, 420)).toBe(false);
  });

  it("rejects videos longer than the seven-minute maximum", () => {
    expect(exceedsVideoDurationLimit(420.1, 420)).toBe(true);
  });

  it("uses native file metadata in seconds rather than the picker value", async () => {
    getVideoMetaData.mockResolvedValue({ duration: 419.75 });

    await expect(
      readVideoDurationSeconds("file:///video.mp4", 420_000),
    ).resolves.toBe(419.75);
  });

  it("falls back to the picker duration in milliseconds when native metadata fails", async () => {
    getVideoMetaData.mockRejectedValue(new Error("unavailable"));
    const consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(
        readVideoDurationSeconds("file:///video.mp4", 421_000),
      ).resolves.toBe(421);
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("does not block a video when both duration sources are unavailable", async () => {
    getVideoMetaData.mockResolvedValue({ duration: Number.NaN });

    await expect(
      readVideoDurationSeconds("file:///video.mp4", undefined),
    ).resolves.toBeUndefined();
  });
});
