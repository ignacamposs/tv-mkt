import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, initializeFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const existingDefault = getApps().find((a) => a.name === '[DEFAULT]');
const app = existingDefault ? getApp() : initializeApp(firebaseConfig);

export const db = existingDefault
  ? getFirestore(app)
  : initializeFirestore(app, { experimentalForceLongPolling: true });

export const auth = getAuth(app);

// Instancia secundaria para que la agencia cree usuarios de comercios sin cerrar su propia sesión
const SECONDARY_APP_NAME = 'SecondaryClientCreator';
const existingSecondary = getApps().find((a) => a.name === SECONDARY_APP_NAME);
const secondaryApp = existingSecondary
  ? getApp(SECONDARY_APP_NAME)
  : initializeApp(firebaseConfig, SECONDARY_APP_NAME);

export const secondaryAuth = getAuth(secondaryApp);