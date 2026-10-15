ALTER TABLE "menus" DROP CONSTRAINT "menus_parent_id_fkey";
--> statement-breakpoint
DROP INDEX "idx_menus_parent_id";--> statement-breakpoint
DROP INDEX "idx_menus_sort_order";--> statement-breakpoint
ALTER TABLE "menus" DROP COLUMN "component_name";--> statement-breakpoint
ALTER TABLE "menus" DROP COLUMN "icon";--> statement-breakpoint
ALTER TABLE "menus" DROP COLUMN "user_message";--> statement-breakpoint
ALTER TABLE "menus" DROP COLUMN "parent_id";--> statement-breakpoint
ALTER TABLE "menus" DROP COLUMN "sort_order";--> statement-breakpoint
ALTER TABLE "menus" DROP COLUMN "props";