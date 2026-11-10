import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { env } from "../config/env.js";

const APP_NAME = "quartierplus-auth";
const projectId = env.firebaseProjectId || process.env.FIREBASE_PROJECT_ID;

export const getFirebaseAdminAuth = () => {
  if (!projectId) {
    throw Object.assign(new Error("Firebase Admin n’est pas configuré."), {
      code: "FIREBASE_PROJECT_ID_MISSING",
    });
  }

  let app = getApps().find((candidate) => candidate.name === APP_NAME);
  if (!app) {
    const serviceAccountValue = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
    let credential = applicationDefault();

    if (serviceAccountValue) {
      let serviceAccount;
      try {
        serviceAccount = JSON.parse(serviceAccountValue);
      } catch {
        throw Object.assign(
          new Error("FIREBASE_SERVICE_ACCOUNT_JSON n’est pas un JSON valide."),
          { code: "FIREBASE_CREDENTIALS_INVALID" },
        );
      }
      if (serviceAccount.project_id !== projectId) {
        throw Object.assign(
          new Error("Le compte de service Firebase ne correspond pas au projet configuré."),
          { code: "FIREBASE_PROJECT_MISMATCH" },
        );
      }
      credential = cert(serviceAccount);
    }

    app = initializeApp({ credential, projectId }, APP_NAME);
  }

  if (app.options.projectId !== projectId) {
    throw Object.assign(
      new Error("L’application Firebase Admin utilise un autre projet."),
      { code: "FIREBASE_PROJECT_MISMATCH" },
    );
  }

  return getAuth(app);
};

export const verifyFirebaseIdToken = async (idToken) =>
  getFirebaseAdminAuth().verifyIdToken(idToken, true);