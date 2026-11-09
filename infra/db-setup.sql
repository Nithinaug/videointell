SELECT 'CREATE DATABASE videointell' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'videointell') \gexec

\c videointell

\i ../backend/internal/db/migrations/0001_init.sql
\i ../backend/internal/db/migrations/0002_video_status.sql

SELECT 'CREATE ROLE pipeline LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pipeline') \gexec
ALTER ROLE pipeline PASSWORD :'pw';
GRANT SELECT, UPDATE ON videos TO pipeline;
GRANT EXECUTE ON FUNCTION set_video_status(TEXT, TEXT[], TEXT, JSONB) TO pipeline;

SELECT 'CREATE ROLE api LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'api') \gexec
GRANT rds_iam TO api;
GRANT CREATE ON SCHEMA public TO api;
ALTER TABLE users OWNER TO api;
ALTER TABLE videos OWNER TO api;
ALTER FUNCTION set_video_status(TEXT, TEXT[], TEXT, JSONB) OWNER TO api;
