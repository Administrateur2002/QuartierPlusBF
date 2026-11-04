import nodemailer from "nodemailer";
import { env } from "../config/env.js";

const smtpTransporter = env.smtpConfigured
  ? nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpPort === 465,
      auth: { user: env.smtpUser, pass: env.smtpPass },
      connectionTimeout: 8_000,
      greetingTimeout: 8_000,
      socketTimeout: 8_000,
    })
  : null;

const providers = {
  smtp: async ({ from, to, code, expiresInMinutes }) => {
    await smtpTransporter.sendMail({
      from,
      to,
      subject: "Votre code de vérification QuartierPlus",
      text: `Votre code QuartierPlus est ${code}. Il expire dans ${expiresInMinutes} minutes.`,
    });
  },
  resend: async ({ apiKey, from, to, code, expiresInMinutes }) => {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: "Votre code de vérification QuartierPlus",
        text: `Votre code QuartierPlus est ${code}. Il expire dans ${expiresInMinutes} minutes.`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Échec de livraison e-mail (${response.status}).`);
    }
  },
};

export const verifySmtpTransport = async () => {
  if (!env.smtpConfigured) {
    const message = env.smtpPartiallyConfigured
      ? "SMTP incomplet; vérifiez SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS et MAIL_FROM."
      : "SMTP non configuré; vérification ignorée.";
    console.warn(message);
    return false;
  }
  try {
    await smtpTransporter.verify();
    console.info(`SMTP prêt (${env.smtpHost}:${env.smtpPort}).`);
    return true;
  } catch (error) {
    console.error("Échec de vérification SMTP :", error.code || error.message);
    return false;
  }
};

export const sendSmtpDiagnosticEmail = async (to) => {
  if (!smtpTransporter) throw new Error("SMTP n'est pas entièrement configuré.");
  await smtpTransporter.sendMail({
    from: env.emailFrom,
    to,
    subject: "Test SMTP QuartierPlus",
    text: "Le transport SMTP de QuartierPlus fonctionne.",
  });
};

export const sendSupportNotification = async (subject, text) => {
  if (!env.supportNotifyEmail) {
    throw new Error("SUPPORT_NOTIFY_EMAIL n'est pas configurée.");
  }
  if (env.emailProvider === "smtp" && smtpTransporter) {
    await smtpTransporter.sendMail({
      from: env.emailFrom,
      to: env.supportNotifyEmail,
      subject,
      text,
    });
    return;
  }
  if (
    env.emailProvider === "resend" &&
    env.emailApiKey &&
    env.emailFrom
  ) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.emailApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.emailFrom,
        to: [env.supportNotifyEmail],
        subject,
        text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Échec de livraison e-mail (${response.status}).`);
    }
    return;
  }
  throw new Error("Aucun fournisseur e-mail n'est configuré pour le support.");
};

export const isEmailDeliveryConfigured = (configuration) =>
  Boolean(
    configuration.emailProvider &&
      configuration.emailFrom &&
      typeof providers[configuration.emailProvider] === "function" &&
      (configuration.emailProvider === "smtp"
        ? configuration.smtpConfigured
        : configuration.emailApiKey),
  );

export const deliverVerificationEmail = async (configuration, to, code, ttl) => {
  const provider = providers[configuration.emailProvider];
  if (!provider || !isEmailDeliveryConfigured(configuration)) {
    throw new Error("L'envoi par e-mail n'est pas configuré.");
  }
  await provider({
    apiKey: configuration.emailApiKey,
    from: configuration.emailFrom,
    to,
    code,
    expiresInMinutes: ttl,
  });
};
