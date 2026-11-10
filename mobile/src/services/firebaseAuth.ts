import {
  createUserWithEmailAndPassword,
  getAuth,
  signInWithPhoneNumber,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  type ConfirmationResult,
  type User,
} from "@react-native-firebase/auth";
import api from "./api";
import type { AuthUser } from "../context/AuthContext";

export type FirebaseRegistration = {
  first_name?: string;
  last_name?: string;
  terms_accepted: boolean;
  age_16_or_older: boolean;
  auth_flow?: "login" | "register";
};

export type FirebaseSessionResult =
  | { kind: "session"; token: string; user: AuthUser }
  | { kind: "email-verification-required" };

export const getFirebaseUser = () => getAuth().currentUser;

export const requestFirebasePhoneCode = (phoneNumber: string) =>
  signInWithPhoneNumber(getAuth(), phoneNumber);

export const confirmFirebasePhoneCode = async (
  confirmation: ConfirmationResult,
  code: string,
) => {
  const credential = await confirmation.confirm(code);
  if (!credential?.user) throw new Error("Firebase n’a pas confirmé le numéro.");
  return credential.user;
};

export const isStrongPassword = (password: string) => {
  const trimmed = password.trim();
  const hasLength = trimmed.length >= 8;
  const hasUppercase = /[A-Z]/.test(trimmed);
  const hasLowercase = /[a-z]/.test(trimmed);
  const hasDigit = /\d/.test(trimmed);
  const hasSymbol = /[^A-Za-z0-9]/.test(trimmed);
  return hasLength && hasUppercase && hasLowercase && hasDigit && hasSymbol;
};

export const exchangeFirebaseSession = async (
  firebaseUser: User,
  registration?: FirebaseRegistration,
): Promise<FirebaseSessionResult> => {
  const idToken = await firebaseUser.getIdToken();
  const { data } = await api.post("/api/v1/auth/firebase", {
    id_token: idToken,
    ...(registration ?? {}),
  });

  if (data?.email_verification_required === true) {
    return { kind: "email-verification-required" };
  }
  const user = data?.user as AuthUser | undefined;
  if (
    typeof data?.token !== "string" ||
    !user ||
    typeof user.id !== "string"
  ) {
    throw new Error("La réponse d’authentification du serveur est invalide.");
  }
  return { kind: "session", token: data.token, user };
};

export const registerWithEmailPassword = async (
  email: string,
  password: string,
  legalRegistration?: Pick<FirebaseRegistration, "terms_accepted" | "age_16_or_older">,
) => {
  const trimmedEmail = email.trim().toLowerCase();
  const credential = await createUserWithEmailAndPassword(
    getAuth(),
    trimmedEmail,
    password,
  );
  if (credential.user) {
    await sendEmailVerification(credential.user);
  }
  return credential.user;
};

export const signInWithEmailPassword = async (email: string, password: string) => {
  const trimmedEmail = email.trim().toLowerCase();
  const credential = await signInWithEmailAndPassword(
    getAuth(),
    trimmedEmail,
    password,
  );
  return credential.user;
};

export const resendEmailVerification = async (user?: User | null) => {
  const activeUser = user ?? getFirebaseUser();
  if (!activeUser) throw new Error("Aucun utilisateur Firebase actif.");
  await sendEmailVerification(activeUser);
};

export const resetPasswordForEmail = async (email: string) => {
  await sendPasswordResetEmail(getAuth(), email.trim().toLowerCase());
};

export const firebaseAuthErrorMessage = (error: unknown) => {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  const messages: Record<string, string> = {
    "auth/account-exists-with-different-credential":
      "Un compte existe déjà avec une autre méthode. Connectez-vous avec cette méthode puis associez vos fournisseurs.",
    "auth/credential-already-in-use":
      "Cette méthode d’authentification est déjà liée à un autre compte.",
    "auth/email-already-in-use":
      "Cette adresse e-mail est déjà utilisée. Essayez de vous connecter.",
    "auth/invalid-credential": "Les identifiants sont invalides ou expirés.",
    "auth/invalid-email": "Saisissez une adresse e-mail valide.",
    "auth/invalid-phone-number":
      "Saisissez un numéro valide au format international, avec son indicatif.",
    "auth/invalid-verification-code": "Le code saisi est incorrect.",
    "auth/network-request-failed":
      "Connexion réseau indisponible. Vérifiez votre accès à Internet puis réessayez.",
    "auth/operation-not-allowed":
      "Cette méthode n’est pas activée dans Firebase Authentication.",
    "auth/quota-exceeded":
      "La limite Firebase est atteinte. Réessayez plus tard.",
    "auth/session-expired":
      "Le code a expiré. Demandez un nouveau code de vérification.",
    "auth/too-many-requests":
      "Trop de tentatives. Attendez avant de réessayer.",
    "auth/user-disabled":
      "Ce compte est désactivé. Contactez l’assistance QuartierPlus.",
    "auth/user-not-found":
      "Aucun compte ne correspond à ces identifiants.",
    "auth/weak-password":
      "Choisissez un mot de passe plus robuste, avec au moins 8 caractères.",
    "auth/wrong-password": "Le mot de passe saisi est incorrect.",
  };
  if (messages[code]) return messages[code];
  if (error instanceof Error && /email.*verif/i.test(error.message)) {
    return "Confirmez votre adresse e-mail avant de continuer.";
  }
  return "L’authentification a échoué. Vérifiez votre connexion puis réessayez.";
};