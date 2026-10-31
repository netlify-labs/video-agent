-- Plan v2 roles: admin, creator, reviewer, viewer. Existing members become creators (they could already make videos).
UPDATE "users" SET "role" = 'creator' WHERE "role" = 'member';
