--
-- PostgreSQL database dump
--

\restrict jx7G3WF2Pga6jXVzaLTuzIiiu1TW1IPXQcufqBC5uuJ5FpFzJLBhLkf99gElxCg

-- Dumped from database version 17.10 (Homebrew)
-- Dumped by pg_dump version 17.10 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: backup_records; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.backup_records (id, operation, filename, status, format_version, artifact_path, encrypted, checksum, size_bytes, started_at, completed_at, initiated_by, error, metadata, created_at) VALUES ('5bba9361-41c8-4f3d-ae59-7f5eb5122313', 'backup', 'pending-5bba9361-41c8-4f3d-ae59-7f5eb5122313.ocgwb', 'queued', 1, NULL, true, NULL, NULL, '2026-08-13 15:54:31.957343+07', NULL, NULL, NULL, '{"schedule": "weekly", "scheduledDate": "2026-08-13", "scheduledWeek": "2026-W33"}', '2026-08-13 15:54:31.957343+07');


--
-- PostgreSQL database dump complete
--

\unrestrict jx7G3WF2Pga6jXVzaLTuzIiiu1TW1IPXQcufqBC5uuJ5FpFzJLBhLkf99gElxCg

