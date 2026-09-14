// One-off backfill: re-normalizes every existing User.phoneNumber to the
// canonical +<digits> form (see `normalizePhoneNumber` in api.ts).
//
// Phone-number matching in /friends/request only works if both the stored
// value and the search value go through the same normalization. That's been
// true for every row written since e9a9f13, but rows written before that
// commit (or hand-inserted) may still hold whatever raw string the user
// typed — e.g. "(555) 123-4567" instead of "+15551234567" — so a
// correctly-normalized search for that same number won't find them.
//
// Run once after deploying this schema/normalization change:
//   bun run tools/backfillPhoneNumbers.ts
//
// Safe to re-run — it's a no-op for rows already in canonical form.
import { prisma } from "./prisma.ts";
import { normalizePhoneNumber } from "../api.ts";

async function main() {
  const users = await prisma.user.findMany({
    where: { phoneNumber: { not: null } },
    select: { id: true, phoneNumber: true },
  });

  let updated = 0;
  for (const user of users) {
    const normalized = normalizePhoneNumber(user.phoneNumber!);
    if (normalized === user.phoneNumber) continue;

    try {
      await prisma.user.update({
        where: { id: user.id },
        data: { phoneNumber: normalized },
      });
      console.log(`user ${user.id}: "${user.phoneNumber}" -> "${normalized}"`);
      updated++;
    } catch (error) {
      // Almost certainly the unique constraint — another user's row already
      // normalizes to the same number. Needs a human to sort out which one
      // is right, so log and move on rather than crashing the whole backfill.
      console.error(
        `user ${user.id}: could not normalize "${user.phoneNumber}" -> "${normalized}":`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  console.log(`Done. ${updated}/${users.length} row(s) updated.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
