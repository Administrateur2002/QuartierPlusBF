import { getVideoMetaData } from "react-native-compressor";

const isValidDuration = (duration: unknown): duration is number =>
  typeof duration === "number" &&
  Number.isFinite(duration) &&
  duration > 0;

export const readVideoDurationSeconds = async (
  uri: string,
  pickerDurationMilliseconds?: number | null,
): Promise<number | undefined> => {
  try {
    const metadata = await getVideoMetaData(uri);
    if (isValidDuration(metadata.duration)) return metadata.duration;
  } catch {
    console.warn(
      "Lecture native de la durée vidéo indisponible; utilisation des métadonnées du sélecteur.",
    );
  }

  if (isValidDuration(pickerDurationMilliseconds)) {
    return pickerDurationMilliseconds / 1000;
  }
  return undefined;
};

export const exceedsVideoDurationLimit = (
  durationSeconds: number,
  maxDurationSeconds: number,
) => durationSeconds > maxDurationSeconds;
