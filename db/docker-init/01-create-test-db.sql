-- Runs once on first container init (postgres image /docker-entrypoint-initdb.d).
-- The demo/test gate resets a scratch schema (DROP SCHEMA public), so it must run
-- against a database SEPARATE from the dev one — otherwise `npm test` would wipe
-- local dev data. The demos default to this database via TEST_DATABASE_URL.
CREATE DATABASE multiagency_test;
