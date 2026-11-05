import { rateLimit } from "express-rate-limit";

const createLimiter = (windowMs, limit, error) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error },
  });

export const accountDataRateLimit = createLimiter(
  60 * 60 * 1000,
  5,
  "Trop de demandes d’export ou de suppression. Réessayez plus tard.",
);

export const mediaSignatureRateLimit = createLimiter(
  60 * 60 * 1000,
  30,
  "Trop de demandes de téléversement. Réessayez plus tard.",
);

export const paymentRateLimit = createLimiter(
  60 * 60 * 1000,
  10,
  "Trop de demandes de paiement. Réessayez plus tard.",
);
