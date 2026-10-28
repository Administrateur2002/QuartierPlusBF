import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import api from "../../services/api";
import type { VoyageStackParamList } from "../../navigation/types";

type Result = { status: "SUCCESS" | "ALREADY_USED" | "EXPIRED" | "WRONG_DATE" | "INVALID"; reason?: string; traveler_name?: string; seat_number?: string };

export default function VoyageAgentScannerScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<VoyageStackParamList>>();
  const route = useRoute<RouteProp<VoyageStackParamList, "VoyageAgentScanner">>();
  const [permission, requestPermission] = useCameraPermissions();
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const locked = useRef(false);

  const scan = async (qrPayload: string) => {
    if (locked.current) return;
    locked.current = true;
    try {
      const response = await api.post<Result>("/v1/voyage/scan", { qr_payload: qrPayload });
      setResult(response.data);
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "Validation impossible.");
      setResult({ status: "INVALID", reason: "Erreur réseau" });
    }
  };

  if (!permission) return <View style={styles.center}><ActivityIndicator color="#fff" /></View>;
  if (!permission.granted) return <View style={styles.center}><Text style={styles.title}>Accès caméra requis</Text><Pressable onPress={() => void requestPermission()} style={styles.button}><Text style={styles.buttonText}>Autoriser</Text></Pressable></View>;
  const accepted = result?.status === "SUCCESS";
  return (
    <View style={[styles.screen, result && (accepted ? styles.success : styles.failure)]}>
      {!result ? <>
        <Pressable onPress={() => navigation.goBack()} style={styles.close}><Text style={styles.closeText}>Fermer</Text></Pressable>
        <CameraView style={styles.camera} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }) => void scan(data)} />
        <View pointerEvents="none" style={styles.overlay}><View style={styles.scanBox} /><Text style={styles.hint}>Scanner le billet du départ</Text></View>
        <Text style={styles.trip}>Départ sélectionné · {route.params.tripId.slice(0, 8)}</Text>
      </> : <Pressable accessibilityRole="button" style={styles.feedback} onPress={() => { setResult(null); setError(""); locked.current = false; }}>
        <Text style={styles.status}>{accepted ? "BILLET VALIDE" : result.status === "ALREADY_USED" ? "DÉJÀ UTILISÉ" : result.status === "EXPIRED" ? "EXPIRÉ" : result.status === "WRONG_DATE" ? "AUTRE DATE" : "REFUSÉ"}</Text>
        <Text style={styles.reason}>{result.reason ?? (accepted ? "Embarquement autorisé" : "Vérification refusée")}</Text>
        {result.traveler_name && <Text style={styles.passenger}>{result.traveler_name}</Text>}
        {result.seat_number && <Text style={styles.passenger}>Siège {result.seat_number}</Text>}
        {error ? <Text style={styles.reason}>{error}</Text> : null}
        <Text style={styles.hint}>Toucher pour scanner le suivant</Text>
      </Pressable>}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: "#102d27", flex: 1, justifyContent: "center" },
  center: { alignItems: "center", backgroundColor: "#102d27", flex: 1, justifyContent: "center", padding: 24 },
  camera: { height: "100%", position: "absolute", width: "100%" },
  close: { left: 18, position: "absolute", top: 54, zIndex: 2 },
  closeText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  overlay: { alignItems: "center", gap: 18 },
  scanBox: { borderColor: "#fff", borderRadius: 14, borderWidth: 3, height: 245, width: 245 },
  hint: { color: "#fff", fontSize: 14, fontWeight: "600", marginTop: 14, textAlign: "center" },
  trip: { bottom: 40, color: "#fff", fontSize: 12, position: "absolute", textAlign: "center", width: "100%" },
  success: { backgroundColor: "#16834f" },
  failure: { backgroundColor: "#a32e2e" },
  feedback: { alignItems: "center", flex: 1, justifyContent: "center", padding: 28 },
  status: { color: "#fff", fontSize: 28, fontWeight: "900", textAlign: "center" },
  reason: { color: "#fff", fontSize: 16, marginTop: 16, textAlign: "center" },
  passenger: { color: "#fff", fontSize: 22, fontWeight: "800", marginTop: 18, textAlign: "center" },
  title: { color: "#fff", fontSize: 20, fontWeight: "800", marginBottom: 16 },
  button: { backgroundColor: "#df5f36", borderRadius: 7, padding: 12 },
  buttonText: { color: "#fff", fontWeight: "700" },
});