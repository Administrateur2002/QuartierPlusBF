const { exceedsVideoDurationLimit } = require("./videoDuration");

describe("video duration limit", () => {
  it("accepts videos lasting only a few seconds", () => {
    expect(exceedsVideoDurationLimit(3, 420)).toBe(false);
  });

  it("accepts videos exactly at the seven-minute maximum", () => {
    expect(exceedsVideoDurationLimit(420, 420)).toBe(false);
  });

  it("rejects videos longer than the seven-minute maximum", () => {
    expect(exceedsVideoDurationLimit(420.1, 420)).toBe(true);
  });
});
