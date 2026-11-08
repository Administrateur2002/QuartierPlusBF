import { Image } from "expo-image";
import { VideoView, useVideoPlayer } from "expo-video";
import { Expand, Heart, Pause, Play, Shrink, Volume2, VolumeX, X } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { StatusBar } from "expo-status-bar";
import {
  ActivityIndicator,
  Animated,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  Vibration,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CloudinaryMediaType } from "../services/cloudinaryUpload";

type Props = {
  uri: string;
  type: CloudinaryMediaType;
  onSingleTap?: () => void;
  onDoubleTap?: () => void;
  onTripleTap?: () => void;
  onLongPress?: () => void;
  height?: number;
  active?: boolean;
  preloadUri?: string;
  preloadType?: CloudinaryMediaType;
  lowDataMode?: boolean;
  autoPlay?: boolean;
  creatorName?: string;
  immersive?: boolean;
  showControls?: boolean;
  onPlaybackEnd?: () => void;
  progressBottom?: number;
};

export default function FeedMedia({
  uri,
  type,
  onSingleTap,
  onDoubleTap,
  onTripleTap,
  onLongPress,
  height,
  active = true,
  preloadUri,
  preloadType,
  lowDataMode = false,
  autoPlay = true,
  creatorName,
  immersive = false,
  showControls = true,
  onPlaybackEnd,
  progressBottom = 0,
}: Props) {
  const insets = useSafeAreaInsets();
  const [muted, setMuted] = useState(true);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [playbackError, setPlaybackError] = useState("");
  const [viewerOpen, setViewerOpen] = useState(false);
  const [fitMode, setFitMode] = useState<"contain" | "cover">("contain");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const tapCount = useRef(0);
  const tapTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastViewerTap = useRef(0);
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const panOrigin = useRef({ x: 0, y: 0 });
  const initialPinchDistance = useRef(0);
  const initialPinchZoom = useRef(1);
  const heartProgress = useRef(new Animated.Value(0)).current;
  const optimizeUri = (source: string) =>
    lowDataMode && source.includes("/upload/")
      ? source.replace("/upload/", "/upload/q_auto:low,w_720,c_limit/")
      : source;
  const mediaUri = optimizeUri(uri);
  const optimizedPreloadUri = preloadUri ? optimizeUri(preloadUri) : undefined;
  const thumbnailUri = mediaUri.includes("/upload/")
    ? mediaUri.replace("/upload/", "/upload/e_blur:1000,q_auto:low,w_48/")
    : undefined;
  const setViewerZoom = (nextZoom: number) => {
    const boundedZoom = Math.max(1, Math.min(4, nextZoom));
    zoomRef.current = boundedZoom;
    setZoom(boundedZoom);
    if (boundedZoom === 1) {
      panRef.current = { x: 0, y: 0 };
      setPan(panRef.current);
    }
  };
  const getTouchDistance = (touches: readonly { pageX: number; pageY: number }[]) => {
    if (touches.length < 2) return 0;
    const [first, second] = touches;
    return Math.hypot(first.pageX - second.pageX, first.pageY - second.pageY);
  };
  const viewerPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponderCapture: (event) =>
        event.nativeEvent.touches.length > 1,
      onMoveShouldSetPanResponderCapture: (event) =>
        event.nativeEvent.touches.length > 1 || zoomRef.current > 1,
      onPanResponderGrant: (event) => {
        const distance = getTouchDistance(event.nativeEvent.touches);
        if (distance > 0) {
          initialPinchDistance.current = distance;
          initialPinchZoom.current = zoomRef.current;
        } else {
          panOrigin.current = panRef.current;
        }
      },
      onPanResponderMove: (event, gesture) => {
        const distance = getTouchDistance(event.nativeEvent.touches);
        if (distance > 0 && initialPinchDistance.current > 0) {
          setViewerZoom(
            initialPinchZoom.current * (distance / initialPinchDistance.current),
          );
          return;
        }
        if (zoomRef.current > 1) {
          const nextPan = {
            x: panOrigin.current.x + gesture.dx,
            y: panOrigin.current.y + gesture.dy,
          };
          panRef.current = nextPan;
          setPan(nextPan);
        }
      },
      onPanResponderRelease: () => {
        initialPinchDistance.current = 0;
      },
      onPanResponderTerminate: () => {
        initialPinchDistance.current = 0;
      },
    }),
  ).current;
  const handleTap = (onSingleTap?: () => void) => {
    tapCount.current += 1;
    if (tapTimeout.current) clearTimeout(tapTimeout.current);
    tapTimeout.current = setTimeout(() => {
      const count = tapCount.current;
      tapCount.current = 0;
      tapTimeout.current = null;
      if (count >= 3) {
        onTripleTap?.();
        return;
      }
      if (count === 2) {
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
        return;
      }
      onSingleTap?.();
    }, 250);
  };
  const handleLongPress = () => {
    if (tapTimeout.current) clearTimeout(tapTimeout.current);
    tapTimeout.current = null;
    tapCount.current = 0;
    onLongPress?.();
  };
  useEffect(
    () => () => {
      if (tapTimeout.current) clearTimeout(tapTimeout.current);
    },
    [],
  );
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
  const player = useVideoPlayer(
    type === "video" && active ? mediaUri : null,
    (instance) => {
      instance.muted = true;
      instance.loop = false;
      instance.timeUpdateEventInterval = 0.25;
      instance.audioMixingMode = "mixWithOthers";
    },
  );

  useEffect(() => {
    if (type !== "video") return;
    setProgress(0);
    setDuration(player.duration || 0);
    setIsPlaying(player.playing);
    setIsBuffering(player.status === "loading");
    setPlaybackError(
      player.status === "error"
        ? "Lecture vidéo indisponible."
        : "",
    );
  }, [mediaUri, player, type]);

  useEffect(() => {
    if (type !== "video") return;
    if (active && autoPlay && !playbackError) player.play();
    else player.pause();
  }, [active, autoPlay, playbackError, player, type]);

  useEffect(() => {
    if (type !== "video") return;
    const subscription = player.addListener("playingChange", ({ isPlaying: playing }) => {
      setIsPlaying(playing);
    });
    const statusSubscription = player.addListener("statusChange", ({ status, error }) => {
      setIsBuffering(status === "loading");
      if (status === "error") {
        const message = error?.message ?? "Lecture vidéo indisponible.";
        console.error("Feed video playback failed:", { uri: mediaUri, error });
        setPlaybackError(message);
        player.pause();
      } else {
        setPlaybackError("");
      }
    });
    const endSubscription = player.addListener("playToEnd", () => {
      if (active) onPlaybackEnd?.();
    });
    return () => {
      subscription.remove();
      statusSubscription.remove();
      endSubscription.remove();
    };
  }, [active, mediaUri, onPlaybackEnd, player, type]);

  useEffect(() => {
    if (optimizedPreloadUri && preloadType === "image") {
      void Image.prefetch(optimizedPreloadUri).catch((error: unknown) => {
        console.error("Unable to preload next feed image:", error);
      });
    }
  }, [optimizedPreloadUri, preloadType]);

  useEffect(() => {
    if (type !== "video") return;
    const subscription = player.addListener("timeUpdate", ({ currentTime }) => {
      setDuration(player.duration || 0);
      setProgress(
        player.duration > 0 ? Math.min(1, currentTime / player.duration) : 0,
      );
    });
    return () => subscription.remove();
  }, [player, type]);

  if (type === "image") {
    return (
      <View style={[styles.media, immersive && styles.immersiveMedia, height ? { height } : null]}>
        <Image
          accessibilityLabel="Photo publiée"
          cachePolicy="memory-disk"
          contentFit="cover"
          placeholder={thumbnailUri ? { uri: thumbnailUri } : undefined}
          source={{ uri: mediaUri }}
          style={StyleSheet.absoluteFill}
          transition={180}
        />
        <Pressable
          accessibilityLabel="Ouvrir la photo en plein écran"
          onLongPress={handleLongPress}
          onPress={() => handleTap(onSingleTap)}
          style={StyleSheet.absoluteFill}
        />
        <Animated.View pointerEvents="none" style={[styles.heartOverlay, heartStyle]}>
          <Heart color="#ffffff" fill="#ffffff" size={76} />
        </Animated.View>
        {showControls ? (
          <Pressable
            accessibilityLabel="Afficher la photo en plein écran"
            accessibilityRole="button"
            onPress={() => {
              setFitMode("contain");
              setViewerZoom(1);
              setViewerOpen(true);
            }}
            style={styles.expandButton}
          >
            <Expand color="#ffffff" size={18} />
          </Pressable>
        ) : null}
        <Modal
          animationType="fade"
          onRequestClose={() => setViewerOpen(false)}
          statusBarTranslucent
          visible={viewerOpen}
        >
          <StatusBar hidden />
          <View style={styles.viewer}>
            <View
              {...viewerPanResponder.panHandlers}
              onTouchEnd={(event) => {
                if (event.nativeEvent.touches.length === 0) {
                  initialPinchDistance.current = 0;
                }
              }}
              style={styles.viewerImageArea}
            >
              <Image
                accessibilityLabel="Photo en plein écran"
                cachePolicy="memory-disk"
                contentFit={fitMode}
                placeholder={thumbnailUri ? { uri: thumbnailUri } : undefined}
                source={{ uri: mediaUri }}
                style={[
                  StyleSheet.absoluteFill,
                  { transform: [{ translateX: pan.x }, { translateY: pan.y }, { scale: zoom }] },
                ]}
                transition={220}
              />
              <Pressable
                accessibilityLabel={zoom > 1 ? "Dézoomer la photo" : "Zoomer la photo"}
                onPress={() => {
                  const now = Date.now();
                  if (now - lastViewerTap.current < 320) {
                    setViewerZoom(zoomRef.current > 1 ? 1 : 2);
                  }
                  lastViewerTap.current = now;
                }}
                onLongPress={() => setViewerZoom(1)}
                style={StyleSheet.absoluteFill}
              />
            </View>
            <View style={styles.viewerControls}>
              <Pressable
                accessibilityLabel="Fermer la photo"
                accessibilityRole="button"
                onPress={() => setViewerOpen(false)}
                style={styles.viewerControl}
              >
                <X color="#ffffff" size={21} />
              </Pressable>
              <Pressable
                accessibilityLabel={fitMode === "contain" ? "Recadrer pour remplir l’écran" : "Afficher la photo entière"}
                accessibilityRole="button"
                onPress={() => setFitMode((current) => current === "contain" ? "cover" : "contain")}
                style={styles.viewerControl}
              >
                {fitMode === "contain" ? <Expand color="#ffffff" size={19} /> : <Shrink color="#ffffff" size={19} />}
              </Pressable>
            </View>
          </View>
        </Modal>
      </View>
    );
  }

  return (
    <View style={[styles.media, immersive && styles.immersiveMedia, height ? { height } : null]}>
      <Pressable
        accessibilityLabel={
          immersive
            ? "Vidéo de la publication, toucher pour lire ou mettre en pause"
            : "Vidéo de la publication"
        }
        onLongPress={handleLongPress}
        onPress={() => {
          handleTap(() => {
            onSingleTap?.();
            if (player.playing) player.pause();
            else if (!playbackError) player.play();
          });
        }}
        style={StyleSheet.absoluteFill}
      >
        {!viewerOpen ? <VideoView contentFit="cover" nativeControls={false} player={player} style={StyleSheet.absoluteFill} /> : null}
      </Pressable>
      {active && isBuffering ? (
        <View pointerEvents="none" style={styles.bufferingOverlay}>
          <ActivityIndicator color="#ffffff" size="large" />
        </View>
      ) : null}
      {showControls && immersive && !isPlaying ? (
        <Pressable
          accessibilityLabel="Lire la vidéo"
          accessibilityRole="button"
          onPress={() => player.play()}
          style={styles.immersivePlayButton}
        >
          <Play color="#ffffff" size={30} />
        </Pressable>
      ) : null}
      <Animated.View pointerEvents="none" style={[styles.heartOverlay, heartStyle]}>
        <Heart color="#ffffff" fill="#ffffff" size={76} />
      </Animated.View>
      {showControls ? (
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
          {muted ? <VolumeX color="#ffffff" size={18} /> : <Volume2 color="#ffffff" size={18} />}
        </Pressable>
      ) : null}
      {showControls && immersive ? (
        <Pressable
          accessibilityLabel="Afficher la vidéo en plein écran"
          accessibilityRole="button"
          onPress={() => setViewerOpen(true)}
          style={styles.expandButton}
        >
          <Expand color="#ffffff" size={18} />
        </Pressable>
      ) : null}
      {!immersive ? (
        <View style={styles.videoControls}>
          <Pressable
            accessibilityLabel={isPlaying ? "Mettre la vidéo en pause" : "Lire la vidéo"}
            accessibilityRole="button"
            onPress={() => player.playing ? player.pause() : player.play()}
            style={styles.videoControlButton}
          >
            {isPlaying ? <Pause color="#ffffff" size={18} /> : <Play color="#ffffff" size={18} />}
          </Pressable>
          <Text style={styles.durationLabel}>{formatTime(player.currentTime)} / {formatTime(duration)}</Text>
          <Pressable
            accessibilityLabel="Afficher la vidéo en plein écran"
            accessibilityRole="button"
            onPress={() => setViewerOpen(true)}
            style={styles.videoControlButton}
          >
            <Expand color="#ffffff" size={17} />
          </Pressable>
        </View>
      ) : null}
      {playbackError ? <Text style={styles.playbackError}>{playbackError}</Text> : null}
      <View
        pointerEvents="none"
        style={[
          styles.progressTrack,
          immersive ? { bottom: progressBottom } : null,
        ]}
      >
        <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
      </View>
      <Modal
        animationType="fade"
        onRequestClose={() => setViewerOpen(false)}
        statusBarTranslucent
        visible={viewerOpen}
      >
        <StatusBar hidden />
        <View style={styles.viewer}>
          <VideoView contentFit="contain" nativeControls={false} player={player} style={StyleSheet.absoluteFill} />
          <View style={styles.viewerVideoControls}>
            <Pressable accessibilityLabel="Fermer la vidéo" accessibilityRole="button" onPress={() => setViewerOpen(false)} style={styles.viewerControl}>
              <X color="#ffffff" size={21} />
            </Pressable>
            <Text style={styles.viewerCreator}>{creatorName ? `${creatorName} · ` : ""}{isPlaying ? "Lecture" : "En pause"} · {formatTime(player.currentTime)} / {formatTime(duration)}</Text>
            <Pressable accessibilityLabel={muted ? "Activer le son" : "Couper le son"} accessibilityRole="button" onPress={() => { player.muted = !muted; setMuted((current) => !current); }} style={styles.viewerControl}>
              {muted ? <VolumeX color="#ffffff" size={19} /> : <Volume2 color="#ffffff" size={19} />}
            </Pressable>
          </View>
          <Pressable accessibilityLabel={isPlaying ? "Mettre en pause" : "Lire"} accessibilityRole="button" onPress={() => player.playing ? player.pause() : player.play()} style={styles.viewerPlayButton}>
            {isPlaying ? <Pause color="#ffffff" size={30} /> : <Play color="#ffffff" size={30} />}
          </Pressable>
          <View
            pointerEvents="none"
            style={[
              styles.viewerProgressTrack,
              { bottom: Math.max(insets.bottom, 4) },
            ]}
          >
            <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
};

const styles = StyleSheet.create({
  media: {
    backgroundColor: "#0f172a",
    borderRadius: 16,
    height: 520,
    overflow: "hidden",
    width: "100%",
  },
  immersiveMedia: { borderRadius: 0 },
  soundButton: {
    alignSelf: "flex-end",
    backgroundColor: "rgba(15,23,42,0.65)",
    borderRadius: 18,
    margin: 12,
    paddingHorizontal: 10,
    paddingVertical: 7,
    zIndex: 2,
  },
  immersivePlayButton: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: "rgba(15,23,42,0.65)",
    borderRadius: 28,
    height: 56,
    justifyContent: "center",
    position: "absolute",
    top: "45%",
    width: 56,
    zIndex: 3,
  },
  expandButton: {
    alignItems: "center",
    backgroundColor: "rgba(15,23,42,0.65)",
    borderRadius: 18,
    bottom: 10,
    height: 36,
    justifyContent: "center",
    position: "absolute",
    right: 10,
    width: 36,
    zIndex: 2,
  },
  videoControls: {
    alignItems: "center",
    bottom: 12,
    flexDirection: "row",
    gap: 10,
    left: 12,
    position: "absolute",
    right: 52,
    zIndex: 2,
  },
  bufferingOverlay: {
    alignItems: "center",
    justifyContent: "center",
    ...StyleSheet.absoluteFill,
    zIndex: 2,
  },
  videoControlButton: {
    alignItems: "center",
    backgroundColor: "rgba(15,23,42,0.65)",
    borderRadius: 18,
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  durationLabel: { color: "#ffffff", flex: 1, fontSize: 11, fontWeight: "700" },
  playbackError: {
    alignSelf: "center",
    backgroundColor: "rgba(15,23,42,0.78)",
    borderRadius: 8,
    color: "#ffffff",
    fontSize: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    position: "absolute",
    top: "45%",
  },
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
  viewer: { backgroundColor: "#000000", flex: 1, justifyContent: "center" },
  viewerImageArea: { flex: 1, justifyContent: "center", overflow: "hidden" },
  viewerControls: {
    flexDirection: "row",
    justifyContent: "space-between",
    left: 0,
    paddingHorizontal: 18,
    position: "absolute",
    right: 0,
    top: 48,
    zIndex: 3,
  },
  viewerControl: {
    alignItems: "center",
    backgroundColor: "rgba(15,23,42,0.62)",
    borderRadius: 20,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  viewerVideoControls: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    left: 18,
    position: "absolute",
    right: 18,
    top: 48,
    zIndex: 2,
  },
  viewerCreator: { color: "#ffffff", flex: 1, fontSize: 12, fontWeight: "700" },
  viewerPlayButton: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: "rgba(15,23,42,0.62)",
    borderRadius: 28,
    height: 56,
    justifyContent: "center",
    position: "absolute",
    width: 56,
  },
  viewerProgressTrack: {
    backgroundColor: "rgba(255,255,255,0.35)",
    bottom: 0,
    height: 3,
    left: 0,
    position: "absolute",
    right: 0,
  },
});
