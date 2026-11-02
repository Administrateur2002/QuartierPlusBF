import { useRef, useState } from "react";
import { Modal, PanResponder, Pressable, StatusBar, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { X, Expand, Shrink } from "lucide-react-native";

type Props = {
  uri: string;
  visible: boolean;
  onRequestClose: () => void;
};

export default function ProfilePhotoViewer({ uri, visible, onRequestClose }: Props) {
  const [fitMode, setFitMode] = useState<"contain" | "cover">("contain");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const panOrigin = useRef({ x: 0, y: 0 });
  const initialPinchDistance = useRef(0);
  const initialPinchZoom = useRef(1);
  const lastViewerTap = useRef(0);

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
      onStartShouldSetPanResponderCapture: (event) => event.nativeEvent.touches.length > 1,
      onMoveShouldSetPanResponderCapture: (event, gesture) =>
        event.nativeEvent.touches.length > 1 ||
        zoomRef.current > 1 ||
        (gesture.dy > 8 && Math.abs(gesture.dy) > Math.abs(gesture.dx)),
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
          setViewerZoom(initialPinchZoom.current * (distance / initialPinchDistance.current));
          return;
        }
        if (zoomRef.current > 1) {
          const nextPan = {
            x: panOrigin.current.x + gesture.dx,
            y: panOrigin.current.y + gesture.dy,
          };
          panRef.current = nextPan;
          setPan(nextPan);
        } else if (gesture.dy > 0) {
          const nextPan = { x: 0, y: gesture.dy };
          panRef.current = nextPan;
          setPan(nextPan);
        }
      },
      onPanResponderRelease: (_event, gesture) => {
        initialPinchDistance.current = 0;
        if (zoomRef.current === 1) {
          panRef.current = { x: 0, y: 0 };
          setPan(panRef.current);
          if (gesture.dy > 120) onRequestClose();
        }
      },
      onPanResponderTerminate: () => {
        initialPinchDistance.current = 0;
        if (zoomRef.current === 1) {
          panRef.current = { x: 0, y: 0 };
          setPan(panRef.current);
        }
      },
    })
  ).current;

  return (
    <Modal
      animationType="fade"
      onRequestClose={onRequestClose}
      statusBarTranslucent
      visible={visible}
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
            accessibilityLabel="Photo de profil en plein écran"
            cachePolicy="memory-disk"
            contentFit={fitMode}
            source={{ uri }}
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
            onPress={onRequestClose}
            style={styles.viewerControl}
          >
            <X color="#ffffff" size={21} />
          </Pressable>
          <Pressable
            accessibilityLabel={fitMode === "contain" ? "Recadrer pour remplir l’écran" : "Afficher la photo entière"}
            accessibilityRole="button"
            onPress={() => setFitMode((current) => (current === "contain" ? "cover" : "contain"))}
            style={styles.viewerControl}
          >
            {fitMode === "contain" ? <Expand color="#ffffff" size={19} /> : <Shrink color="#ffffff" size={19} />}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  viewer: {
    flex: 1,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
  },
  viewerImageArea: {
    flex: 1,
    width: "100%",
    justifyContent: "center",
    alignItems: "center",
  },
  viewerControls: {
    position: "absolute",
    top: 0,
    right: 0,
    flexDirection: "row",
    gap: 8,
    padding: 18,
  },
  viewerControl: {
    backgroundColor: "rgba(0,0,0,0.5)",
    borderRadius: 18,
    padding: 7,
    marginLeft: 8,
  },
});
