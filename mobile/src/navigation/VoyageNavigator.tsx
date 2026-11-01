import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { VoyageStackParamList } from "./types";
import VoyageAgentScannerScreen from "../screens/voyage/VoyageAgentScannerScreen";
import VoyageCompanyScreen from "../screens/voyage/VoyageCompanyScreen";
import VoyageHomeScreen from "../screens/voyage/VoyageHomeScreen";

const Stack = createNativeStackNavigator<VoyageStackParamList>();

export default function VoyageNavigator() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="VoyageHome" component={VoyageHomeScreen} />
      <Stack.Screen name="VoyageCompany" component={VoyageCompanyScreen} />
      <Stack.Screen name="VoyageAgentScanner" component={VoyageAgentScannerScreen} />
    </Stack.Navigator>
  );
}