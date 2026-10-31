-- Contract step of run-keyed rows (the expand step is 0015). The API deployed before this one
-- reads and writes by run_id and conflicts on (run_id, id) / (run_id, thread_id, idx), so it
-- keeps working on this schema; it never touches `threads`.
DROP TRIGGER "pi_messages_fill_run_id" ON "pi_messages";--> statement-breakpoint
DROP FUNCTION "pi_messages_fill_run_id"();--> statement-breakpoint
-- A row an older API wrote after the expand migration and before its trigger was dropped has run_id.
ALTER TABLE "pi_messages" ALTER COLUMN "run_id" SET NOT NULL;--> statement-breakpoint
-- Move each primary key onto the unique index that already holds the run-keyed columns.
ALTER TABLE "events" DROP CONSTRAINT "events_pkey";--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_run_id_id_pk" PRIMARY KEY USING INDEX "events_run_id_id";--> statement-breakpoint
ALTER TABLE "pi_messages" DROP CONSTRAINT "pi_messages_thread_id_idx_pk";--> statement-breakpoint
ALTER TABLE "pi_messages" ADD CONSTRAINT "pi_messages_run_id_thread_id_idx_pk" PRIMARY KEY USING INDEX "pi_messages_run_thread_idx";--> statement-breakpoint
-- No query filters events by thread alone, so the thread index goes instead of being rebuilt.
DROP INDEX "events_thread";--> statement-breakpoint
DROP TABLE "threads";
