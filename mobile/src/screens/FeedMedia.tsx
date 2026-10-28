import { Image } from "expo-image";
import { VideoView, useVideoPlayer } from "expo-video";
import { Heart } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, Vibration, View } from "react-native";
import type { CloudinaryMediaType } from "../services/cloudinaryUpload";

type Props = {
  uri: string;
  type: CloudinaryMediaType;
  onDoubleTap?: () => void;
  height?: number;
  active?: boolean;
  preloadUri?: string;
  lowDataMode?: boolean;
};

export default function FeedMedia({
  uri,
  type,
  onDoubleTap,
  height,
  active = true,
  preloadUri,
  lowDataMode = false,
}: Props) {
  const [muted, setMuted] = useState(true);
  const [progress, setProgress] = useState(0);
  const lastTap = useRef(0);
  const heartProgress = useRef(new Animated.Value(0)).current;
  const optimizeUri = (source: string) =>
    lowDataMode && source.includes("/upload/")
      ? source.replace("/upload/", "/upload/q_auto:low,w_720,c_limit/")
      : source;
  const mediaUri = optimizeUri(uri);
  const optimizedPreloadUri = preloadUri ? optimizeUri(preloadUri) : undefined;
  const handleTap = () => {
    const now = Date.now();
    if (now - lastTap.current < 320) {
      heartProgress.setValue(0);
      Vibration.vibrate(10);
      Animated.sequence([
        Animated.spring(heartProgress, {
          toValue: 1,
          useNativeDriver: true,
          speed: 18,
          bounciness: 12,
        }),
        Animated.delay(350),
        Animated.timing(heartProgress, {
          toValue: 0,
          duration: 220,
          useNativeDriver: true,
        }),
      ]).start();
      onDoubleTap?.();
    }
    lastTap.current = now;
  };
  const heartStyle = {
    opacity: heartProgress,
    transform: [
      {
        scale: heartProgress.interpolate({
          inputRange: [0, 1],
          outputRange: [0.4, 1.2],
        }),
      },
    ],
  };
  const player = useVideoPlayer(type === "video" ? mediaUri : null, (instance) => {
    instance.muted = true;
    instance.loop = true;
    instance.timeUpdateEventInterval = 0.25;
    instance.audioMixingMode = "mixWithOthers";
    if (active) instance.play();
  });

  useEffect(() => {
    if (type !== "video") return;
    if (active) player.play();
    else player.pause();
  }, [active, player, type]);

  useEffect(() => {
    if (optimizedPreloadUri && type === "image") {
      void Image.prefetch(optimizedPreloadUri).catch((error: unknown) => {
        console.error("Unable to preload next feed image:", error);
      });
    }
  }, [optimizedPreloadUri, type]);

  useEffect(() => {
    if (type !== "video") return;
    const subscription = player.addListener("timeUpdate", ({ currentTime }) => {
      setProgress(
        player.duration > 0 ? Math.min(1, currentTime / player.duration) : 0,
      );
    });
    return () => subscription.remove();
  }, [player, type]);

  if (type === "image") {
    return (
      <Pressable onPress={handleTap} style={[styles.media, height ? { height } : null]}>
        <Image
          accessibilityLabel="Photo publiée"
          cachePolicy="memory-disk"
          contentFit="cover"
          source={{ uri: mediaUri }}
          style={StyleSheet.absoluteFill}
          transition={180}
        />
        <Animated.View pointerEvents="none" style={[styles.heartOverlay, heartStyle]}>
          <Heart color="#ffffff" fill="#ffffff" size={76} />
        </Animated.View>
      </Pressable>
    );
  }

  return (
    <View style={[styles.media, height ? { height } : null]}>
      <Pressable
        accessibilityLabel="Vidéo de la publication"
        onPress={() => {
          handleTap();
        }}
        style={StyleSheet.absoluteFill}
      >
        <VideoView
          contentFit="cover"
          nativeControls={false}
          player={player}
          style={StyleSheet.absoluteFill}
        />
      </Pressable>
      <Animated.View pointerEvents="none" style={[styles.heartOverlay, heartStyle]}>
        <Heart color="#ffffff" fill="#ffffff" size={76} />
      </Animated.View>
      <Pressable
        accessibilityLabel={muted ? "Activer le son de la vidéo" : "Couper le son de la vidéo"}
        accessibilityRole="button"
        onPress={() => {
          setMuted((current) => {
            player.muted = !current;
            return !current;
          });
        }}
        style={styles.soundButton}
      >
        <Text style={styles.soundLabel}>{muted ? "Son coupé · Activer" : "Son activé · Couper"}</Text>
      </Pressable>
      <View style={styles.progressTrack} pointerEvents="none">
        <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  media: {
    backgroundColor: "#0f172a",
    borderRadius: 16,
    height: 520,
    overflow: "hidden",
    width: "100%",
  },
  soundButton: {
    alignSelf: "flex-end",
    backgroundColor: "rgba(15,23,42,0.65)",
    borderRadius: 18,
    margin: 12,
    paddingHorizontal: 10,
    paddingVertical: 7,
    zIndex: 2,
  },
  soundLabel: { color: "#fff", fontSize: 11, fontWeight: "700" },
  progressTrack: {
    backgroundColor: "rgba(255,255,255,0.35)",
    bottom: 0,
    height: 3,
    left: 0,
    position: "absolute",
    right: 0,
  },
  progressFill: { backgroundColor: "#fff", height: 3 },
  heartOverlay: {
    alignItems: "center",
    justifyContent: "center",
    ...StyleSheet.absoluteFill,
    zIndex: 1,
  },
});
