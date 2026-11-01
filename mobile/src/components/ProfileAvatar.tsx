import { useEffect, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";

type Props = {
  name?: string | null;
  photoUrl?: string | null;
  size?: number;
  isAlly?: boolean;
  isProVerified?: boolean;
};

const initialsFor = (name?: string | null) =>
  name
    ?.trim()
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toLocaleUpperCase() || "?";

export default function ProfileAvatar({
  name,
  photoUrl,
  size = 40,
  isAlly = false,
  isProVerified = false,
}: Props) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [photoUrl]);
  const ringColor = isProVerified
    ? "#d4a017"
    : isAlly
      ? "#16a34a"
      : "#e2e8f0";
  const imageSize = Math.max(1, size - 4);

  return (
    <View
      accessibilityLabel={`${name || "Utilisateur"}${isProVerified ? ", commerce vérifié" : isAlly ? ", allié" : ""}`}
      accessibilityRole="image"
      style={[
        styles.ring,
        { backgroundColor: ringColor, height: size, width: size },
      ]}
    >
        <View
          style={[
            styles.inner,
            { height: imageSize, width: imageSize },
          ]}
        >
          {photoUrl && !imageFailed ? (
            <Image
              onError={() => setImageFailed(true)}
              source={{ uri: photoUrl }}
              style={{ height: imageSize, width: imageSize }}
            />
          ) : (
            <Text style={[styles.initials, { fontSize: Math.max(12, size * 0.34) }]}>
              {initialsFor(name)}
            </Text>
          )}
        </View>
    </View>
  );
}

const styles = StyleSheet.create({
  ring: {
    alignItems: "center",
    borderRadius: 999,
    borderWidth: 2,
    justifyContent: "center",
    overflow: "hidden",
  },
  inner: {
    alignItems: "center",
    backgroundColor: "#eaf0f6",
    borderRadius: 999,
    justifyContent: "center",
    overflow: "hidden",
  },
  initials: { color: "#334155", fontWeight: "800" },
});
