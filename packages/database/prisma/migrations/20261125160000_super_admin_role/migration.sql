-- Super Admin: the one role nothing can restrict. Everyone who was Admin
-- moves to it, so nobody loses anything on the day this runs. Admin becomes an
-- ordinary role that starts with every permission there is and can be
-- narrowed in Settings → People. No table changes; only rows.

-- 1. The role itself.
INSERT INTO "roles" ("id", "name", "description", "isSystem", "createdAt", "updatedAt")
SELECT 'role-super-admin', 'Super Admin', 'Every screen and every action, always; cannot be restricted', true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "name" = 'Super Admin');

-- 2. Everyone on Admin today moves to it.
UPDATE "users"
SET "roleId" = (SELECT "id" FROM "roles" WHERE "name" = 'Super Admin'), "updatedAt" = NOW()
WHERE "roleId" = (SELECT "id" FROM "roles" WHERE "name" = 'Admin');

-- 3. Admin holds every module-wide permission, so it starts with full access
--    now that it no longer bypasses the matrix. Super Admin gets them too: it
--    needs none under the new code, but the code still running when this is
--    applied reads each person's rights from their role, and without these
--    everyone just moved to Super Admin would be shut out until it deploys.
INSERT INTO "role_permissions" ("id", "roleId", "permissionId")
SELECT 'rp_' || md5(r."id" || ':' || p."id"), r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."name" IN ('Admin', 'Super Admin') AND p."module" NOT LIKE '%.%'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

UPDATE "roles"
SET "description" = 'Full access to start with; can be narrowed in Settings → People', "updatedAt" = NOW()
WHERE "name" = 'Admin';
