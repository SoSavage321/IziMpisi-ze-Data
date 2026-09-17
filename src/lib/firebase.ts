/**
 * Firebase client.
 *
 * Two databases, on purpose:
 *
 *   Realtime Database — live telemetry, device state and the command queue.
 *     A device reports every 5 seconds; three of them is ~52,000 writes a day,
 *     which is far past Firestore's free daily write allowance but nothing to
 *     RTDB, which bills bandwidth rather than writes. It also gives the ESP32
 *     the simplest possible client: an authenticated REST PUT.
 *
 *   Firestore — batches, treatment cycles, alarms, configuration history,
 *     maintenance, stock, shift logs and the audit trail. These are the
 *     records the compliance report is built from, and they need real
 *     queries: date ranges, ordering, filtering by result.
 *
 * The web API key is not a secret. It identifies the project; access is decided
 * by the security rules in firebase/firestore.rules and database.rules.json.
 */

import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { getDatabase, type Database } from 'firebase/database';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

/** True when the app is configured to talk to a real Firebase project. */
export const isFirebase = Boolean(config.apiKey && config.projectId && config.databaseURL);

let app: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let dbInstance: Firestore | null = null;
let rtdbInstance: Database | null = null;

function ensure(): FirebaseApp {
  if (!isFirebase) {
    throw new Error(
      'Firebase is not configured. Copy .env.example to .env and fill in the VITE_FIREBASE_* values.',
    );
  }
  if (!app) app = initializeApp(config as Required<typeof config>);
  return app;
}

export function fbAuth(): Auth {
  if (!authInstance) authInstance = getAuth(ensure());
  return authInstance;
}

export function fbStore(): Firestore {
  if (!dbInstance) dbInstance = getFirestore(ensure());
  return dbInstance;
}

export function fbRtdb(): Database {
  if (!rtdbInstance) rtdbInstance = getDatabase(ensure());
  return rtdbInstance;
}

/** Where each kind of record lives. Imported by the backend and the seed script. */
export const COL = {
  orgs: 'orgs',
  sites: 'sites',
  devices: 'devices',
  profiles: 'profiles',
  deviceConfig: 'deviceConfig',
  batches: 'batches',
  cycles: 'cycles',
  alarms: 'alarms',
  events: 'events',
  commands: 'commands',
  maintenanceItems: 'maintenanceItems',
  maintenanceLogs: 'maintenanceLogs',
  inventory: 'inventory',
  inventoryMovements: 'inventoryMovements',
  shiftLogs: 'shiftLogs',
  auditLog: 'auditLog',
  notificationPrefs: 'notificationPrefs',
} as const;

/** Realtime Database paths, shared with the firmware. */
export const RTDB = {
  live: (deviceId: string) => `live/${deviceId}`,
  telemetry: (deviceId: string) => `telemetry/${deviceId}`,
  commands: (deviceId: string) => `commands/${deviceId}`,
  config: (deviceId: string) => `deviceConfig/${deviceId}`,
} as const;
