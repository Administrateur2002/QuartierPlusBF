import "dotenv/config";

const nodeEnv = process.env.NODE_ENV?.trim() || "development";
if (!["development", "test", "production"].includes(nodeEnv)) {
  throw new Error("NODE_ENV must be development, test, or production.");
}
const isProduction = nodeEnv === "production";

const optional = (name) => process.env[name]?.trim() ?? "";
const optionalUnquoted = (name) =>
  optional(name).replace(/^(['"])(.*)\1$/, "$2").trim();

const required = (name) => {
  const value = optional(name);
  if (!value) throw new Error(`Variable ${name} manquante.`);
  return value;
};

const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const pgSslValue = optional("PGSSL");
if (pgSslValue && !["true", "false"].includes(pgSslValue)) {
  throw new Error("PGSSL must be true or false.");
}
const promoFreeAccessValue = optional("IS_PROMO_FREE_ACCESS");
if (promoFreeAccessValue && !["true", "false"].includes(promoFreeAccessValue)) {
  throw new Error("IS_PROMO_FREE_ACCESS must be true or false.");
}
const billingEnabledValue = optional("BILLING_ENABLED");
if (billingEnabledValue && !["true", "false"].includes(billingEnabledValue)) {
  throw new Error("BILLING_ENABLED must be true or false.");
}
const proEnabledValue = optional("PRO_ENABLED");
if (proEnabledValue && !["true", "false"].includes(proEnabledValue)) {
  throw new Error("PRO_ENABLED must be true or false.");
}
const voyageEnabledValue = optional("VOYAGE_ENABLED");
if (voyageEnabledValue && !["true", "false"].includes(voyageEnabledValue)) {
  throw new Error("VOYAGE_ENABLED must be true or false.");
}
const voyageDemoDataValue = optional("VOYAGE_DEMO_DATA");
if (voyageDemoDataValue && !["true", "false"].includes(voyageDemoDataValue)) {
  throw new Error("VOYAGE_DEMO_DATA must be true or false.");
}
const voyageEnabled = voyageEnabledValue === "true";
const ticketSigningPrivateKeyB64 = optionalUnquoted(
  "TICKET_SIGNING_PRIVATE_KEY_B64",
);
if (voyageEnabled && !ticketSigningPrivateKeyB64) {
  throw new Error("TICKET_SIGNING_PRIVATE_KEY_B64 is required when VOYAGE_ENABLED=true.");
}

const databaseUrl = required("DATABASE_URL");
let parsedDatabaseUrl;
try {
  parsedDatabaseUrl = new URL(databaseUrl);
} catch {
  throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
}
if (!["postgres:", "postgresql:"].includes(parsedDatabaseUrl.protocol)) {
  throw new Error("DATABASE_URL must use the postgres or postgresql protocol.");
}

const otpTestModeValue = optional("OTP_TEST_MODE");
if (otpTestModeValue && !["true", "false"].includes(otpTestModeValue)) {
  throw new Error("OTP_TEST_MODE must be true or false.");
}
const otpTestMode = otpTestModeValue === "true";
if (isProduction && otpTestMode) {
  throw new Error("OTP_TEST_MODE must not be enabled in production.");
}
const otpTestAllowlist = [
  ...new Set(
    optional("OTP_TEST_ALLOWLIST")
      .split(",")
      .map((phoneNumber) => phoneNumber.trim())
      .filter(Boolean),
  ),
];
if (otpTestAllowlist.some((phoneNumber) => !/^\+[1-9]\d{7,14}$/.test(phoneNumber))) {
  throw new Error("OTP_TEST_ALLOWLIST must contain comma-separated E.164 phone numbers.");
}

const smsDeliveryUrl = optional("SMS_DELIVERY_URL");
const smsDeliveryToken = optional("SMS_DELIVERY_TOKEN");
if (isProduction && (!smsDeliveryUrl || !smsDeliveryToken)) {
  throw new Error("SMS_DELIVERY_URL and SMS_DELIVERY_TOKEN are required in production.");
}
if (smsDeliveryUrl) {
  let smsUrl;
  try {
    smsUrl = new URL(smsDeliveryUrl);
  } catch {
    throw new Error("SMS_DELIVERY_URL must be a valid URL.");
  }
  if (isProduction && smsUrl.protocol !== "https:") {
    throw new Error("SMS_DELIVERY_URL must use HTTPS in production.");
  }
}

const jwtSecret = required("JWT_SECRET");
if (jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must contain at least 32 characters.");
}

const ticketQrSecret = optional("TICKET_QR_SECRET");
if (isProduction && ticketQrSecret.length < 32) {
  throw new Error(
    "TICKET_QR_SECRET must contain at least 32 characters in production.",
  );
}

const cloudinaryCloudName = optionalUnquoted("CLOUDINARY_CLOUD_NAME");
const cloudinaryApiKey = optionalUnquoted("CLOUDINARY_API_KEY");
const cloudinaryApiSecret = optionalUnquoted("CLOUDINARY_API_SECRET");
const positiveInteger = (name, fallback) => {
  const value = optional(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
};

const googleClientId = optional("GOOGLE_CLIENT_ID");
const smtpHost = optional("SMTP_HOST");
const smtpPortValue = optional("SMTP_PORT");
const smtpPort = smtpPortValue ? Number(smtpPortValue) : 0;
if (smtpPortValue && (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535)) {
  throw new Error("SMTP_PORT doit être un port valide.");
}
const smtpUser = optional("SMTP_USER");
const smtpPass = optional("SMTP_PASS").replace(/\s+/g, "");
const mailFrom = optional("MAIL_FROM");
const smtpConfigured = Boolean(smtpHost && smtpPort && smtpUser && smtpPass && mailFrom);
const smtpPartiallyConfigured = [smtpHost, smtpPortValue, smtpUser, smtpPass, mailFrom].some(Boolean) && !smtpConfigured;
const emailProvider = optional("EMAIL_PROVIDER").toLowerCase() || (smtpConfigured ? "smtp" : "");
const adminTestEmailToken = optional("ADMIN_TEST_EMAIL_TOKEN");
const livekitApiKey = optionalUnquoted("LIVEKIT_API_KEY");
const livekitApiSecret = optionalUnquoted("LIVEKIT_API_SECRET");
const livekitUrl = optionalUnquoted("LIVEKIT_URL");
const livekitApiKeyIssues = [];
if (!livekitApiKey) {
  livekitApiKeyIssues.push("is missing");
} else {
  if (!/^API[A-Za-z0-9_-]+$/.test(livekitApiKey)) {
    livekitApiKeyIssues.push(
      "must match /^API[A-Za-z0-9_-]+$/ after trimming and removing surrounding quotes",
    );
  }
}
const isPlaceholderLiveKitValue = (value) =>
  /(?:your[-_]|replace[-_]?with|fake|placeholder|changeme|example(?:\.|$))/i.test(
    value,
  );
if (livekitApiKey && isPlaceholderLiveKitValue(livekitApiKey)) {
  livekitApiKeyIssues.push("must not be an example or placeholder value");
}
const isValidLiveKitUrl = (value) => {
  if (!value || isPlaceholderLiveKitValue(value)) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "wss:" &&
      Boolean(parsed.hostname)
    );
  } catch {
    return false;
  }
};
const livekitConfigurationProblems = [
  livekitApiKeyIssues.length > 0 ? "LIVEKIT_API_KEY" : null,
  livekitApiSecret.length < 32 || isPlaceholderLiveKitValue(livekitApiSecret)
    ? "LIVEKIT_API_SECRET"
    : null,
  !isValidLiveKitUrl(livekitUrl)
    ? "LIVEKIT_URL"
    : null,
].filter((name) => name !== null);
const livekitConfigurationProblemDetails = [
  ...(livekitApiKeyIssues.length > 0
    ? [`LIVEKIT_API_KEY ${livekitApiKeyIssues.join("; ")}.`]
    : []),
  ...(livekitApiSecret.length < 32 || isPlaceholderLiveKitValue(livekitApiSecret)
    ? [
        "LIVEKIT_API_SECRET must contain at least 32 characters and must not be an example or placeholder value.",
      ]
    : []),
  ...(!isValidLiveKitUrl(livekitUrl)
    ? [
        "LIVEKIT_URL must be a valid wss:// URL.",
      ]
    : []),
];
const livekitConfigurationIsUsable = livekitConfigurationProblems.length === 0;
const grinModerationEnabledValue = optional("GRIN_MODERATION_ENABLED");
if (
  grinModerationEnabledValue &&
  !["true", "false"].includes(grinModerationEnabledValue)
) {
  throw new Error("GRIN_MODERATION_ENABLED must be true or false.");
}
const grinModerationEnabled = grinModerationEnabledValue === "true";
const grinModerationWebhookSecret = optional("GRIN_MODERATION_WEBHOOK_SECRET");
if (grinModerationEnabled && grinModerationWebhookSecret.length < 32) {
  throw new Error(
    "GRIN_MODERATION_WEBHOOK_SECRET must contain at least 32 characters when GRIN_MODERATION_ENABLED=true.",
  );
}
const moderationUploadsEnabledValue = optional("MODERATION_UPLOADS_ENABLED");
if (
  moderationUploadsEnabledValue &&
  !["true", "false"].includes(moderationUploadsEnabledValue)
) {
  throw new Error("MODERATION_UPLOADS_ENABLED must be true or false.");
}
const moderationUploadsEnabled = moderationUploadsEnabledValue === "true";
const textModerationEnabledValue = optional("TEXT_MODERATION_ENABLED");
const conflictProtectionEnabledValue = optional("CONFLICT_PROTECTION_ENABLED");
if (
  (textModerationEnabledValue &&
    !["true", "false"].includes(textModerationEnabledValue)) ||
  (conflictProtectionEnabledValue &&
    !["true", "false"].includes(conflictProtectionEnabledValue))
) {
  throw new Error(
    "TEXT_MODERATION_ENABLED and CONFLICT_PROTECTION_ENABLED must be true or false.",
  );
}
const textModerationEnabled = textModerationEnabledValue === "true";
const conflictProtectionEnabled = conflictProtectionEnabledValue === "true";
if (textModerationEnabled && !grinModerationEnabled) {
  throw new Error(
    "TEXT_MODERATION_ENABLED requires GRIN_MODERATION_ENABLED=true for live-text review.",
  );
}
if (conflictProtectionEnabled && !textModerationEnabled) {
  throw new Error(
    "CONFLICT_PROTECTION_ENABLED requires TEXT_MODERATION_ENABLED=true.",
  );
}
const moderationServiceUrl = optional("MODERATION_SERVICE_URL");
const moderationDailyAnalysisLimit = positiveInteger(
  "MODERATION_DAILY_ANALYSIS_LIMIT",
  100,
);
const moderationHighThreshold = Number(
  optional("MODERATION_HIGH_THRESHOLD") || "90",
);
const moderationMediumThreshold = Number(
  optional("MODERATION_MEDIUM_THRESHOLD") || "50",
);
if (
  !Number.isFinite(moderationHighThreshold) ||
  moderationHighThreshold < 0 ||
  moderationHighThreshold > 100 ||
  !Number.isFinite(moderationMediumThreshold) ||
  moderationMediumThreshold < 0 ||
  moderationMediumThreshold > 100 ||
  moderationMediumThreshold >= moderationHighThreshold
) {
  throw new Error(
    "MODERATION_HIGH_THRESHOLD and MODERATION_MEDIUM_THRESHOLD must be percentages from 0 to 100, with medium below high.",
  );
}
if (moderationUploadsEnabled) {
  let parsedModerationServiceUrl;
  try {
    parsedModerationServiceUrl = new URL(moderationServiceUrl);
  } catch {
    throw new Error(
      "MODERATION_SERVICE_URL must be a valid HTTPS URL when MODERATION_UPLOADS_ENABLED=true.",
    );
  }
  if (
    parsedModerationServiceUrl.protocol !== "https:" ||
    !grinModerationWebhookSecret ||
    grinModerationWebhookSecret.length < 32
  ) {
    throw new Error(
      "MODERATION_UPLOADS_ENABLED requires HTTPS MODERATION_SERVICE_URL and a GRIN_MODERATION_WEBHOOK_SECRET of at least 32 characters.",
    );
  }
}
const grinModeratorIds = [
  ...new Set(
    optional("GRIN_MODERATOR_IDS")
      .split(",")
      .map((userId) => userId.trim())
      .filter(Boolean),
  ),
];
const adminEmail = (optional("ADMIN_EMAIL") || "administrateurquartierplus@gmail.com")
  .toLowerCase();
const supportNotifyEmail = optional("SUPPORT_NOTIFY_EMAIL").toLowerCase();
if (
  supportNotifyEmail &&
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportNotifyEmail)
) {
  throw new Error("SUPPORT_NOTIFY_EMAIL must be a valid email address.");
}
if (moderationUploadsEnabled || textModerationEnabled) {
  const supportEmailDeliveryReady =
    Boolean(supportNotifyEmail) &&
    Boolean(mailFrom || optional("EMAIL_FROM")) &&
    ((emailProvider === "smtp" && smtpConfigured) ||
      (emailProvider === "resend" && Boolean(optional("EMAIL_API_KEY"))));
  if (!supportEmailDeliveryReady) {
    throw new Error(
      "Enabled moderation features require SUPPORT_NOTIFY_EMAIL and a configured SMTP or Resend email provider.",
    );
  }
}
const adminUserIds = [
  ...new Set(
    optional("ADMIN_USER_IDS")
      .split(",")
      .map((userId) => userId.trim())
      .filter(Boolean),
  ),
].map((userId) => userId.toLowerCase());
const moderatorIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (grinModeratorIds.some((userId) => !moderatorIdPattern.test(userId))) {
  throw new Error("GRIN_MODERATOR_IDS must contain comma-separated user UUIDs.");
}
if (grinModerationEnabled && grinModeratorIds.length === 0) {
  throw new Error(
    "GRIN_MODERATOR_IDS is required when GRIN_MODERATION_ENABLED=true.",
  );
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
  throw new Error("ADMIN_EMAIL must be a valid email address.");
}
if (adminUserIds.some((userId) => !moderatorIdPattern.test(userId))) {
  throw new Error("ADMIN_USER_IDS must contain comma-separated user UUIDs.");
}
if (isProduction) {
  if (!googleClientId) {
    throw new Error("GOOGLE_CLIENT_ID is required in production.");
  }
}

const fedapayEnvironment = optional("FEDAPAY_ENVIRONMENT") || "sandbox";
if (!["sandbox", "live"].includes(fedapayEnvironment)) {
  throw new Error("FEDAPAY_ENVIRONMENT must be sandbox or live.");
}

export const env = Object.freeze({
  nodeEnv,
  port,
  databaseUrl,
  jwtSecret,
  jwtExpiresIn: optional("JWT_EXPIRES_IN") || "7d",
  googleClientId,
  googleClientIds: [
    googleClientId,
    ...optional("GOOGLE_CLIENT_IDS")
      .split(",")
      .map((clientId) => clientId.trim()),
  ].filter((clientId, index, all) => clientId && all.indexOf(clientId) === index),
  otpTestMode,
  otpTestAllowlist,
  smsDeliveryUrl,
  smsDeliveryToken,
  emailProvider,
  emailApiKey: optional("EMAIL_API_KEY"),
  emailFrom: mailFrom || optional("EMAIL_FROM"),
  smtpHost,
  smtpPort,
  smtpUser,
  smtpPass,
  smtpConfigured,
  smtpPartiallyConfigured,
  adminTestEmailToken,
  adminEmail,
  adminUserIds,
  livekitApiKey,
  livekitApiSecret,
  livekitUrl,
  livekitConfigurationIsUsable,
  livekitConfigurationProblems,
  livekitConfigurationProblemDetails,
  grinModerationEnabled,
  grinModerationWebhookSecret,
  grinModeratorIds,
  moderationUploadsEnabled,
  textModerationEnabled,
  conflictProtectionEnabled,
  moderationServiceUrl,
  moderationDailyAnalysisLimit,
  moderationHighThreshold,
  moderationMediumThreshold,
  supportNotifyEmail,
  fedapaySecretKey: optional("FEDAPAY_SECRET_KEY"),
  fedapayPublicKey: optional("FEDAPAY_PUBLIC_KEY"),
  fedapayEnvironment,
  fedapayWebhookSecret: optional("FEDAPAY_WEBHOOK_SECRET"),
  ticketQrSecret: ticketQrSecret || jwtSecret,
  cloudinaryCloudName,
  cloudinaryApiKey,
  cloudinaryApiSecret,
  postMaxPhotoBytes: positiveInteger("POST_MAX_PHOTO_BYTES", 10 * 1024 * 1024),
  postMaxVideoSeconds: positiveInteger("POST_MAX_VIDEO_SECONDS", 420),
  postMaxVideoBytes: positiveInteger("POST_MAX_VIDEO_BYTES", 100 * 1024 * 1024),
  postDailyLimit: positiveInteger("POST_DAILY_LIMIT", 10),
  isPromoFreeAccess: promoFreeAccessValue === "true",
  billingEnabled: billingEnabledValue === "true",
  proEnabled: proEnabledValue === "true",
  voyageEnabled,
  voyageDemoData: voyageDemoDataValue === "true",
  ticketSigningPrivateKeyB64,
  ticketSigningKid: optional("TICKET_SIGNING_KID") || "v1",
  proAdminToken: optional("PRO_ADMIN_TOKEN"),
  pgSsl: pgSslValue === "true",
  socketCorsOrigins: optional("SOCKET_CORS_ORIGIN")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
});
