-- Expand step of run-keyed rows. Safe beside the previous API (it inserts pi_messages without
-- run_id, and this trigger fills it) and for the new one (it always sets run_id itself). The contract
-- step (NOT NULL, the primary keys, the threads table) is a later migration, once this is deployed.
ALTER TABLE "pi_messages" ADD COLUMN "run_id" text;--> statement-breakpoint
-- Every stored thread id is `<runId>.<name>`, and run ids hold no '.'.
UPDATE "pi_messages" SET "run_id" = split_part("thread_id", '.', 1);--> statement-breakpoint
CREATE FUNCTION "pi_messages_fill_run_id"() RETURNS trigger AS $$
BEGIN
  NEW."run_id" := split_part(NEW."thread_id", '.', 1);
  RETURN NEW;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "pi_messages_fill_run_id" BEFORE INSERT ON "pi_messages"
  FOR EACH ROW WHEN (NEW."run_id" IS NULL) EXECUTE FUNCTION "pi_messages_fill_run_id"();--> statement-breakpoint
CREATE UNIQUE INDEX "events_run_id_id" ON "events" USING btree ("run_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pi_messages_run_thread_idx" ON "pi_messages" USING btree ("run_id","thread_id","idx");
