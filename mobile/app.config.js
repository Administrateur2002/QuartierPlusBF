const iosGoogleClientId =
  process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim() ?? "";
const iosGoogleClientMatch = iosGoogleClientId.match(
  /^(\d+-[a-z0-9-]+)\.apps\.googleusercontent\.com$/i,
);

if (iosGoogleClientId && !iosGoogleClientMatch) {
  console.warn(
    "EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID invalide ; la configuration Google iOS est ignorée.",
  );
}

const googleSignInPlugin = iosGoogleClientMatch
  ? [
      "@react-native-google-signin/google-signin",
      {
        iosUrlScheme: `com.googleusercontent.apps.${iosGoogleClientMatch[1]}`,
      },
    ]
  : null;

module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    permissions: [
      ...new Set([
        ...(config.android.permissions ?? []),
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.ACCESS_BACKGROUND_LOCATION",
        "android.permission.FOREGROUND_SERVICE",
        "android.permission.FOREGROUND_SERVICE_LOCATION",
        "android.permission.POST_NOTIFICATIONS",
      ]),
    ],
    googleServicesFile:
      process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json",
  },
  ios: {
    ...config.ios,
    infoPlist: {
      ...config.ios?.infoPlist,
      UIBackgroundModes: [
        ...new Set([...(config.ios?.infoPlist?.UIBackgroundModes ?? []), "location"]),
      ],
    },
  },
  extra: {
    ...config.extra,
    commitSha: process.env.EXPO_PUBLIC_GIT_SHA ?? "unknown",
  },
  plugins: [
    ...config.plugins.map((plugin) =>
      Array.isArray(plugin) && plugin[0] === "react-native-maps"
        ? [
            plugin[0],
            {
              ...plugin[1],
              androidGoogleMapsApiKey:
                process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ?? "",
            },
          ]
        : Array.isArray(plugin) && plugin[0] === "expo-location"
          ? [
              plugin[0],
              {
                ...plugin[1],
                locationAlwaysAndWhenInUsePermission:
                  "La position est partagée uniquement pendant une livraison QuartierPlus Pro en cours.",
                isAndroidBackgroundLocationEnabled: true,
                isAndroidForegroundServiceEnabled: true,
                isIosBackgroundLocationEnabled: true,
              },
            ]
          : plugin,
    ),
    ...(googleSignInPlugin ? [googleSignInPlugin] : []),
  ],
});
