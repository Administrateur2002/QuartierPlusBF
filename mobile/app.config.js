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

const androidMinify =
  process.env.EXPO_ANDROID_MINIFY?.trim().toLowerCase() !== "false";
const androidBuildArchs = (
  process.env.EXPO_ANDROID_BUILD_ARCHS ?? "arm64-v8a,armeabi-v7a"
)
  .split(",")
  .map((architecture) => architecture.trim())
  .filter(Boolean);
const supportedAndroidArchitectures = new Set(["arm64-v8a", "armeabi-v7a"]);
if (
  androidBuildArchs.length === 0 ||
  androidBuildArchs.some(
    (architecture) => !supportedAndroidArchitectures.has(architecture),
  )
) {
  throw new Error(
    "EXPO_ANDROID_BUILD_ARCHS doit contenir arm64-v8a et/ou armeabi-v7a.",
  );
}

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
    [
      "expo-build-properties",
      {
        android: {
          buildArchs: androidBuildArchs,
          enableMinifyInReleaseBuilds: androidMinify,
          enableShrinkResourcesInReleaseBuilds: androidMinify,
          useLegacyPackaging: true,
          extraProguardRules: `
-keep class io.livekit.android.** { *; }
-keep class io.livekit.reactnative.** { *; }
-keep class org.webrtc.** { *; }
-keep class com.oney.WebRTCModule.** { *; }
-keep class com.google.firebase.FirebaseApp
-keep class com.google.firebase.crashlytics.** { *; }
-keep class expo.modules.sqlite.** { *; }
-keep class com.swmansion.reanimated.** { *; }
-keep class com.swmansion.worklets.** { *; }
`,
        },
      },
    ],
  ],
});
