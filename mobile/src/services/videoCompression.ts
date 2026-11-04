import { Video } from "react-native-compressor";

export const compressVideoForUpload = (
  uri: string,
  onProgress: (progress: number) => void,
  maxSize = 720,
  bitrate = 1_500_000,
) =>
  Video.compress(
    uri,
    {
      compressionMethod: "manual",
      maxSize,
      bitrate,
    },
    onProgress,
  );
