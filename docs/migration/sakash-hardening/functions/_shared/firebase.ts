// Deno (Supabase Edge Functions) helpers for Firebase. Not unit-tested: they need a real Firebase project.
// Required function secrets: FIREBASE_PROJECT_ID, FIREBASE_SERVICE_ACCOUNT (the service-account JSON, as text),
// PAYSTACK_SECRET_KEY. The service account needs the "Cloud Datastore User" role and nothing else.
import { SignJWT, createRemoteJWKSet, importPKCS8, jwtVerify } from "npm:jose@5.9.6";
import { decodeFields, encodeFields, type FsFields } from "./firestore.ts";

const projectId = () => Deno.env.get("FIREBASE_PROJECT_ID")!;
const base = () => `https://firestore.googleapis.com/v1/projects/${projectId()}/databases/(default)/documents`;

const jwks = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));

/** The signed-in customer, from the Firebase ID token the app sends. Throws if it is invalid, expired or for another project. */
export async function verifyIdToken(token: string): Promise<{ uid: string; email: string }> {
  const { payload } = await jwtVerify(token, jwks, { issuer: `https://securetoken.google.com/${projectId()}`, audience: projectId(), algorithms: ["RS256"] });
  if (!payload.sub || typeof payload.email !== "string") throw new Error("token has no subject or email");
  return { uid: payload.sub, email: payload.email };
}

let cached: { token: string; exp: number } | null = null;
async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const sa = JSON.parse(Deno.env.get("FIREBASE_SERVICE_ACCOUNT")!);
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/datastore" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.client_email).setSubject(sa.client_email).setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now).setExpirationTime(now + 3600)
    .sign(await importPKCS8(sa.private_key, "RS256"));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
  const j = await res.json();
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

export async function getDoc(path: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${base()}/${path}`, { headers: { authorization: `Bearer ${await accessToken()}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore read ${path} failed (${res.status})`);
  const d = await res.json();
  return decodeFields((d.fields ?? {}) as FsFields);
}

export interface Write {
  path: string;
  set?: Record<string, unknown>;           // fields to write (merged into an existing document)
  mustNotExist?: boolean;                  // create only: fails if the document already exists
  mustExist?: boolean;
}

/** Applies writes together or not at all. */
export async function commit(writes: Write[]): Promise<void> {
  const name = (p: string) => `projects/${projectId()}/databases/(default)/documents/${p}`;
  const body = {
    writes: writes.map((w) => ({
      update: { name: name(w.path), fields: encodeFields(w.set ?? {}) },
      updateMask: { fieldPaths: Object.keys(w.set ?? {}).map((k) => "`" + k.replace(/`/g, "") + "`") },
      ...(w.mustNotExist ? { currentDocument: { exists: false } } : w.mustExist ? { currentDocument: { exists: true } } : {}),
    })),
  };
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${projectId()}/databases/(default)/documents:commit`, {
    method: "POST",
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    const e = new Error(`Firestore commit failed (${res.status})`) as Error & { conflict?: boolean };
    e.conflict = res.status === 409 || res.status === 400 && /ALREADY_EXISTS|already exists/i.test(text);
    throw e;
  }
}
