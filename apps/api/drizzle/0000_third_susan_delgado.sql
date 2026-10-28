CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "events_run_seq" UNIQUE("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "pi_messages" (
	"thread_id" text NOT NULL,
	"idx" integer NOT NULL,
	"message" text NOT NULL,
	CONSTRAINT "pi_messages_thread_id_idx_pk" PRIMARY KEY("thread_id","idx")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"parent_thread_id" text,
	"kind" text NOT NULL,
	"task" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_parent_thread_id_threads_id_fk" FOREIGN KEY ("parent_thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_thread" ON "events" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "threads_run" ON "threads" USING btree ("run_id");