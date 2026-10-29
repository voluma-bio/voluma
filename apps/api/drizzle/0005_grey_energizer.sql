CREATE TABLE "provider_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"sandbox" text NOT NULL,
	"provider" text NOT NULL,
	"route" text NOT NULL,
	"model" text,
	"instance" text NOT NULL,
	"status" text NOT NULL,
	"reserved_usd" double precision NOT NULL,
	"cost_usd" double precision,
	"file_id" text,
	"http_status" integer,
	"frames" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ttfb_ms" integer,
	"duration_ms" integer
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cost_cap_usd" double precision DEFAULT 10 NOT NULL;--> statement-breakpoint
CREATE INDEX "provider_calls_run" ON "provider_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "provider_calls_open" ON "provider_calls" USING btree ("status","instance");