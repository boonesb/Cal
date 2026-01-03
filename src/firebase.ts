import { FirebaseApp, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

let app: FirebaseApp | null = null;

export const getFirebaseApp = (): FirebaseApp => {
  if (!app) {
    Object.entries(firebaseConfig).forEach(([key, value]) => {
      if (!value) console.warn(`Missing Firebase config value for ${key}.`);
    });
    app = initializeApp(firebaseConfig);
  }
  return app;
};

export const firebaseApp = getFirebaseApp();
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);

// Optional: only log in dev
if (import.meta.env.DEV) {
  console.log("LIVE projectId:", firebaseApp.options.projectId);
  console.log("LIVE authDomain:", firebaseApp.options.authDomain);
}
