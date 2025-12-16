import { FirebaseApp, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

let app: FirebaseApp | null = null;

export const getFirebaseApp = () => {
  if (!app) {
    Object.entries(firebaseConfig).forEach(([key, value]) => {
      if (!value) {
        console.warn(`Missing Firebase config value for ${key}.`);
      }
    });
    app = initializeApp(firebaseConfig);
  }
  return app;
};

export const auth = getAuth(getFirebaseApp());
export const db = getFirestore(getFirebaseApp());
const a = getFirebaseApp();
console.log("Firebase projectId (live):", a.options.projectId);
console.log("Firebase authDomain (live):", a.options.authDomain);

