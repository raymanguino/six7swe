-- Portfolio profile and content sections for public repo privacy
CREATE TABLE IF NOT EXISTS "portfolio_profile" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"title" varchar(512) NOT NULL,
	"email" varchar(255) NOT NULL,
	"phone" varchar(50),
	"location" varchar(255),
	"linkedin_url" varchar(512),
	"github_url" varchar(512),
	"summary" text,
	"skills" jsonb DEFAULT '[]'::jsonb,
	"experience" jsonb DEFAULT '[]'::jsonb,
	"projects" jsonb DEFAULT '[]'::jsonb,
	"full_resume_text" text NOT NULL,
	"resume_filename" varchar(255),
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "content_sections" (
	"id" serial PRIMARY KEY NOT NULL,
	"filename" varchar(255) NOT NULL,
	"content" text NOT NULL,
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
