import { Hono } from "hono";
import { join } from "path";
import { mkdir, unlink } from "fs/promises";
import type { Session } from "./tools/auth.ts";
import { createSession } from "./tools/auth.ts";
import { exposePrismaCRUD, prisma } from "./tools/prisma.ts";
import { handleFileUpload } from "./tools/fileUpload.ts";
import { handlePrismaError, PermissionResult } from "./tools/createCRUD.ts";
import { sendPushNotification } from "./tools/fcm.ts";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";

// Where this server is reachable from the public internet. Only needed to
// build absolute avatar URLs for push notifications — the receiving device
// downloads the image itself, so a relative path is useless there. The API
// hands relative paths to the app, which resolves them against whatever
// base URL it was pointed at, so local dev works without setting this.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "https://hangout.msouthwick.com")
  .replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// Profile pictures
// ---------------------------------------------------------------------------
// Stored outside ./public (which is bind-mounted for APK distribution) and
// served by GET /avatars/:filename instead. That route is public rather than
// session-gated on purpose: Android downloads the image in a push
// notification itself, with no auth header to give it.
const AVATARS_DIR = "./uploads/avatars";
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

await mkdir(AVATARS_DIR, { recursive: true }).catch(() => {});

const AVATAR_CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

// Identifies the image format from its magic bytes rather than trusting the
// upload's declared Content-Type. These files get served back to everyone on
// a public URL, so a mislabeled upload (e.g. HTML claiming to be a JPEG)
// shouldn't be able to decide what we serve it as.
function detectImageExtension(bytes: Uint8Array): string | null {
  const startsWith = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (bytes.length >= 3 && startsWith(0xff, 0xd8, 0xff)) return ".jpg";
  if (bytes.length >= 8 && startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return ".png";
  if (
    bytes.length >= 12 &&
    startsWith(0x52, 0x49, 0x46, 0x46) && // "RIFF"
    [0x57, 0x45, 0x42, 0x50].every((b, i) => bytes[8 + i] === b) // "WEBP"
  ) {
    return ".webp";
  }
  return null;
}

// The path the app stores/renders, resolved against whichever backend it's
// pointed at. Absolute form (for push notifications) is built separately
// with PUBLIC_BASE_URL.
function avatarPath(filename: string | null): string | null {
  return filename ? `/avatars/${filename}` : null;
}

// ---------------------------------------------------------------------------
// App-user helpers — link a login session (keyed by email) to the app's own
// Prisma `User` row (phone number, availability, friendships live there).
// ---------------------------------------------------------------------------
async function getOrCreateAppUser(email: string, name: string | undefined) {
  return prisma.user.upsert({
    where: { email },
    // Never touch `name` on an existing row — the user may have set their
    // own display name in Settings, and re-signing in with Google shouldn't
    // clobber it back to whatever Google has on file.
    update: {},
    create: { email, name },
  });
}

// Normalizes phone numbers so "(555) 123-4567", "555-123-4567", and
// "+15551234567" all match the same stored/looked-up value, regardless of
// how a friend typed it in. Best-effort (assumes US/Canada when no country
// code is given) — good enough for matching within a friend group without
// pulling in a full phone-number-parsing library.
//
// Exported so `tools/backfillPhoneNumbers.ts` can re-normalize phone numbers
// that were stored before this normalization existed (raw/exact-match rows
// from before e9a9f13) — matching only works if both sides funnel through
// the same function, and old rows never got the chance to.
export function normalizePhoneNumber(raw: string): string {
  const hasPlus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (hasPlus) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return "+" + digits;
}

// Looks up a value from the `Config` table (see prisma/schema.prisma) — a
// flat key/value store for small bits of server-controlled copy the app
// needs (e.g. `share_text`, the invite message shown when a searched phone
// number doesn't belong to any user yet). Returns null if the key hasn't
// been set.
async function getConfigValue(key: string): Promise<string | null> {
  const row = await prisma.config.findUnique({ where: { key } });
  return row?.value ?? null;
}

// Pushes to every accepted friend who has notifications turned on for this
// user, using their custom availabilityMessage if they've set one (falls
// back to a sensible default). Best-effort — errors are logged by
// sendPushNotification itself and never propagate to the caller.
async function notifyFriendsOfAvailability(user: {
  id: number;
  name: string | null;
  availabilityMessage: string | null;
  avatarFilename: string | null;
}): Promise<void> {
  const body = (user.availabilityMessage && user.availabilityMessage.trim())
    ? user.availabilityMessage.trim()
    : `${user.name ?? "A friend"} is available to hang out!`;
  // Absolute, because the receiving device fetches this itself.
  const imageUrl = user.avatarFilename
    ? `${PUBLIC_BASE_URL}${avatarPath(user.avatarFilename)}`
    : null;
  const friendships = await prisma.friendship.findMany({
    where: { status: "ACCEPTED", OR: [{ requesterId: user.id }, { addresseeId: user.id }] },
    include: { requester: true, addressee: true },
  });
  for (const f of friendships) {
    const iAmRequester = f.requesterId === user.id;
    const friend = iAmRequester ? f.addressee : f.requester;
    const theyWantToBeNotifiedAboutMe = iAmRequester ? f.addresseeNotify : f.requesterNotify;
    if (theyWantToBeNotifiedAboutMe && friend.fcmToken) {
      await sendPushNotification(friend.fcmToken, "Hangout", body, imageUrl);
    }
  }
}

function getSessionUserId(c: any): number | null {
  const session = c.get("session") as Session | undefined;
  const userId = session?.db?.userId;
  return typeof userId === "number" ? userId : null;
}

function serializeUser(user: {
  id: number;
  email: string;
  name: string | null;
  phoneNumber: string | null;
  availableForHangout: boolean;
  availabilityMessage: string | null;
  avatarFilename: string | null;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phoneNumber: user.phoneNumber,
    availableForHangout: user.availableForHangout,
    availabilityMessage: user.availabilityMessage,
    avatarUrl: avatarPath(user.avatarFilename),
  };
}

export function publicRoutes(app: Hono): void {
  app.get("/hello", (c) => c.json({ message: "Hello World" }));

  // Profile pictures. Public (no session) because a device rendering a push
  // notification downloads the image with no way to authenticate — see
  // AVATARS_DIR above. Filenames are unguessable UUIDs.
  app.get("/avatars/:filename", async (c) => {
    const filename = c.req.param("filename");
    // Only ever match the shape we generate — no slashes or dots to walk out
    // of the avatars directory with.
    const match = /^[0-9a-f-]{36}(\.jpg|\.png|\.webp)$/.exec(filename);
    if (!match) return c.json({ error: "Not found" }, 404);

    const file = Bun.file(join(AVATARS_DIR, filename));
    if (!(await file.exists())) return c.json({ error: "Not found" }, 404);

    return new Response(file, {
      headers: {
        "Content-Type": AVATAR_CONTENT_TYPES[match[1]!]!,
        // A new upload always gets a new filename, so these bytes never
        // change — worth caching hard on devices and in notification trays.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  });

  app.post("/file-upload", async (c) => {
    const result = await handleFileUpload(c);
    console.log("File upload result:", result);
    return "error" in result ? c.json(result, 400) : c.json(result, 201);
  });

  app.post("/json", async (c) => {
    const data = await c.req.json();
    console.log("Received JSON:", data);
    return c.json({ received: data });
  });

  // Native mobile "Sign in with Google" — the Flutter app runs the on-device
  // Google Sign-In flow itself and hands us the resulting ID token, instead
  // of going through the browser-redirect flows in tools/auth.ts.
  app.post("/auth/mobile/google", async (c) => {
    if (!GOOGLE_CLIENT_ID) {
      return c.json(
        {
          error: "Google sign-in not configured",
          hint: "Set GOOGLE_CLIENT_ID (a Google Cloud 'Web application' OAuth client id) in .env",
        },
        503,
      );
    }
    try {
      const { idToken } = await c.req.json<{ idToken: string }>();
      if (!idToken) return c.json({ error: "idToken is required" }, 400);

      const res = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`,
      );
      if (!res.ok) return c.json({ error: "Invalid Google token" }, 401);
      const payload = (await res.json()) as Record<string, unknown>;
      if (payload.aud !== GOOGLE_CLIENT_ID) {
        return c.json({ error: "Token audience mismatch" }, 401);
      }

      const email = payload.email as string;
      const name = (payload.name as string) || email;
      const appUser = await getOrCreateAppUser(email, name);

      const session: Session = {
        user: undefined as any,
        username: name,
        email,
        google_data: payload,
        photoUrl: (payload.picture as string) || null,
        db: { userId: appUser.id },
      };
      const token = await createSession(c, session, email);
      return c.json({ token, user: serializeUser(appUser) });
    } catch (e) {
      console.error("Mobile Google sign-in error:", e);
      return c.json({ error: "Google authentication failed" }, 401);
    }
  });
}

export function privateRoutes(app: Hono): void {
  app.get("/user", (c) => {
    const session = (c as any).get("session") as Session;
    return c.json(
      session.cas_data || session.google_data || session.microsoft_data || {},
    );
  });

  // Note: the old `/friends/:userId` route (list *any* user's friends, no
  // ownership check) has been replaced by the session-scoped `/friends`
  // below — it let any logged-in caller enumerate any other user's friend
  // list, which isn't something we want once this holds real people's data.

  // -------------------------------------------------------------------------
  // "Me" — the current app user
  // -------------------------------------------------------------------------
  app.get("/me", async (c) => {
    const userId = getSessionUserId(c);
    if (!userId) return c.json({ error: "No linked app user" }, 404);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return c.json({ error: "No linked app user" }, 404);
    return c.json(serializeUser(user));
  });

  app.put("/me/phone", async (c) => {
    const userId = getSessionUserId(c);
    if (!userId) return c.json({ error: "No linked app user" }, 404);
    try {
      const { phoneNumber } = await c.req.json<{ phoneNumber?: string }>();
      if (!phoneNumber || !phoneNumber.trim()) {
        return c.json({ error: "phoneNumber is required" }, 400);
      }
      const normalized = normalizePhoneNumber(phoneNumber);
      if (normalized.replace(/\D/g, "").length < 7) {
        return c.json({ error: "Please enter a valid phone number" }, 400);
      }
      const user = await prisma.user.update({
        where: { id: userId },
        data: { phoneNumber: normalized },
      });
      return c.json(serializeUser(user));
    } catch (error) {
      if (error instanceof SyntaxError) {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      return handlePrismaError(c, error);
    }
  });

  app.put("/me/name", async (c) => {
    const userId = getSessionUserId(c);
    if (!userId) return c.json({ error: "No linked app user" }, 404);
    try {
      const { name } = await c.req.json<{ name?: string }>();
      const trimmed = name?.trim();
      if (!trimmed) {
        return c.json({ error: "name is required" }, 400);
      }
      if (trimmed.length > 60) {
        return c.json({ error: "name must be 60 characters or fewer" }, 400);
      }
      const user = await prisma.user.update({
        where: { id: userId },
        data: { name: trimmed },
      });
      return c.json(serializeUser(user));
    } catch (error) {
      if (error instanceof SyntaxError) {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      return handlePrismaError(c, error);
    }
  });

  app.put("/me/availability", async (c) => {
    const userId = getSessionUserId(c);
    if (!userId) return c.json({ error: "No linked app user" }, 404);
    try {
      const { available } = await c.req.json<{ available?: boolean }>();
      if (typeof available !== "boolean") {
        return c.json({ error: "available (boolean) is required" }, 400);
      }
      const previous = await prisma.user.findUnique({ where: { id: userId } });
      const user = await prisma.user.update({
        where: { id: userId },
        data: { availableForHangout: available },
      });
      if (available && !previous?.availableForHangout) {
        notifyFriendsOfAvailability(user).catch((e) =>
          console.error("Failed to notify friends of availability:", e)
        );
      }
      return c.json(serializeUser(user));
    } catch (error) {
      if (error instanceof SyntaxError) {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      return handlePrismaError(c, error);
    }
  });

  app.put("/me/fcm-token", async (c) => {
    const userId = getSessionUserId(c);
    if (!userId) return c.json({ error: "No linked app user" }, 404);
    try {
      const { fcmToken } = await c.req.json<{ fcmToken?: string }>();
      if (!fcmToken || !fcmToken.trim()) {
        return c.json({ error: "fcmToken is required" }, 400);
      }
      await prisma.user.update({ where: { id: userId }, data: { fcmToken } });
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof SyntaxError) {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      return handlePrismaError(c, error);
    }
  });

  // Profile picture upload — multipart/form-data with a `file` field. The
  // app crops and downscales before sending, so there's no server-side image
  // processing here, just format/size validation.
  app.put("/me/avatar", async (c) => {
    const userId = getSessionUserId(c);
    if (!userId) return c.json({ error: "No linked app user" }, 404);
    try {
      const formData = await c.req.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return c.json(
          { error: "No file provided. Send a multipart/form-data request with a 'file' field." },
          400,
        );
      }
      if (file.size > MAX_AVATAR_BYTES) {
        return c.json({ error: "Image is too large (5 MB max)" }, 400);
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const ext = detectImageExtension(bytes);
      if (!ext) {
        return c.json({ error: "Unsupported image format — use JPEG, PNG, or WebP" }, 400);
      }

      const previous = await prisma.user.findUnique({
        where: { id: userId },
        select: { avatarFilename: true },
      });

      // New random filename per upload, so the old URL is never reused and
      // the immutable caching on GET /avatars/:filename stays honest.
      const filename = `${crypto.randomUUID()}${ext}`;
      await Bun.write(join(AVATARS_DIR, filename), bytes);

      const user = await prisma.user.update({
        where: { id: userId },
        data: { avatarFilename: filename },
      });

      if (previous?.avatarFilename) {
        await unlink(join(AVATARS_DIR, previous.avatarFilename)).catch(() => {});
      }
      return c.json(serializeUser(user));
    } catch (error) {
      return handlePrismaError(c, error);
    }
  });

  app.put("/me/availability-message", async (c) => {
    const userId = getSessionUserId(c);
    if (!userId) return c.json({ error: "No linked app user" }, 404);
    try {
      const { availabilityMessage } = await c.req.json<{ availabilityMessage?: string | null }>();
      const trimmed = availabilityMessage?.trim() || null;
      if (trimmed && trimmed.length > 200) {
        return c.json({ error: "availabilityMessage must be 200 characters or fewer" }, 400);
      }
      const user = await prisma.user.update({
        where: { id: userId },
        data: { availabilityMessage: trimmed },
      });
      return c.json(serializeUser(user));
    } catch (error) {
      if (error instanceof SyntaxError) {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      return handlePrismaError(c, error);
    }
  });

  // -------------------------------------------------------------------------
  // Friends
  // -------------------------------------------------------------------------
  app.get("/friends", async (c) => {
    const userId = getSessionUserId(c);
    if (!userId) return c.json({ error: "No linked app user" }, 404);

    const friendships = await prisma.friendship.findMany({
      where: {
        status: "ACCEPTED",
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      include: { requester: true, addressee: true },
    });

    const friends = friendships.map((f) => {
      const iAmRequester = f.requesterId === userId;
      const friend = iAmRequester ? f.addressee : f.requester;
      const notify = iAmRequester ? f.requesterNotify : f.addresseeNotify;
      return {
        friendshipId: f.id,
        id: friend.id,
        name: friend.name,
        email: friend.email,
        phoneNumber: friend.phoneNumber,
        availableForHangout: friend.availableForHangout,
        avatarUrl: avatarPath(friend.avatarFilename),
        notify,
      };
    });

    return c.json(friends);
  });

  app.get("/friends/requests", async (c) => {
    const userId = getSessionUserId(c);
    if (!userId) return c.json({ error: "No linked app user" }, 404);

    const pending = await prisma.friendship.findMany({
      where: {
        status: "PENDING",
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      include: { requester: true, addressee: true },
    });

    const incoming = pending
      .filter((f) => f.addresseeId === userId)
      .map((f) => ({
        friendshipId: f.id,
        id: f.requester.id,
        name: f.requester.name,
        email: f.requester.email,
        phoneNumber: f.requester.phoneNumber,
        avatarUrl: avatarPath(f.requester.avatarFilename),
        createdAt: f.createdAt,
      }));
    const outgoing = pending
      .filter((f) => f.requesterId === userId)
      .map((f) => ({
        friendshipId: f.id,
        id: f.addressee.id,
        name: f.addressee.name,
        email: f.addressee.email,
        phoneNumber: f.addressee.phoneNumber,
        avatarUrl: avatarPath(f.addressee.avatarFilename),
        createdAt: f.createdAt,
      }));

    return c.json({ incoming, outgoing });
  });

  app.post("/friends/request", async (c) => {
    const userId = getSessionUserId(c);
    if (!userId) return c.json({ error: "No linked app user" }, 404);
    try {
      const { phoneNumber } = await c.req.json<{ phoneNumber?: string }>();
      if (!phoneNumber || !phoneNumber.trim()) {
        return c.json({ error: "phoneNumber is required" }, 400);
      }
      const target = await prisma.user.findUnique({
        where: { phoneNumber: normalizePhoneNumber(phoneNumber) },
      });
      if (!target) {
        const inviteMessage = await getConfigValue("share_text");
        return c.json(
          { error: "No user with that phone number", inviteMessage },
          404,
        );
      }
      if (target.id === userId) {
        return c.json({ error: "You can't friend yourself" }, 400);
      }

      const existing = await prisma.friendship.findFirst({
        where: {
          OR: [
            { requesterId: userId, addresseeId: target.id },
            { requesterId: target.id, addresseeId: userId },
          ],
        },
      });
      if (existing) {
        return c.json(
          { error: "A friendship or request already exists", status: existing.status },
          409,
        );
      }

      const friendship = await prisma.friendship.create({
        data: { requesterId: userId, addresseeId: target.id },
      });
      return c.json(friendship, 201);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      return handlePrismaError(c, error);
    }
  });

  app.post("/friends/:id/accept", async (c) => {
    const userId = getSessionUserId(c);
    if (!userId) return c.json({ error: "No linked app user" }, 404);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "Invalid ID" }, 400);

    const friendship = await prisma.friendship.findUnique({ where: { id } });
    if (!friendship || friendship.addresseeId !== userId) {
      return c.json({ error: "Not found" }, 404);
    }
    if (friendship.status !== "PENDING") {
      return c.json({ error: "Request is no longer pending" }, 409);
    }
    const updated = await prisma.friendship.update({
      where: { id },
      data: { status: "ACCEPTED" },
    });
    return c.json(updated);
  });

  app.post("/friends/:id/decline", async (c) => {
    const userId = getSessionUserId(c);
    if (!userId) return c.json({ error: "No linked app user" }, 404);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "Invalid ID" }, 400);

    const friendship = await prisma.friendship.findUnique({ where: { id } });
    if (
      !friendship ||
      (friendship.requesterId !== userId && friendship.addresseeId !== userId)
    ) {
      return c.json({ error: "Not found" }, 404);
    }
    if (friendship.status !== "PENDING") {
      return c.json({ error: "Request is no longer pending" }, 409);
    }

    if (friendship.addresseeId === userId) {
      const updated = await prisma.friendship.update({
        where: { id },
        data: { status: "DECLINED" },
      });
      return c.json(updated);
    }
    // The requester is cancelling their own outgoing request.
    await prisma.friendship.delete({ where: { id } });
    return c.json({ message: "Request cancelled" });
  });

  app.delete("/friends/:id", async (c) => {
    const userId = getSessionUserId(c);
    if (!userId) return c.json({ error: "No linked app user" }, 404);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "Invalid ID" }, 400);

    const result = await prisma.friendship.deleteMany({
      where: { id, OR: [{ requesterId: userId }, { addresseeId: userId }] },
    });
    if (result.count === 0) return c.json({ error: "Not found" }, 404);
    return c.json({ message: "Deleted" });
  });

  app.put("/friends/:id/notify", async (c) => {
    const userId = getSessionUserId(c);
    if (!userId) return c.json({ error: "No linked app user" }, 404);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "Invalid ID" }, 400);
    try {
      const { notify } = await c.req.json<{ notify?: boolean }>();
      if (typeof notify !== "boolean") {
        return c.json({ error: "notify (boolean) is required" }, 400);
      }
      const friendship = await prisma.friendship.findUnique({ where: { id } });
      if (
        !friendship ||
        (friendship.requesterId !== userId && friendship.addresseeId !== userId)
      ) {
        return c.json({ error: "Not found" }, 404);
      }
      const updated = await prisma.friendship.update({
        where: { id },
        data:
          friendship.requesterId === userId
            ? { requesterNotify: notify }
            : { addresseeNotify: notify },
      });
      return c.json(updated);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      return handlePrismaError(c, error);
    }
  });

  // -------------------------------------------------------------------------
  // Generic auto-CRUD (see tools/createCRUD.ts) — the app itself doesn't use
  // this (all real behavior is the dedicated routes above); kept mounted
  // admin-only for debugging, since it defaults to wide open otherwise.
  // -------------------------------------------------------------------------
  function checkPermissions(_action: string, c: any): PermissionResult {
    const session = c.get("session") as Session;
    return { allowed: session.user?.priv === 1 };
  }

  exposePrismaCRUD("api", app, checkPermissions);
}

export async function onLogin(session: Session): Promise<void> {
  const email = session.email || (session.cas_data?.email as string | undefined);
  const name =
    session.username ||
    (session.cas_data?.name as string | undefined) ||
    email;
  console.log("User logged in:", email, name);
  if (email) {
    const appUser = await getOrCreateAppUser(email, name);
    session.db = { userId: appUser.id };
  }
}

/* session.google_data

{
  iss: 'https://accounts.google.com',
  azp: '...',
  aud: '...',
  sub: '103589682456946370010',
  email: 'southwickmatthias@gmail.com',
  email_verified: true,
  name: 'Matthias Southwick',
  picture: 'https://lh3.googleusercontent.com/...',
  given_name: 'Matthias',
  family_name: 'Southwick',
  iat: 1723081204,
  exp: 1723084804,
}

*/
/* session.microsoft_data: {
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users/$entity',
  userPrincipalName: 'Southwickmatthias@gmail.com',
  id: '4a1639e4ad5f1ca5',
  displayName: 'Matthias Southwick',
  surname: 'Southwick',
  givenName: 'Matthias',
  preferredLanguage: 'en-US',
  mail: null,
  mobilePhone: null,
  jobTitle: null,
  officeLocation: null,
  businessPhones: []
}

*/
