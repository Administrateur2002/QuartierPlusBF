import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { LEGAL_DOCUMENTS } from "../legal/documents";

type Props = {
  visible: boolean;
  onClose: () => void;
};

export default function LegalDocumentsModal({ visible, onClose }: Props) {
  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      transparent
      visible={visible}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.title}>
            Documents légaux
          </Text>
          <ScrollView contentContainerStyle={styles.documents}>
            {LEGAL_DOCUMENTS.map((document) => (
              <View key={document.id} style={styles.document}>
                <Text accessibilityRole="header" style={styles.documentTitle}>
                  {document.title}
                </Text>
                <Text style={styles.body}>{document.body}</Text>
              </View>
            ))}
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            style={styles.close}
          >
            <Text style={styles.closeText}>Fermer</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: "rgba(20,25,21,0.55)",
    flex: 1,
    justifyContent: "center",
    padding: 18,
  },
  card: {
    backgroundColor: "#fffdf8",
    borderRadius: 16,
    flex: 1,
    maxHeight: "94%",
    padding: 20,
  },
  title: {
    color: "#252823",
    fontSize: 20,
    fontWeight: "800",
    marginBottom: 12,
  },
  documents: { gap: 20, paddingBottom: 16 },
  document: { gap: 7 },
  documentTitle: { color: "#252823", fontSize: 16, fontWeight: "800" },
  body: { color: "#444840", fontSize: 13, lineHeight: 20 },
  close: {
    alignItems: "center",
    backgroundColor: "#252823",
    borderRadius: 7,
    justifyContent: "center",
    marginTop: 12,
    minHeight: 46,
  },
  closeText: { color: "#fff", fontSize: 14, fontWeight: "700" },
});
