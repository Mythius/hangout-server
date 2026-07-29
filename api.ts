import { Hono } from "hono";
import type { Session } from "./tools/auth.ts";
import { createSession } from "./tools/auth.ts";
import { exposePrismaCRUD, prisma } from "./tools/prisma.ts";
import { handleFileUpload } from "./tools/fileUpload.ts";
import { handlePrismaError, PermissionResult } from "./tools/createCRUD.ts";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";

// ---------------------------------------------------------------------------
// App-user helpers — link a login session (keyed by email) to the app's own
// Prisma `User` row (phone number, availability, friendships live there).
// ---------------------------------------------------------------------------
async function getOrCreateAppUser(email: string, name: string | undefined) {
  return prisma.user.upsert({
    where: { email },
    update: name ? { name } : {},
    create: { email, name },
  });
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
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phoneNumber: user.phoneNumber,
    availableForHangout: user.availableForHangout,
  };
}

export function publicRoutes(app: Hono): void {
  app.get("/hello", (c) => c.json({ message: "Hello World" }));

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
      const user = await prisma.user.update({
        where: { id: userId },
        data: { phoneNumber: phoneNumber.trim() },
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
      const user = await prisma.user.update({
        where: { id: userId },
        data: { availableForHangout: available },
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
        where: { phoneNumber: phoneNumber.trim() },
      });
      if (!target) {
        return c.json({ error: "No user with that phone number" }, 404);
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
