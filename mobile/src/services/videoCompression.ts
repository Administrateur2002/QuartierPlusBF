import { Video } from "react-native-compressor";

export const compressVideoForUpload = (
  uri: string,
  onProgress: (progress: number) => void,
) =>
  Video.compress(
    uri,
    {
      compressionMethod: "manual",
      maxSize: 720,
      bitrate: 1_000_000,
    },
    onProgress,
  );
