import { GoogleAuth } from "google-auth-library";
import { join } from "path";

// Sends push notifications via Firebase Cloud Messaging's HTTP v1 API using
// a service account key (see README for how to obtain one). Setup:
//   Firebase console → Project settings → Service accounts → Generate new
//   private key → save as secrets/firebase-adminsdk.json (gitignored).

const KEY_PATH = join(process.cwd(), "secrets/firebase-adminsdk.json");

let auth: GoogleAuth | null = null;
let projectId: string | null = null;

async function getAuth(): Promise<{ auth: GoogleAuth; projectId: string } | null> {
  if (!(await Bun.file(KEY_PATH).exists())) return null;
  if (!auth) {
    auth = new GoogleAuth({
      keyFile: KEY_PATH,
      scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
    });
    const key = JSON.parse(await Bun.file(KEY_PATH).text());
    projectId = key.project_id;
  }
  return { auth, projectId: projectId! };
}

// Sends a notification to a single device token. Best-effort: logs and
// swallows errors (an unreachable/expired token shouldn't break the caller's
// request, e.g. someone flipping their availability).
//
// `imageUrl` must be publicly reachable without auth — the receiving device
// downloads it itself (FCM only passes the URL along), so a session-gated
// URL would silently render no image.
export async function sendPushNotification(
  deviceToken: string,
  title: string,
  body: string,
  imageUrl?: string | null
): Promise<void> {
  try {
    const ctx = await getAuth();
    if (!ctx) {
      console.warn("FCM not configured (no secrets/firebase-adminsdk.json) — skipping push");
      return;
    }
    const client = await ctx.auth.getClient();
    const accessToken = await client.getAccessToken();

    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${ctx.projectId}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            notification: { title, body, ...(imageUrl ? { image: imageUrl } : {}) },
          },
        }),
      }
    );
    if (!res.ok) {
      console.error("FCM send failed:", res.status, await res.text());
    }
  } catch (e) {
    console.error("FCM send error:", e);
  }
}
