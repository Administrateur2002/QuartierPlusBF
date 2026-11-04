jest.mock("react-native-compressor", () => ({
  Video: {
    compress: jest.fn(async () => "file:///compressed.mp4"),
  },
}));

const { Video } = require("react-native-compressor");
const { compressVideoForUpload } = require("./videoCompression");

test("compresses videos to a maximum 720p before upload and reports progress", async () => {
  const onProgress = jest.fn();

  await expect(
    compressVideoForUpload("file:///original.mp4", onProgress),
  ).resolves.toBe("file:///compressed.mp4");

  expect(Video.compress).toHaveBeenCalledWith(
    "file:///original.mp4",
    {
      compressionMethod: "manual",
      maxSize: 720,
      bitrate: 1_500_000,
    },
    onProgress,
  );
});

test("supports a lower-resolution fallback profile", async () => {
  const onProgress = jest.fn();

  await compressVideoForUpload(
    "file:///original.mp4",
    onProgress,
    480,
    900_000,
  );

  expect(Video.compress).toHaveBeenCalledWith(
    "file:///original.mp4",
    {
      compressionMethod: "manual",
      maxSize: 480,
      bitrate: 900_000,
    },
    onProgress,
  );
});
