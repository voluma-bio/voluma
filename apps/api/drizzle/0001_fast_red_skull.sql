CREATE TABLE "inputs" (
	"id" text PRIMARY KEY NOT NULL,
	"lab_id" text NOT NULL,
	"source" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"lab_id" text NOT NULL,
	"started_by" text NOT NULL,
	"workflow_id" text NOT NULL,
	"workflows" json NOT NULL,
	"input_id" text NOT NULL,
	"credentials" text NOT NULL,
	"example" boolean DEFAULT false NOT NULL,
	"forked_from" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text NOT NULL,
	"started_at" timestamp with time zone,
	"awaiting_since" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"outcome" text,
	"error" text,
	"lease_holder" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"recoveries" integer DEFAULT 0 NOT NULL,
	"model_cost_usd" double precision DEFAULT 0 NOT NULL,
	"sandbox_seconds" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "runs_lab_state" ON "runs" USING btree ("lab_id","state","created_at");--> statement-breakpoint
CREATE INDEX "runs_started_by" ON "runs" USING btree ("started_by");