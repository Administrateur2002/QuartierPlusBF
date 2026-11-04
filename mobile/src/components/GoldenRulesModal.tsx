import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { GOLDEN_RULES } from "../legal/goldenRules";

type Props = {
  visible: boolean;
  onClose: () => void;
};

export default function GoldenRulesModal({ visible, onClose }: Props) {
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
            Règles d'or
          </Text>
          <ScrollView contentContainerStyle={styles.rules}>
            {GOLDEN_RULES.map((rule, index) => (
              <Text key={rule} style={styles.rule}>
                {index + 1}. {rule}
              </Text>
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
    padding: 20,
  },
  card: {
    backgroundColor: "#fffdf8",
    borderRadius: 16,
    maxHeight: "88%",
    padding: 22,
  },
  title: {
    color: "#252823",
    fontSize: 20,
    fontWeight: "800",
    marginBottom: 14,
  },
  rules: { gap: 12, paddingBottom: 8 },
  rule: { color: "#444840", fontSize: 14, lineHeight: 21 },
  close: {
    alignItems: "center",
    backgroundColor: "#252823",
    borderRadius: 7,
    justifyContent: "center",
    marginTop: 16,
    minHeight: 46,
  },
  closeText: { color: "#fff", fontSize: 14, fontWeight: "700" },
});
